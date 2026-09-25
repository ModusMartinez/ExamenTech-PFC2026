-- ExamenTech: ATIVA a exigência de convite para toda nova conta em auth.users.
-- Não executar antes de revisar 004, preparar as organizações/códigos e
-- coordenar com a equipe. Add user no painel e outros cadastros sem convite
-- também serão bloqueados. Usuários já existentes não são alterados.

-- A função de perfil e o gatilho de convite precisam entrar juntos.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE t.tgrelid = 'auth.users'::regclass
          AND t.tgname = 'ao_criar_usuario'
          AND t.tgenabled IN ('O', 'A')
          AND n.nspname = 'public'
          AND p.proname = 'criar_perfil_novo_usuario'
    ) THEN
        RAISE EXCEPTION 'O gatilho ao_criar_usuario de 001 precisa estar ativo.';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.exigir_convite_antes_de_criar_usuario()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_ticket TEXT := lower(btrim(COALESCE(
        NEW.raw_user_meta_data ->> 'ticket_cadastro', ''
    )));
    v_convite_id UUID;
    v_codigo_org_hash TEXT;
BEGIN
    IF v_ticket = '' OR char_length(v_ticket) > 128 THEN
        RAISE EXCEPTION 'Cadastro requer convite válido.' USING ERRCODE = '22023';
    END IF;

    -- O UPDATE condicional bloqueia dois cadastros simultâneos com o mesmo
    -- ticket. Se qualquer etapa do cadastro falhar, a transação é revertida.
    UPDATE public.tickets_cadastro_aluno
    SET utilizado_em = NOW(), utilizado_por = NEW.id
    WHERE codigo_hash = encode(sha256(convert_to(v_ticket, 'UTF8')), 'hex')
      AND utilizado_em IS NULL AND expira_em > NOW()
    RETURNING convite_id, organizacao_codigo_hash
    INTO v_convite_id, v_codigo_org_hash;

    IF v_convite_id IS NULL THEN
        RAISE EXCEPTION 'Cadastro requer convite válido.' USING ERRCODE = '22023';
    END IF;

    UPDATE public.convites_aluno c
    SET situacao = 'UTILIZADO', utilizado_em = NOW(), utilizado_por = NEW.id
    WHERE c.id = v_convite_id
      AND c.email = lower(btrim(NEW.email))
      AND c.situacao = 'LIBERADO'
      AND c.utilizado_em IS NULL AND c.expira_em > NOW()
      AND EXISTS (
          SELECT 1 FROM public.organizacoes o
          WHERE o.id = c.organizacao_id AND o.situacao = 'ATIVO'
            AND o.codigo_rotacionado_em IS NOT NULL
            AND encode(sha256(convert_to(o.token_login, 'UTF8')), 'hex') =
                v_codigo_org_hash
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cadastro requer convite válido.' USING ERRCODE = '22023';
    END IF;

    -- Não persistir o ticket no metadata do Auth. Os códigos permanentes da
    -- organização e do convite nunca são enviados ao Auth, só ao RPC anterior.
    NEW.raw_user_meta_data := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb)
        - 'ticket_cadastro';

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.exigir_convite_antes_de_criar_usuario()
FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA examentech_private TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION examentech_private.exigir_convite_antes_de_criar_usuario()
TO supabase_auth_admin;

-- Substitui a função de 003: o aluno continua ALUNO/PENDENTE, agora com a
-- organização do convite consumido na mesma transação de criação do Auth.
CREATE OR REPLACE FUNCTION public.criar_perfil_novo_usuario()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_nome TEXT;
    v_organizacao_id UUID;
BEGIN
    SELECT c.organizacao_id INTO v_organizacao_id
    FROM public.convites_aluno c
    WHERE c.utilizado_por = NEW.id AND c.situacao = 'UTILIZADO';

    IF v_organizacao_id IS NULL THEN
        RAISE EXCEPTION 'Cadastro requer organização válida.' USING ERRCODE = '22023';
    END IF;

    v_nome := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'nome', '')), '');
    IF v_nome IS NULL THEN
        v_nome := split_part(COALESCE(NEW.email, 'usuario'), '@', 1);
    END IF;

    INSERT INTO public.perfis (id, nome, email, perfil, situacao, organizacao_id)
    VALUES (
        NEW.id, v_nome, lower(NEW.email), 'ALUNO', 'PENDENTE', v_organizacao_id
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.criar_perfil_novo_usuario()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_perfil_novo_usuario()
TO supabase_auth_admin;

DROP TRIGGER IF EXISTS examentech_exigir_convite_aluno ON auth.users;
CREATE TRIGGER examentech_exigir_convite_aluno
BEFORE INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION examentech_private.exigir_convite_antes_de_criar_usuario();

-- O trigger AFTER INSERT "ao_criar_usuario" de 001 permanece instalado e
-- chama a nova versão de public.criar_perfil_novo_usuario().

COMMIT;
