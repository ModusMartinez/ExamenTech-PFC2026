-- Somente leitura. Não retorna contas, e-mails, códigos ou credenciais.
SELECT
  to_regprocedure('public.preparar_cadastro_com_rgm(text,text,text,text)') IS NOT NULL AS cadastro_rgm_045,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='perfis_rgm_normalizado_unico') AS rgm_unico_045,
  to_regprocedure('public.listar_usuarios_redefinicao_mfa(text)') IS NOT NULL AS consulta_mfa_046,
  to_regprocedure('public.autorizar_redefinicao_mfa(uuid)') IS NOT NULL AS autorizacao_mfa_046,
  to_regprocedure('public.concluir_redefinicao_mfa(uuid,boolean)') IS NOT NULL AS conclusao_mfa_046,
  coalesce(NOT has_function_privilege('authenticated',
    to_regprocedure('public.concluir_redefinicao_mfa(uuid,boolean)'), 'EXECUTE'), false) AS conclusao_restrita_046,
  to_regprocedure('public.consultar_ingresso_aluno()') IS NOT NULL AS ingresso_047,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='examentech_private' AND p.proname='registrar_aceite_termos'
      AND p.prosrc LIKE '%2026-11-12-v11%' AND p.prosrc LIKE '%2026-11-12-v9%') AS documentos_048;
