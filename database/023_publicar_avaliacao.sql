-- Aplicar depois de 022. Publicação da avaliação; execução pelo aluno fica para outro bloco.
BEGIN;

ALTER TABLE public.avaliacoes ADD COLUMN IF NOT EXISTS publicada_em TIMESTAMPTZ;
ALTER TABLE public.avaliacoes DROP CONSTRAINT IF EXISTS avaliacoes_situacao_check;
ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_situacao_check
CHECK (situacao IN ('RASCUNHO', 'PUBLICADA'));
ALTER TABLE public.avaliacoes DROP CONSTRAINT IF EXISTS avaliacoes_publicacao_valida;
ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_publicacao_valida CHECK (
    (situacao = 'RASCUNHO' AND publicada_em IS NULL)
    OR (situacao = 'PUBLICADA' AND publicada_em IS NOT NULL AND isfinite(publicada_em))
);

ALTER TABLE public.eventos_seguranca DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA', 'MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA', 'AVALIACAO_EDITADA', 'QUESTAO_CRIADA', 'ALTERNATIVAS_CRIADAS',
    'AVALIACAO_PUBLICADA'
));

CREATE OR REPLACE FUNCTION examentech_private.publicar_avaliacao(p_avaliacao_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_professor_id UUID := auth.uid();
    v_organizacao_id UUID;
    v_turma public.turmas%ROWTYPE;
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_publicada_em TIMESTAMPTZ;
BEGIN
    SELECT p.organizacao_id INTO v_organizacao_id
    FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    JOIN auth.sessions s ON s.user_id = p.id
    WHERE p.id = v_professor_id AND p.perfil = 'PROFESSOR'
      AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
      AND (auth.jwt() ->> 'aal') = 'aal2'
      AND s.id::TEXT = (auth.jwt() ->> 'session_id')
    FOR SHARE OF p, o, s;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Publicação exige professor ativo, organização ativa, sessão e MFA.' USING ERRCODE = '42501';
    END IF;

    SELECT t.* INTO v_turma FROM public.turmas t
    JOIN public.avaliacoes a ON a.turma_id = t.id
    WHERE a.id = p_avaliacao_id AND a.professor_id = v_professor_id
      AND t.professor_id = v_professor_id AND t.organizacao_id = v_organizacao_id
    FOR SHARE OF t;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_turma.situacao <> 'ATIVA' THEN
        RAISE EXCEPTION 'A turma está inativa.' USING ERRCODE = '55000';
    END IF;

    -- Mesmo lock usado na edição e na criação de questões/alternativas (020–022).
    -- Essas operações aguardam a publicação e depois recusam a situação PUBLICADA.
    SELECT * INTO v_avaliacao FROM public.avaliacoes
    WHERE id = p_avaliacao_id AND turma_id = v_turma.id AND professor_id = v_professor_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_avaliacao.situacao <> 'RASCUNHO' THEN
        RAISE EXCEPTION 'Somente avaliações em rascunho podem ser publicadas.' USING ERRCODE = '55000';
    END IF;

    -- Consulta o relógio após esperar pelo lock; não usa o início da transação.
    v_publicada_em := clock_timestamp();
    IF v_avaliacao.fim_em <= v_publicada_em
       OR make_interval(mins => v_avaliacao.duracao_minutos) > v_avaliacao.fim_em - v_avaliacao.inicio_em THEN
        RAISE EXCEPTION 'A janela deve estar aberta ou no futuro, e comportar a duração.' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.questoes WHERE avaliacao_id = v_avaliacao.id) THEN
        RAISE EXCEPTION 'Cadastre pelo menos uma questão antes de publicar.' USING ERRCODE = '23514';
    END IF;

    -- Pontuação e campos básicos já são garantidos pelas constraints de 019–022.
    IF EXISTS (
        SELECT 1 FROM public.questoes q
        LEFT JOIN public.alternativas a ON a.questao_id = q.id
        WHERE q.avaliacao_id = v_avaliacao.id
        GROUP BY q.id, q.tipo
        HAVING (q.tipo = 'OBJETIVA' AND (
            count(a.id) NOT BETWEEN 2 AND 5 OR count(a.id) FILTER (WHERE a.correta) <> 1
            OR count(DISTINCT a.texto) <> count(a.id)
            OR min(a.ordem) <> 1 OR max(a.ordem) <> count(a.id)
        )) OR (q.tipo = 'DISSERTATIVA' AND count(a.id) <> 0)
    ) THEN
        RAISE EXCEPTION 'Confira as alternativas: de 2 a 5 distintas e uma correta por questão objetiva; dissertativas sem alternativas.'
            USING ERRCODE = '23514';
    END IF;

    UPDATE public.avaliacoes SET situacao = 'PUBLICADA', publicada_em = v_publicada_em
    WHERE id = v_avaliacao.id;

    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'AVALIACAO_PUBLICADA', 'EXAMENTECH', 'publicar_avaliacao',
        TRUE, v_professor_id, v_avaliacao.id
    );

    RETURN jsonb_build_object('id', v_avaliacao.id, 'situacao', 'PUBLICADA', 'publicada_em', v_publicada_em);
END;
$$;

CREATE OR REPLACE FUNCTION public.publicar_avaliacao(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.publicar_avaliacao(p_avaliacao_id) $$;

REVOKE ALL ON FUNCTION examentech_private.publicar_avaliacao(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publicar_avaliacao(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.publicar_avaliacao(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publicar_avaliacao(UUID) TO authenticated;

COMMENT ON TABLE public.avaliacoes IS
    'Avaliação da turma inteira. Professor autor publica por função. Estrutura editável apenas em RASCUNHO; escrita direta e exclusão bloqueadas.';

COMMIT;
