-- SOMENTE LEITURA: não altera perfis, organizações, sessões ou fatores.
-- No SQL Editor da mesma base de testes usada no site, substitua os dois
-- e-mails abaixo: o ADMIN conectado e o ALUNO/PROFESSOR que deseja atender.
-- Envie somente a linha de resultados; ela não retorna e-mails nem IDs.
-- A sessão/MFA do navegador NÃO é a sessão do SQL Editor: esta consulta
-- confere os vínculos e permissões; não confirma o AAL da janela do site.
WITH entrada AS (
    SELECT lower(btrim('EMAIL_DO_ADMIN')) AS admin_email,
           lower(btrim('EMAIL_DO_ALUNO_OU_PROFESSOR')) AS alvo_email
)
SELECT
    (a.id IS NOT NULL) AS perfil_admin_encontrado,
    COALESCE(a.perfil = 'ADMIN', FALSE) AS perfil_e_admin,
    COALESCE(a.situacao = 'ATIVO', FALSE) AS admin_ativo,
    (a.organizacao_id IS NOT NULL) AS admin_tem_organizacao,
    COALESCE(o.situacao = 'ATIVO', FALSE) AS organizacao_admin_ativa,
    (p.id IS NOT NULL) AS perfil_alvo_encontrado,
    COALESCE(p.perfil IN ('ALUNO', 'PROFESSOR'), FALSE) AS alvo_aluno_ou_professor,
    COALESCE(p.situacao = 'ATIVO', FALSE) AS alvo_ativo,
    COALESCE(a.organizacao_id = p.organizacao_id, FALSE) AS mesma_organizacao,
    to_regprocedure('public.listar_usuarios_redefinicao_mfa(text)') IS NOT NULL AS funcao_046_existe,
    COALESCE(has_function_privilege('authenticated',
        to_regprocedure('public.listar_usuarios_redefinicao_mfa(text)'), 'EXECUTE'), FALSE) AS consulta_046_liberada
FROM entrada e
LEFT JOIN public.perfis a ON lower(btrim(a.email)) = e.admin_email
LEFT JOIN public.organizacoes o ON o.id = a.organizacao_id
LEFT JOIN public.perfis p ON lower(btrim(p.email)) = e.alvo_email;
