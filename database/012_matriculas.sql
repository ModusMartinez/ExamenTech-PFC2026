-- Base das matrículas de RF07–RF11. Aplicar depois de 011.
-- Solicitação, aprovação e alterações de situação serão liberadas em etapas próprias.
BEGIN;

CREATE TABLE IF NOT EXISTS public.turma_alunos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turma_id UUID NOT NULL REFERENCES public.turmas(id) ON DELETE RESTRICT,
    aluno_id UUID NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT,
    situacao TEXT NOT NULL DEFAULT 'PENDENTE',
    solicitado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT turma_alunos_vinculo_unico UNIQUE (turma_id, aluno_id),
    CONSTRAINT turma_alunos_situacao_valida
        CHECK (situacao IN ('PENDENTE', 'ATIVA', 'INATIVA'))
);

CREATE INDEX IF NOT EXISTS turma_alunos_aluno_idx ON public.turma_alunos (aluno_id);

ALTER TABLE public.turma_alunos ENABLE ROW LEVEL SECURITY;
-- Nenhum perfil pode criar, aprovar ou apagar vínculos diretamente pela Data API.
REVOKE ALL ON public.turma_alunos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.turma_alunos TO authenticated;

CREATE OR REPLACE FUNCTION examentech_private.pode_consultar_matricula(
    p_turma_id UUID, p_aluno_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.turmas t
        WHERE t.id = p_turma_id
          AND (
              -- Reutiliza as regras de professor responsável/ADMIN, sessão e MFA.
              examentech_private.pode_consultar_turma(t.professor_id, t.organizacao_id)
              OR (
                  p_aluno_id = auth.uid()
                  AND (auth.jwt() ->> 'aal') = 'aal2'
                  AND EXISTS (
                      SELECT 1 FROM auth.sessions s
                      WHERE s.id::TEXT = (auth.jwt() ->> 'session_id')
                        AND s.user_id = auth.uid()
                  )
                  AND EXISTS (
                      SELECT 1 FROM public.perfis p
                      JOIN public.organizacoes o ON o.id = p.organizacao_id
                      WHERE p.id = auth.uid() AND p.perfil = 'ALUNO'
                        AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
                        AND p.organizacao_id = t.organizacao_id
                  )
              )
          )
    );
$$;

REVOKE ALL ON FUNCTION examentech_private.pode_consultar_matricula(UUID, UUID)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.pode_consultar_matricula(UUID, UUID)
TO authenticated;

DROP POLICY IF EXISTS matriculas_consultar ON public.turma_alunos;
CREATE POLICY matriculas_consultar ON public.turma_alunos
FOR SELECT TO authenticated
USING (examentech_private.pode_consultar_matricula(turma_id, aluno_id));

COMMENT ON TABLE public.turma_alunos IS
    'Vínculo único aluno/turma. Inativação preserva o registro; sem escrita pela aplicação nesta etapa.';

COMMIT;
