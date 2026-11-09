-- Executar APÓS o arquivo privado agendar-limpeza-fotos.sql.local.
-- Confere o trabalho ativo e dispara uma chamada de limpeza usando o Vault.
-- A chamada remove somente arquivos elegíveis segundo a migração 031.
-- O resultado mostra apenas a configuração do trabalho e o request_id, sem token.
SELECT
    j.jobname,
    j.active,
    j.schedule,
    net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='examentech_fotos_cleanup_url')
            || '/functions/v1/examentech-limpar-fotos',
        headers := jsonb_build_object('Content-Type','application/json',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
                WHERE name='examentech_fotos_cleanup_token')),
        body := '{}'::JSONB,
        timeout_milliseconds := 120000
    ) AS request_id
FROM cron.job j
WHERE j.jobname='examentech-fotos-retencao' AND j.active=TRUE;
