-- MODELO: o script local de preparação substitui os dois marcadores.
-- Execute somente depois de publicar e testar a Edge Function de limpeza.
-- Não substitua por chaves privadas do Supabase: o token é exclusivo da limpeza.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
    IF to_regprocedure('public.listar_fotos_para_limpeza()') IS NULL
       OR to_regclass('vault.decrypted_secrets') IS NULL THEN
        RAISE EXCEPTION 'Confira a migração 031 e a disponibilidade do Supabase Vault.';
    END IF;
    IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='examentech-fotos-retencao')
       OR EXISTS(SELECT 1 FROM vault.decrypted_secrets
         WHERE name IN ('examentech_fotos_cleanup_url','examentech_fotos_cleanup_token')) THEN
        RAISE EXCEPTION 'A configuração de limpeza já existe. Confira o agendamento antes de repetir.';
    END IF;
    IF '__CLEANUP_TOKEN__' !~ '^[a-f0-9]{64}$'
       OR '__PROJECT_URL__' !~ '^https://[a-z0-9]+\.supabase\.co$' THEN
        RAISE EXCEPTION 'Use o arquivo privado gerado pela preparação local, não este modelo.';
    END IF;
    PERFORM vault.create_secret('__PROJECT_URL__','examentech_fotos_cleanup_url');
    PERFORM vault.create_secret('__CLEANUP_TOKEN__','examentech_fotos_cleanup_token');
END;
$$;

SELECT cron.schedule('examentech-fotos-retencao','0 3 * * *',$job$
    SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='examentech_fotos_cleanup_url')
            || '/functions/v1/examentech-limpar-fotos',
        headers := jsonb_build_object('Content-Type','application/json',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
                WHERE name='examentech_fotos_cleanup_token')),
        body := '{}'::JSONB,
        timeout_milliseconds := 120000
    ) AS request_id;
$job$);
COMMIT;
