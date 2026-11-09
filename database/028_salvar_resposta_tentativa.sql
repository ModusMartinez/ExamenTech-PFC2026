-- Aplicar depois de 027. Respostas do aluno, sem correção ou finalização.
BEGIN;

-- Permite uma FK que confere tentativa, questão e alternativa em conjunto.
CREATE UNIQUE INDEX IF NOT EXISTS tentativa_alternativas_resposta_unica
ON public.tentativa_alternativas (tentativa_id, questao_id, alternativa_id);

CREATE TABLE IF NOT EXISTS public.respostas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tentativa_id UUID NOT NULL,
    questao_id UUID NOT NULL,
    alternativa_id UUID,
    texto TEXT,
    versao INTEGER NOT NULL CHECK (versao > 0),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT respostas_tentativa_questao_unica UNIQUE (tentativa_id, questao_id),
    FOREIGN KEY (tentativa_id, questao_id)
        REFERENCES public.tentativa_questoes(tentativa_id, questao_id) ON DELETE RESTRICT,
    FOREIGN KEY (tentativa_id, questao_id, alternativa_id)
        REFERENCES public.tentativa_alternativas(tentativa_id, questao_id, alternativa_id) ON DELETE RESTRICT,
    CONSTRAINT respostas_conteudo_valido CHECK (
        (alternativa_id IS NULL OR texto IS NULL)
        AND (texto IS NULL OR char_length(texto) <= 10000)
    )
);

ALTER TABLE public.respostas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.respostas FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION examentech_private.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_versao INTEGER,
    p_alternativa_id UUID DEFAULT NULL, p_texto TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_aluno_id UUID := auth.uid();
    v_organizacao_id UUID;
    v_acesso RECORD;
    v_tipo TEXT;
    v_texto TEXT := NULLIF(p_texto, '');
    v_resposta public.respostas%ROWTYPE;
    v_versao_atual INTEGER;
    v_agora TIMESTAMPTZ;
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
        RAISE EXCEPTION 'Salvamento exige aluno ativo, organização ativa, sessão e MFA.' USING ERRCODE = '42501';
    END IF;

    -- O lock da tentativa serializa os salvamentos e impede mudança de situação no meio da gravação.
    SELECT te.avaliacao_id, te.situacao AS tentativa_situacao, te.iniciada_em, te.limite_em,
           a.situacao AS avaliacao_situacao, a.inicio_em, a.fim_em, t.situacao AS turma_situacao
    INTO v_acesso
    FROM public.tentativas te
    JOIN public.avaliacoes a ON a.id = te.avaliacao_id
    JOIN public.turmas t ON t.id = a.turma_id
    JOIN public.turma_alunos m ON m.turma_id = t.id AND m.aluno_id = te.aluno_id
    WHERE te.id = p_tentativa_id AND te.aluno_id = v_aluno_id
      AND t.organizacao_id = v_organizacao_id AND m.situacao = 'ATIVA'
    FOR SHARE OF t, m, a FOR UPDATE OF te;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tentativa não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;

    SELECT q.tipo INTO v_tipo
    FROM public.tentativa_questoes tq
    JOIN public.questoes q ON q.id = tq.questao_id AND q.avaliacao_id = v_acesso.avaliacao_id
    WHERE tq.tentativa_id = p_tentativa_id AND tq.questao_id = p_questao_id
    FOR SHARE OF tq, q;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Questão não encontrada nesta tentativa.' USING ERRCODE = 'P0002';
    END IF;

    IF p_versao IS NULL OR p_versao <= 0 THEN
        RAISE EXCEPTION 'Informe uma versão positiva para a resposta.' USING ERRCODE = '23514';
    END IF;
    IF (v_tipo = 'OBJETIVA' AND p_texto IS NOT NULL)
       OR (v_tipo = 'DISSERTATIVA' AND p_alternativa_id IS NOT NULL)
       OR char_length(p_texto) > 10000 THEN
        RAISE EXCEPTION 'Resposta incompatível com o tipo da questão ou acima de 10000 caracteres.' USING ERRCODE = '23514';
    END IF;
    IF p_alternativa_id IS NOT NULL THEN
        PERFORM 1 FROM public.tentativa_alternativas ta
        JOIN public.alternativas a ON a.id = ta.alternativa_id AND a.questao_id = ta.questao_id
        WHERE ta.tentativa_id = p_tentativa_id AND ta.questao_id = p_questao_id
          AND ta.alternativa_id = p_alternativa_id
        FOR SHARE OF ta, a;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'A alternativa não pertence à questão desta tentativa.' USING ERRCODE = '23514';
        END IF;
    END IF;

    SELECT * INTO v_resposta FROM public.respostas
    WHERE tentativa_id = p_tentativa_id AND questao_id = p_questao_id;
    v_versao_atual := COALESCE(v_resposta.versao, 0);

    -- Conferir depois dos locks; now() usaria o horário de início da transação.
    v_agora := clock_timestamp();
    IF v_acesso.tentativa_situacao <> 'EM_ANDAMENTO'
       OR v_acesso.avaliacao_situacao <> 'PUBLICADA' OR v_acesso.turma_situacao <> 'ATIVA'
       OR v_agora < v_acesso.iniciada_em OR v_agora < v_acesso.inicio_em
       OR v_agora >= LEAST(v_acesso.limite_em, v_acesso.fim_em) THEN
        RAISE EXCEPTION 'A tentativa não está disponível para salvar respostas.' USING ERRCODE = '55000';
    END IF;

    -- Repetir a última versão com o mesmo conteúdo confirma o salvamento, sem outro evento.
    IF p_versao <> v_versao_atual
       OR ROW(p_alternativa_id, v_texto) IS DISTINCT FROM ROW(v_resposta.alternativa_id, v_resposta.texto) THEN
        IF p_versao::BIGINT <> v_versao_atual::BIGINT + 1 THEN
            RAISE EXCEPTION 'Versão da resposta desatualizada ou fora de sequência.' USING ERRCODE = '55000';
        END IF;

        INSERT INTO public.respostas (tentativa_id, questao_id, alternativa_id, texto, versao, criado_em, atualizado_em)
        VALUES (p_tentativa_id, p_questao_id, p_alternativa_id, v_texto, p_versao, v_agora, v_agora)
        ON CONFLICT (tentativa_id, questao_id) DO UPDATE
        SET alternativa_id = EXCLUDED.alternativa_id, texto = EXCLUDED.texto,
            versao = EXCLUDED.versao, atualizado_em = EXCLUDED.atualizado_em
        RETURNING * INTO v_resposta;

        -- RESPOSTA_SALVA já é permitido pela 025. Não registrar texto, alternativa ou gabarito no log.
        INSERT INTO public.eventos_seguranca (
            solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
        ) VALUES (
            gen_random_uuid(), 'RESPOSTA_SALVA', 'EXAMENTECH', 'salvar_resposta_tentativa',
            TRUE, v_aluno_id, v_resposta.id
        );
    END IF;

    RETURN jsonb_build_object(
        'id', v_resposta.id, 'tentativa_id', v_resposta.tentativa_id, 'questao_id', v_resposta.questao_id,
        'alternativa_id', v_resposta.alternativa_id, 'texto', v_resposta.texto, 'versao', v_resposta.versao,
        'criado_em', v_resposta.criado_em, 'atualizado_em', v_resposta.atualizado_em
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_versao INTEGER,
    p_alternativa_id UUID DEFAULT NULL, p_texto TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.salvar_resposta_tentativa(
    p_tentativa_id, p_questao_id, p_versao, p_alternativa_id, p_texto
) $$;

REVOKE ALL ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) TO authenticated;

COMMENT ON TABLE public.respostas IS
    'Última resposta recebida por questão da tentativa. Escrita somente pela função autorizada; sem exclusão direta ou correção neste bloco.';
COMMENT ON COLUMN public.respostas.versao IS
    'Sequência por tentativa e questão: inicia em 1. Repetir a versão atual só é permitido com o mesmo conteúdo.';

COMMIT;
