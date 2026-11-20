-- Aplicar depois de 008. Preserva contas, convites e tickets existentes.
-- As tabelas mantêm os nomes antigos para não quebrar as integrações.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'auth.users'::regclass
          AND tgname = 'examentech_exigir_convite_aluno'
          AND tgenabled IN ('O', 'A')
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'auth.users'::regclass
          AND tgname = 'examentech_registrar_aceite_termos'
          AND tgenabled IN ('O', 'A')
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'auth.users'::regclass
          AND tgname = 'ao_criar_usuario'
          AND tgenabled IN ('O', 'A')
    ) THEN
        RAISE EXCEPTION 'Os gatilhos de convite, perfil e aceite precisam estar ativos (001 a 008).';
    END IF;
END;
$$;

ALTER TABLE public.convites_aluno
ADD COLUMN IF NOT EXISTS perfil_destino TEXT NOT NULL DEFAULT 'ALUNO';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.convites_aluno'::regclass
          AND conname = 'convites_perfil_destino_valido'
    ) THEN
        ALTER TABLE public.convites_aluno
        ADD CONSTRAINT convites_perfil_destino_valido
        CHECK (perfil_destino IN ('ALUNO', 'PROFESSOR'));
    END IF;
END;
$$;

COMMENT ON COLUMN public.convites_aluno.perfil_destino IS
    'Perfil definido na emissão: ADMIN convida PROFESSOR ou ALUNO; PROFESSOR só convida ALUNO da sua organização.';

-- Não permitir alterar o destino de um convite pelo navegador.
REVOKE ALL ON public.convites_aluno, public.tickets_cadastro_aluno
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION examentech_private.emitir_convite(
    p_email TEXT, p_organizacao_id UUID, p_perfil_destino TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_email TEXT := lower(btrim(COALESCE(p_email, '')));
    v_perfil TEXT;
    v_situacao TEXT;
    v_organizacao_usuario UUID;
    v_codigo TEXT;
    v_id UUID;
    v_expira_em TIMESTAMPTZ := NOW() + INTERVAL '7 days';
BEGIN
    IF (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2' OR auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
    END IF;

    IF p_perfil_destino IS NULL OR p_perfil_destino NOT IN ('ALUNO', 'PROFESSOR') THEN
        RAISE EXCEPTION 'Tipo de convite inválido.' USING ERRCODE = '22023';
    END IF;

    SELECT perfil, situacao, organizacao_id
    INTO v_perfil, v_situacao, v_organizacao_usuario
    FROM public.perfis WHERE id = auth.uid();

    IF v_situacao IS DISTINCT FROM 'ATIVO'
       OR v_perfil IS NULL OR v_perfil NOT IN ('ADMIN', 'PROFESSOR')
       OR (v_perfil = 'PROFESSOR' AND (
           p_perfil_destino <> 'ALUNO'
           OR v_organizacao_usuario IS DISTINCT FROM p_organizacao_id
       )) THEN
        RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
    END IF;

    IF p_organizacao_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.organizacoes
        WHERE id = p_organizacao_id AND situacao = 'ATIVO'
          AND codigo_rotacionado_em IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Organização sem código ativo.' USING ERRCODE = '22023';
    END IF;

    IF char_length(v_email) > 320
       OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
        RAISE EXCEPTION 'Informe um e-mail válido.' USING ERRCODE = '22023';
    END IF;

    v_codigo := replace(gen_random_uuid()::TEXT, '-', '') ||
                replace(gen_random_uuid()::TEXT, '-', '');

    INSERT INTO public.convites_aluno (
        organizacao_id, email, codigo_hash, liberado_por, expira_em, perfil_destino
    ) VALUES (
        p_organizacao_id, v_email,
        encode(sha256(convert_to(v_codigo, 'UTF8')), 'hex'),
        auth.uid(), v_expira_em, p_perfil_destino
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'id', v_id, 'email', v_email, 'organizacao_id', p_organizacao_id,
        'codigo', v_codigo, 'expira_em', v_expira_em, 'perfil_destino', p_perfil_destino
    );
END;
$$;

-- Mantém o nome usado pelo fluxo de aluno e acrescenta o de professor.
CREATE OR REPLACE FUNCTION examentech_private.emitir_convite_aluno(
    p_email TEXT, p_organizacao_id UUID
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.emitir_convite(p_email, p_organizacao_id, 'ALUNO') $$;

CREATE OR REPLACE FUNCTION public.emitir_convite_professor(
    p_email TEXT, p_organizacao_id UUID
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.emitir_convite(p_email, p_organizacao_id, 'PROFESSOR') $$;

-- O mesmo ticket atende aos dois perfis. Nenhum perfil é recebido do cadastro.
CREATE OR REPLACE FUNCTION public.preparar_cadastro(
    p_email TEXT, p_codigo_organizacao TEXT, p_codigo_convite TEXT
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
    SELECT examentech_private.preparar_cadastro_aluno(
        p_email, p_codigo_organizacao, p_codigo_convite
    )
$$;

REVOKE ALL ON FUNCTION examentech_private.emitir_convite(TEXT, UUID, TEXT)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.emitir_convite_aluno(TEXT, UUID)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emitir_convite_professor(TEXT, UUID)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preparar_cadastro(TEXT, TEXT, TEXT)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION examentech_private.emitir_convite(TEXT, UUID, TEXT)
TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.emitir_convite_aluno(TEXT, UUID)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.emitir_convite_professor(TEXT, UUID)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.preparar_cadastro(TEXT, TEXT, TEXT)
TO anon;

CREATE OR REPLACE FUNCTION public.criar_perfil_novo_usuario()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_nome TEXT;
    v_organizacao_id UUID;
    v_perfil TEXT;
BEGIN
    -- O BEFORE INSERT de 005 já conferiu e consumiu ticket e convite.
    SELECT c.organizacao_id, c.perfil_destino
    INTO v_organizacao_id, v_perfil
    FROM public.convites_aluno c
    JOIN public.organizacoes o ON o.id = c.organizacao_id
    WHERE c.utilizado_por = NEW.id
      AND c.situacao = 'UTILIZADO' AND c.utilizado_em IS NOT NULL
      AND c.email = lower(btrim(NEW.email)) AND o.situacao = 'ATIVO';

    IF v_organizacao_id IS NULL OR v_perfil IS NULL
       OR v_perfil NOT IN ('ALUNO', 'PROFESSOR') THEN
        RAISE EXCEPTION 'Cadastro requer convite e organização válidos.' USING ERRCODE = '22023';
    END IF;

    v_nome := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'nome', '')), '');
    IF v_nome IS NULL THEN
        v_nome := split_part(COALESCE(NEW.email, 'usuario'), '@', 1);
    END IF;

    -- Perfil vem do convite salvo no banco, nunca dos metadados do navegador.
    INSERT INTO public.perfis (id, nome, email, perfil, situacao, organizacao_id)
    VALUES (NEW.id, v_nome, lower(NEW.email), v_perfil, 'ATIVO', v_organizacao_id);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.criar_perfil_novo_usuario()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_perfil_novo_usuario()
TO supabase_auth_admin;

-- Nova versão dos termos para contemplar o convite de professor.
-- Aceites já gravados continuam com a versão original, sem atualização retroativa.
CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF (NEW.raw_user_meta_data -> 'termos_aceitos') IS DISTINCT FROM 'true'::jsonb
       OR (NEW.raw_user_meta_data ->> 'termos_versao') IS DISTINCT FROM '2026-09-27-v2'
       OR (NEW.raw_user_meta_data ->> 'privacidade_versao') IS DISTINCT FROM '2026-09-27' THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos Termos de Uso.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.aceites_termos (usuario_id, termos_versao, privacidade_versao, aceito_em)
    VALUES (NEW.id, '2026-09-27-v2', '2026-09-27', NOW());
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_aceite_termos()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_aceite_termos()
TO supabase_auth_admin;

-- Não altera MFA, confirmação de e-mail, auditoria nem contas antigas.
COMMIT;
