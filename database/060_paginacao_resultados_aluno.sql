-- RF27: aplicar após 059. Acrescenta páginas de 50 resultados sem alterar as regras de acesso.
BEGIN;

CREATE OR REPLACE FUNCTION public.listar_meus_resultados(p_pagina INTEGER)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_pagina IS NULL OR p_pagina < 0 THEN
        RAISE EXCEPTION 'Página inválida.' USING ERRCODE = '22023';
    END IF;

    -- O registro adicional informa se há uma próxima página.
    RETURN (
        SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.publicado_em DESC, r.tentativa_id), '[]'::JSONB)
        FROM (SELECT * FROM examentech_private.meus_resultados_publicados()
            ORDER BY publicado_em DESC, tentativa_id
            LIMIT 51 OFFSET (p_pagina::BIGINT * 50)) r
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.listar_meus_resultados()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(jsonb_agg(item ORDER BY posicao), '[]'::JSONB)
    FROM jsonb_array_elements(public.listar_meus_resultados(0))
        WITH ORDINALITY AS pagina(item, posicao)
    WHERE posicao <= 50;
$$;

REVOKE ALL ON FUNCTION public.listar_meus_resultados(), public.listar_meus_resultados(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.listar_meus_resultados(), public.listar_meus_resultados(INTEGER)
    TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
