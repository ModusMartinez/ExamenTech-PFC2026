-- Aplicar após 057. Mantém a consulta anterior e acrescenta páginas de 50 tentativas.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.listar_tentativas_responsavel(p_avaliacao_id UUID, p_pagina INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_resultado JSONB;
BEGIN
    IF examentech_private.responsavel_pode_gerir_avaliacao(p_avaliacao_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou sem acesso.' USING ERRCODE = '42501';
    END IF;
    IF p_pagina IS NULL OR p_pagina < 0 THEN
        RAISE EXCEPTION 'Página inválida.' USING ERRCODE = '22023';
    END IF;

    -- O registro adicional informa se há uma próxima página.
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.iniciada_em DESC, item.id), '[]'::JSONB)
    INTO v_resultado FROM (
        SELECT te.id, te.avaliacao_id, te.aluno_id, p.nome AS aluno_nome, te.situacao,
            te.iniciada_em, te.limite_em, te.encerrada_em, te.ciclo, te.retomada_autorizada
        FROM public.tentativas te JOIN public.perfis p ON p.id = te.aluno_id
        WHERE te.avaliacao_id = p_avaliacao_id
        ORDER BY te.iniciada_em DESC, te.id
        LIMIT 51 OFFSET (p_pagina::BIGINT * 50)
    ) item;
    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(), 'TENTATIVAS_CONSULTADAS', 'EXAMENTECH', 'listar_tentativas_responsavel', TRUE, auth.uid(), p_avaliacao_id);
    RETURN v_resultado;
END;
$$;

-- A assinatura antiga continua retornando no máximo 50 itens, com a mesma autorização e auditoria.
CREATE OR REPLACE FUNCTION public.listar_tentativas_responsavel(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(jsonb_agg(item ORDER BY posicao), '[]'::JSONB)
    FROM jsonb_array_elements(public.listar_tentativas_responsavel(p_avaliacao_id, 0))
        WITH ORDINALITY AS pagina(item, posicao)
    WHERE posicao <= 50;
$$;

REVOKE ALL ON FUNCTION public.listar_tentativas_responsavel(UUID),
    public.listar_tentativas_responsavel(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_tentativas_responsavel(UUID),
    public.listar_tentativas_responsavel(UUID, INTEGER) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
