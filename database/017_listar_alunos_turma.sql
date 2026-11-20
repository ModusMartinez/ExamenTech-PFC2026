-- Aplicar depois de 016. Consulta de matrículas ativas, sem alterar vínculos.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.listar_alunos_turma(p_turma_id UUID, p_pagina INTEGER DEFAULT 0)
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

    IF p_turma_id IS NULL OR p_pagina IS NULL OR p_pagina < 0 OR p_pagina > 1000000 THEN
        RAISE EXCEPTION 'Turma ou página inválida.' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.turmas t WHERE t.id = p_turma_id
          AND examentech_private.pode_consultar_turma(t.professor_id, t.organizacao_id)
    ) THEN
        RAISE EXCEPTION 'Turma não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;

    -- Um registro extra indica próxima página. Não libera leitura geral de perfis.
    RETURN (
        SELECT COALESCE(jsonb_agg(aluno ORDER BY aluno.aluno_nome, aluno.id), '[]'::JSONB)
        FROM (
            SELECT m.id, p.nome AS aluno_nome, p.rgm AS aluno_rgm
            FROM public.turma_alunos m
            JOIN public.perfis p ON p.id = m.aluno_id
            WHERE m.turma_id = p_turma_id AND m.situacao = 'ATIVA'
            ORDER BY p.nome, m.id
            LIMIT 51 OFFSET (p_pagina * 50)
        ) aluno
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.listar_alunos_turma(p_turma_id UUID, p_pagina INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.listar_alunos_turma(p_turma_id, p_pagina) $$;

REVOKE ALL ON FUNCTION examentech_private.listar_alunos_turma(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listar_alunos_turma(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.listar_alunos_turma(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_alunos_turma(UUID, INTEGER) TO authenticated;

COMMIT;
