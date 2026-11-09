-- Aplicar após 042. O aceite do aviso de monitoramento é versionado na tentativa.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION examentech_private.iniciar_tentativa_sem_fotos(
    p_avaliacao_id UUID, p_aviso_versao TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_resultado JSONB;
    v_tentativa public.tentativas%ROWTYPE;
BEGIN
    IF p_aviso_versao IS NULL OR p_aviso_versao NOT IN ('2026-11-08-v4', '2026-11-09-v5') THEN
        RAISE EXCEPTION 'Aviso da avaliação não confirmado.' USING ERRCODE = '23514';
    END IF;
    v_resultado := examentech_private.iniciar_tentativa(p_avaliacao_id);
    UPDATE public.tentativas SET aviso_versao = p_aviso_versao, aviso_aceito_em = iniciada_em,
        ciclo_iniciado_em = iniciada_em
    WHERE id = (v_resultado ->> 'id')::UUID RETURNING * INTO v_tentativa;
    RETURN to_jsonb(v_tentativa);
END;
$$;

CREATE OR REPLACE FUNCTION public.iniciar_tentativa(
    p_avaliacao_id UUID, p_aviso_versao TEXT, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa JSONB;
BEGIN
    IF p_aviso_versao IS DISTINCT FROM '2026-11-08-v4' THEN
        RAISE EXCEPTION 'Aviso da atividade não confirmado.' USING ERRCODE = '23514';
    END IF;
    -- O início canônico valida a autorização antes de verificar o tipo.
    v_tentativa := examentech_private.iniciar_tentativa_sem_fotos(p_avaliacao_id, p_aviso_versao);
    IF EXISTS (SELECT 1 FROM public.avaliacoes WHERE id = p_avaliacao_id AND tipo = 'PROVA') THEN
        RAISE EXCEPTION 'Provas exigem aceite do monitoramento e foto inicial.' USING ERRCODE = '55000';
    END IF;
    RETURN examentech_private.vincular_execucao_tentativa(v_tentativa, p_chave_execucao);
END;
$$;

CREATE OR REPLACE FUNCTION public.iniciar_tentativa_com_fotos(
    p_avaliacao_id UUID, p_aviso_versao TEXT, p_fotos_aviso_versao TEXT, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa JSONB;
BEGIN
    IF p_aviso_versao IS DISTINCT FROM '2026-11-09-v5' THEN
        RAISE EXCEPTION 'Aviso do monitoramento da prova não confirmado.' USING ERRCODE = '23514';
    END IF;
    v_tentativa := public.iniciar_tentativa_com_fotos(p_avaliacao_id, p_aviso_versao, p_fotos_aviso_versao);
    IF EXISTS (SELECT 1 FROM public.avaliacoes WHERE id = p_avaliacao_id AND tipo <> 'PROVA') THEN
        RAISE EXCEPTION 'A coleta de fotografias é exclusiva das provas.' USING ERRCODE = '55000';
    END IF;
    RETURN examentech_private.vincular_execucao_tentativa(v_tentativa, p_chave_execucao);
END;
$$;

-- Mantém o histórico de tentativas anteriores sem coleta. As novas provas têm
-- um aviso de fotos no ciclo desde o início, antes de liberar a execução.
CREATE OR REPLACE FUNCTION examentech_private.exigir_foto_inicial(p_tentativa_id UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.tentativas te
        JOIN public.avisos_fotos_tentativa av ON av.tentativa_id = te.id AND av.ciclo = te.ciclo
        WHERE te.id = p_tentativa_id AND (av.revogado_em IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM public.fotos_tentativa f WHERE f.tentativa_id = te.id AND f.ciclo = te.ciclo
            AND f.momento = 'INICIAL' AND f.situacao = 'DISPONIVEL'
        ))
    ) THEN
        RAISE EXCEPTION 'Confirme o envio da foto inicial para realizar a prova.' USING ERRCODE = '55000';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.exigir_foto_inicial(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION examentech_private.consultar_conteudo_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.tentativa_do_aluno(p_tentativa_id);
    PERFORM examentech_private.exigir_foto_inicial(p_tentativa_id);
    RETURN examentech_private.consultar_conteudo_sem_fotos(p_tentativa_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_versao INTEGER,
    p_alternativa_id UUID, p_texto TEXT, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    PERFORM examentech_private.bloquear_avaliacao_da_tentativa(p_tentativa_id);
    PERFORM examentech_private.exigir_foto_inicial(p_tentativa_id);
    RETURN examentech_private.salvar_resposta_tentativa(p_tentativa_id, p_questao_id, p_versao, p_alternativa_id, p_texto);
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.gravar_encerramento_tentativa(
    p_tentativa_id UUID, p_motivo TEXT, p_encerrada_em TIMESTAMPTZ, p_usuario_id UUID
)
RETURNS public.tentativas LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_interrompida BOOLEAN := p_motivo IN ('SAIDA', 'ABA_OU_FOCO', 'TELA_CHEIA');
BEGIN
    UPDATE public.tentativas
    SET situacao = CASE WHEN v_interrompida THEN 'INTERROMPIDA' ELSE 'FINALIZADA' END,
        encerrada_em = p_encerrada_em
    WHERE id = p_tentativa_id AND situacao = 'EM_ANDAMENTO'
    RETURNING * INTO STRICT v_tentativa;

    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(), CASE WHEN v_interrompida THEN 'TENTATIVA_INTERROMPIDA' ELSE 'TENTATIVA_FINALIZADA' END,
        'EXAMENTECH', CASE p_motivo WHEN 'SAIDA' THEN 'saida_tentativa'
            WHEN 'ABA_OU_FOCO' THEN 'perda_aba_ou_foco' WHEN 'TELA_CHEIA' THEN 'saida_tela_cheia'
            WHEN 'PRAZO' THEN 'prazo_tentativa' ELSE 'finalizar_tentativa' END, TRUE, p_usuario_id, p_tentativa_id);
    RETURN v_tentativa;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.exigir_prova(p_avaliacao_id UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.avaliacoes WHERE id = p_avaliacao_id AND tipo = 'PROVA') THEN
        RAISE EXCEPTION 'Ocorrência exclusiva de prova.' USING ERRCODE = '23514';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.exigir_prova(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION examentech_private.encerrar_tentativa(p_tentativa_id UUID, p_motivo TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_agora TIMESTAMPTZ;
    v_saida BOOLEAN := p_motivo IN ('SAIDA', 'ABA_OU_FOCO', 'TELA_CHEIA');
BEGIN
    IF p_motivo IS NULL OR NOT (v_saida OR p_motivo IN ('ENVIO', 'PRAZO')) THEN
        RAISE EXCEPTION 'Motivo inválido.' USING ERRCODE = '23514';
    END IF;
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF p_motivo IN ('ABA_OU_FOCO', 'TELA_CHEIA') THEN
        PERFORM examentech_private.exigir_prova(v_tentativa.avaliacao_id);
    END IF;
    IF v_tentativa.situacao = 'EM_ANDAMENTO' THEN
        v_agora := clock_timestamp();
        IF (p_motivo = 'ENVIO' AND v_agora >= v_tentativa.limite_em)
           OR (p_motivo = 'PRAZO' AND v_agora < v_tentativa.limite_em) THEN
            RAISE EXCEPTION 'Operação fora do prazo da tentativa.' USING ERRCODE = '55000';
        END IF;
        IF p_motivo = 'ENVIO' THEN
            PERFORM examentech_private.exigir_foto_inicial(p_tentativa_id);
        ELSIF v_saida AND v_agora >= v_tentativa.limite_em THEN
            p_motivo := 'PRAZO';
        END IF;
        v_tentativa := examentech_private.gravar_encerramento_tentativa(v_tentativa.id, p_motivo,
            CASE WHEN p_motivo = 'PRAZO' THEN v_tentativa.limite_em ELSE v_agora END, auth.uid());
    ELSIF v_tentativa.situacao <> 'FINALIZADA' AND NOT v_saida THEN
        RAISE EXCEPTION 'Tentativa já encerrada.' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('id', v_tentativa.id, 'situacao', v_tentativa.situacao,
        'encerrada_em', v_tentativa.encerrada_em, 'falhas_camera', v_tentativa.falhas_camera);
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_falha_camera(
    p_tentativa_id UUID, p_solicitacao_id UUID, p_chave_execucao UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    PERFORM examentech_private.exigir_prova((
        SELECT avaliacao_id FROM public.tentativas WHERE id = p_tentativa_id AND aluno_id = auth.uid()
    ));
    RETURN examentech_private.registrar_falha_camera(p_tentativa_id, p_solicitacao_id);
END;
$$;

ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO','TURNSTILE_REJEITADO','TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO','LOGIN_SUCESSO','LOGIN_NEGADO','TURMA_CRIADA',
    'MATRICULA_SOLICITADA','MATRICULA_APROVADA','MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA','AVALIACAO_EDITADA','QUESTAO_CRIADA','ALTERNATIVAS_CRIADAS',
    'AVALIACAO_PUBLICADA','TENTATIVA_INICIADA','RESPOSTA_SALVA','TENTATIVA_FINALIZADA',
    'TENTATIVA_INTERROMPIDA','TENTATIVA_RETOMADA','CAMERA_FALHA','TENTATIVA_DESBLOQUEADA',
    'REATIVACAO_AUTORIZADA','TENTATIVAS_CONSULTADAS','FOTO_RECEBIDA','FOTO_CONSULTADA','FOTO_EXCLUIDA',
    'AVALIACAO_CANCELADA','CLIPBOARD_BLOQUEADO'
));

CREATE OR REPLACE FUNCTION public.registrar_bloqueio_clipboard(
    p_tentativa_id UUID, p_solicitacao_id UUID, p_chave_execucao UUID, p_operacao TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_evento public.eventos_seguranca%ROWTYPE;
    v_acao TEXT := CASE p_operacao WHEN 'copy' THEN 'copiar_bloqueado'
        WHEN 'cut' THEN 'recortar_bloqueado' WHEN 'paste' THEN 'colar_bloqueado' END;
BEGIN
    IF v_acao IS NULL OR p_solicitacao_id IS NULL THEN
        RAISE EXCEPTION 'Operação ou identificador da ocorrência inválido.' USING ERRCODE = '23514';
    END IF;
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO' OR clock_timestamp() >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
    END IF;
    PERFORM examentech_private.exigir_prova(v_tentativa.avaliacao_id);

    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (p_solicitacao_id, 'CLIPBOARD_BLOQUEADO', 'EXAMENTECH', v_acao, TRUE, auth.uid(), p_tentativa_id)
    ON CONFLICT (solicitacao_id) DO NOTHING;
    SELECT * INTO v_evento FROM public.eventos_seguranca WHERE solicitacao_id = p_solicitacao_id;
    IF NOT FOUND OR v_evento.evento IS DISTINCT FROM 'CLIPBOARD_BLOQUEADO'
       OR v_evento.usuario_id IS DISTINCT FROM auth.uid() OR v_evento.recurso_id IS DISTINCT FROM p_tentativa_id
       OR v_evento.acao IS DISTINCT FROM v_acao THEN
        RAISE EXCEPTION 'Identificador da ocorrência já utilizado.' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('tentativa_id', v_evento.recurso_id, 'solicitacao_id', v_evento.solicitacao_id,
        'registrado_em', v_evento.criado_em);
END;
$$;
REVOKE ALL ON FUNCTION public.registrar_bloqueio_clipboard(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_bloqueio_clipboard(UUID, UUID, UUID, TEXT) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
