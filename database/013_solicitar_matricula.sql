-- Aplicar depois de 012. Solicita ingresso, sem aprovar ou reativar matrículas.
BEGIN;

ALTER TABLE public.eventos_seguranca
DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca
ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA'
));

CREATE OR REPLACE FUNCTION examentech_private.solicitar_matricula(p_codigo TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_aluno_id UUID := auth.uid();
    v_codigo TEXT := upper(btrim(COALESCE(p_codigo, '')));
    v_organizacao_id UUID;
    v_turma public.turmas%ROWTYPE;
    v_matricula public.turma_alunos%ROWTYPE;
BEGIN
    IF v_aluno_id IS NULL OR (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS (
           SELECT 1 FROM auth.sessions
           WHERE id::TEXT = (auth.jwt() ->> 'session_id') AND user_id = v_aluno_id
       ) THEN
        RAISE EXCEPTION 'Sessão válida com MFA obrigatório.' USING ERRCODE = '42501';
    END IF;

    -- Mantém perfil, organização e turma estáveis durante a solicitação.
    SELECT p.organizacao_id INTO v_organizacao_id
    FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    WHERE p.id = v_aluno_id AND p.perfil = 'ALUNO'
      AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
    FOR SHARE OF p, o;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Somente aluno ativo de uma organização ativa pode solicitar.'
            USING ERRCODE = '42501';
    END IF;

    IF v_codigo !~ '^[A-F0-9]{12}$' THEN
        RAISE EXCEPTION 'Código de turma inválido ou indisponível.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_turma FROM public.turmas
    WHERE codigo_ingresso = v_codigo AND situacao = 'ATIVA'
      AND organizacao_id = v_organizacao_id
    FOR SHARE;
    IF NOT FOUND THEN
        -- Não revela se um código pertence a outra organização.
        RAISE EXCEPTION 'Código de turma inválido ou indisponível.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.turma_alunos (turma_id, aluno_id, situacao)
    VALUES (v_turma.id, v_aluno_id, 'PENDENTE')
    ON CONFLICT (turma_id, aluno_id) DO NOTHING
    RETURNING * INTO v_matricula;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Já existe uma matrícula nesta turma.' USING ERRCODE = '23505';
    END IF;

    -- Na mesma transação: falha na auditoria desfaz a solicitação.
    -- Não grava o código de ingresso. Sem sessao_id para permitir várias turmas por sessão.
    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'MATRICULA_SOLICITADA', 'EXAMENTECH',
        'solicitar_matricula', TRUE, v_aluno_id, v_matricula.id
    );

    RETURN jsonb_build_object(
        'id', v_matricula.id, 'turma_id', v_turma.id, 'turma_nome', v_turma.nome,
        'situacao', v_matricula.situacao, 'solicitado_em', v_matricula.solicitado_em
    );
END;
$$;

-- Mesmo padrão dos convites: entrada pública sem privilégios elevados,
-- com a regra e a escrita controlada na função privada.
CREATE OR REPLACE FUNCTION public.solicitar_matricula(p_codigo TEXT)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.solicitar_matricula(p_codigo) $$;

REVOKE ALL ON FUNCTION examentech_private.solicitar_matricula(TEXT)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.solicitar_matricula(TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.solicitar_matricula(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_matricula(TEXT) TO authenticated;

COMMENT ON TABLE public.turma_alunos IS
    'Vínculo único aluno/turma. Solicitação por código gera PENDENTE; escrita direta continua bloqueada.';

COMMIT;
