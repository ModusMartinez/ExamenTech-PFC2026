-- RF39: totais de tentativas por estado da correção, após a 052.
BEGIN;

CREATE OR REPLACE FUNCTION public.consultar_indicadores_dashboard_periodo(p_inicio DATE DEFAULT NULL, p_fim DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_base JSONB;
    v_dashboard JSONB;
    v_inicio TIMESTAMPTZ := p_inicio::TIMESTAMP AT TIME ZONE 'America/Sao_Paulo';
    v_fim TIMESTAMPTZ := (p_fim + 1)::TIMESTAMP AT TIME ZONE 'America/Sao_Paulo';
    v_pendentes BIGINT;
    v_concluidas BIGINT;
BEGIN
    -- A consulta base valida o perfil, a organização, o MFA, a sessão e as datas.
    v_base := examentech_private.consultar_indicadores_dashboard_periodo(p_inicio, p_fim);
    v_dashboard := v_base || examentech_private.dashboard_complemento_rf47(p_inicio, p_fim);
    IF v_base->>'perfil' <> 'PROFESSOR' THEN
        RETURN v_dashboard;
    END IF;

    SELECT count(*) FILTER (WHERE pendente), count(*) FILTER (WHERE NOT pendente)
    INTO v_pendentes, v_concluidas
    FROM (
        SELECT EXISTS (
            -- Assim como na publicação, basta uma questão sem pontuação para a correção estar pendente.
            SELECT 1
            FROM public.questoes q
            LEFT JOIN examentech_private.pontuacoes_tentativa c
                ON c.tentativa_id = te.id AND c.questao_id = q.id
            WHERE q.avaliacao_id = a.id AND c.tentativa_id IS NULL
        ) AS pendente
        FROM public.tentativas te
        JOIN public.avaliacoes a ON a.id = te.avaliacao_id
        JOIN public.turmas t ON t.id = a.turma_id
        JOIN public.perfis p ON p.id = auth.uid() AND p.organizacao_id = t.organizacao_id
        WHERE a.professor_id = p.id AND t.professor_id = p.id AND a.situacao = 'PUBLICADA'
          AND te.situacao = 'FINALIZADA'
          AND (v_inicio IS NULL OR te.encerrada_em >= v_inicio)
          AND (v_fim IS NULL OR te.encerrada_em < v_fim)
    ) AS correcoes;

    RETURN v_dashboard || jsonb_build_object('indicadores_correcoes', jsonb_build_array(
        jsonb_build_object('rotulo', 'Correções pendentes', 'valor', v_pendentes),
        jsonb_build_object('rotulo', 'Correções concluídas', 'valor', v_concluidas)
    ));
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
