-- Aplicar após 036, junto da interface que mantém a prova disponível sem câmera.
-- Preserva tentativas, fotos, respostas e aceites já registrados.
BEGIN;
DO $$ BEGIN
    IF to_regprocedure('public.registrar_falha_camera(uuid,uuid)') IS NULL
       OR to_regprocedure('examentech_private.iniciar_tentativa_sem_fotos(uuid,text)') IS NULL
       OR to_regclass('public.aceites_termos') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='auth.users'::regclass
           AND tgname='examentech_registrar_aceite_termos' AND tgenabled IN ('O','A')) THEN
        RAISE EXCEPTION 'Confira as queries 031, 032 e 036 antes desta atualização.';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION examentech_private.iniciar_tentativa_sem_fotos(p_avaliacao_id UUID,p_aviso_versao TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_liberacao public.liberacoes_tentativa%ROWTYPE;
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_agora TIMESTAMPTZ; v_resultado JSONB;
BEGIN
    IF p_aviso_versao IS DISTINCT FROM '2026-11-08-v3' THEN
        RAISE EXCEPTION 'Aviso da prova não confirmado.' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_tentativa FROM public.tentativas
    WHERE avaliacao_id = p_avaliacao_id AND aluno_id = auth.uid() FOR UPDATE;
    IF FOUND THEN
        v_tentativa := examentech_private.tentativa_do_aluno(v_tentativa.id);
        IF v_tentativa.situacao <> 'INTERROMPIDA' OR NOT v_tentativa.retomada_autorizada THEN
            RAISE EXCEPTION 'Já existe uma tentativa. A retomada exige autorização do responsável.' USING ERRCODE = '55000';
        END IF;
        SELECT * INTO v_liberacao FROM public.liberacoes_tentativa
        WHERE tentativa_id = v_tentativa.id AND ciclo_anterior = v_tentativa.ciclo AND utilizada_em IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Liberação não encontrada.' USING ERRCODE = '55000'; END IF;
        SELECT * INTO v_avaliacao FROM public.avaliacoes WHERE id = p_avaliacao_id FOR SHARE;
        v_agora := clock_timestamp();
        IF v_agora < v_avaliacao.inicio_em OR v_agora >= v_avaliacao.fim_em THEN
            RAISE EXCEPTION 'O período da avaliação terminou ou ainda não começou.' USING ERRCODE = '55000';
        END IF;
        UPDATE public.liberacoes_tentativa SET utilizada_em = v_agora WHERE id = v_liberacao.id;
        UPDATE public.tentativas SET situacao = 'EM_ANDAMENTO', encerrada_em = NULL,
            ciclo = ciclo + 1, ciclo_iniciado_em = v_agora, retomada_autorizada = FALSE,
            limite_em = LEAST(v_avaliacao.fim_em,v_agora + make_interval(mins => v_liberacao.minutos)),
            falhas_camera = 0,aviso_versao = p_aviso_versao,aviso_aceito_em = v_agora
        WHERE id = v_tentativa.id RETURNING * INTO v_tentativa;
        INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id)
        VALUES (gen_random_uuid(),'TENTATIVA_RETOMADA','EXAMENTECH','retomada_autorizada',TRUE,auth.uid(),v_tentativa.id);
    ELSE
        v_resultado := examentech_private.iniciar_tentativa(p_avaliacao_id);
        UPDATE public.tentativas SET aviso_versao = p_aviso_versao,aviso_aceito_em = iniciada_em,
            ciclo_iniciado_em = iniciada_em
        WHERE id = (v_resultado ->> 'id')::UUID RETURNING * INTO v_tentativa;
    END IF;
    RETURN to_jsonb(v_tentativa);
END;
$$;
CREATE OR REPLACE FUNCTION examentech_private.encerrar_tentativa(
    p_tentativa_id UUID, p_motivo TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_agora TIMESTAMPTZ;
    v_situacao TEXT;
BEGIN
    IF p_motivo NOT IN ('ENVIO', 'PRAZO', 'SAIDA') OR p_motivo IS NULL THEN
        RAISE EXCEPTION 'Motivo inválido.' USING ERRCODE = '23514';
    END IF;
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO' THEN
        -- Repetir uma confirmação perdida não reabre nem duplica a auditoria.
        IF (p_motivo IN ('ENVIO', 'PRAZO') AND v_tentativa.situacao = 'FINALIZADA')
           OR (p_motivo = 'SAIDA' AND v_tentativa.situacao = 'INTERROMPIDA') THEN
            RETURN jsonb_build_object('id', v_tentativa.id,
                'situacao', v_tentativa.situacao, 'encerrada_em', v_tentativa.encerrada_em,
                'falhas_camera', v_tentativa.falhas_camera);
        END IF;
        RAISE EXCEPTION 'Tentativa já encerrada.' USING ERRCODE = '55000';
    END IF;
    v_agora := clock_timestamp();
    IF p_motivo = 'ENVIO' AND v_agora >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Prazo da tentativa encerrado.' USING ERRCODE = '55000';
    END IF;
    IF p_motivo = 'PRAZO' AND v_agora < v_tentativa.limite_em THEN
        RAISE EXCEPTION 'O prazo da tentativa ainda não terminou.' USING ERRCODE = '55000';
    END IF;
    v_situacao := CASE WHEN p_motivo IN ('ENVIO', 'PRAZO') THEN 'FINALIZADA' ELSE 'INTERROMPIDA' END;
    UPDATE public.tentativas SET situacao = v_situacao, encerrada_em = v_agora
    WHERE id = p_tentativa_id RETURNING * INTO v_tentativa;

    INSERT INTO public.eventos_seguranca
        (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(),
        CASE WHEN p_motivo IN ('ENVIO', 'PRAZO') THEN 'TENTATIVA_FINALIZADA' ELSE 'TENTATIVA_INTERROMPIDA' END,
        'EXAMENTECH', CASE WHEN p_motivo = 'SAIDA' THEN 'saida_tentativa'
            WHEN p_motivo = 'PRAZO' THEN 'prazo_tentativa' ELSE 'finalizar_tentativa' END,
        TRUE, auth.uid(), p_tentativa_id);

    RETURN jsonb_build_object('id', v_tentativa.id, 'situacao', v_tentativa.situacao,
        'encerrada_em', v_tentativa.encerrada_em, 'falhas_camera', v_tentativa.falhas_camera);
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.iniciar_tentativa_sem_fotos(UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION examentech_private.encerrar_tentativa(UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.encerrar_tentativa(UUID,TEXT) TO authenticated;
COMMENT ON FUNCTION public.encerrar_tentativa(UUID,TEXT) IS
    'Encerra por envio, prazo ou saída. Falha da câmera usa registrar_falha_camera e não encerra a prova.';

CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF (NEW.raw_user_meta_data->'termos_aceitos') IS DISTINCT FROM 'true'::JSONB
       OR NOT (
           ((NEW.raw_user_meta_data->>'termos_versao') IS NOT DISTINCT FROM '2026-11-08-v7'
            AND (NEW.raw_user_meta_data->>'privacidade_versao') IS NOT DISTINCT FROM '2026-11-08-v5')
           OR ((NEW.raw_user_meta_data->>'termos_versao') IS NOT DISTINCT FROM '2026-11-08-v8'
            AND (NEW.raw_user_meta_data->>'privacidade_versao') IS NOT DISTINCT FROM '2026-11-06-v4')
       ) THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos documentos.' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.aceites_termos(usuario_id,termos_versao,privacidade_versao,aceito_em)
    VALUES(NEW.id,NEW.raw_user_meta_data->>'termos_versao',NEW.raw_user_meta_data->>'privacidade_versao',clock_timestamp());
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.registrar_aceite_termos() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_aceite_termos() TO supabase_auth_admin;
NOTIFY pgrst, 'reload schema';
COMMIT;
