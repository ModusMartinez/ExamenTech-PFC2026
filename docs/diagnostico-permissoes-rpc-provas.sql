-- Somente leitura. Execute no SQL Editor do Supabase de TESTE.
-- Confere privilégios das funções antigas e novas; não retorna dados pessoais.
SELECT
    has_function_privilege(
        'authenticated', 'public.iniciar_tentativa(uuid)', 'EXECUTE'
    ) AS iniciar_antigo_liberado,
    has_function_privilege(
        'authenticated', 'public.iniciar_tentativa(uuid,text)', 'EXECUTE'
    ) AS iniciar_com_aviso_liberado,
    has_function_privilege(
        'authenticated', 'public.salvar_resposta_prova(uuid,uuid,uuid,text)', 'EXECUTE'
    ) AS salvar_antigo_liberado,
    has_function_privilege(
        'authenticated', 'public.finalizar_tentativa(uuid)', 'EXECUTE'
    ) AS finalizar_antigo_liberado,
    has_function_privilege(
        'authenticated', 'public.salvar_resposta_tentativa(uuid,uuid,uuid,text)', 'EXECUTE'
    ) AS salvar_novo_liberado,
    has_function_privilege(
        'authenticated', 'public.encerrar_tentativa(uuid,text)', 'EXECUTE'
    ) AS encerrar_novo_liberado;
