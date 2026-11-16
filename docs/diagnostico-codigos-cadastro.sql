-- SOMENTE LEITURA. Não cria conta/ticket, não consome nem altera convite.
-- No SQL Editor do MESMO Supabase usado pelo site, substitua apenas os três
-- textos entre aspas abaixo. Use o e-mail e os códigos que digitou no cadastro.
-- O convite é o código original exibido pelo site, não codigo_hash do banco.
-- Não salve uma cópia preenchida no Git. Envie apenas a linha de resultados,
-- sem mostrar o editor preenchido: ela não contém e-mail nem códigos.
WITH entrada AS (
    SELECT
        lower(btrim('EMAIL_DO_CADASTRO')) AS email,
        btrim('CODIGO_DA_ORGANIZACAO') AS codigo_organizacao,
        lower(btrim('CONVITE_INDIVIDUAL')) AS codigo_convite
), convite AS (
    SELECT c.*, o.token_login, o.situacao AS organizacao_situacao,
           o.codigo_rotacionado_em
    FROM public.convites_aluno c
    JOIN public.organizacoes o ON o.id = c.organizacao_id
    CROSS JOIN entrada e
    WHERE c.codigo_hash = encode(sha256(convert_to(e.codigo_convite, 'UTF8')), 'hex')
)
SELECT
    EXISTS (SELECT 1 FROM convite) AS convite_original_encontrado,
    EXISTS (
        SELECT 1 FROM public.convites_aluno c CROSS JOIN entrada e
        WHERE c.codigo_hash = e.codigo_convite
    ) AS foi_colado_codigo_hash,
    COALESCE(c.email = e.email, FALSE) AS email_confere,
    COALESCE(c.token_login COLLATE "C" = e.codigo_organizacao COLLATE "C", FALSE) AS codigo_organizacao_confere,
    COALESCE(c.organizacao_situacao = 'ATIVO', FALSE) AS organizacao_ativa,
    COALESCE(c.codigo_rotacionado_em IS NOT NULL, FALSE) AS codigo_organizacao_habilitado,
    COALESCE(c.situacao = 'LIBERADO', FALSE) AS convite_liberado,
    COALESCE(c.expira_em > now(), FALSE) AS convite_no_prazo,
    (c.id IS NOT NULL AND c.utilizado_em IS NULL) AS convite_nao_utilizado
FROM entrada e
LEFT JOIN convite c ON TRUE;
