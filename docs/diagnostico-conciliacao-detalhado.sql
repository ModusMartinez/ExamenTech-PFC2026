-- Somente leitura. Execute no SQL Editor do Supabase de TESTE.
-- Mostra qual condição impede a conciliação; não retorna contas nem respostas.
SELECT
    to_regclass('public.respostas_prova') IS NOT NULL AS possui_respostas_antigas,
    to_regclass('public.tentativa_questoes') IS NOT NULL AS possui_ordem_questoes,
    to_regclass('public.tentativa_alternativas') IS NOT NULL AS possui_ordem_alternativas,
    to_regprocedure('public.consultar_conteudo_tentativa(uuid)') IS NOT NULL AS possui_consulta_nova,
    to_regclass('public.respostas_tentativa') IS NOT NULL AS possui_respostas_novas,
    EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tentativas'
          AND column_name = 'limite_em'
    ) AS possui_limite_novo,
    EXISTS (
        SELECT 1 FROM public.tentativas WHERE situacao <> 'FINALIZADA'
    ) AS possui_tentativa_nao_finalizada,
    COALESCE((
        SELECT string_agg(situacao || ':' || total::text, ', ' ORDER BY situacao)
        FROM (
            SELECT situacao, count(*) AS total
            FROM public.tentativas
            GROUP BY situacao
        ) estados
    ), 'sem tentativas') AS resumo_situacoes;
