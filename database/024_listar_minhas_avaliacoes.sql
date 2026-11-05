BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.listar_minhas_avaliacoes()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_organizacao_id UUID;
BEGIN
    SELECT p.organizacao_id INTO v_organizacao_id
    FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    JOIN auth.sessions s ON s.user_id = p.id
    WHERE p.id = auth.uid() AND p.perfil = 'ALUNO'
      AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
      AND (auth.jwt() ->> 'aal') = 'aal2'
      AND s.id::TEXT = (auth.jwt() ->> 'session_id');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Consulta exige aluno ativo, organização ativa, sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    -- Projeção limitada: a consulta não libera questões nem gabarito ao aluno.
    RETURN (
        SELECT COALESCE(jsonb_agg(avaliacao ORDER BY avaliacao.publicada_em DESC, avaliacao.id DESC), '[]'::JSONB)
        FROM (
            SELECT a.id, a.turma_id, t.nome AS turma_nome, a.titulo, a.tipo,
                   a.inicio_em, a.fim_em, a.duracao_minutos, a.situacao, a.publicada_em
            FROM public.avaliacoes a
            JOIN public.turmas t ON t.id = a.turma_id
            JOIN public.turma_alunos m ON m.turma_id = t.id
            WHERE m.aluno_id = auth.uid() AND m.situacao = 'ATIVA'
              AND t.situacao = 'ATIVA' AND t.organizacao_id = v_organizacao_id
              AND a.situacao = 'PUBLICADA'
            ORDER BY a.publicada_em DESC, a.id DESC
            LIMIT 50
        ) avaliacao
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.listar_minhas_avaliacoes()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.listar_minhas_avaliacoes() $$;

REVOKE ALL ON FUNCTION examentech_private.listar_minhas_avaliacoes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listar_minhas_avaliacoes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.listar_minhas_avaliacoes() TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_minhas_avaliacoes() TO authenticated;

COMMIT;
