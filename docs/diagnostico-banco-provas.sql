-- Consulta somente de leitura. Execute no SQL Editor do projeto Supabase de TESTE.
-- Use o projeto configurado no ambiente local, com o papel postgres do SQL Editor.
-- Não retorna contas, respostas, fotografias nem chaves.
-- A presença dos objetos não comprova a aplicação completa de uma migration.
-- Referência: https://www.postgresql.org/docs/current/functions-info.html
SELECT
    current_database() AS banco,
    to_regclass('public.tentativas') IS NOT NULL AS tentativas,
    to_regclass('public.respostas_prova') IS NOT NULL AS respostas_modelo_antigo,
    to_regclass('public.tentativa_questoes') IS NOT NULL AS ordem_modelo_novo,
    to_regclass('public.tentativa_alternativas') IS NOT NULL AS alternativas_modelo_novo,
    to_regclass('public.respostas_tentativa') IS NOT NULL AS respostas_modelo_novo,
    to_regclass('public.respostas') IS NOT NULL AS respostas_com_versao_local,
    ARRAY(
        SELECT column_name || ' ' || data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'respostas'
        ORDER BY ordinal_position
    ) AS colunas_respostas_local,
    ARRAY(
        SELECT column_name || ' ' || data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'respostas_tentativa'
        ORDER BY ordinal_position
    ) AS colunas_respostas_entrega,
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
    to_regprocedure('public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)') IS NOT NULL
        AS rpc_salvar_resposta_com_versao,
    to_regprocedure('examentech_private.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)') IS NOT NULL
        AS funcao_privada_resposta_com_versao,
    to_regprocedure('public.consultar_respostas_tentativa(uuid)') IS NOT NULL
        AS rpc_consultar_respostas,
    to_regprocedure('public.iniciar_tentativa(uuid,text)') IS NOT NULL
        AS rpc_iniciar_com_aviso,
    to_regprocedure('public.encerrar_tentativa(uuid,text)') IS NOT NULL
        AS rpc_encerrar_nova,
    to_regprocedure('public.reativar_tentativa(uuid,text,integer)') IS NOT NULL
        AS rpc_reativar_tentativa,
    to_regclass('public.fotos_tentativa') IS NOT NULL AS fotos_tentativa,
    to_regprocedure('public.iniciar_tentativa_com_fotos(uuid,text,text)') IS NOT NULL
        AS rpc_iniciar_com_fotos;
