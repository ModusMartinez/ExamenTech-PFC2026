-- Aplicar depois de 019. Edição dos dados do rascunho, sem mudar turma ou autoria.
BEGIN;

ALTER TABLE public.eventos_seguranca
DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca
ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA',
    'MATRICULA_SOLICITADA', 'MATRICULA_APROVADA', 'MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA', 'AVALIACAO_EDITADA'
));

CREATE OR REPLACE FUNCTION examentech_private.editar_avaliacao_rascunho(
    p_avaliacao_id UUID, p_titulo TEXT, p_tipo TEXT,
    p_inicio_em TIMESTAMPTZ, p_fim_em TIMESTAMPTZ, p_duracao_minutos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_professor_id UUID := auth.uid();
    v_organizacao_id UUID;
    v_turma public.turmas%ROWTYPE;
    v_avaliacao public.avaliacoes%ROWTYPE;
BEGIN
    SELECT p.organizacao_id INTO v_organizacao_id
    FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    JOIN auth.sessions s ON s.user_id = p.id
    WHERE p.id = v_professor_id AND p.perfil = 'PROFESSOR'
      AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
      AND (auth.jwt() ->> 'aal') = 'aal2'
      AND s.id::TEXT = (auth.jwt() ->> 'session_id')
    FOR SHARE OF p, o, s;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Edição exige professor ativo, organização ativa, sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    SELECT t.* INTO v_turma FROM public.turmas t
    JOIN public.avaliacoes a ON a.turma_id = t.id
    WHERE a.id = p_avaliacao_id AND a.professor_id = v_professor_id
      AND t.professor_id = v_professor_id AND t.organizacao_id = v_organizacao_id
    FOR SHARE OF t;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_turma.situacao <> 'ATIVA' THEN
        RAISE EXCEPTION 'A turma está inativa.' USING ERRCODE = '55000';
    END IF;

    -- Bloqueia a linha antes de conferir a situação e alterar seus campos.
    SELECT * INTO v_avaliacao FROM public.avaliacoes
    WHERE id = p_avaliacao_id AND turma_id = v_turma.id AND professor_id = v_professor_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou acesso não autorizado.' USING ERRCODE = 'P0002';
    END IF;
    IF v_avaliacao.situacao <> 'RASCUNHO' THEN
        RAISE EXCEPTION 'Somente avaliações em rascunho podem ser editadas.' USING ERRCODE = '55000';
    END IF;

    -- Salvar os mesmos valores não altera a linha nem cria outro evento.
    IF ROW(v_avaliacao.titulo, v_avaliacao.tipo, v_avaliacao.inicio_em,
           v_avaliacao.fim_em, v_avaliacao.duracao_minutos)
       IS NOT DISTINCT FROM ROW(btrim(p_titulo), p_tipo, p_inicio_em, p_fim_em, p_duracao_minutos) THEN
        RETURN to_jsonb(v_avaliacao);
    END IF;

    -- Reutiliza as constraints da 019; não permite trocar turma, autor ou situação.
    UPDATE public.avaliacoes
    SET titulo = btrim(p_titulo), tipo = p_tipo, inicio_em = p_inicio_em,
        fim_em = p_fim_em, duracao_minutos = p_duracao_minutos
    WHERE id = v_avaliacao.id
    RETURNING * INTO v_avaliacao;

    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'AVALIACAO_EDITADA', 'EXAMENTECH',
        'editar_avaliacao_rascunho', TRUE, v_professor_id, v_avaliacao.id
    );

    RETURN to_jsonb(v_avaliacao);
END;
$$;

CREATE OR REPLACE FUNCTION public.editar_avaliacao_rascunho(
    p_avaliacao_id UUID, p_titulo TEXT, p_tipo TEXT,
    p_inicio_em TIMESTAMPTZ, p_fim_em TIMESTAMPTZ, p_duracao_minutos INTEGER
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.editar_avaliacao_rascunho(
    p_avaliacao_id, p_titulo, p_tipo, p_inicio_em, p_fim_em, p_duracao_minutos
) $$;

REVOKE ALL ON FUNCTION examentech_private.editar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.editar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.editar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.editar_avaliacao_rascunho(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
TO authenticated;

COMMENT ON TABLE public.avaliacoes IS
    'Avaliação da turma inteira. Funções controlam criação e edição em RASCUNHO; escrita direta, publicação e exclusão bloqueadas.';

COMMIT;
