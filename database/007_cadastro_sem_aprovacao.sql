-- Aplicar depois de 005 e 006 no Supabase usado pela aplicação.
-- Cadastro com convite cria ALUNO/ATIVO, sem aprovação manual.
-- Não altera confirmação de e-mail, MFA, papéis ou contas INATIVO.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE t.tgrelid = 'auth.users'::regclass
          AND t.tgname = 'examentech_exigir_convite_aluno'
          AND t.tgenabled IN ('O', 'A')
          AND n.nspname = 'examentech_private'
          AND p.proname = 'exigir_convite_antes_de_criar_usuario'
    ) THEN
        RAISE EXCEPTION 'A exigência de convite de 005 precisa estar ativa.';
    END IF;

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
        RAISE EXCEPTION 'O gatilho de criação de perfil precisa estar ativo.';
    END IF;
END;
$$;

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
    -- O gatilho BEFORE INSERT de 005 já validou e consumiu o convite.
    SELECT c.organizacao_id INTO v_organizacao_id
    FROM public.convites_aluno c
    JOIN public.organizacoes o ON o.id = c.organizacao_id
    WHERE c.utilizado_por = NEW.id
      AND c.situacao = 'UTILIZADO'
      AND c.utilizado_em IS NOT NULL
      AND c.email = lower(btrim(NEW.email))
      AND o.situacao = 'ATIVO';

    IF v_organizacao_id IS NULL THEN
        RAISE EXCEPTION 'Cadastro requer organização válida.' USING ERRCODE = '22023';
    END IF;

    v_nome := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'nome', '')), '');
    IF v_nome IS NULL THEN
        v_nome := split_part(COALESCE(NEW.email, 'usuario'), '@', 1);
    END IF;

    -- Perfil e situação vêm do banco, nunca dos metadados do navegador.
    INSERT INTO public.perfis (id, nome, email, perfil, situacao, organizacao_id)
    VALUES (
        NEW.id, v_nome, lower(NEW.email), 'ALUNO', 'ATIVO', v_organizacao_id
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.criar_perfil_novo_usuario()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_perfil_novo_usuario()
TO supabase_auth_admin;

ALTER TABLE public.perfis ALTER COLUMN situacao SET DEFAULT 'ATIVO';

-- Inclui alunos já cadastrados pelo fluxo de convite, como a conta de teste.
-- Não reativa INATIVO, não promove papéis e não libera contas sem convite.
UPDATE public.perfis p
SET situacao = 'ATIVO'
FROM auth.users u
WHERE p.id = u.id
  AND p.perfil = 'ALUNO'
  AND p.situacao = 'PENDENTE'
  AND EXISTS (
      SELECT 1
      FROM public.convites_aluno c
      JOIN public.organizacoes o ON o.id = c.organizacao_id
      WHERE c.utilizado_por = p.id
        AND c.organizacao_id = p.organizacao_id
        AND c.email = lower(btrim(u.email))
        AND c.situacao = 'UTILIZADO'
        AND c.utilizado_em IS NOT NULL
        AND o.situacao = 'ATIVO'
  );

-- PENDENTE permanece permitido apenas para registros legados não elegíveis.
-- Eles continuam bloqueados. Os eventos antigos de auditoria são preservados.
COMMIT;
