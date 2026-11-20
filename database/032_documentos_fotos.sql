-- Aplicar após 029, 030 e 031, junto da ativação das novas telas.
-- Não altera registros de aceites anteriores e não ativa o envio de fotografias.
BEGIN;
DO $$ BEGIN
    IF pg_catalog.to_regclass('public.aceites_termos') IS NULL
       OR pg_catalog.to_regclass('public.fotos_tentativa') IS NULL
       OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='auth.users'::regclass
           AND tgname='examentech_registrar_aceite_termos' AND tgenabled IN ('O','A')) THEN
        RAISE EXCEPTION 'Confira 010, 029, 030 e 031 antes desta atualização.';
    END IF;
END $$;
CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF (NEW.raw_user_meta_data->'termos_aceitos') IS DISTINCT FROM 'true'::JSONB
       OR (NEW.raw_user_meta_data->>'termos_versao') IS DISTINCT FROM '2026-11-08-v6'
       OR (NEW.raw_user_meta_data->>'privacidade_versao') IS DISTINCT FROM '2026-11-08-v5' THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos documentos.' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.aceites_termos(usuario_id,termos_versao,privacidade_versao,aceito_em)
    VALUES(NEW.id,'2026-11-08-v6','2026-11-08-v5',clock_timestamp());
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.registrar_aceite_termos() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_aceite_termos() TO supabase_auth_admin;
COMMIT;
