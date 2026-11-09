-- Aplicar depois de 014. Consulta restrita para a tela de aprovação.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.listar_matriculas_pendentes()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.perfis p
        JOIN auth.sessions s ON s.user_id = p.id
        WHERE p.id = auth.uid() AND p.perfil IN ('PROFESSOR', 'ADMIN')
          AND p.situacao = 'ATIVO' AND (auth.jwt() ->> 'aal') = 'aal2'
          AND s.id::TEXT = (auth.jwt() ->> 'session_id')
    ) THEN
        RAISE EXCEPTION 'Consulta exige professor ou administrador ativo, com sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    -- Não amplia a leitura de perfis: só identifica alunos dos vínculos autorizados.
    RETURN (
        SELECT COALESCE(jsonb_agg(pendente ORDER BY pendente.solicitado_em, pendente.id), '[]'::JSONB)
        FROM (
            SELECT m.id, m.turma_id, t.nome AS turma_nome,
                   m.aluno_id, p.nome AS aluno_nome, p.rgm AS aluno_rgm,
                   m.situacao, m.solicitado_em
            FROM public.turma_alunos m
            JOIN public.turmas t ON t.id = m.turma_id
            JOIN public.perfis p ON p.id = m.aluno_id
            WHERE m.situacao = 'PENDENTE'
              AND examentech_private.pode_consultar_turma(t.professor_id, t.organizacao_id)
            ORDER BY m.solicitado_em, m.id
            LIMIT 50
        ) pendente
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.listar_matriculas_pendentes()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.listar_matriculas_pendentes() $$;

REVOKE ALL ON FUNCTION examentech_private.listar_matriculas_pendentes()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listar_matriculas_pendentes()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.listar_matriculas_pendentes() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_matriculas_pendentes() TO authenticated;

COMMIT;
