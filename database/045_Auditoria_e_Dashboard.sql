-- RF37: linha do tempo por tentativa para o responsável da avaliação.
-- RF40: complementa os indicadores reais com resultados e ocorrências por perfil.
-- Aplicar depois de 044, após conferir as migrações anteriores na base.
BEGIN;

CREATE OR REPLACE FUNCTION public.listar_linha_tempo_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    SELECT te.* INTO v_tentativa FROM public.tentativas te
    WHERE te.id = p_tentativa_id
      AND examentech_private.responsavel_pode_gerir_avaliacao(te.avaliacao_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tentativa não encontrada ou sem acesso.' USING ERRCODE = '42501';
    END IF;

    RETURN (
        SELECT COALESCE(jsonb_agg(to_jsonb(itens) ORDER BY ocorrido_em, tipo, id), '[]'::JSONB)
        FROM (
            SELECT e.id, e.criado_em AS ocorrido_em, 'EVENTO'::TEXT AS tipo,
                e.evento AS titulo, e.acao AS detalhe, NULL::TEXT AS situacao,
                NULL::TEXT AS momento, NULL::TIMESTAMPTZ AS expira_em
            FROM public.eventos_seguranca e
            WHERE e.recurso_id = p_tentativa_id
               OR e.recurso_id IN (SELECT f.id FROM public.fotos_tentativa f WHERE f.tentativa_id = p_tentativa_id)
            UNION ALL
            SELECT f.id, COALESCE(f.recebida_em, f.agendada_em) AS ocorrido_em,
                'FOTO'::TEXT AS tipo, 'Captura de foto'::TEXT AS titulo,
                CASE f.momento WHEN 'INICIAL' THEN 'Foto inicial' ELSE 'Foto durante a prova' END AS detalhe,
                CASE WHEN f.expira_em <= clock_timestamp() THEN 'EXCLUIDA' ELSE f.situacao END AS situacao,
                f.momento, f.expira_em
            FROM public.fotos_tentativa f WHERE f.tentativa_id = p_tentativa_id
        ) itens
    );
END;
$$;
REVOKE ALL ON FUNCTION public.listar_linha_tempo_tentativa(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_linha_tempo_tentativa(UUID) TO authenticated;

-- Mantém a autorização de perfil/sessão/MFA e os gráficos instituídos na 044.
-- Acrescenta somente métricas agregadas; nenhum dado de aluno é devolvido.
CREATE OR REPLACE FUNCTION examentech_private.indicadores_dashboard_rf40()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_usuario UUID := auth.uid();
    v_perfil TEXT;
    v_org UUID;
    v_eventos INTEGER := 0;
    v_resultados INTEGER := 0;
    v_organizacoes INTEGER := 0;
BEGIN
    SELECT p.perfil, p.organizacao_id INTO v_perfil, v_org
    FROM public.perfis p WHERE p.id = v_usuario AND p.situacao = 'ATIVO';
    IF NOT FOUND THEN RAISE EXCEPTION 'Perfil inativo.' USING ERRCODE = '42501'; END IF;

    IF v_perfil = 'ADMIN' THEN
        SELECT count(*) INTO v_organizacoes FROM public.organizacoes WHERE situacao = 'ATIVO';
        SELECT count(*) INTO v_eventos FROM public.eventos_seguranca e
        WHERE e.evento IN ('CAMERA_FALHA','CLIPBOARD_BLOQUEADO','TENTATIVA_INTERROMPIDA');
        SELECT count(*) INTO v_resultados FROM examentech_private.resultados_publicados;
    ELSIF v_perfil = 'PROFESSOR' THEN
        IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizacoes o WHERE o.id=v_org AND o.situacao='ATIVO') THEN
            RAISE EXCEPTION 'Organização inativa.' USING ERRCODE = '42501';
        END IF;
        SELECT count(*) INTO v_eventos FROM public.eventos_seguranca e
        JOIN public.tentativas te ON te.id=e.recurso_id
        JOIN public.avaliacoes a ON a.id=te.avaliacao_id
        WHERE a.professor_id=v_usuario AND e.evento IN ('CAMERA_FALHA','CLIPBOARD_BLOQUEADO','TENTATIVA_INTERROMPIDA');
        SELECT count(*) INTO v_resultados FROM public.tentativas te
        JOIN public.avaliacoes a ON a.id=te.avaliacao_id
        JOIN examentech_private.resultados_publicados rp ON rp.avaliacao_id=a.id
        WHERE a.professor_id=v_usuario AND te.situacao='FINALIZADA';
    ELSIF v_perfil = 'ALUNO' THEN
        IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizacoes o WHERE o.id=v_org AND o.situacao='ATIVO') THEN
            RAISE EXCEPTION 'Organização inativa.' USING ERRCODE = '42501';
        END IF;
        SELECT count(*) INTO v_eventos FROM public.eventos_seguranca e
        JOIN public.tentativas te ON te.id=e.recurso_id
        JOIN public.avaliacoes a ON a.id=te.avaliacao_id
        JOIN public.turmas t ON t.id=a.turma_id AND t.organizacao_id=v_org
        JOIN public.turma_alunos m ON m.turma_id=t.id AND m.aluno_id=v_usuario AND m.situacao='ATIVA'
        WHERE te.aluno_id=v_usuario AND e.evento IN ('CAMERA_FALHA','CLIPBOARD_BLOQUEADO','TENTATIVA_INTERROMPIDA');
        SELECT count(*) INTO v_resultados FROM examentech_private.meus_resultados_publicados();
    ELSE
        RAISE EXCEPTION 'Perfil inválido.' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('resultados',v_resultados,'ocorrencias',v_eventos,'organizacoes_ativas',v_organizacoes);
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.indicadores_dashboard_rf40() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consultar_indicadores_dashboard()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_base JSONB; v_extra JSONB;
BEGIN
    v_base := examentech_private.consultar_indicadores_dashboard();
    v_extra := examentech_private.indicadores_dashboard_rf40();
    RETURN v_base || jsonb_build_object(
        'indicadores', (v_base->'indicadores') || CASE WHEN v_base->>'perfil'='ADMIN' THEN jsonb_build_array(
            jsonb_build_object('rotulo','Organizações ativas','valor',(v_extra->>'organizacoes_ativas')::INTEGER),
            jsonb_build_object('rotulo','Resultados publicados','valor',(v_extra->>'resultados')::INTEGER),
            jsonb_build_object('rotulo','Ocorrências registradas','valor',(v_extra->>'ocorrencias')::INTEGER)
        ) ELSE jsonb_build_array(
            jsonb_build_object('rotulo','Resultados liberados','valor',(v_extra->>'resultados')::INTEGER),
            jsonb_build_object('rotulo','Ocorrências registradas','valor',(v_extra->>'ocorrencias')::INTEGER)
        ) END
    );
END;
$$;
REVOKE ALL ON FUNCTION public.consultar_indicadores_dashboard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_indicadores_dashboard() TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
