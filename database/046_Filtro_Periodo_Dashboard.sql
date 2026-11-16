-- RF40: filtro por intervalo de datas nos dashboards e nota da última avaliação publicada do aluno.
-- Aplicar depois de 045.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.consultar_indicadores_dashboard_periodo(
    p_inicio DATE, p_fim DATE
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_usuario UUID := auth.uid();
    v_perfil TEXT;
    v_org UUID;
    v_inicio TIMESTAMPTZ;
    v_fim TIMESTAMPTZ;
    v_cards JSONB;
    v_chart JSONB;
    v_chart_turmas JSONB := '[]'::JSONB;
    v_titulo TEXT;
    v_extra BIGINT := 0;
    v_resultados BIGINT := 0;
    v_nota NUMERIC;
    v_ultima_avaliacao TEXT;
BEGIN
    IF p_inicio IS NOT NULL AND p_fim IS NOT NULL AND p_fim < p_inicio THEN
        RAISE EXCEPTION 'O período final deve ser igual ou posterior ao inicial.' USING ERRCODE = '22023';
    END IF;
    v_inicio := CASE WHEN p_inicio IS NULL THEN NULL ELSE p_inicio::TIMESTAMP AT TIME ZONE 'America/Sao_Paulo' END;
    v_fim := CASE WHEN p_fim IS NULL THEN NULL ELSE (p_fim + 1)::TIMESTAMP AT TIME ZONE 'America/Sao_Paulo' END;

    SELECT p.perfil, p.organizacao_id INTO v_perfil, v_org
    FROM public.perfis p LEFT JOIN public.organizacoes o ON o.id=p.organizacao_id
    WHERE p.id=v_usuario AND p.situacao='ATIVO'
      AND (p.perfil='ADMIN' OR o.situacao='ATIVO');
    IF NOT FOUND OR (auth.jwt()->>'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.user_id=v_usuario AND s.id::TEXT=auth.jwt()->>'session_id') THEN
        RAISE EXCEPTION 'Perfil, sessão ou MFA indisponível para o dashboard.' USING ERRCODE = '42501';
    END IF;

    IF v_perfil='ADMIN' THEN
        SELECT jsonb_build_array(
            jsonb_build_object('rotulo','Usuários ativos','valor',count(*) FILTER (WHERE situacao='ATIVO')),
            jsonb_build_object('rotulo','Professores ativos','valor',count(*) FILTER (WHERE perfil='PROFESSOR' AND situacao='ATIVO')),
            jsonb_build_object('rotulo','Alunos ativos','valor',count(*) FILTER (WHERE perfil='ALUNO' AND situacao='ATIVO')),
            jsonb_build_object('rotulo','Turmas ativas','valor',(SELECT count(*) FROM public.turmas t WHERE t.situacao='ATIVA'
                AND (v_inicio IS NULL OR t.criado_em>=v_inicio) AND (v_fim IS NULL OR t.criado_em<v_fim)))
        ) INTO v_cards FROM public.perfis WHERE (v_inicio IS NULL OR criado_em>=v_inicio) AND (v_fim IS NULL OR criado_em<v_fim);
        SELECT jsonb_agg(jsonb_build_object('rotulo',rotulo,'valor',total) ORDER BY ordem)
        INTO v_chart FROM (
            SELECT CASE perfil WHEN 'ADMIN' THEN 'Administradores' WHEN 'PROFESSOR' THEN 'Professores' ELSE 'Alunos' END rotulo,
                CASE perfil WHEN 'ADMIN' THEN 1 WHEN 'PROFESSOR' THEN 2 ELSE 3 END ordem,
                count(*) total FROM public.perfis WHERE situacao='ATIVO'
                AND criado_em >= COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND criado_em < COALESCE(v_fim,'infinity'::TIMESTAMPTZ)
            GROUP BY perfil
        ) x;
        SELECT COALESCE(jsonb_agg(jsonb_build_object('rotulo',concat_ws(' · ',o.nome,t.nome),'valor',coalesce(m.total,0))
            ORDER BY o.nome,t.nome,t.id),'[]'::JSONB) INTO v_chart_turmas
        FROM public.turmas t JOIN public.organizacoes o ON o.id=t.organizacao_id
        LEFT JOIN LATERAL (SELECT count(*) total FROM public.turma_alunos ta WHERE ta.turma_id=t.id AND ta.situacao='ATIVA'
            AND ta.solicitado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND ta.solicitado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)) m ON TRUE
        WHERE t.situacao='ATIVA';
        v_titulo := 'Usuários ativos por perfil';
        SELECT count(*) INTO v_extra FROM public.eventos_seguranca e WHERE e.evento IN ('CAMERA_FALHA','CLIPBOARD_BLOQUEADO','TENTATIVA_INTERROMPIDA')
            AND e.criado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND e.criado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ);
        RETURN jsonb_build_object('perfil',v_perfil,'indicadores',v_cards || jsonb_build_array(
                jsonb_build_object('rotulo','Organizações ativas','valor',(SELECT count(*) FROM public.organizacoes WHERE situacao='ATIVO')),
                jsonb_build_object('rotulo','Resultados publicados','valor',(SELECT count(*) FROM examentech_private.resultados_publicados rp
                    WHERE rp.publicado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND rp.publicado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ))),
                jsonb_build_object('rotulo','Ocorrências registradas','valor',v_extra)),
            'titulo_grafico',v_titulo,'grafico',COALESCE(v_chart,'[]'::JSONB),
            'titulo_grafico_turmas','Matrículas ativas por turma e organização','grafico_turmas',v_chart_turmas);

    ELSIF v_perfil='PROFESSOR' THEN
        WITH minhas_turmas AS (
            SELECT id,nome,criado_em FROM public.turmas WHERE professor_id=v_usuario AND organizacao_id=v_org AND situacao='ATIVA'
        ), matriculas AS (
            SELECT turma_id,count(*) total FROM public.turma_alunos WHERE situacao='ATIVA'
              AND solicitado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND solicitado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)
              AND turma_id IN (SELECT id FROM minhas_turmas) GROUP BY turma_id
        ), avaliacoes AS (
            SELECT a.* FROM public.avaliacoes a JOIN minhas_turmas t ON t.id=a.turma_id
        )
        SELECT jsonb_build_array(
            jsonb_build_object('rotulo','Turmas ativas','valor',(SELECT count(*) FROM minhas_turmas
                WHERE criado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND criado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ))),
            jsonb_build_object('rotulo','Alunos matriculados','valor',COALESCE((SELECT sum(total) FROM matriculas),0)),
            jsonb_build_object('rotulo','Avaliações publicadas','valor',(SELECT count(*) FROM avaliacoes WHERE situacao='PUBLICADA'
                AND publicada_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND publicada_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ))),
            jsonb_build_object('rotulo','Matrículas pendentes','valor',(SELECT count(*) FROM public.turma_alunos m JOIN minhas_turmas t ON t.id=m.turma_id
                WHERE m.situacao='PENDENTE' AND m.solicitado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND m.solicitado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)))
        ), COALESCE((SELECT jsonb_agg(jsonb_build_object('rotulo',t.nome,'valor',COALESCE(m.total,0)) ORDER BY t.nome)
            FROM minhas_turmas t LEFT JOIN matriculas m ON m.turma_id=t.id),'[]'::JSONB)
        INTO v_cards,v_chart;
        v_titulo := 'Alunos matriculados por turma';
        SELECT count(*) INTO v_extra FROM public.eventos_seguranca e JOIN public.tentativas te ON te.id=e.recurso_id
          JOIN public.avaliacoes a ON a.id=te.avaliacao_id
        WHERE a.professor_id=v_usuario AND e.evento IN ('CAMERA_FALHA','CLIPBOARD_BLOQUEADO','TENTATIVA_INTERROMPIDA')
          AND e.criado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND e.criado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ);
        SELECT count(*) INTO v_resultados FROM public.tentativas te JOIN public.avaliacoes a ON a.id=te.avaliacao_id
          JOIN examentech_private.resultados_publicados rp ON rp.avaliacao_id=a.id
        WHERE a.professor_id=v_usuario AND te.situacao='FINALIZADA'
          AND rp.publicado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND rp.publicado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ);
        RETURN jsonb_build_object('perfil',v_perfil,'indicadores',v_cards || jsonb_build_array(
            jsonb_build_object('rotulo','Resultados liberados','valor',v_resultados),
            jsonb_build_object('rotulo','Ocorrências registradas','valor',v_extra)),
            'titulo_grafico',v_titulo,'grafico',COALESCE(v_chart,'[]'::JSONB));

    ELSIF v_perfil='ALUNO' THEN
        WITH minhas_turmas AS (
            SELECT t.id,t.nome FROM public.turmas t JOIN public.turma_alunos m ON m.turma_id=t.id
            WHERE m.aluno_id=v_usuario AND m.situacao='ATIVA' AND t.situacao='ATIVA' AND t.organizacao_id=v_org
        ), publicadas AS (
            SELECT a.* FROM public.avaliacoes a JOIN minhas_turmas t ON t.id=a.turma_id WHERE a.situacao='PUBLICADA'
              AND a.publicada_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND a.publicada_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)
        ), tentativas AS (
            SELECT te.* FROM public.tentativas te JOIN public.avaliacoes a ON a.id=te.avaliacao_id
            JOIN minhas_turmas t ON t.id=a.turma_id WHERE te.aluno_id=v_usuario
              AND te.iniciada_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND te.iniciada_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)
        )
        SELECT jsonb_build_array(
            jsonb_build_object('rotulo','Matrículas ativas no período','valor',(SELECT count(*) FROM minhas_turmas mt
                JOIN public.turma_alunos m ON m.turma_id=mt.id AND m.aluno_id=v_usuario AND m.situacao='ATIVA'
                WHERE m.solicitado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND m.solicitado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ))),
            jsonb_build_object('rotulo','Avaliações publicadas no período','valor',(SELECT count(*) FROM publicadas)),
            jsonb_build_object('rotulo','Tentativas em andamento','valor',(SELECT count(*) FROM tentativas WHERE situacao='EM_ANDAMENTO')),
            jsonb_build_object('rotulo','Tentativas finalizadas','valor',(SELECT count(*) FROM tentativas WHERE situacao='FINALIZADA'))
        ), jsonb_build_array(
            jsonb_build_object('rotulo','Avaliações publicadas','valor',(SELECT count(*) FROM publicadas)),
            jsonb_build_object('rotulo','Tentativas em andamento','valor',(SELECT count(*) FROM tentativas WHERE situacao='EM_ANDAMENTO')),
            jsonb_build_object('rotulo','Finalizadas','valor',(SELECT count(*) FROM tentativas WHERE situacao='FINALIZADA')),
            jsonb_build_object('rotulo','Interrompidas','valor',(SELECT count(*) FROM tentativas WHERE situacao='INTERROMPIDA'))
        ) INTO v_cards,v_chart;

        SELECT (c.resumo->>'nota')::NUMERIC,r.titulo INTO v_nota,v_ultima_avaliacao
        FROM examentech_private.meus_resultados_publicados() r
        JOIN public.tentativas te ON te.id=r.tentativa_id
        CROSS JOIN LATERAL (SELECT examentech_private.resumo_correcao_tentativa(te) AS resumo) c
        WHERE r.publicado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND r.publicado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)
        ORDER BY r.publicado_em DESC,r.tentativa_id DESC LIMIT 1;

        SELECT count(*) INTO v_extra FROM public.eventos_seguranca e JOIN public.tentativas te ON te.id=e.recurso_id
          JOIN public.avaliacoes a ON a.id=te.avaliacao_id JOIN public.turmas t ON t.id=a.turma_id AND t.organizacao_id=v_org
          JOIN public.turma_alunos m ON m.turma_id=t.id AND m.aluno_id=v_usuario AND m.situacao='ATIVA'
        WHERE te.aluno_id=v_usuario AND e.evento IN ('CAMERA_FALHA','CLIPBOARD_BLOQUEADO','TENTATIVA_INTERROMPIDA')
          AND e.criado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND e.criado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ);
        SELECT count(*) INTO v_resultados FROM examentech_private.meus_resultados_publicados() r
        WHERE r.publicado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ) AND r.publicado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ);
        RETURN jsonb_build_object('perfil',v_perfil,'indicadores',v_cards || jsonb_build_array(
            jsonb_build_object('rotulo','Resultados liberados','valor',v_resultados),
            jsonb_build_object('rotulo','Ocorrências registradas','valor',v_extra),
            jsonb_build_object('rotulo','Nota da última avaliação','valor',v_nota,'detalhe',COALESCE(v_ultima_avaliacao,'Sem resultado publicado no período'))),
            'titulo_grafico','Avaliações e tentativas','grafico',COALESCE(v_chart,'[]'::JSONB));
    END IF;
    RAISE EXCEPTION 'Perfil inválido para dashboard.' USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_indicadores_dashboard_periodo(p_inicio DATE DEFAULT NULL,p_fim DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT examentech_private.consultar_indicadores_dashboard_periodo(p_inicio,p_fim) $$;
REVOKE ALL ON FUNCTION examentech_private.consultar_indicadores_dashboard_periodo(DATE,DATE) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.consultar_indicadores_dashboard_periodo(DATE,DATE) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_indicadores_dashboard_periodo(DATE,DATE) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
