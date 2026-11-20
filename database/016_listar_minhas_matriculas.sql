-- Aplicar depois de 015. Consulta do aluno, sem modificar matrículas.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.listar_minhas_matriculas()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.perfis p
        JOIN public.organizacoes o ON o.id = p.organizacao_id
        JOIN auth.sessions s ON s.user_id = p.id
        WHERE p.id = auth.uid() AND p.perfil = 'ALUNO'
          AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
          AND (auth.jwt() ->> 'aal') = 'aal2'
          AND s.id::TEXT = (auth.jwt() ->> 'session_id')
    ) THEN
        RAISE EXCEPTION 'Consulta exige aluno ativo, organização ativa, sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    -- Inclui vínculos inativos; retorna só a identificação da turma, nunca seu código.
    RETURN (
        SELECT COALESCE(jsonb_agg(matricula ORDER BY matricula.solicitado_em DESC, matricula.id DESC), '[]'::JSONB)
        FROM (
            SELECT m.id, m.turma_id, t.nome AS turma_nome, m.situacao, m.solicitado_em
            FROM public.turma_alunos m
            JOIN public.turmas t ON t.id = m.turma_id
            WHERE m.aluno_id = auth.uid()
              AND examentech_private.pode_consultar_matricula(m.turma_id, m.aluno_id)
            ORDER BY m.solicitado_em DESC, m.id DESC
            LIMIT 50
        ) matricula
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.listar_minhas_matriculas()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.listar_minhas_matriculas() $$;

REVOKE ALL ON FUNCTION examentech_private.listar_minhas_matriculas()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listar_minhas_matriculas()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.listar_minhas_matriculas() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_minhas_matriculas() TO authenticated;

COMMIT;
