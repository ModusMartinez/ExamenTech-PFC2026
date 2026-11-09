-- Aplicar depois de 020. Questões do rascunho; alternativas e gabarito ficam para outro bloco.
BEGIN;

CREATE TABLE IF NOT EXISTS public.questoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    avaliacao_id UUID NOT NULL REFERENCES public.avaliacoes(id) ON DELETE RESTRICT,
    tipo TEXT NOT NULL CHECK (tipo IN ('OBJETIVA', 'DISSERTATIVA')),
    enunciado TEXT NOT NULL,
    pontuacao NUMERIC NOT NULL,
    ordem INTEGER NOT NULL CHECK (ordem > 0),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT questoes_enunciado_valido CHECK (
        enunciado = btrim(enunciado) AND char_length(enunciado) BETWEEN 3 AND 10000
        AND enunciado ~ '[^[:space:]]'
    ),
    -- NUMERIC sem escala fixa evita arredondar antes de validar as casas decimais.
    CONSTRAINT questoes_pontuacao_valida CHECK (
        pontuacao > 0 AND pontuacao <= 9999.99 AND pontuacao = trunc(pontuacao, 2)
    ),
    CONSTRAINT questoes_ordem_unica UNIQUE (avaliacao_id, ordem)
);

ALTER TABLE public.questoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.questoes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.questoes TO authenticated;

-- Herda a RLS da avaliação: autor ainda responsável ou ADMIN, ambos com sessão e MFA.
DROP POLICY IF EXISTS questoes_consultar ON public.questoes;
CREATE POLICY questoes_consultar ON public.questoes
FOR SELECT TO authenticated
USING (EXISTS (
    SELECT 1 FROM public.avaliacoes a
    WHERE a.id = questoes.avaliacao_id AND a.situacao = 'RASCUNHO'
));

ALTER TABLE public.eventos_seguranca
DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca
ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA', 'MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA', 'AVALIACAO_EDITADA', 'QUESTAO_CRIADA'
));

CREATE OR REPLACE FUNCTION examentech_private.criar_questao_rascunho(
    p_avaliacao_id UUID, p_tipo TEXT, p_enunciado TEXT, p_pontuacao NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_professor_id UUID := auth.uid();
    v_organizacao_id UUID;
    v_turma public.turmas%ROWTYPE;
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_questao public.questoes%ROWTYPE;
    v_ordem INTEGER;
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
        RAISE EXCEPTION 'Criação de questão exige professor ativo, organização ativa, sessão e MFA.'
            USING ERRCODE = '42501';
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

    -- Serializa criações na mesma avaliação antes de conferir a situação e calcular a ordem.
    SELECT * INTO v_avaliacao FROM public.avaliacoes
    WHERE id = p_avaliacao_id AND turma_id = v_turma.id AND professor_id = v_professor_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_avaliacao.situacao <> 'RASCUNHO' THEN
        RAISE EXCEPTION 'Somente avaliações em rascunho podem receber questões.' USING ERRCODE = '55000';
    END IF;

    SELECT coalesce(max(ordem), 0) + 1 INTO v_ordem
    FROM public.questoes WHERE avaliacao_id = v_avaliacao.id;

    INSERT INTO public.questoes (avaliacao_id, tipo, enunciado, pontuacao, ordem)
    VALUES (v_avaliacao.id, p_tipo, btrim(p_enunciado), p_pontuacao, v_ordem)
    RETURNING * INTO v_questao;

    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'QUESTAO_CRIADA', 'EXAMENTECH', 'criar_questao_rascunho',
        TRUE, v_professor_id, v_questao.id
    );

    RETURN to_jsonb(v_questao);
END;
$$;

CREATE OR REPLACE FUNCTION public.criar_questao_rascunho(
    p_avaliacao_id UUID, p_tipo TEXT, p_enunciado TEXT, p_pontuacao NUMERIC
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.criar_questao_rascunho(
    p_avaliacao_id, p_tipo, p_enunciado, p_pontuacao
) $$;

REVOKE ALL ON FUNCTION examentech_private.criar_questao_rascunho(UUID, TEXT, TEXT, NUMERIC)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.criar_questao_rascunho(UUID, TEXT, TEXT, NUMERIC)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.criar_questao_rascunho(UUID, TEXT, TEXT, NUMERIC)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.criar_questao_rascunho(UUID, TEXT, TEXT, NUMERIC)
TO authenticated;

COMMENT ON TABLE public.questoes IS
    'Questões da avaliação, sem banco reutilizável. Criação em rascunho por função; edição, exclusão e escrita direta bloqueadas.';

COMMIT;
