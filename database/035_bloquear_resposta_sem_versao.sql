-- Aplicar após 033/034 e a atualização do painel para a API com versão.
-- Preserva funções e registros; retira somente o acesso da aplicação à assinatura antiga.
BEGIN;

DO $$
BEGIN
    IF to_regclass('public.respostas_tentativa') IS NULL
       OR to_regclass('public.respostas') IS NOT NULL THEN
        RAISE EXCEPTION 'Confira o diagnóstico: esta query exige a tabela respostas_tentativa como modelo único.';
    END IF;
    IF to_regprocedure('public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)') IS NULL
       OR to_regprocedure('examentech_private.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'Aplique as queries 033 e 034 antes desta query.';
    END IF;
    IF NOT has_function_privilege('authenticated',
            'public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated',
            'examentech_private.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Confira as permissões da função com versão antes de bloquear a antiga.';
    END IF;
END;
$$;

-- Revogar também a implementação privada impede contornar a entrada pública.
REVOKE ALL ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID, UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    -- Permissões herdadas de outro papel também contam; não confirmar um bloqueio incompleto.
    IF EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid IN (
            'public.salvar_resposta_tentativa(uuid,uuid,uuid,text)'::regprocedure,
            'examentech_private.salvar_resposta_tentativa(uuid,uuid,uuid,text)'::regprocedure
        ) AND (has_function_privilege('anon', oid, 'EXECUTE')
            OR has_function_privilege('authenticated', oid, 'EXECUTE'))
    ) THEN
        RAISE EXCEPTION 'A função antiga ainda tem permissão herdada. Confira os papéis antes de reaplicar.';
    END IF;
END;
$$;

COMMENT ON FUNCTION public.salvar_resposta_tentativa(UUID, UUID, UUID, TEXT) IS
    'Assinatura sem versão, bloqueada para a aplicação pela query 035. Usar a assinatura com p_versao.';
COMMENT ON COLUMN public.respostas_tentativa.versao IS
    'Sequência por questão. A aplicação envia a próxima versão; repetir versão e conteúdo atuais confirma sem nova gravação.';

NOTIFY pgrst, 'reload schema';
COMMIT;
