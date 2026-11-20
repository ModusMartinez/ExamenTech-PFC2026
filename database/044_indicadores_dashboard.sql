-- Indicadores reais dos painéis, calculados no banco e limitados ao escopo do perfil.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.consultar_indicadores_dashboard()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_perfil TEXT;
    v_org UUID;
    v_usuario UUID := auth.uid();
    v_situacao_perfil TEXT;
    v_situacao_org TEXT;
    v_session_id TEXT := auth.jwt() ->> 'session_id';
   v_aal TEXT := auth.jwt() ->> 'aal';
    v_cards JSONB;
    v_chart JSONB;
    v_chart_turmas JSONB;
    v_titulo TEXT;
BEGIN
    SELECT p.perfil, p.organizacao_id, p.situacao, o.situacao
      INTO v_perfil, v_org, v_situacao_perfil, v_situacao_org
    FROM public.perfis p
    LEFT JOIN public.organizacoes o ON o.id = p.organizacao_id
    WHERE p.id = v_usuario;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Dashboard: perfil do usuário não encontrado.' USING ERRCODE = '42501';
    END IF;
    IF v_situacao_perfil IS DISTINCT FROM 'ATIVO' THEN
        RAISE EXCEPTION 'Dashboard: perfil do usuário não está ativo.' USING ERRCODE = '42501';
    END IF;
    IF v_aal IS DISTINCT FROM 'aal2' THEN
        RAISE EXCEPTION 'Dashboard: a sessão atual não confirmou MFA (AAL2). Saia e entre novamente.' USING ERRCODE = '42501';
    END IF;
    IF v_session_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM auth.sessions s
        WHERE s.user_id = v_usuario AND s.id::TEXT = v_session_id
    ) THEN
        RAISE EXCEPTION 'Dashboard: a sessão atual não foi localizada no Supabase Auth. Entre novamente.' USING ERRCODE = '42501';
    END IF;

    IF v_perfil = 'ADMIN' THEN
        SELECT jsonb_build_array(
            jsonb_build_object('rotulo','Usuários ativos','valor',count(*) FILTER (WHERE situacao='ATIVO')),
            jsonb_build_object('rotulo','Professores ativos','valor',count(*) FILTER (WHERE perfil='PROFESSOR' AND situacao='ATIVO')),
            jsonb_build_object('rotulo','Alunos ativos','valor',count(*) FILTER (WHERE perfil='ALUNO' AND situacao='ATIVO')),
            jsonb_build_object('rotulo','Turmas ativas','valor',(SELECT count(*) FROM public.turmas WHERE situacao='ATIVA'))
        ) INTO v_cards FROM public.perfis;
        SELECT jsonb_agg(jsonb_build_object('rotulo',perfil,'valor',total) ORDER BY perfil)
        INTO v_chart FROM (
            SELECT CASE perfil WHEN 'ADMIN' THEN 'Administradores' WHEN 'PROFESSOR' THEN 'Professores' ELSE 'Alunos' END perfil,
                   count(*) total FROM public.perfis WHERE situacao='ATIVO' GROUP BY perfil
        ) x;
        SELECT coalesce(jsonb_agg(
            jsonb_build_object(
                'rotulo', concat_ws(' · ', o.nome, t.nome),
                'valor', coalesce(m.total, 0)
            ) ORDER BY o.nome, t.nome, t.id
        ), '[]'::jsonb)
        INTO v_chart_turmas
        FROM public.turmas t
        JOIN public.organizacoes o ON o.id = t.organizacao_id
        LEFT JOIN LATERAL (
            SELECT count(*) AS total FROM public.turma_alunos ta
            WHERE ta.turma_id = t.id AND ta.situacao = 'ATIVA'
        ) m ON TRUE
        WHERE t.situacao = 'ATIVA';
        v_titulo := 'Usuários ativos por perfil';
    ELSIF v_perfil = 'PROFESSOR' THEN
        IF v_org IS NULL OR v_situacao_org IS DISTINCT FROM 'ATIVO' THEN
            RAISE EXCEPTION 'Dashboard: professor sem organização ativa.' USING ERRCODE = '42501';
        END IF;
        WITH minhas_turmas AS (
            SELECT id,nome FROM public.turmas WHERE professor_id=v_usuario AND organizacao_id=v_org AND situacao='ATIVA'
        ), matriculas AS (
            SELECT turma_id,count(*) total FROM public.turma_alunos WHERE situacao='ATIVA'
            AND turma_id IN (SELECT id FROM minhas_turmas) GROUP BY turma_id
        ), avaliacoes AS (
            SELECT a.* FROM public.avaliacoes a JOIN minhas_turmas t ON t.id=a.turma_id
        )
        SELECT jsonb_build_array(
            jsonb_build_object('rotulo','Turmas ativas','valor',(SELECT count(*) FROM minhas_turmas)),
            jsonb_build_object('rotulo','Alunos matriculados','valor',coalesce((SELECT sum(total) FROM matriculas),0)),
            jsonb_build_object('rotulo','Avaliações publicadas','valor',(SELECT count(*) FROM avaliacoes WHERE situacao='PUBLICADA')),
            jsonb_build_object('rotulo','Matrículas pendentes','valor',(SELECT count(*) FROM public.turma_alunos m JOIN minhas_turmas t ON t.id=m.turma_id WHERE m.situacao='PENDENTE'))
        ), coalesce((SELECT jsonb_agg(jsonb_build_object('rotulo',t.nome,'valor',coalesce(m.total,0)) ORDER BY t.nome) FROM minhas_turmas t LEFT JOIN matriculas m ON m.turma_id=t.id),'[]'::jsonb)
        INTO v_cards,v_chart;
        v_titulo := 'Alunos matriculados por turma';
    ELSIF v_perfil = 'ALUNO' THEN
        IF v_org IS NULL OR v_situacao_org IS DISTINCT FROM 'ATIVO' THEN
            RAISE EXCEPTION 'Dashboard: aluno sem organização ativa.' USING ERRCODE = '42501';
        END IF;
        WITH minhas_turmas AS (
            SELECT t.id,t.nome FROM public.turmas t JOIN public.turma_alunos m ON m.turma_id=t.id
            WHERE m.aluno_id=v_usuario AND m.situacao='ATIVA' AND t.situacao='ATIVA' AND t.organizacao_id=v_org
        ), publicadas AS (
            SELECT a.* FROM public.avaliacoes a JOIN minhas_turmas t ON t.id=a.turma_id WHERE a.situacao='PUBLICADA'
        ), tentativas AS (
            SELECT te.* FROM public.tentativas te JOIN public.avaliacoes a ON a.id=te.avaliacao_id
            JOIN minhas_turmas t ON t.id=a.turma_id WHERE te.aluno_id=v_usuario
        )
        SELECT jsonb_build_array(
            jsonb_build_object('rotulo','Turmas ativas','valor',(SELECT count(*) FROM minhas_turmas)),
            jsonb_build_object('rotulo','Avaliações disponíveis','valor',(SELECT count(*) FROM publicadas WHERE inicio_em<=now() AND fim_em>now())),
            jsonb_build_object('rotulo','Tentativas em andamento','valor',(SELECT count(*) FROM tentativas WHERE situacao='EM_ANDAMENTO')),
            jsonb_build_object('rotulo','Tentativas finalizadas','valor',(SELECT count(*) FROM tentativas WHERE situacao='FINALIZADA'))
        ), jsonb_build_array(
            jsonb_build_object('rotulo','Disponíveis agora','valor',(SELECT count(*) FROM publicadas WHERE inicio_em<=now() AND fim_em>now())),
            jsonb_build_object('rotulo','Agendadas','valor',(SELECT count(*) FROM publicadas WHERE inicio_em>now())),
            jsonb_build_object('rotulo','Finalizadas','valor',(SELECT count(*) FROM tentativas WHERE situacao='FINALIZADA')),
            jsonb_build_object('rotulo','Interrompidas','valor',(SELECT count(*) FROM tentativas WHERE situacao='INTERROMPIDA'))
        ) INTO v_cards,v_chart;
        v_titulo := 'Avaliações e tentativas';
    ELSE
        RAISE EXCEPTION 'Perfil inválido para dashboard.' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
        'perfil',v_perfil,
        'indicadores',coalesce(v_cards,'[]'::jsonb),
        'titulo_grafico',v_titulo,
        'grafico',coalesce(v_chart,'[]'::jsonb),
        'titulo_grafico_turmas','Alunos ativos por turma e organização',
        'grafico_turmas',v_chart_turmas
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_indicadores_dashboard()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.consultar_indicadores_dashboard() $$;
REVOKE ALL ON FUNCTION examentech_private.consultar_indicadores_dashboard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.consultar_indicadores_dashboard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.consultar_indicadores_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_indicadores_dashboard() TO authenticated;
COMMIT;
