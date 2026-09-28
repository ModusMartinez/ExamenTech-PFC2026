-- Aplicar depois de 009. Atualiza apenas as versões exigidas em novos cadastros.
-- Não altera contas, convites, permissões ou aceites já registrados.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'auth.users'::regclass
          AND tgname = 'examentech_registrar_aceite_termos'
          AND tgenabled IN ('O', 'A')
    ) OR pg_catalog.to_regprocedure('public.emitir_convite_professor(text,uuid)') IS NULL THEN
        RAISE EXCEPTION 'Aplique 008 e 009 antes de atualizar os documentos.';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF (NEW.raw_user_meta_data -> 'termos_aceitos') IS DISTINCT FROM 'true'::jsonb
       OR (NEW.raw_user_meta_data ->> 'termos_versao') IS DISTINCT FROM '2026-09-27-v3'
       OR (NEW.raw_user_meta_data ->> 'privacidade_versao') IS DISTINCT FROM '2026-09-27-v2' THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos Termos de Uso.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.aceites_termos (usuario_id, termos_versao, privacidade_versao, aceito_em)
    VALUES (NEW.id, '2026-09-27-v3', '2026-09-27-v2', NOW());
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_aceite_termos()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_aceite_termos()
TO supabase_auth_admin;

COMMIT;
