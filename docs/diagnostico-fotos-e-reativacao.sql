-- Somente leitura: não cria tabelas, não ativa coleta e não mostra dados pessoais.
SELECT
    to_regclass('public.tentativas') IS NOT NULL AS tentativas,
    to_regclass('public.respostas_tentativa') IS NOT NULL AS respostas_canonicas,
    to_regprocedure('public.iniciar_tentativa(uuid,text)') IS NOT NULL AS inicio_com_aviso,
    to_regprocedure('public.encerrar_tentativa(uuid,text)') IS NOT NULL AS encerramento,
    to_regclass('public.aceites_termos') IS NOT NULL AS aceites_documentos,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='auth.users'::regclass
        AND tgname='examentech_registrar_aceite_termos' AND tgenabled IN ('O','A')) AS gatilho_aceite_ativo,
    to_regprocedure('public.reativar_tentativa(uuid,text,integer)') IS NOT NULL AS reativacao_030,
    to_regclass('public.fotos_tentativa') IS NOT NULL AS fotos_031,
    to_regprocedure('public.iniciar_tentativa_com_fotos(uuid,text,text)') IS NOT NULL AS inicio_fotos_031,
    to_regprocedure('public.listar_fotos_para_limpeza()') IS NOT NULL AS limpeza_031,
    COALESCE(pg_get_functiondef(to_regprocedure('examentech_private.registrar_aceite_termos()'))
        LIKE '%2026-11-08-v6%',FALSE) AS documentos_032,
    EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
        AND policyname='evidencias_sem_acesso_direto' AND permissive='RESTRICTIVE') AS storage_restrito_031,
    COALESCE((SELECT NOT public FROM storage.buckets WHERE id='examentech-evidencias'),FALSE) AS bucket_privado;
