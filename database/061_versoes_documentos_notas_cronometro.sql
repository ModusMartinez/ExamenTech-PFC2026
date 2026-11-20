-- Aplicar após 060, junto da interface com os textos de notas e cronômetro atualizados.
-- Novos cadastros exigem as versões abaixo; os aceites existentes são preservados.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF (NEW.raw_user_meta_data -> 'termos_aceitos') IS DISTINCT FROM 'true'::JSONB
       OR NOT (
           ((NEW.raw_user_meta_data ->> 'termos_versao') IS NOT DISTINCT FROM '2026-11-18-v13'
            AND (NEW.raw_user_meta_data ->> 'privacidade_versao') IS NOT DISTINCT FROM '2026-11-18-v10')
           OR ((NEW.raw_user_meta_data ->> 'termos_versao') IS NOT DISTINCT FROM '2026-11-18-v14'
            AND (NEW.raw_user_meta_data ->> 'privacidade_versao') IS NOT DISTINCT FROM '2026-11-18-v11')
       ) THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos documentos.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.aceites_termos (usuario_id, termos_versao, privacidade_versao, aceito_em)
    VALUES (NEW.id, NEW.raw_user_meta_data ->> 'termos_versao',
        NEW.raw_user_meta_data ->> 'privacidade_versao', clock_timestamp());
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_aceite_termos() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_aceite_termos() TO supabase_auth_admin;

ALTER TABLE public.avisos_fotos_tentativa
    ALTER COLUMN termos_versao SET DEFAULT '2026-11-18-v13',
    ALTER COLUMN privacidade_versao SET DEFAULT '2026-11-18-v10';
COMMIT;
