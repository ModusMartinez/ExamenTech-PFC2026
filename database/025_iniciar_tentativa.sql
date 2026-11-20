-- Aplicar depois de 024. Base do início de tentativa; não libera questões ou respostas.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tentativas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    avaliacao_id UUID NOT NULL REFERENCES public.avaliacoes(id) ON DELETE RESTRICT,
    aluno_id UUID NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT,
    situacao TEXT NOT NULL DEFAULT 'EM_ANDAMENTO' CHECK (situacao = 'EM_ANDAMENTO'),
    iniciada_em TIMESTAMPTZ NOT NULL,
    limite_em TIMESTAMPTZ NOT NULL,
    CONSTRAINT tentativas_aluno_avaliacao_unica UNIQUE (avaliacao_id, aluno_id),
    CONSTRAINT tentativas_prazo_valido CHECK (
        isfinite(iniciada_em) AND isfinite(limite_em) AND limite_em > iniciada_em
    )
);

CREATE INDEX IF NOT EXISTS tentativas_aluno_idx ON public.tentativas (aluno_id);
ALTER TABLE public.tentativas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tentativas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tentativas TO authenticated;

CREATE OR REPLACE FUNCTION examentech_private.pode_consultar_tentativa(p_avaliacao_id UUID, p_aluno_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.avaliacoes a
        JOIN public.turmas t ON t.id = a.turma_id
        JOIN public.turma_alunos m ON m.turma_id = t.id AND m.aluno_id = p_aluno_id
        WHERE a.id = p_avaliacao_id
          AND examentech_private.pode_consultar_matricula(t.id, p_aluno_id)
          AND (p_aluno_id = auth.uid()
               OR examentech_private.pode_consultar_turma(a.professor_id, t.organizacao_id))
    );
$$;

REVOKE ALL ON FUNCTION examentech_private.pode_consultar_tentativa(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.pode_consultar_tentativa(UUID, UUID) TO authenticated;

-- Consulta dos metadados preservada após inativação do vínculo; não autoriza execução.
DROP POLICY IF EXISTS tentativas_consultar ON public.tentativas;
CREATE POLICY tentativas_consultar ON public.tentativas FOR SELECT TO authenticated
USING (examentech_private.pode_consultar_tentativa(avaliacao_id, aluno_id));

ALTER TABLE public.eventos_seguranca DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA', 'MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA', 'AVALIACAO_EDITADA', 'QUESTAO_CRIADA', 'ALTERNATIVAS_CRIADAS',
    'AVALIACAO_PUBLICADA', 'TENTATIVA_INICIADA',
    -- Eventos já encontrados no banco de testes; preservar o histórico não habilita retomada.
    'RESPOSTA_SALVA', 'TENTATIVA_FINALIZADA', 'TENTATIVA_RETOMADA'
));

CREATE OR REPLACE FUNCTION examentech_private.iniciar_tentativa(p_avaliacao_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_aluno_id UUID := auth.uid();
    v_organizacao_id UUID;
    v_turma public.turmas%ROWTYPE;
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_tentativa public.tentativas%ROWTYPE;
    v_iniciada_em TIMESTAMPTZ;
BEGIN
    SELECT p.organizacao_id INTO v_organizacao_id
    FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    JOIN auth.sessions s ON s.user_id = p.id
    WHERE p.id = v_aluno_id AND p.perfil = 'ALUNO'
      AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
      AND (auth.jwt() ->> 'aal') = 'aal2'
      AND s.id::TEXT = (auth.jwt() ->> 'session_id')
    FOR SHARE OF p, o, s;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Início exige aluno ativo, organização ativa, sessão e MFA.' USING ERRCODE = '42501';
    END IF;

    SELECT t.* INTO v_turma FROM public.turmas t
    JOIN public.avaliacoes a ON a.turma_id = t.id
    WHERE a.id = p_avaliacao_id AND t.organizacao_id = v_organizacao_id
    FOR SHARE OF t;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;

    -- Impede que a matrícula seja inativada entre a validação e a gravação.
    PERFORM 1 FROM public.turma_alunos
    WHERE turma_id = v_turma.id AND aluno_id = v_aluno_id AND situacao = 'ATIVA'
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_avaliacao FROM public.avaliacoes
    WHERE id = p_avaliacao_id AND turma_id = v_turma.id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_turma.situacao <> 'ATIVA' OR v_avaliacao.situacao <> 'PUBLICADA' THEN
        RAISE EXCEPTION 'Início exige turma ativa e avaliação publicada.' USING ERRCODE = '55000';
    END IF;

    -- Usa o relógio do banco depois de possíveis esperas pelos locks.
    v_iniciada_em := clock_timestamp();
    IF v_iniciada_em < v_avaliacao.inicio_em OR v_iniciada_em >= v_avaliacao.fim_em THEN
        RAISE EXCEPTION 'A avaliação está fora do horário de realização.' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.tentativas (avaliacao_id, aluno_id, iniciada_em, limite_em)
    VALUES (
        v_avaliacao.id, v_aluno_id, v_iniciada_em,
        LEAST(v_avaliacao.fim_em, v_iniciada_em + make_interval(mins => v_avaliacao.duracao_minutos))
    )
    ON CONFLICT (avaliacao_id, aluno_id) DO NOTHING
    RETURNING * INTO v_tentativa;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Já existe uma tentativa nesta avaliação. Não é permitido reiniciar.' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'TENTATIVA_INICIADA', 'EXAMENTECH', 'iniciar_tentativa',
        TRUE, v_aluno_id, v_tentativa.id
    );

    RETURN to_jsonb(v_tentativa);
END;
$$;

CREATE OR REPLACE FUNCTION public.iniciar_tentativa(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.iniciar_tentativa(p_avaliacao_id) $$;

REVOKE ALL ON FUNCTION examentech_private.iniciar_tentativa(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.iniciar_tentativa(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.iniciar_tentativa(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.iniciar_tentativa(UUID) TO authenticated;

COMMENT ON TABLE public.tentativas IS
    'Tentativa única por aluno e avaliação. Início e prazo definidos pelo banco, com auditoria atômica. Sem escrita direta ou reabertura.';

COMMIT;
