-- RF32: registra a pausa da interface sem alterar a situação ou o prazo da tentativa.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- Preserva todos os tipos de evento permitidos pelas migrações anteriores.
DO $$
DECLARE v_regra TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO STRICT v_regra FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.eventos_seguranca'::regclass AND conname = 'eventos_seguranca_evento_valido';
    ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido;
    EXECUTE 'ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (('
        || substring(v_regra FROM 7) || ') OR evento = ''PROVA_PAUSADA'')';
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_pausa_prova(
    p_tentativa_id UUID, p_solicitacao_id UUID, p_chave_execucao UUID, p_motivo TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_evento public.eventos_seguranca%ROWTYPE;
    v_acao TEXT := CASE p_motivo
        WHEN 'ABA_OU_FOCO' THEN 'perda_aba_ou_foco'
        WHEN 'TELA_CHEIA' THEN 'saida_tela_cheia'
    END;
BEGIN
    IF v_acao IS NULL OR p_solicitacao_id IS NULL THEN
        RAISE EXCEPTION 'Motivo ou identificador da ocorrência inválido.' USING ERRCODE = '23514';
    END IF;
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    PERFORM examentech_private.bloquear_avaliacao_da_tentativa(p_tentativa_id);
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    PERFORM examentech_private.exigir_prova(v_tentativa.avaliacao_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO' OR clock_timestamp() >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (p_solicitacao_id, 'PROVA_PAUSADA', 'EXAMENTECH', v_acao, TRUE, auth.uid(), p_tentativa_id)
    ON CONFLICT (solicitacao_id) DO NOTHING;
    SELECT * INTO v_evento FROM public.eventos_seguranca WHERE solicitacao_id = p_solicitacao_id;
    IF NOT FOUND OR v_evento.evento IS DISTINCT FROM 'PROVA_PAUSADA'
       OR v_evento.usuario_id IS DISTINCT FROM auth.uid() OR v_evento.recurso_id IS DISTINCT FROM p_tentativa_id
       OR v_evento.acao IS DISTINCT FROM v_acao THEN
        RAISE EXCEPTION 'Identificador da ocorrência já utilizado.' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('tentativa_id', v_evento.recurso_id, 'solicitacao_id', v_evento.solicitacao_id,
        'registrado_em', v_evento.criado_em);
END;
$$;
REVOKE ALL ON FUNCTION public.registrar_pausa_prova(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_pausa_prova(UUID, UUID, UUID, TEXT) TO authenticated;

-- Aceita o aviso novo e o anterior para permitir aplicar o SQL antes de publicar a interface.
CREATE OR REPLACE FUNCTION examentech_private.iniciar_tentativa_sem_fotos(
    p_avaliacao_id UUID, p_aviso_versao TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_resultado JSONB;
    v_tentativa public.tentativas%ROWTYPE;
BEGIN
    IF p_aviso_versao IS NULL OR p_aviso_versao NOT IN ('2026-11-08-v4', '2026-11-09-v5', '2026-11-16-v6') THEN
        RAISE EXCEPTION 'Aviso da avaliação não confirmado.' USING ERRCODE = '23514';
    END IF;
    v_resultado := examentech_private.iniciar_tentativa(p_avaliacao_id);
    UPDATE public.tentativas SET aviso_versao = p_aviso_versao, aviso_aceito_em = iniciada_em,
        ciclo_iniciado_em = iniciada_em
    WHERE id = (v_resultado ->> 'id')::UUID RETURNING * INTO STRICT v_tentativa;
    RETURN to_jsonb(v_tentativa);
END;
$$;

CREATE OR REPLACE FUNCTION public.iniciar_tentativa_com_fotos(
    p_avaliacao_id UUID, p_aviso_versao TEXT, p_fotos_aviso_versao TEXT, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa JSONB;
BEGIN
    IF p_aviso_versao IS NULL OR p_aviso_versao NOT IN ('2026-11-09-v5', '2026-11-16-v6') THEN
        RAISE EXCEPTION 'Aviso do monitoramento da prova não confirmado.' USING ERRCODE = '23514';
    END IF;
    v_tentativa := public.iniciar_tentativa_com_fotos(p_avaliacao_id, p_aviso_versao, p_fotos_aviso_versao);
    IF EXISTS (SELECT 1 FROM public.avaliacoes WHERE id = p_avaliacao_id AND tipo <> 'PROVA') THEN
        RAISE EXCEPTION 'A coleta de fotografias é exclusiva das provas.' USING ERRCODE = '55000';
    END IF;
    RETURN examentech_private.vincular_execucao_tentativa(v_tentativa, p_chave_execucao);
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
