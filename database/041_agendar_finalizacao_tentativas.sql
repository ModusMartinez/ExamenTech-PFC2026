-- Aplicar no SQL Editor do Supabase como postgres após 040.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('examentech-finalizar-tentativas', '* * * * *',
    'SELECT examentech_private.finalizar_tentativas_vencidas()');
COMMIT;
