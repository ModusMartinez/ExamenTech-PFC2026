-- Aplicar depois de 026. Consulta para execução pelo aluno, sem gabarito.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.consultar_conteudo_tentativa(p_tentativa_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_aluno_id UUID := auth.uid();
    v_organizacao_id UUID;
    v_acesso RECORD;
    v_agora TIMESTAMPTZ;
    v_questoes JSONB;
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
        RAISE EXCEPTION 'Consulta exige aluno ativo, organização ativa, sessão e MFA.' USING ERRCODE = '42501';
    END IF;

    SELECT te.avaliacao_id, te.situacao AS tentativa_situacao, te.iniciada_em, te.limite_em,
           a.titulo, a.tipo, a.situacao AS avaliacao_situacao, a.inicio_em, a.fim_em,
           t.situacao AS turma_situacao
    INTO v_acesso
    FROM public.tentativas te
    JOIN public.avaliacoes a ON a.id = te.avaliacao_id
    JOIN public.turmas t ON t.id = a.turma_id
    JOIN public.turma_alunos m ON m.turma_id = t.id AND m.aluno_id = te.aluno_id
    WHERE te.id = p_tentativa_id AND te.aluno_id = v_aluno_id
      AND t.organizacao_id = v_organizacao_id AND m.situacao = 'ATIVA'
    FOR SHARE OF t, m, a, te;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tentativa não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;

    -- Consulta de execução tem regras mais restritas que a consulta histórica da 025.
    v_agora := clock_timestamp();
    IF v_acesso.tentativa_situacao <> 'EM_ANDAMENTO'
       OR v_acesso.avaliacao_situacao <> 'PUBLICADA' OR v_acesso.turma_situacao <> 'ATIVA'
       OR v_agora < v_acesso.iniciada_em OR v_agora < v_acesso.inicio_em
       OR v_agora >= LEAST(v_acesso.limite_em, v_acesso.fim_em) THEN
        RAISE EXCEPTION 'A tentativa não está disponível para realização.' USING ERRCODE = '55000';
    END IF;

    -- Projeção explícita: não retornar linhas inteiras das questões ou alternativas.
    SELECT jsonb_agg(jsonb_build_object(
        'id', q.id, 'tipo', q.tipo, 'enunciado', q.enunciado,
        'pontuacao', q.pontuacao, 'ordem', tq.ordem,
        'alternativas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', a.id, 'texto', a.texto, 'ordem', ta.ordem
            ) ORDER BY ta.ordem)
            FROM public.tentativa_alternativas ta
            JOIN public.alternativas a ON a.id = ta.alternativa_id AND a.questao_id = q.id
            WHERE ta.tentativa_id = p_tentativa_id AND ta.questao_id = q.id
              AND q.tipo = 'OBJETIVA'
        ), '[]'::JSONB)
    ) ORDER BY tq.ordem) INTO v_questoes
    FROM public.tentativa_questoes tq
    JOIN public.questoes q ON q.id = tq.questao_id AND q.avaliacao_id = v_acesso.avaliacao_id
    WHERE tq.tentativa_id = p_tentativa_id;

    IF v_questoes IS NULL THEN
        RAISE EXCEPTION 'A tentativa não possui conteúdo com ordem salva.' USING ERRCODE = '55000';
    END IF;

    RETURN jsonb_build_object(
        'tentativa_id', p_tentativa_id, 'avaliacao_id', v_acesso.avaliacao_id,
        'titulo', v_acesso.titulo, 'tipo', v_acesso.tipo,
        'iniciada_em', v_acesso.iniciada_em, 'limite_em', v_acesso.limite_em,
        'questoes', v_questoes
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_conteudo_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.consultar_conteudo_tentativa(p_tentativa_id) $$;

REVOKE ALL ON FUNCTION examentech_private.consultar_conteudo_tentativa(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consultar_conteudo_tentativa(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.consultar_conteudo_tentativa(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_conteudo_tentativa(UUID) TO authenticated;

COMMENT ON FUNCTION public.consultar_conteudo_tentativa(UUID) IS
    'Conteúdo da própria tentativa em andamento e dentro do prazo, com ordem salva e sem gabarito. Não altera tentativa, prazo ou auditoria.';

COMMIT;
