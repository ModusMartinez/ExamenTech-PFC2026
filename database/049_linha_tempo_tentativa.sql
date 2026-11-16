-- RF37: linha do tempo por tentativa para o responsável da avaliação.
-- Aplicar depois das migrações de identidade 045–048.
BEGIN;

CREATE OR REPLACE FUNCTION public.listar_linha_tempo_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    SELECT te.* INTO v_tentativa FROM public.tentativas te
    WHERE te.id = p_tentativa_id
      AND examentech_private.responsavel_pode_gerir_avaliacao(te.avaliacao_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tentativa não encontrada ou sem acesso.' USING ERRCODE = '42501';
    END IF;

    RETURN (
        SELECT COALESCE(jsonb_agg(to_jsonb(itens) ORDER BY ocorrido_em, tipo, id), '[]'::JSONB)
        FROM (
            SELECT e.id, e.criado_em AS ocorrido_em, 'EVENTO'::TEXT AS tipo,
                e.evento AS titulo, e.acao AS detalhe, NULL::TEXT AS situacao,
                NULL::TEXT AS momento, NULL::TIMESTAMPTZ AS expira_em
            FROM public.eventos_seguranca e
            WHERE e.recurso_id = p_tentativa_id
               OR e.recurso_id IN (SELECT f.id FROM public.fotos_tentativa f WHERE f.tentativa_id = p_tentativa_id)
            UNION ALL
            SELECT f.id, COALESCE(f.recebida_em, f.agendada_em) AS ocorrido_em,
                'FOTO'::TEXT AS tipo, 'Captura de foto'::TEXT AS titulo,
                CASE f.momento WHEN 'INICIAL' THEN 'Foto inicial' ELSE 'Foto durante a prova' END AS detalhe,
                CASE WHEN f.expira_em <= clock_timestamp() THEN 'EXCLUIDA' ELSE f.situacao END AS situacao,
                f.momento, f.expira_em
            FROM public.fotos_tentativa f WHERE f.tentativa_id = p_tentativa_id
        ) itens
    );
END;
$$;
REVOKE ALL ON FUNCTION public.listar_linha_tempo_tentativa(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_linha_tempo_tentativa(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
