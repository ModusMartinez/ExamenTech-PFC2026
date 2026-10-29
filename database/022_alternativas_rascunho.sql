-- Aplicar depois de 021. Cadastro do conjunto de alternativas e gabarito no rascunho.
BEGIN;

CREATE TABLE IF NOT EXISTS public.alternativas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    questao_id UUID NOT NULL REFERENCES public.questoes(id) ON DELETE RESTRICT,
    texto TEXT NOT NULL,
    ordem INTEGER NOT NULL CHECK (ordem BETWEEN 1 AND 5),
    correta BOOLEAN NOT NULL DEFAULT FALSE,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT alternativas_texto_valido CHECK (
        texto = btrim(texto) AND char_length(texto) BETWEEN 1 AND 2000
        AND texto ~ '[^[:space:]]'
    ),
    CONSTRAINT alternativas_ordem_unica UNIQUE (questao_id, ordem)
);

-- A função exige uma correta; o índice impede duas corretas para a mesma questão.
CREATE UNIQUE INDEX IF NOT EXISTS alternativas_uma_correta
ON public.alternativas (questao_id) WHERE correta;

ALTER TABLE public.alternativas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.alternativas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.alternativas TO authenticated;

DROP POLICY IF EXISTS alternativas_consultar ON public.alternativas;
CREATE POLICY alternativas_consultar ON public.alternativas
FOR SELECT TO authenticated
USING (EXISTS (
    SELECT 1 FROM public.questoes q
    JOIN public.avaliacoes a ON a.id = q.avaliacao_id
    WHERE q.id = alternativas.questao_id AND a.situacao = 'RASCUNHO'
));

ALTER TABLE public.eventos_seguranca
DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca
ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA', 'MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA', 'AVALIACAO_EDITADA', 'QUESTAO_CRIADA', 'ALTERNATIVAS_CRIADAS'
));

CREATE OR REPLACE FUNCTION examentech_private.criar_alternativas_rascunho(
    p_questao_id UUID, p_alternativas TEXT[], p_ordem_correta INTEGER
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
    v_resultado JSONB;
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
        RAISE EXCEPTION 'Criação de alternativas exige professor ativo, organização ativa, sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    SELECT t.* INTO v_turma FROM public.turmas t
    JOIN public.avaliacoes a ON a.turma_id = t.id
    JOIN public.questoes q ON q.avaliacao_id = a.id
    WHERE q.id = p_questao_id AND a.professor_id = v_professor_id
      AND t.professor_id = v_professor_id AND t.organizacao_id = v_organizacao_id
    FOR SHARE OF t;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Questão não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_turma.situacao <> 'ATIVA' THEN
        RAISE EXCEPTION 'A turma está inativa.' USING ERRCODE = '55000';
    END IF;

    -- Mesma ordem de locks da 021: avaliação antes da questão.
    SELECT a.* INTO v_avaliacao FROM public.avaliacoes a
    JOIN public.questoes q ON q.avaliacao_id = a.id
    WHERE q.id = p_questao_id AND a.turma_id = v_turma.id AND a.professor_id = v_professor_id
    FOR UPDATE OF a;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Questão não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_avaliacao.situacao <> 'RASCUNHO' THEN
        RAISE EXCEPTION 'Somente avaliações em rascunho podem receber alternativas.' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO v_questao FROM public.questoes
    WHERE id = p_questao_id AND avaliacao_id = v_avaliacao.id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Questão não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_questao.tipo <> 'OBJETIVA' THEN
        RAISE EXCEPTION 'Somente questões objetivas podem receber alternativas.' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.alternativas WHERE questao_id = v_questao.id) THEN
        RAISE EXCEPTION 'A questão já possui alternativas.' USING ERRCODE = '55000';
    END IF;

    IF p_alternativas IS NULL OR cardinality(p_alternativas) NOT BETWEEN 2 AND 5
       OR array_ndims(p_alternativas) <> 1 OR array_lower(p_alternativas, 1) <> 1 THEN
        RAISE EXCEPTION 'Informe de 2 a 5 alternativas em uma lista simples.' USING ERRCODE = '23514';
    END IF;
    IF p_ordem_correta IS NULL OR p_ordem_correta NOT BETWEEN 1 AND cardinality(p_alternativas) THEN
        RAISE EXCEPTION 'Selecione uma alternativa correta da lista.' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(DISTINCT btrim(texto)) FROM unnest(p_alternativas) AS item(texto))
       <> cardinality(p_alternativas) THEN
        RAISE EXCEPTION 'As alternativas devem ter textos distintos e não nulos.' USING ERRCODE = '23514';
    END IF;

    FOR v_ordem IN 1..cardinality(p_alternativas) LOOP
        INSERT INTO public.alternativas (questao_id, texto, ordem, correta)
        VALUES (v_questao.id, btrim(p_alternativas[v_ordem]), v_ordem, v_ordem = p_ordem_correta);
    END LOOP;

    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'ALTERNATIVAS_CRIADAS', 'EXAMENTECH', 'criar_alternativas_rascunho',
        TRUE, v_professor_id, v_questao.id
    );

    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.ordem) INTO v_resultado
    FROM public.alternativas a WHERE a.questao_id = v_questao.id;
    RETURN v_resultado;
END;
$$;

CREATE OR REPLACE FUNCTION public.criar_alternativas_rascunho(
    p_questao_id UUID, p_alternativas TEXT[], p_ordem_correta INTEGER
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.criar_alternativas_rascunho(
    p_questao_id, p_alternativas, p_ordem_correta
) $$;

REVOKE ALL ON FUNCTION examentech_private.criar_alternativas_rascunho(UUID, TEXT[], INTEGER)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.criar_alternativas_rascunho(UUID, TEXT[], INTEGER)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.criar_alternativas_rascunho(UUID, TEXT[], INTEGER)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.criar_alternativas_rascunho(UUID, TEXT[], INTEGER)
TO authenticated;

COMMENT ON TABLE public.alternativas IS
    'Alternativas e gabarito do rascunho, somente para autor ou ADMIN. O acesso futuro do aluno deve omitir correta no servidor.';

COMMIT;
