-- Somente leitura. Execute no SQL Editor do mesmo projeto Supabase de TESTE.
-- Retorna apenas quantidades e existência de funções. Não mostra contas nem respostas.
WITH estados AS (
    SELECT situacao, count(*)::INTEGER AS total
    FROM public.tentativas
    GROUP BY situacao
)
SELECT
    (SELECT count(*)::INTEGER FROM public.tentativas) AS tentativas_total,
    (SELECT count(*)::INTEGER FROM public.respostas_prova) AS respostas_antigas_total,
    (SELECT count(*)::INTEGER FROM public.tentativa_questoes) AS questoes_ordenadas_total,
    (SELECT count(*)::INTEGER FROM public.tentativa_alternativas) AS alternativas_ordenadas_total,
    COALESCE((SELECT total FROM estados WHERE situacao = 'PAUSADA'), 0) AS pausadas,
    COALESCE((SELECT total FROM estados WHERE situacao = 'BLOQUEADA'), 0) AS bloqueadas,
    COALESCE((SELECT total FROM estados WHERE situacao = 'EM_ANDAMENTO'), 0) AS em_andamento,
    COALESCE((SELECT total FROM estados WHERE situacao = 'INTERROMPIDA'), 0) AS interrompidas,
    COALESCE((SELECT total FROM estados WHERE situacao = 'FINALIZADA'), 0) AS finalizadas,
    to_regprocedure('public.iniciar_tentativa(uuid)') IS NOT NULL AS inicio_um_argumento,
    to_regprocedure('public.iniciar_tentativa(uuid,text)') IS NOT NULL AS inicio_com_aviso,
    to_regprocedure('public.consultar_conteudo_tentativa(uuid)') IS NOT NULL AS consulta_nova,
    to_regprocedure('public.salvar_resposta_prova(uuid,uuid,uuid,text)') IS NOT NULL AS salvar_antigo,
    to_regprocedure('public.finalizar_tentativa(uuid)') IS NOT NULL AS finalizar_antigo;
