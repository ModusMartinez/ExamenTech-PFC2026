-- Continuação da sequência da branch desenv (023-027). Para o banco de testes
-- com tentativas do protótipo antigo, executar antes docs/conciliar-banco-provas-teste.sql.
BEGIN;

ALTER TABLE public.tentativas ADD COLUMN IF NOT EXISTS encerrada_em TIMESTAMPTZ;
ALTER TABLE public.tentativas ADD COLUMN IF NOT EXISTS falhas_camera INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.tentativas ADD COLUMN IF NOT EXISTS aviso_versao TEXT;
ALTER TABLE public.tentativas ADD COLUMN IF NOT EXISTS aviso_aceito_em TIMESTAMPTZ;
ALTER TABLE public.tentativas DROP CONSTRAINT IF EXISTS tentativas_situacao_check;
ALTER TABLE public.tentativas ADD CONSTRAINT tentativas_situacao_check
    CHECK (situacao IN ('EM_ANDAMENTO', 'FINALIZADA', 'INTERROMPIDA'));
ALTER TABLE public.tentativas ADD CONSTRAINT tentativas_encerramento_coerente
    CHECK ((situacao = 'EM_ANDAMENTO' AND encerrada_em IS NULL)
        OR (situacao <> 'EM_ANDAMENTO' AND encerrada_em IS NOT NULL));
ALTER TABLE public.tentativas ADD CONSTRAINT tentativas_falhas_camera_validas
    CHECK (falhas_camera BETWEEN 0 AND 1);
ALTER TABLE public.tentativas ADD CONSTRAINT tentativas_aviso_coerente
    CHECK ((aviso_versao IS NULL AND aviso_aceito_em IS NULL)
        OR (aviso_versao IS NOT NULL AND aviso_aceito_em IS NOT NULL));

-- O início anterior fica inacessível ao navegador. Esta função grava a ciência
-- no mesmo commit da tentativa e da auditoria da migração 025.
CREATE OR REPLACE FUNCTION examentech_private.iniciar_tentativa_com_aviso(
    p_avaliacao_id UUID, p_aviso_versao TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_resultado JSONB;
    v_tentativa public.tentativas%ROWTYPE;
BEGIN
    IF p_aviso_versao IS DISTINCT FROM '2026-11-06-v2' THEN
        RAISE EXCEPTION 'Aviso da prova não confirmado.' USING ERRCODE = '23514';
    END IF;
    v_resultado := examentech_private.iniciar_tentativa(p_avaliacao_id);
    UPDATE public.tentativas SET aviso_versao = p_aviso_versao,
        aviso_aceito_em = iniciada_em
    WHERE id = (v_resultado ->> 'id')::UUID RETURNING * INTO v_tentativa;
    RETURN to_jsonb(v_tentativa);
END;
$$;

CREATE OR REPLACE FUNCTION public.iniciar_tentativa(p_avaliacao_id UUID, p_aviso_versao TEXT)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.iniciar_tentativa_com_aviso(p_avaliacao_id, p_aviso_versao) $$;

REVOKE ALL ON FUNCTION public.iniciar_tentativa(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.iniciar_tentativa(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.iniciar_tentativa(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.iniciar_tentativa_com_aviso(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iniciar_tentativa(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.iniciar_tentativa_com_aviso(UUID, TEXT) TO authenticated;

CREATE TABLE public.respostas_tentativa (
    tentativa_id UUID NOT NULL,
    questao_id UUID NOT NULL,
    alternativa_id UUID,
    texto TEXT,
    salva_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tentativa_id, questao_id),
    FOREIGN KEY (tentativa_id, questao_id)
        REFERENCES public.tentativa_questoes(tentativa_id, questao_id) ON DELETE RESTRICT,
    FOREIGN KEY (tentativa_id, alternativa_id)
        REFERENCES public.tentativa_alternativas(tentativa_id, alternativa_id) ON DELETE RESTRICT,
    CONSTRAINT respostas_tentativa_formato CHECK
        ((alternativa_id IS NOT NULL AND texto IS NULL)
         OR (alternativa_id IS NULL AND texto IS NOT NULL
             AND length(btrim(texto)) BETWEEN 1 AND 10000))
);
ALTER TABLE public.respostas_tentativa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.respostas_tentativa FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.respostas_tentativa TO authenticated;
CREATE POLICY respostas_tentativa_consultar ON public.respostas_tentativa
FOR SELECT TO authenticated USING (
    EXISTS (
        SELECT 1 FROM public.tentativas te
        WHERE te.id = tentativa_id
          AND examentech_private.pode_consultar_tentativa(te.avaliacao_id, te.aluno_id)
    )
);

ALTER TABLE public.eventos_seguranca DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA', 'MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA', 'AVALIACAO_EDITADA', 'QUESTAO_CRIADA', 'ALTERNATIVAS_CRIADAS',
    'AVALIACAO_PUBLICADA', 'TENTATIVA_INICIADA', 'RESPOSTA_SALVA',
    'TENTATIVA_FINALIZADA', 'TENTATIVA_INTERROMPIDA', 'TENTATIVA_RETOMADA',
    -- Preserva eventos registrados pelo protótipo antigo no banco de testes.
    'CAMERA_FALHA', 'TENTATIVA_DESBLOQUEADA'
));

-- Uma única função de autorização para todas as operações de escrita da tentativa.
-- O bloqueio da linha serializa resposta, envio e interrupção.
CREATE OR REPLACE FUNCTION examentech_private.tentativa_do_aluno(p_tentativa_id UUID)
RETURNS public.tentativas
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
BEGIN
    PERFORM 1 FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    JOIN auth.sessions s ON s.user_id = p.id
    WHERE p.id = auth.uid() AND p.perfil = 'ALUNO'
      AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
      AND (auth.jwt() ->> 'aal') = 'aal2'
      AND s.id::TEXT = (auth.jwt() ->> 'session_id');
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Operação exige aluno ativo, sessão e MFA.' USING ERRCODE = '42501';
    END IF;

    SELECT te.* INTO v_tentativa
    FROM public.tentativas te
    JOIN public.avaliacoes a ON a.id = te.avaliacao_id
    JOIN public.turmas t ON t.id = a.turma_id
    JOIN public.turma_alunos m ON m.turma_id = t.id AND m.aluno_id = te.aluno_id
    JOIN public.perfis p ON p.id = te.aluno_id
    WHERE te.id = p_tentativa_id AND te.aluno_id = auth.uid()
      AND p.organizacao_id = t.organizacao_id
      AND a.situacao = 'PUBLICADA' AND t.situacao = 'ATIVA' AND m.situacao = 'ATIVA'
    FOR UPDATE OF te;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tentativa não encontrada ou sem acesso.' USING ERRCODE = 'P0002';
    END IF;
    RETURN v_tentativa;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_alternativa_id UUID, p_texto TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_tipo TEXT;
    v_texto TEXT;
    v_resposta public.respostas_tentativa%ROWTYPE;
BEGIN
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO'
       OR clock_timestamp() >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
    END IF;

    SELECT q.tipo INTO v_tipo
    FROM public.tentativa_questoes tq
    JOIN public.questoes q ON q.id = tq.questao_id AND q.avaliacao_id = v_tentativa.avaliacao_id
    WHERE tq.tentativa_id = p_tentativa_id AND tq.questao_id = p_questao_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Questão não pertence à tentativa.' USING ERRCODE = 'P0002';
    END IF;

    IF v_tipo = 'OBJETIVA' THEN
        IF p_alternativa_id IS NULL OR p_texto IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM public.tentativa_alternativas ta
            WHERE ta.tentativa_id = p_tentativa_id AND ta.questao_id = p_questao_id
              AND ta.alternativa_id = p_alternativa_id
        ) THEN
            RAISE EXCEPTION 'Alternativa inválida para a questão.' USING ERRCODE = '23514';
        END IF;
    ELSE
        v_texto := btrim(p_texto);
        IF p_alternativa_id IS NOT NULL OR v_texto IS NULL
           OR length(v_texto) NOT BETWEEN 1 AND 10000 THEN
            RAISE EXCEPTION 'Resposta dissertativa inválida.' USING ERRCODE = '23514';
        END IF;
    END IF;

    INSERT INTO public.respostas_tentativa
        (tentativa_id, questao_id, alternativa_id, texto)
    VALUES (p_tentativa_id, p_questao_id, p_alternativa_id, v_texto)
    ON CONFLICT (tentativa_id, questao_id) DO UPDATE SET
        alternativa_id = EXCLUDED.alternativa_id, texto = EXCLUDED.texto,
        salva_em = clock_timestamp()
    RETURNING * INTO v_resposta;

    INSERT INTO public.eventos_seguranca
        (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(), 'RESPOSTA_SALVA', 'EXAMENTECH',
            'salvar_resposta_tentativa', TRUE, auth.uid(), p_tentativa_id);

    RETURN jsonb_build_object('questao_id', v_resposta.questao_id,
        'alternativa_id', v_resposta.alternativa_id, 'texto', v_resposta.texto,
        'salva_em', v_resposta.salva_em);
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.encerrar_tentativa(
    p_tentativa_id UUID, p_motivo TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_agora TIMESTAMPTZ;
    v_situacao TEXT;
BEGIN
    IF p_motivo NOT IN ('ENVIO', 'PRAZO', 'CAMERA', 'SAIDA') OR p_motivo IS NULL THEN
        RAISE EXCEPTION 'Motivo inválido.' USING ERRCODE = '23514';
    END IF;
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO' THEN
        -- Repetir uma confirmação perdida não reabre nem duplica a auditoria.
        IF (p_motivo IN ('ENVIO', 'PRAZO') AND v_tentativa.situacao = 'FINALIZADA')
           OR (p_motivo IN ('CAMERA', 'SAIDA') AND v_tentativa.situacao = 'INTERROMPIDA') THEN
            RETURN jsonb_build_object('id', v_tentativa.id,
                'situacao', v_tentativa.situacao, 'encerrada_em', v_tentativa.encerrada_em,
                'falhas_camera', v_tentativa.falhas_camera);
        END IF;
        RAISE EXCEPTION 'Tentativa já encerrada.' USING ERRCODE = '55000';
    END IF;
    v_agora := clock_timestamp();
    IF p_motivo = 'ENVIO' AND v_agora >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Prazo da tentativa encerrado.' USING ERRCODE = '55000';
    END IF;
    IF p_motivo = 'PRAZO' AND v_agora < v_tentativa.limite_em THEN
        RAISE EXCEPTION 'O prazo da tentativa ainda não terminou.' USING ERRCODE = '55000';
    END IF;
    v_situacao := CASE WHEN p_motivo IN ('ENVIO', 'PRAZO') THEN 'FINALIZADA' ELSE 'INTERROMPIDA' END;
    UPDATE public.tentativas SET situacao = v_situacao, encerrada_em = v_agora,
        falhas_camera = CASE WHEN p_motivo = 'CAMERA' THEN 1 ELSE falhas_camera END
    WHERE id = p_tentativa_id RETURNING * INTO v_tentativa;

    INSERT INTO public.eventos_seguranca
        (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(),
        CASE WHEN p_motivo IN ('ENVIO', 'PRAZO') THEN 'TENTATIVA_FINALIZADA' ELSE 'TENTATIVA_INTERROMPIDA' END,
        'EXAMENTECH', CASE WHEN p_motivo = 'CAMERA' THEN 'falha_camera'
            WHEN p_motivo = 'SAIDA' THEN 'saida_tentativa'
            WHEN p_motivo = 'PRAZO' THEN 'prazo_tentativa' ELSE 'finalizar_tentativa' END,
        TRUE, auth.uid(), p_tentativa_id);

    RETURN jsonb_build_object('id', v_tentativa.id, 'situacao', v_tentativa.situacao,
        'encerrada_em', v_tentativa.encerrada_em, 'falhas_camera', v_tentativa.falhas_camera);
END;
$$;

CREATE OR REPLACE FUNCTION public.salvar_resposta_tentativa(
    p_tentativa_id UUID, p_questao_id UUID, p_alternativa_id UUID, p_texto TEXT)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.salvar_resposta_tentativa(
    p_tentativa_id, p_questao_id, p_alternativa_id, p_texto) $$;

CREATE OR REPLACE FUNCTION public.encerrar_tentativa(p_tentativa_id UUID, p_motivo TEXT)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.encerrar_tentativa(p_tentativa_id, p_motivo) $$;

REVOKE ALL ON FUNCTION examentech_private.tentativa_do_aluno(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.encerrar_tentativa(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encerrar_tentativa(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.tentativa_do_aluno(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.encerrar_tentativa(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.encerrar_tentativa(UUID, TEXT) TO authenticated;

COMMENT ON TABLE public.respostas_tentativa IS
    'Respostas da tentativa única; escrita somente pelas funções com autorização e auditoria.';
COMMENT ON FUNCTION public.encerrar_tentativa(UUID, TEXT) IS
    'Envio final ou interrupção definitiva por câmera/saída. Uma tentativa encerrada não pode ser retomada.';

COMMIT;
