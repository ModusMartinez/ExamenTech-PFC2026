-- Complementa 050: contagem regressiva da próxima prova do aluno e pizza de ocorrências do professor.
-- Aplicar depois de 050.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.dashboard_complemento_rf47(p_inicio DATE,p_fim DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_usuario UUID := auth.uid();
    v_perfil TEXT;
    v_org UUID;
    v_inicio TIMESTAMPTZ;
    v_fim TIMESTAMPTZ;
    v_grafico JSONB;
    v_proxima JSONB;
BEGIN
    IF p_inicio IS NOT NULL AND p_fim IS NOT NULL AND p_fim<p_inicio THEN
        RAISE EXCEPTION 'O período final deve ser igual ou posterior ao inicial.' USING ERRCODE='22023';
    END IF;
    v_inicio := CASE WHEN p_inicio IS NULL THEN NULL ELSE p_inicio::TIMESTAMP AT TIME ZONE 'America/Sao_Paulo' END;
    v_fim := CASE WHEN p_fim IS NULL THEN NULL ELSE (p_fim+1)::TIMESTAMP AT TIME ZONE 'America/Sao_Paulo' END;
    SELECT p.perfil,p.organizacao_id INTO v_perfil,v_org FROM public.perfis p
    LEFT JOIN public.organizacoes o ON o.id=p.organizacao_id
    WHERE p.id=v_usuario AND p.situacao='ATIVO' AND (p.perfil='ADMIN' OR o.situacao='ATIVO');
    IF NOT FOUND OR (auth.jwt()->>'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.user_id=v_usuario AND s.id::TEXT=auth.jwt()->>'session_id') THEN
        RAISE EXCEPTION 'Perfil, sessão ou MFA indisponível para o dashboard.' USING ERRCODE='42501';
    END IF;

    IF v_perfil='PROFESSOR' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('rotulo',rotulo,'valor',total) ORDER BY prioridade),'[]'::JSONB)
        INTO v_grafico FROM (
            SELECT CASE e.evento
                WHEN 'CAMERA_FALHA' THEN 'Falha de câmera'
                WHEN 'CLIPBOARD_BLOQUEADO' THEN 'Área de transferência bloqueada'
                ELSE 'Tentativa interrompida' END AS rotulo,
                CASE e.evento WHEN 'CAMERA_FALHA' THEN 1 WHEN 'CLIPBOARD_BLOQUEADO' THEN 2 ELSE 3 END AS prioridade,
                count(*) AS total
            FROM public.eventos_seguranca e
            JOIN public.tentativas te ON te.id=e.recurso_id
            JOIN public.avaliacoes a ON a.id=te.avaliacao_id
            WHERE a.professor_id=v_usuario
              AND e.evento IN ('CAMERA_FALHA','CLIPBOARD_BLOQUEADO','TENTATIVA_INTERROMPIDA')
              AND e.criado_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ)
              AND e.criado_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)
            GROUP BY e.evento
        ) ocorrencias;
        RETURN jsonb_build_object('grafico_ocorrencias',COALESCE(v_grafico,'[]'::JSONB));
    ELSIF v_perfil='ALUNO' THEN
        SELECT jsonb_build_object(
            'titulo',a.titulo,
            'alvo_em',CASE WHEN now()>=a.inicio_em THEN a.fim_em ELSE a.inicio_em END,
            'tipo',CASE WHEN now()>=a.inicio_em THEN 'ENCERRAMENTO' ELSE 'INICIO' END
        ) INTO v_proxima
        FROM public.avaliacoes a
        JOIN public.turmas t ON t.id=a.turma_id AND t.organizacao_id=v_org AND t.situacao='ATIVA'
        JOIN public.turma_alunos m ON m.turma_id=t.id AND m.aluno_id=v_usuario AND m.situacao='ATIVA'
        WHERE a.situacao='PUBLICADA' AND a.fim_em>now()
          AND a.inicio_em>=COALESCE(v_inicio,'-infinity'::TIMESTAMPTZ)
          AND a.inicio_em<COALESCE(v_fim,'infinity'::TIMESTAMPTZ)
        ORDER BY CASE WHEN now()>=a.inicio_em THEN 0 ELSE 1 END,
          CASE WHEN now()>=a.inicio_em THEN a.fim_em ELSE a.inicio_em END,
          a.id
        LIMIT 1;
        RETURN jsonb_build_object('proxima_avaliacao',v_proxima);
    END IF;
    RETURN '{}'::JSONB;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.dashboard_complemento_rf47(DATE,DATE) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.consultar_indicadores_dashboard_periodo(p_inicio DATE DEFAULT NULL,p_fim DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_base JSONB; v_complemento JSONB;
BEGIN
    v_base := examentech_private.consultar_indicadores_dashboard_periodo(p_inicio,p_fim);
    v_complemento := examentech_private.dashboard_complemento_rf47(p_inicio,p_fim);
    RETURN v_base || v_complemento;
END;
$$;
REVOKE ALL ON FUNCTION public.consultar_indicadores_dashboard_periodo(DATE,DATE) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_indicadores_dashboard_periodo(DATE,DATE) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
