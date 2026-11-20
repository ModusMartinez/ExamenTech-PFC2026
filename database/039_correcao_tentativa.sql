-- Aplicar após 038. A correção é privada até existir publicação de resultados.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS examentech_private.pontuacoes_tentativa (
    tentativa_id UUID NOT NULL REFERENCES public.tentativas(id) ON DELETE CASCADE,
    questao_id UUID NOT NULL REFERENCES public.questoes(id) ON DELETE RESTRICT,
    pontos NUMERIC NOT NULL CHECK (pontos BETWEEN 0 AND 9999.99 AND pontos = trunc(pontos, 2)),
    comentario TEXT CHECK (char_length(comentario) <= 2000),
    versao INTEGER NOT NULL DEFAULT 0 CHECK (versao >= 0),
    corrigida_por UUID REFERENCES public.perfis(id),
    corrigida_em TIMESTAMPTZ,
    PRIMARY KEY (tentativa_id, questao_id),
    CHECK ((versao = 0 AND corrigida_por IS NULL AND corrigida_em IS NULL AND comentario IS NULL)
        OR (versao > 0 AND corrigida_por IS NOT NULL AND corrigida_em IS NOT NULL))
);
ALTER TABLE examentech_private.pontuacoes_tentativa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON examentech_private.pontuacoes_tentativa FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION examentech_private.registrar_pontuacoes_automaticas(p_tentativa_id UUID)
RETURNS VOID LANGUAGE sql SET search_path = '' AS $$
    INSERT INTO examentech_private.pontuacoes_tentativa (tentativa_id, questao_id, pontos)
    SELECT te.id, q.id, CASE WHEN a.correta THEN q.pontuacao ELSE 0 END
    FROM public.tentativas te
    JOIN public.questoes q ON q.avaliacao_id = te.avaliacao_id
    LEFT JOIN public.respostas_tentativa r ON r.tentativa_id = te.id AND r.questao_id = q.id
    LEFT JOIN public.alternativas a ON a.id = r.alternativa_id AND a.questao_id = q.id
    WHERE te.id = p_tentativa_id AND te.situacao = 'FINALIZADA'
      AND (q.tipo = 'OBJETIVA' OR NOT COALESCE(r.texto ~ '[^[:space:]]', FALSE))
    ON CONFLICT (tentativa_id, questao_id) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION examentech_private.corrigir_ao_finalizar_tentativa()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.registrar_pontuacoes_automaticas(NEW.id);
    RETURN NEW;
END;
$$;

-- A finalização e o salvamento já serializam pela linha da tentativa.
-- O gabarito e a pontuação vêm das questões publicadas, inclusive no histórico.
CREATE OR REPLACE TRIGGER tentativas_corrigir_ao_finalizar
AFTER UPDATE OF situacao ON public.tentativas FOR EACH ROW
WHEN (OLD.situacao IS DISTINCT FROM NEW.situacao AND NEW.situacao = 'FINALIZADA')
EXECUTE FUNCTION examentech_private.corrigir_ao_finalizar_tentativa();

DO $$
BEGIN
    PERFORM examentech_private.registrar_pontuacoes_automaticas(id)
    FROM public.tentativas WHERE situacao = 'FINALIZADA';
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.tentativa_para_correcao(p_tentativa_id UUID)
RETURNS public.tentativas LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    SELECT te.* INTO v_tentativa
    FROM public.tentativas te
    JOIN public.avaliacoes a ON a.id = te.avaliacao_id AND a.professor_id = auth.uid()
    JOIN public.perfis p ON p.id = a.professor_id AND p.perfil = 'PROFESSOR'
    WHERE te.id = p_tentativa_id AND examentech_private.responsavel_pode_gerir_avaliacao(a.id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Somente o professor autor pode acessar a correção.' USING ERRCODE = '42501';
    END IF;
    IF v_tentativa.situacao <> 'FINALIZADA' THEN
        RAISE EXCEPTION 'A correção exige uma tentativa finalizada.' USING ERRCODE = '55000';
    END IF;
    RETURN v_tentativa;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.resumo_correcao_tentativa(p_tentativa public.tentativas)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'tentativa_id', p_tentativa.id,
        'pontos_obtidos', COALESCE(sum(c.pontos), 0), 'pontos_totais', sum(q.pontuacao),
        'pendentes', count(*) FILTER (WHERE c.pontos IS NULL),
        'nota', CASE WHEN count(c.pontos) = count(*) THEN round(sum(c.pontos) * 10 / sum(q.pontuacao), 2) END,
        'questoes', jsonb_agg(jsonb_build_object(
            'id', q.id, 'tipo', q.tipo, 'ordem', q.ordem, 'enunciado', q.enunciado, 'maximo', q.pontuacao,
            'resposta', CASE WHEN q.tipo = 'OBJETIVA' THEN marcada.texto
                WHEN r.texto ~ '[^[:space:]]' THEN r.texto END,
            'gabarito', gabarito.texto, 'pontos', c.pontos, 'comentario', c.comentario,
            'versao', COALESCE(c.versao, 0)
        ) ORDER BY q.ordem, q.id)
    )
    FROM public.questoes q
    LEFT JOIN public.respostas_tentativa r ON r.tentativa_id = p_tentativa.id AND r.questao_id = q.id
    LEFT JOIN public.alternativas marcada ON marcada.id = r.alternativa_id AND marcada.questao_id = q.id
    LEFT JOIN public.alternativas gabarito ON gabarito.questao_id = q.id AND gabarito.correta
    LEFT JOIN examentech_private.pontuacoes_tentativa c ON c.tentativa_id = p_tentativa.id AND c.questao_id = q.id
    WHERE q.avaliacao_id = p_tentativa.avaliacao_id;
$$;

CREATE OR REPLACE FUNCTION public.consultar_correcao_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT examentech_private.resumo_correcao_tentativa(examentech_private.tentativa_para_correcao(p_tentativa_id));
$$;

CREATE OR REPLACE FUNCTION public.corrigir_dissertativa(
    p_tentativa_id UUID, p_questao_id UUID, p_pontos NUMERIC, p_comentario TEXT, p_versao INTEGER
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_maximo NUMERIC;
    v_anterior examentech_private.pontuacoes_tentativa%ROWTYPE;
    v_comentario TEXT := CASE WHEN p_comentario ~ '[^[:space:]]' THEN btrim(p_comentario) END;
BEGIN
    -- Serializa correções da mesma tentativa e protege contra sobrescrita em outra aba.
    v_tentativa := examentech_private.tentativa_para_correcao(p_tentativa_id);
    PERFORM 1 FROM public.tentativas WHERE id = v_tentativa.id FOR UPDATE;

    SELECT q.pontuacao INTO v_maximo FROM public.questoes q
    JOIN public.respostas_tentativa r ON r.questao_id = q.id AND r.tentativa_id = v_tentativa.id
    WHERE q.id = p_questao_id AND q.avaliacao_id = v_tentativa.avaliacao_id
      AND q.tipo = 'DISSERTATIVA' AND r.texto ~ '[^[:space:]]';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Selecione uma dissertativa respondida desta tentativa.' USING ERRCODE = '23514';
    END IF;
    IF p_pontos IS NULL OR p_pontos NOT BETWEEN 0 AND v_maximo OR p_pontos <> trunc(p_pontos, 2)
       OR char_length(v_comentario) > 2000 OR p_versao IS NULL OR p_versao < 0 THEN
        RAISE EXCEPTION 'Confira a pontuação e o comentário da correção.' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_anterior FROM examentech_private.pontuacoes_tentativa
    WHERE tentativa_id = v_tentativa.id AND questao_id = p_questao_id;
    IF FOUND AND v_anterior.pontos = p_pontos AND v_anterior.comentario IS NOT DISTINCT FROM v_comentario
       AND p_versao IN (v_anterior.versao, v_anterior.versao - 1) THEN
        RETURN examentech_private.resumo_correcao_tentativa(v_tentativa);
    END IF;
    IF COALESCE(v_anterior.versao, 0) <> p_versao THEN
        RAISE EXCEPTION 'A correção mudou. Atualize antes de salvar.' USING ERRCODE = '40001';
    END IF;

    INSERT INTO examentech_private.pontuacoes_tentativa
        (tentativa_id, questao_id, pontos, comentario, versao, corrigida_por, corrigida_em)
    VALUES (v_tentativa.id, p_questao_id, p_pontos, v_comentario, p_versao + 1, auth.uid(), clock_timestamp())
    ON CONFLICT (tentativa_id, questao_id) DO UPDATE SET pontos = EXCLUDED.pontos, comentario = EXCLUDED.comentario,
        versao = EXCLUDED.versao, corrigida_por = EXCLUDED.corrigida_por, corrigida_em = EXCLUDED.corrigida_em;
    RETURN examentech_private.resumo_correcao_tentativa(v_tentativa);
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_pontuacoes_automaticas(UUID),
    examentech_private.corrigir_ao_finalizar_tentativa(), examentech_private.tentativa_para_correcao(UUID),
    examentech_private.resumo_correcao_tentativa(public.tentativas)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consultar_correcao_tentativa(UUID),
    public.corrigir_dissertativa(UUID, UUID, NUMERIC, TEXT, INTEGER)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consultar_correcao_tentativa(UUID),
    public.corrigir_dissertativa(UUID, UUID, NUMERIC, TEXT, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
