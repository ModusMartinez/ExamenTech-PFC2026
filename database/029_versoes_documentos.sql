-- Aplicar depois de 028, junto da interface com os documentos de novembro.
-- Aceites já registrados permanecem com as versões vistas no cadastro.
BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('public.aceites_termos') IS NULL
       OR NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'auth.users'::regclass
             AND tgname = 'examentech_registrar_aceite_termos'
             AND tgenabled IN ('O', 'A')
       ) THEN
        RAISE EXCEPTION 'Aplique 010 antes de atualizar as versões dos documentos.';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF (NEW.raw_user_meta_data -> 'termos_aceitos') IS DISTINCT FROM 'true'::jsonb
       OR (NEW.raw_user_meta_data ->> 'termos_versao') IS DISTINCT FROM '2026-11-06-v5'
       OR (NEW.raw_user_meta_data ->> 'privacidade_versao') IS DISTINCT FROM '2026-11-06-v4' THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos Termos de Uso.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.aceites_termos (usuario_id, termos_versao, privacidade_versao, aceito_em)
    VALUES (NEW.id, '2026-11-06-v5', '2026-11-06-v4', NOW());
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_aceite_termos()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_aceite_termos()
TO supabase_auth_admin;

COMMIT;
