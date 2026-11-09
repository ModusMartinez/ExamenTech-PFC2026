-- Aplicar após 033 no banco da entrega0911. Não cria a tabela public.respostas.
-- A assinatura sem versão permanece disponível até a atualização da tela.
BEGIN;

DO $$
BEGIN
    IF to_regclass('public.respostas') IS NOT NULL THEN
        RAISE EXCEPTION 'Conciliar as duas tabelas de respostas antes de aplicar esta query.';
    END IF;
    IF (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'respostas_tentativa'
          AND column_name IN ('id', 'versao', 'criado_em')) <> 3
       OR NOT EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid = to_regclass('public.respostas_tentativa')
             AND tgname = 'respostas_tentativa_versionar' AND tgenabled IN ('O', 'A')
             AND tgfoid = to_regprocedure('examentech_private.versionar_resposta_tentativa()')
       ) THEN
        RAISE EXCEPTION 'Aplique a query 033 antes desta query.';
    END IF;
END;
$$;

-- A API permite limpar a resposta e preserva os espaços do texto dissertativo.
ALTER TABLE public.respostas_tentativa DROP CONSTRAINT IF EXISTS respostas_tentativa_formato;
ALTER TABLE public.respostas_tentativa ADD CONSTRAINT respostas_tentativa_formato CHECK (
    (alternativa_id IS NULL OR texto IS NULL)
    AND (texto IS NULL OR char_length(texto) <= 10000)
);

CREATE OR REPLACE FUNCTION examentech_private.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_versao INTEGER,
    p_alternativa_id UUID, p_texto TEXT
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
    v_resposta public.respostas_tentativa%ROWTYPE;
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

    SELECT * INTO v_resposta FROM public.respostas_tentativa
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

        -- O trigger da 033 mantém ID/data inicial e avança a versão na mesma gravação.
        INSERT INTO public.respostas_tentativa (tentativa_id, questao_id, alternativa_id, texto, salva_em)
        VALUES (p_tentativa_id, p_questao_id, p_alternativa_id, v_texto, v_agora)
        ON CONFLICT (tentativa_id, questao_id) DO UPDATE
        SET alternativa_id = EXCLUDED.alternativa_id, texto = EXCLUDED.texto,
            salva_em = EXCLUDED.salva_em
        RETURNING * INTO v_resposta;

        -- Mantém recurso_id apontando para a tentativa, como na RPC da entrega0911.
        INSERT INTO public.eventos_seguranca (
            solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
        ) VALUES (
            gen_random_uuid(), 'RESPOSTA_SALVA', 'EXAMENTECH', 'salvar_resposta_tentativa',
            TRUE, v_aluno_id, p_tentativa_id
        );
    END IF;

    RETURN jsonb_build_object(
        'id', v_resposta.id, 'tentativa_id', v_resposta.tentativa_id, 'questao_id', v_resposta.questao_id,
        'alternativa_id', v_resposta.alternativa_id, 'texto', v_resposta.texto, 'versao', v_resposta.versao,
        'criado_em', v_resposta.criado_em, 'atualizado_em', v_resposta.salva_em
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_versao INTEGER,
    p_alternativa_id UUID, p_texto TEXT
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.salvar_resposta_tentativa(
    p_tentativa_id, p_questao_id, p_versao, p_alternativa_id, p_texto
) $$;

REVOKE ALL ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, INTEGER, UUID, TEXT) IS
    'Salva em respostas_tentativa com versão sequencial. Repetir versão e conteúdo atuais confirma sem nova gravação ou evento.';
COMMENT ON COLUMN public.respostas_tentativa.versao IS
    'Sequência por questão. A RPC com versão exige a próxima; a RPC antiga continua avançando pelo trigger, sem conferir a versão enviada pelo aluno.';

NOTIFY pgrst, 'reload schema';
COMMIT;
