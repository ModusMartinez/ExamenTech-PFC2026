-- Aplicar após 040. A 041 continua responsável pelos encerramentos por prazo.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.avaliacoes ADD COLUMN IF NOT EXISTS cancelada_em TIMESTAMPTZ;
ALTER TABLE public.avaliacoes DROP CONSTRAINT avaliacoes_situacao_check;
ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_situacao_check
    CHECK (situacao IN ('RASCUNHO', 'PUBLICADA', 'CANCELADA'));
ALTER TABLE public.avaliacoes DROP CONSTRAINT avaliacoes_publicacao_valida;
ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_publicacao_valida CHECK (
    (situacao = 'RASCUNHO' AND publicada_em IS NULL)
    OR (situacao IN ('PUBLICADA', 'CANCELADA') AND publicada_em IS NOT NULL AND isfinite(publicada_em))
);
ALTER TABLE public.avaliacoes DROP CONSTRAINT IF EXISTS avaliacoes_cancelamento_valido;
ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_cancelamento_valido CHECK (
    (situacao <> 'CANCELADA' AND cancelada_em IS NULL)
    OR (situacao = 'CANCELADA' AND cancelada_em IS NOT NULL AND isfinite(cancelada_em) AND cancelada_em >= publicada_em)
);

ALTER TABLE public.tentativas DROP CONSTRAINT tentativas_situacao_check;
ALTER TABLE public.tentativas ADD CONSTRAINT tentativas_situacao_check
    CHECK (situacao IN ('EM_ANDAMENTO', 'FINALIZADA', 'INTERROMPIDA', 'CANCELADA'));

ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO','TURNSTILE_REJEITADO','TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO','LOGIN_SUCESSO','LOGIN_NEGADO','TURMA_CRIADA',
    'MATRICULA_SOLICITADA','MATRICULA_APROVADA','MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA','AVALIACAO_EDITADA','QUESTAO_CRIADA','ALTERNATIVAS_CRIADAS',
    'AVALIACAO_PUBLICADA','TENTATIVA_INICIADA','RESPOSTA_SALVA','TENTATIVA_FINALIZADA',
    'TENTATIVA_INTERROMPIDA','TENTATIVA_RETOMADA','CAMERA_FALHA','TENTATIVA_DESBLOQUEADA',
    'REATIVACAO_AUTORIZADA','TENTATIVAS_CONSULTADAS','FOTO_RECEBIDA','FOTO_CONSULTADA','FOTO_EXCLUIDA',
    'AVALIACAO_CANCELADA'
));

-- Conteúdo e salvamento bloqueiam avaliação e tentativa. Adquirir primeiro o
-- lock da avaliação mantém a ordem usada pelo início e pelo cancelamento.
CREATE OR REPLACE FUNCTION examentech_private.bloquear_avaliacao_da_tentativa(p_tentativa_id UUID)
RETURNS VOID LANGUAGE sql SET search_path = '' AS $$
    SELECT FROM public.avaliacoes a
    JOIN public.tentativas te ON te.avaliacao_id = a.id
    WHERE te.id = p_tentativa_id AND te.aluno_id = auth.uid()
    FOR SHARE OF a;
$$;
REVOKE ALL ON FUNCTION examentech_private.bloquear_avaliacao_da_tentativa(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consultar_conteudo_tentativa(p_tentativa_id UUID, p_chave_execucao UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.verificar_execucao_tentativa(p_tentativa_id, p_chave_execucao);
    PERFORM examentech_private.bloquear_avaliacao_da_tentativa(p_tentativa_id);
    RETURN examentech_private.consultar_conteudo_tentativa(p_tentativa_id);
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
    RETURN examentech_private.salvar_resposta_tentativa(p_tentativa_id, p_questao_id, p_versao, p_alternativa_id, p_texto);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancelar_avaliacao(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_cancelada_em TIMESTAMPTZ;
BEGIN
    SELECT a.* INTO v_avaliacao FROM public.avaliacoes a
    JOIN public.perfis p ON p.id = a.professor_id AND p.perfil = 'PROFESSOR'
    WHERE a.id = p_avaliacao_id AND a.professor_id = auth.uid()
      AND examentech_private.responsavel_pode_gerir_avaliacao(a.id)
    FOR UPDATE OF a;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Somente o professor autor pode cancelar a avaliação.' USING ERRCODE = '42501';
    END IF;

    IF v_avaliacao.situacao = 'CANCELADA' THEN
        v_cancelada_em := v_avaliacao.cancelada_em;
    ELSE
        IF v_avaliacao.situacao <> 'PUBLICADA' OR EXISTS (
            SELECT 1 FROM examentech_private.resultados_publicados WHERE avaliacao_id = v_avaliacao.id
        ) THEN
            RAISE EXCEPTION 'A avaliação precisa estar publicada e sem resultados divulgados.' USING ERRCODE = '55000';
        END IF;

        v_cancelada_em := clock_timestamp();
        UPDATE public.avaliacoes SET situacao = 'CANCELADA', cancelada_em = v_cancelada_em
        WHERE id = v_avaliacao.id;

        -- Mantém as respostas e o histórico. Só as tentativas em curso mudam de estado.
        UPDATE public.tentativas SET situacao = 'CANCELADA', encerrada_em = v_cancelada_em
        WHERE avaliacao_id = v_avaliacao.id AND situacao = 'EM_ANDAMENTO';

        INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
        VALUES (gen_random_uuid(), 'AVALIACAO_CANCELADA', 'EXAMENTECH', 'cancelar_avaliacao', TRUE, auth.uid(), v_avaliacao.id);
    END IF;

    RETURN jsonb_build_object('id', v_avaliacao.id, 'situacao', 'CANCELADA', 'cancelada_em', v_cancelada_em);
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_avaliacao(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_avaliacao(UUID) TO authenticated;

-- O Realtime usa a RLS de tentativas. Nenhuma resposta ou chave de execução
-- é publicada nesse canal.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tentativas'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.tentativas;
    END IF;
END;
$$;

COMMIT;
