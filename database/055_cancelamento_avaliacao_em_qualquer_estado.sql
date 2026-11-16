-- RF28: inclui rascunhos e avaliações com resultado divulgado.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.avaliacoes DROP CONSTRAINT avaliacoes_publicacao_valida;
ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_publicacao_valida CHECK (
    (situacao = 'RASCUNHO' AND publicada_em IS NULL)
    OR (situacao = 'PUBLICADA' AND publicada_em IS NOT NULL AND isfinite(publicada_em))
    OR (situacao = 'CANCELADA' AND (publicada_em IS NULL OR isfinite(publicada_em)))
);

ALTER TABLE public.avaliacoes DROP CONSTRAINT avaliacoes_cancelamento_valido;
ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_cancelamento_valido CHECK (
    (situacao <> 'CANCELADA' AND cancelada_em IS NULL)
    OR (situacao = 'CANCELADA' AND cancelada_em IS NOT NULL AND isfinite(cancelada_em)
        AND (publicada_em IS NULL OR cancelada_em >= publicada_em))
);

CREATE OR REPLACE FUNCTION public.cancelar_avaliacao(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_cancelada_em TIMESTAMPTZ;
BEGIN
    SELECT a.* INTO v_avaliacao FROM public.avaliacoes a
    JOIN public.perfis p ON p.id = a.professor_id AND p.perfil = 'PROFESSOR'
    WHERE a.id = p_avaliacao_id AND a.professor_id = auth.uid()
      AND examentech_private.responsavel_pode_gerir_avaliacao(a.id)
    FOR UPDATE OF a;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Somente o professor autor pode cancelar a avaliação.' USING ERRCODE = '42501';
    END IF;

    IF v_avaliacao.situacao = 'CANCELADA' THEN
        v_cancelada_em := v_avaliacao.cancelada_em;
    ELSE
        v_cancelada_em := clock_timestamp();
        UPDATE public.avaliacoes SET situacao = 'CANCELADA', cancelada_em = v_cancelada_em
        WHERE id = v_avaliacao.id;

        -- Mantém as respostas e o histórico. Só as tentativas em curso mudam de estado.
        UPDATE public.tentativas SET situacao = 'CANCELADA', encerrada_em = v_cancelada_em
        WHERE avaliacao_id = v_avaliacao.id AND situacao = 'EM_ANDAMENTO';

        INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
        VALUES (gen_random_uuid(), 'AVALIACAO_CANCELADA', 'EXAMENTECH', 'cancelar_avaliacao', TRUE, auth.uid(), v_avaliacao.id);
    END IF;

    RETURN jsonb_build_object('id', v_avaliacao.id, 'situacao', 'CANCELADA', 'cancelada_em', v_cancelada_em);
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_avaliacao(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_avaliacao(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
