-- Base de RF12–RF16. Aplicar depois de 018; não publica avaliações.
BEGIN;

CREATE TABLE IF NOT EXISTS public.avaliacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turma_id UUID NOT NULL REFERENCES public.turmas(id) ON DELETE RESTRICT,
    professor_id UUID NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT,
    titulo TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('PROVA', 'ATIVIDADE')),
    inicio_em TIMESTAMPTZ NOT NULL,
    fim_em TIMESTAMPTZ NOT NULL,
    duracao_minutos INTEGER NOT NULL CHECK (duracao_minutos > 0),
    situacao TEXT NOT NULL DEFAULT 'RASCUNHO' CHECK (situacao = 'RASCUNHO'),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT avaliacoes_titulo_valido CHECK (
        titulo = btrim(titulo) AND char_length(titulo) BETWEEN 3 AND 150
        AND titulo ~ '[^[:space:]]'
    ),
    CONSTRAINT avaliacoes_janela_valida CHECK (
        isfinite(inicio_em) AND isfinite(fim_em) AND fim_em > inicio_em
    )
);

CREATE INDEX IF NOT EXISTS avaliacoes_turma_idx ON public.avaliacoes (turma_id);
CREATE INDEX IF NOT EXISTS avaliacoes_professor_idx ON public.avaliacoes (professor_id);

ALTER TABLE public.avaliacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avaliacoes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.avaliacoes TO authenticated;

-- A RLS de turmas confere o responsável atual. O helper confere também o autor.
-- ADMIN mantém a consulta institucional; aluno não lê rascunhos nem se matriculado.
DROP POLICY IF EXISTS avaliacoes_consultar ON public.avaliacoes;
CREATE POLICY avaliacoes_consultar ON public.avaliacoes
FOR SELECT TO authenticated
USING (EXISTS (
    SELECT 1 FROM public.turmas t
    WHERE t.id = avaliacoes.turma_id
      AND examentech_private.pode_consultar_turma(avaliacoes.professor_id, t.organizacao_id)
));

ALTER TABLE public.eventos_seguranca
DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca
ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA', 'MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA'
));

CREATE OR REPLACE FUNCTION examentech_private.criar_avaliacao_rascunho(
    p_turma_id UUID, p_titulo TEXT, p_tipo TEXT,
    p_inicio_em TIMESTAMPTZ, p_fim_em TIMESTAMPTZ, p_duracao_minutos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_professor_id UUID := auth.uid();
    v_organizacao_id UUID;
    v_turma public.turmas%ROWTYPE;
    v_avaliacao public.avaliacoes%ROWTYPE;
BEGIN
    -- Mantém perfil, organização e sessão válidos até concluir a gravação.
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
        RAISE EXCEPTION 'Criação exige professor ativo, organização ativa, sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turma FROM public.turmas
    WHERE id = p_turma_id AND professor_id = v_professor_id
      AND organizacao_id = v_organizacao_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Turma não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_turma.situacao <> 'ATIVA' THEN
        RAISE EXCEPTION 'A turma está inativa.' USING ERRCODE = '55000';
    END IF;

    -- Autor e situação não são recebidos do cliente. Constraints validam os campos.
    INSERT INTO public.avaliacoes (
        turma_id, professor_id, titulo, tipo, inicio_em, fim_em, duracao_minutos
    ) VALUES (
        v_turma.id, v_professor_id, btrim(p_titulo), p_tipo,
        p_inicio_em, p_fim_em, p_duracao_minutos
    ) RETURNING * INTO v_avaliacao;

    -- Auditoria e rascunho são atômicos; não grava título, código ou dados do aluno.
    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'AVALIACAO_CRIADA', 'EXAMENTECH',
        'criar_avaliacao_rascunho', TRUE, v_professor_id, v_avaliacao.id
    );

    RETURN to_jsonb(v_avaliacao);
END;
$$;

CREATE OR REPLACE FUNCTION public.criar_avaliacao_rascunho(
    p_turma_id UUID, p_titulo TEXT, p_tipo TEXT,
    p_inicio_em TIMESTAMPTZ, p_fim_em TIMESTAMPTZ, p_duracao_minutos INTEGER
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.criar_avaliacao_rascunho(
    p_turma_id, p_titulo, p_tipo, p_inicio_em, p_fim_em, p_duracao_minutos
) $$;

REVOKE ALL ON FUNCTION examentech_private.criar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.criar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.criar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.criar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
TO authenticated;

COMMENT ON TABLE public.avaliacoes IS
    'Avaliação da turma inteira. Criação em RASCUNHO por função; sem edição, publicação ou exclusão nesta etapa.';

COMMIT;
