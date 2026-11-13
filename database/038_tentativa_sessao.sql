-- Aplicar após 037, junto da aplicação que envia a chave em memória da página da prova.
BEGIN;

CREATE TABLE IF NOT EXISTS examentech_private.execucoes_tentativa (
    tentativa_id UUID PRIMARY KEY REFERENCES public.tentativas(id) ON DELETE CASCADE,
    sessao_id UUID NOT NULL,
    chave_hash BYTEA NOT NULL
);
ALTER TABLE examentech_private.execucoes_tentativa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON examentech_private.execucoes_tentativa FROM PUBLIC, anon, authenticated, service_role;

-- A sessão antiga não pode ser inferida com segurança. Preservar o histórico e
-- encerrar apenas as tentativas em andamento que ainda não têm vínculo.
WITH interrompidas AS (
    UPDATE public.tentativas te
    SET situacao = 'INTERROMPIDA', encerrada_em = clock_timestamp()
    WHERE te.situacao = 'EM_ANDAMENTO' AND NOT EXISTS (
        SELECT 1 FROM examentech_private.execucoes_tentativa e WHERE e.tentativa_id = te.id
    )
    RETURNING te.id, te.aluno_id, te.encerrada_em
)
INSERT INTO public.eventos_seguranca
    (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id, criado_em)
SELECT gen_random_uuid(), 'TENTATIVA_INTERROMPIDA', 'EXAMENTECH', 'migrar_tentativa_sem_sessao',
    TRUE, aluno_id, id, encerrada_em
FROM interrompidas;

UPDATE public.tentativas SET retomada_autorizada = FALSE WHERE retomada_autorizada;

CREATE OR REPLACE FUNCTION examentech_private.iniciar_tentativa_sem_fotos(
    p_avaliacao_id UUID, p_aviso_versao TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_resultado JSONB;
    v_tentativa public.tentativas%ROWTYPE;
BEGIN
    IF p_aviso_versao IS DISTINCT FROM '2026-11-08-v4' THEN
        RAISE EXCEPTION 'Aviso da prova não confirmado.' USING ERRCODE = '23514';
    END IF;

    -- O início canônico rejeita outra tentativa e grava a ordem na mesma transação.
    v_resultado := examentech_private.iniciar_tentativa(p_avaliacao_id);
    UPDATE public.tentativas SET aviso_versao = p_aviso_versao, aviso_aceito_em = iniciada_em,
        ciclo_iniciado_em = iniciada_em
    WHERE id = (v_resultado ->> 'id')::UUID RETURNING * INTO v_tentativa;
    RETURN to_jsonb(v_tentativa);
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.vincular_execucao_tentativa(
    p_tentativa JSONB, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF p_chave_execucao IS NULL THEN
        RAISE EXCEPTION 'Chave de execução obrigatória.' USING ERRCODE = '23514';
    END IF;
    INSERT INTO examentech_private.execucoes_tentativa (tentativa_id, sessao_id, chave_hash)
    VALUES ((p_tentativa ->> 'id')::UUID, (auth.jwt() ->> 'session_id')::UUID,
        sha256(convert_to(p_chave_execucao::TEXT, 'UTF8')));
    RETURN p_tentativa;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.verificar_execucao_tentativa(
    p_tentativa_id UUID, p_chave_execucao UUID
)
RETURNS VOID LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM examentech_private.execucoes_tentativa e
        WHERE e.tentativa_id = p_tentativa_id AND e.sessao_id::TEXT = (auth.jwt() ->> 'session_id')
          AND e.chave_hash = sha256(convert_to(p_chave_execucao::TEXT, 'UTF8'))
    ) THEN
        RAISE EXCEPTION 'A execução exige a sessão e a página que iniciaram a tentativa.' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- As funções com chave reutilizam as regras de acesso, estado, prazo e auditoria
-- anteriores. As assinaturas sem chave ficam restritas ao dono das funções.
CREATE OR REPLACE FUNCTION public.iniciar_tentativa(
    p_avaliacao_id UUID, p_aviso_versao TEXT, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT examentech_private.vincular_execucao_tentativa(
        public.iniciar_tentativa(p_avaliacao_id, p_aviso_versao), p_chave_execucao)
$$;

CREATE OR REPLACE FUNCTION public.iniciar_tentativa_com_fotos(
    p_avaliacao_id UUID, p_aviso_versao TEXT, p_fotos_aviso_versao TEXT, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT examentech_private.vincular_execucao_tentativa(
        public.iniciar_tentativa_com_fotos(p_avaliacao_id, p_aviso_versao, p_fotos_aviso_versao), p_chave_execucao)
$$;

CREATE OR REPLACE FUNCTION public.consultar_conteudo_tentativa(p_tentativa_id UUID, p_chave_execucao UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    RETURN examentech_private.consultar_conteudo_tentativa(p_tentativa_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_respostas_tentativa(p_tentativa_id UUID, p_chave_execucao UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    RETURN public.consultar_respostas_tentativa(p_tentativa_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_versao INTEGER,
    p_alternativa_id UUID, p_texto TEXT, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    RETURN examentech_private.salvar_resposta_tentativa(p_tentativa_id, p_questao_id, p_versao, p_alternativa_id, p_texto);
END;
$$;

CREATE OR REPLACE FUNCTION public.encerrar_tentativa(p_tentativa_id UUID, p_motivo TEXT, p_chave_execucao UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    RETURN examentech_private.encerrar_tentativa(p_tentativa_id, p_motivo);
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_falha_camera(
    p_tentativa_id UUID, p_solicitacao_id UUID, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    RETURN examentech_private.registrar_falha_camera(p_tentativa_id, p_solicitacao_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_plano_fotos(p_tentativa_id UUID, p_chave_execucao UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    RETURN public.consultar_plano_fotos(p_tentativa_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.reservar_envio_foto(
    p_captura_id UUID, p_upload_id UUID, p_sha256 TEXT,
    p_tamanho INTEGER, p_largura INTEGER, p_altura INTEGER, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(
        (SELECT f.tentativa_id FROM public.fotos_tentativa f WHERE f.id = p_captura_id), p_chave_execucao);
    RETURN public.reservar_envio_foto(p_captura_id, p_upload_id, p_sha256, p_tamanho, p_largura, p_altura);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirmar_envio_foto(p_captura_id UUID, p_upload_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_foto public.fotos_tentativa%ROWTYPE;
    v_aluno UUID;
    v_limite_em TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_foto FROM public.fotos_tentativa WHERE id = p_captura_id FOR UPDATE;
    IF NOT FOUND OR v_foto.upload_id IS DISTINCT FROM p_upload_id OR v_foto.situacao NOT IN ('ENVIANDO', 'DISPONIVEL') THEN
        RAISE EXCEPTION 'Reserva de envio não encontrada.' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'examentech-evidencias' AND name = v_foto.caminho) THEN
        RAISE EXCEPTION 'Arquivo não encontrado no armazenamento.' USING ERRCODE = '55000';
    END IF;
    IF v_foto.situacao = 'ENVIANDO' THEN
        -- A reserva antecede a transferência pelo Storage. Conferir a tentativa de
        -- novo antes de aceitar o arquivo, sob o mesmo lock usado no encerramento.
        SELECT te.aluno_id, te.limite_em INTO v_aluno, v_limite_em FROM public.tentativas te
        JOIN examentech_private.execucoes_tentativa e ON e.tentativa_id = te.id
        JOIN auth.sessions s ON s.id = e.sessao_id AND s.user_id = te.aluno_id
        WHERE te.id = v_foto.tentativa_id AND te.situacao = 'EM_ANDAMENTO' AND te.ciclo = v_foto.ciclo
        FOR UPDATE OF te FOR KEY SHARE OF s;
        IF NOT FOUND OR clock_timestamp() >= v_limite_em THEN
            RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
        END IF;
        UPDATE public.fotos_tentativa SET situacao = 'DISPONIVEL', recebida_em = clock_timestamp()
        WHERE id = p_captura_id RETURNING * INTO v_foto;
        INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
        VALUES (gen_random_uuid(), 'FOTO_RECEBIDA', 'EXAMENTECH', 'confirmar_envio_foto', TRUE, v_aluno, v_foto.id);
    END IF;
    RETURN jsonb_build_object('id', v_foto.id, 'recebida_em', v_foto.recebida_em, 'expira_em', v_foto.expira_em);
END;
$$;

ALTER POLICY respostas_tentativa_consultar ON public.respostas_tentativa USING (
    EXISTS (
        SELECT 1 FROM public.tentativas te
        WHERE te.id = tentativa_id AND auth.uid() <> te.aluno_id
          AND examentech_private.pode_consultar_tentativa(te.avaliacao_id, te.aluno_id)
    )
);

-- Atualizar os novos aceites sem reescrever quais versões foram aceitas antes.
ALTER TABLE public.avisos_fotos_tentativa
    ALTER COLUMN termos_versao SET DEFAULT '2026-11-08-v9',
    ALTER COLUMN privacidade_versao SET DEFAULT '2026-11-08-v6';

CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF (NEW.raw_user_meta_data -> 'termos_aceitos') IS DISTINCT FROM 'true'::JSONB
       OR NOT (
           ((NEW.raw_user_meta_data ->> 'termos_versao') IS NOT DISTINCT FROM '2026-11-08-v9'
            AND (NEW.raw_user_meta_data ->> 'privacidade_versao') IS NOT DISTINCT FROM '2026-11-08-v6')
           OR ((NEW.raw_user_meta_data ->> 'termos_versao') IS NOT DISTINCT FROM '2026-11-08-v10'
            AND (NEW.raw_user_meta_data ->> 'privacidade_versao') IS NOT DISTINCT FROM '2026-11-08-v7')
       ) THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos documentos.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.aceites_termos (usuario_id, termos_versao, privacidade_versao, aceito_em)
    VALUES (NEW.id, NEW.raw_user_meta_data ->> 'termos_versao',
        NEW.raw_user_meta_data ->> 'privacidade_versao', clock_timestamp());
    RETURN NEW;
END;
$$;

DO $$
DECLARE
    v_assinatura REGPROCEDURE;
BEGIN
    FOREACH v_assinatura IN ARRAY ARRAY[
        'public.iniciar_tentativa(uuid)', 'public.iniciar_tentativa(uuid,text)',
        'public.iniciar_tentativa_com_fotos(uuid,text,text)', 'public.consultar_conteudo_tentativa(uuid)',
        'public.consultar_respostas_tentativa(uuid)', 'public.salvar_resposta_tentativa(uuid,uuid,uuid,text)',
        'public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)', 'public.encerrar_tentativa(uuid,text)',
        'public.registrar_falha_camera(uuid,uuid)', 'public.consultar_plano_fotos(uuid)',
        'public.reservar_envio_foto(uuid,uuid,text,integer,integer,integer)',
        'public.reativar_tentativa(uuid,text,integer)', 'examentech_private.iniciar_tentativa(uuid)',
        'examentech_private.iniciar_tentativa_sem_fotos(uuid,text)', 'examentech_private.iniciar_tentativa_com_aviso(uuid,text)',
        'examentech_private.consultar_conteudo_tentativa(uuid)', 'examentech_private.consultar_conteudo_sem_fotos(uuid)',
        'examentech_private.salvar_resposta_tentativa(uuid,uuid,uuid,text)',
        'examentech_private.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)',
        'examentech_private.encerrar_tentativa(uuid,text)', 'examentech_private.registrar_falha_camera(uuid,uuid)',
        'examentech_private.tentativa_do_aluno(uuid)', 'examentech_private.vincular_execucao_tentativa(jsonb,uuid)',
        'examentech_private.verificar_execucao_tentativa(uuid,uuid)'
    ]::REGPROCEDURE[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_assinatura);
        IF has_function_privilege('authenticated', v_assinatura, 'EXECUTE')
           OR has_function_privilege('anon', v_assinatura, 'EXECUTE') THEN
            RAISE EXCEPTION 'Permissão herdada ainda permite executar %.', v_assinatura;
        END IF;
    END LOOP;

    FOREACH v_assinatura IN ARRAY ARRAY[
        'public.iniciar_tentativa(uuid,text,uuid)', 'public.iniciar_tentativa_com_fotos(uuid,text,text,uuid)',
        'public.consultar_conteudo_tentativa(uuid,uuid)', 'public.consultar_respostas_tentativa(uuid,uuid)',
        'public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text,uuid)', 'public.encerrar_tentativa(uuid,text,uuid)',
        'public.registrar_falha_camera(uuid,uuid,uuid)', 'public.consultar_plano_fotos(uuid,uuid)',
        'public.reservar_envio_foto(uuid,uuid,text,integer,integer,integer,uuid)'
    ]::REGPROCEDURE[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_assinatura);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_assinatura);
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
