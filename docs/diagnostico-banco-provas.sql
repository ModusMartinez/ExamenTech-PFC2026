-- Consulta somente de leitura. Execute no SQL Editor do projeto Supabase de TESTE.
-- Não retorna contas, respostas, fotografias nem chaves.
SELECT
    current_database() AS banco,
    to_regclass('public.tentativas') IS NOT NULL AS tentativas,
    to_regclass('public.respostas_prova') IS NOT NULL AS respostas_modelo_antigo,
    to_regclass('public.tentativa_questoes') IS NOT NULL AS ordem_modelo_novo,
    to_regclass('public.tentativa_alternativas') IS NOT NULL AS alternativas_modelo_novo,
    to_regclass('public.respostas_tentativa') IS NOT NULL AS respostas_modelo_novo,
    EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tentativas'
          AND column_name = 'tempo_restante_segundos'
    ) AS tempo_restante_modelo_antigo,
    EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tentativas'
          AND column_name = 'limite_em'
    ) AS limite_modelo_novo,
    to_regprocedure('public.salvar_resposta_tentativa(uuid,uuid,uuid,text)') IS NOT NULL
        AS rpc_salvar_resposta_nova,
    to_regprocedure('public.encerrar_tentativa(uuid,text)') IS NOT NULL
        AS rpc_encerrar_nova;
