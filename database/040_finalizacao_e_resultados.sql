-- Aplicar após 039. O agendamento do Supabase fica na 041.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS tentativas_pendentes_prazo_idx ON public.tentativas (limite_em, id)
WHERE situacao = 'EM_ANDAMENTO';

CREATE OR REPLACE FUNCTION examentech_private.gravar_encerramento_tentativa(
    p_tentativa_id UUID, p_motivo TEXT, p_encerrada_em TIMESTAMPTZ, p_usuario_id UUID
)
RETURNS public.tentativas LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    UPDATE public.tentativas
    SET situacao = CASE WHEN p_motivo = 'SAIDA' THEN 'INTERROMPIDA' ELSE 'FINALIZADA' END,
        encerrada_em = p_encerrada_em
    WHERE id = p_tentativa_id AND situacao = 'EM_ANDAMENTO'
    RETURNING * INTO STRICT v_tentativa;

    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(), CASE WHEN p_motivo = 'SAIDA' THEN 'TENTATIVA_INTERROMPIDA' ELSE 'TENTATIVA_FINALIZADA' END,
        'EXAMENTECH', CASE p_motivo WHEN 'SAIDA' THEN 'saida_tentativa' WHEN 'PRAZO' THEN 'prazo_tentativa'
            ELSE 'finalizar_tentativa' END, TRUE, p_usuario_id, p_tentativa_id);
    RETURN v_tentativa;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.encerrar_tentativa(p_tentativa_id UUID, p_motivo TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_agora TIMESTAMPTZ;
BEGIN
    IF p_motivo IS NULL OR p_motivo NOT IN ('ENVIO', 'PRAZO', 'SAIDA') THEN
        RAISE EXCEPTION 'Motivo inválido.' USING ERRCODE = '23514';
    END IF;
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao = 'EM_ANDAMENTO' THEN
        v_agora := clock_timestamp();
        IF (p_motivo = 'ENVIO' AND v_agora >= v_tentativa.limite_em)
           OR (p_motivo = 'PRAZO' AND v_agora < v_tentativa.limite_em) THEN
            RAISE EXCEPTION 'Operação fora do prazo da tentativa.' USING ERRCODE = '55000';
        END IF;
        IF p_motivo = 'SAIDA' AND v_agora >= v_tentativa.limite_em THEN
            p_motivo := 'PRAZO';
        END IF;
        v_tentativa := examentech_private.gravar_encerramento_tentativa(v_tentativa.id, p_motivo,
            CASE WHEN p_motivo = 'PRAZO' THEN v_tentativa.limite_em ELSE v_agora END, auth.uid());
    ELSIF v_tentativa.situacao <> 'FINALIZADA' AND p_motivo <> 'SAIDA' THEN
        RAISE EXCEPTION 'Tentativa já encerrada.' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('id', v_tentativa.id, 'situacao', v_tentativa.situacao,
        'encerrada_em', v_tentativa.encerrada_em, 'falhas_camera', v_tentativa.falhas_camera);
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.finalizar_tentativas_vencidas()
RETURNS INTEGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    v_limite TIMESTAMPTZ := clock_timestamp();
    v_tentativa RECORD;
    v_total INTEGER := 0;
BEGIN
    -- Resposta, saída e job disputam o mesmo lock. O próximo lote recolhe linhas ocupadas.
    FOR v_tentativa IN SELECT id, limite_em FROM public.tentativas
        WHERE situacao = 'EM_ANDAMENTO' AND limite_em <= v_limite
        ORDER BY limite_em, id LIMIT 200 FOR UPDATE SKIP LOCKED
    LOOP
        PERFORM examentech_private.gravar_encerramento_tentativa(v_tentativa.id, 'PRAZO', v_tentativa.limite_em, NULL);
        v_total := v_total + 1;
    END LOOP;
    RETURN v_total;
END;
$$;

CREATE TABLE IF NOT EXISTS examentech_private.resultados_publicados (
    avaliacao_id UUID PRIMARY KEY REFERENCES public.avaliacoes(id) ON DELETE CASCADE,
    publicado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    publicado_por UUID NOT NULL REFERENCES public.perfis(id)
);
ALTER TABLE examentech_private.resultados_publicados ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON examentech_private.resultados_publicados FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION examentech_private.avaliacao_para_publicar_resultados(p_avaliacao_id UUID)
RETURNS public.avaliacoes LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_avaliacao public.avaliacoes%ROWTYPE;
BEGIN
    SELECT a.* INTO v_avaliacao FROM public.avaliacoes a
    JOIN public.perfis p ON p.id = a.professor_id AND p.perfil = 'PROFESSOR'
    WHERE a.id = p_avaliacao_id AND a.professor_id = auth.uid() AND a.situacao = 'PUBLICADA'
      AND examentech_private.responsavel_pode_gerir_avaliacao(a.id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Somente o professor autor pode publicar os resultados.' USING ERRCODE = '42501';
    END IF;
    RETURN v_avaliacao;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.estado_publicacao_resultados(p_avaliacao public.avaliacoes)
RETURNS JSONB LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    v_publicado_em TIMESTAMPTZ;
    v_estado TEXT;
BEGIN
    SELECT publicado_em INTO v_publicado_em FROM examentech_private.resultados_publicados WHERE avaliacao_id = p_avaliacao.id;
    IF FOUND THEN
        v_estado := 'PUBLICADO';
    ELSIF clock_timestamp() < p_avaliacao.fim_em THEN
        v_estado := 'JANELA_ABERTA';
    ELSIF EXISTS (SELECT 1 FROM public.tentativas WHERE avaliacao_id = p_avaliacao.id AND situacao = 'EM_ANDAMENTO') THEN
        v_estado := 'ENCERRAMENTO_PENDENTE';
    ELSIF NOT EXISTS (SELECT 1 FROM public.tentativas WHERE avaliacao_id = p_avaliacao.id AND situacao = 'FINALIZADA') THEN
        v_estado := 'SEM_TENTATIVAS';
    ELSIF EXISTS (
        SELECT 1 FROM public.tentativas te
        JOIN public.questoes q ON q.avaliacao_id = te.avaliacao_id
        LEFT JOIN examentech_private.pontuacoes_tentativa c ON c.tentativa_id = te.id AND c.questao_id = q.id
        WHERE te.avaliacao_id = p_avaliacao.id AND te.situacao = 'FINALIZADA' AND c.tentativa_id IS NULL
    ) THEN
        v_estado := 'CORRECAO_PENDENTE';
    ELSE
        v_estado := 'PRONTO';
    END IF;
    RETURN jsonb_build_object('avaliacao_id', p_avaliacao.id, 'estado', v_estado, 'publicado_em', v_publicado_em);
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_publicacao_resultados(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT examentech_private.estado_publicacao_resultados(examentech_private.avaliacao_para_publicar_resultados(p_avaliacao_id));
$$;

CREATE OR REPLACE FUNCTION public.publicar_resultados_avaliacao(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_estado JSONB;
BEGIN
    v_avaliacao := examentech_private.avaliacao_para_publicar_resultados(p_avaliacao_id);
    -- Aguarda inícios em curso e serializa duas publicações da mesma avaliação.
    PERFORM 1 FROM public.avaliacoes WHERE id = v_avaliacao.id FOR UPDATE;
    v_avaliacao := examentech_private.avaliacao_para_publicar_resultados(p_avaliacao_id);
    v_estado := examentech_private.estado_publicacao_resultados(v_avaliacao);
    IF v_estado ->> 'estado' = 'PUBLICADO' THEN RETURN v_estado; END IF;
    IF v_estado ->> 'estado' <> 'PRONTO' THEN
        RAISE EXCEPTION 'A avaliação ainda não está pronta para publicar os resultados.' USING ERRCODE = '55000';
    END IF;

    -- A correção da 039 usa este lock antes de gravar pontos e comentários.
    PERFORM 1 FROM public.tentativas WHERE avaliacao_id = v_avaliacao.id AND situacao = 'FINALIZADA' ORDER BY id FOR UPDATE;
    INSERT INTO examentech_private.resultados_publicados (avaliacao_id, publicado_por) VALUES (v_avaliacao.id, auth.uid());
    RETURN examentech_private.estado_publicacao_resultados(v_avaliacao);
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.proteger_correcao_publicada()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tentativas te JOIN examentech_private.resultados_publicados p ON p.avaliacao_id = te.avaliacao_id
        WHERE te.id = NEW.tentativa_id) THEN
        RAISE EXCEPTION 'A correção já foi publicada.' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER pontuacoes_proteger_publicacao BEFORE INSERT OR UPDATE
ON examentech_private.pontuacoes_tentativa FOR EACH ROW EXECUTE FUNCTION examentech_private.proteger_correcao_publicada();

CREATE OR REPLACE FUNCTION public.consultar_correcao_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT examentech_private.resumo_correcao_tentativa(te) || jsonb_build_object('publicado_em', p.publicado_em)
    FROM examentech_private.tentativa_para_correcao(p_tentativa_id) te
    LEFT JOIN examentech_private.resultados_publicados p ON p.avaliacao_id = te.avaliacao_id;
$$;

CREATE OR REPLACE FUNCTION examentech_private.meus_resultados_publicados()
RETURNS TABLE (tentativa_id UUID, avaliacao_id UUID, titulo TEXT, turma_nome TEXT, publicado_em TIMESTAMPTZ)
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT te.id, a.id, a.titulo, t.nome, p.publicado_em FROM public.tentativas te
    JOIN public.avaliacoes a ON a.id = te.avaliacao_id
    JOIN public.turmas t ON t.id = a.turma_id
    JOIN public.perfis aluno ON aluno.id = te.aluno_id AND aluno.perfil = 'ALUNO'
    JOIN examentech_private.resultados_publicados p ON p.avaliacao_id = a.id
    WHERE te.aluno_id = auth.uid() AND te.situacao = 'FINALIZADA'
      AND examentech_private.pode_consultar_matricula(t.id, te.aluno_id);
$$;

CREATE OR REPLACE FUNCTION public.listar_meus_resultados()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.publicado_em DESC, r.tentativa_id), '[]'::JSONB)
    FROM (SELECT * FROM examentech_private.meus_resultados_publicados()
        ORDER BY publicado_em DESC, tentativa_id LIMIT 50) r;
$$;

CREATE OR REPLACE FUNCTION public.consultar_meu_resultado(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_publicacao RECORD;
    v_tentativa public.tentativas%ROWTYPE;
    v_correcao JSONB;
    v_questoes JSONB;
BEGIN
    SELECT * INTO v_publicacao FROM examentech_private.meus_resultados_publicados() WHERE tentativa_id = p_tentativa_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Resultado indisponível para este aluno.' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO STRICT v_tentativa FROM public.tentativas WHERE id = p_tentativa_id;
    v_correcao := examentech_private.resumo_correcao_tentativa(v_tentativa);

    SELECT jsonb_agg((q.questao || jsonb_build_object('ordem', COALESCE(tq.ordem, q.ordem), 'alternativas', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'texto', a.texto, 'correta', a.correta,
            'marcada', COALESCE(r.alternativa_id = a.id, FALSE)) ORDER BY COALESCE(ta.ordem, a.ordem)), '[]'::JSONB)
        FROM public.alternativas a
        LEFT JOIN public.tentativa_alternativas ta ON ta.alternativa_id = a.id AND ta.tentativa_id = v_tentativa.id
        LEFT JOIN public.respostas_tentativa r ON r.questao_id = a.questao_id AND r.tentativa_id = v_tentativa.id
        WHERE a.questao_id = q.id
    ))) ORDER BY COALESCE(tq.ordem, q.ordem)) INTO v_questoes
    FROM jsonb_array_elements(v_correcao -> 'questoes') AS item(questao)
    CROSS JOIN LATERAL (SELECT item.questao, (item.questao ->> 'id')::UUID AS id, (item.questao ->> 'ordem')::INTEGER AS ordem) q
    LEFT JOIN public.tentativa_questoes tq ON tq.questao_id = q.id AND tq.tentativa_id = v_tentativa.id;

    RETURN v_correcao || to_jsonb(v_publicacao) || jsonb_build_object('questoes', v_questoes);
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.gravar_encerramento_tentativa(UUID,TEXT,TIMESTAMPTZ,UUID),
    examentech_private.finalizar_tentativas_vencidas(), examentech_private.avaliacao_para_publicar_resultados(UUID),
    examentech_private.estado_publicacao_resultados(public.avaliacoes), examentech_private.proteger_correcao_publicada(),
    examentech_private.meus_resultados_publicados() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consultar_publicacao_resultados(UUID), public.publicar_resultados_avaliacao(UUID),
    public.listar_meus_resultados(), public.consultar_meu_resultado(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consultar_publicacao_resultados(UUID), public.publicar_resultados_avaliacao(UUID),
    public.listar_meus_resultados(), public.consultar_meu_resultado(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
