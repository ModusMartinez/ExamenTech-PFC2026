-- Aplicar depois de 013. Aprova somente matrículas pendentes; não altera contas.
BEGIN;

ALTER TABLE public.eventos_seguranca
DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca
ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA'
));

CREATE OR REPLACE FUNCTION examentech_private.aprovar_matricula(p_matricula_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_responsavel_id UUID := auth.uid();
    v_turma public.turmas%ROWTYPE;
    v_matricula public.turma_alunos%ROWTYPE;
BEGIN
    -- Mantém a sessão e o perfil do aprovador válidos até concluir a operação.
    PERFORM 1 FROM public.perfis p
    JOIN auth.sessions s ON s.user_id = p.id
    WHERE p.id = v_responsavel_id AND p.perfil IN ('PROFESSOR', 'ADMIN')
      AND p.situacao = 'ATIVO' AND (auth.jwt() ->> 'aal') = 'aal2'
      AND s.id::TEXT = (auth.jwt() ->> 'session_id')
    FOR SHARE OF p, s;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aprovação exige professor ou administrador ativo, com sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    SELECT t.* INTO v_turma FROM public.turmas t
    JOIN public.turma_alunos m ON m.turma_id = t.id
    WHERE m.id = p_matricula_id
      AND examentech_private.pode_consultar_turma(t.professor_id, t.organizacao_id)
    FOR SHARE OF t;
    IF NOT FOUND THEN
        -- A mesma resposta evita revelar vínculos de outro professor/organização.
        RAISE EXCEPTION 'Matrícula não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;

    -- Serializa aprovações do mesmo vínculo, evitando dois eventos de sucesso.
    SELECT * INTO v_matricula FROM public.turma_alunos
    WHERE id = p_matricula_id AND turma_id = v_turma.id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Matrícula não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_matricula.situacao <> 'PENDENTE' OR v_turma.situacao <> 'ATIVA' THEN
        RAISE EXCEPTION 'A matrícula não está pendente ou não pode ser aprovada.' USING ERRCODE = '55000';
    END IF;

    PERFORM 1 FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    WHERE p.id = v_matricula.aluno_id AND p.perfil = 'ALUNO' AND p.situacao = 'ATIVO'
      AND p.organizacao_id = v_turma.organizacao_id AND o.situacao = 'ATIVO'
    FOR SHARE OF p, o;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'A matrícula não está pendente ou não pode ser aprovada.' USING ERRCODE = '55000';
    END IF;

    UPDATE public.turma_alunos SET situacao = 'ATIVA'
    WHERE id = v_matricula.id
    RETURNING * INTO v_matricula;

    -- Falha na auditoria desfaz a aprovação. O ator é o aprovador, não o aluno.
    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'MATRICULA_APROVADA', 'EXAMENTECH',
        'aprovar_matricula', TRUE, v_responsavel_id, v_matricula.id
    );

    RETURN jsonb_build_object(
        'id', v_matricula.id, 'turma_id', v_turma.id, 'turma_nome', v_turma.nome,
        'situacao', v_matricula.situacao, 'solicitado_em', v_matricula.solicitado_em
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.aprovar_matricula(p_matricula_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.aprovar_matricula(p_matricula_id) $$;

REVOKE ALL ON FUNCTION examentech_private.aprovar_matricula(UUID)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aprovar_matricula(UUID)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.aprovar_matricula(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.aprovar_matricula(UUID) TO authenticated;

COMMENT ON TABLE public.turma_alunos IS
    'Vínculo único aluno/turma. Funções controlam solicitação e aprovação; escrita direta continua bloqueada.';

COMMIT;
