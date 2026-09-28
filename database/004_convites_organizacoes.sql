-- ExamenTech: preparar organizações e convites de aluno.
-- Revisar com a equipe antes de executar. Este arquivo NÃO ativa a exigência
-- de convite no Auth; a ativação está em 005_ativar_convite_cadastro.sql.
-- Requer a tabela public.organizacoes já existente e 001/003 aplicados.

DO $$
BEGIN
    IF to_regclass('public.organizacoes') IS NULL THEN
        RAISE EXCEPTION 'A tabela public.organizacoes precisa existir antes desta migração.';
    END IF;
END;
$$;

-- Usuários antigos permanecem sem organização até revisão da equipe.
ALTER TABLE public.perfis
ADD COLUMN IF NOT EXISTS organizacao_id UUID;

-- Indica quais organizações receberam um código novo no fluxo revisado.
-- token_login continua com o formato existente de 21 caracteres. Valores
-- antigos não são habilitados automaticamente para convites de aluno.
ALTER TABLE public.organizacoes
ADD COLUMN IF NOT EXISTS codigo_rotacionado_em TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'perfis_organizacao_id_fkey'
          AND conrelid = 'public.perfis'::regclass
    ) THEN
        ALTER TABLE public.perfis
        ADD CONSTRAINT perfis_organizacao_id_fkey
        FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id)
        ON DELETE RESTRICT;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS perfis_organizacao_id_idx
ON public.perfis (organizacao_id);

-- token_login já pertence à tabela da equipe e tem UNIQUE e CHECK de 21
-- caracteres. O código da organização permanece em claro nessa coluna para
-- preservar o formato atual. A auditoria de acesso a essa tabela é essencial.

CREATE TABLE IF NOT EXISTS public.convites_aluno (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizacao_id UUID NOT NULL REFERENCES public.organizacoes(id) ON DELETE RESTRICT,
    email TEXT NOT NULL,
    codigo_hash TEXT NOT NULL UNIQUE,
    situacao TEXT NOT NULL DEFAULT 'LIBERADO',
    liberado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expira_em TIMESTAMPTZ NOT NULL,
    utilizado_em TIMESTAMPTZ,
    utilizado_por UUID UNIQUE REFERENCES auth.users(id)
        ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT convites_aluno_situacao_valida
        CHECK (situacao IN ('LIBERADO', 'UTILIZADO', 'REVOGADO')),
    CONSTRAINT convites_aluno_codigo_hash_valido
        CHECK (char_length(codigo_hash) = 64)
);

CREATE INDEX IF NOT EXISTS convites_aluno_busca_idx
ON public.convites_aluno (organizacao_id, email, situacao, expira_em);

CREATE TABLE IF NOT EXISTS public.tickets_cadastro_aluno (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    convite_id UUID NOT NULL REFERENCES public.convites_aluno(id) ON DELETE CASCADE,
    codigo_hash TEXT NOT NULL UNIQUE,
    organizacao_codigo_hash TEXT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expira_em TIMESTAMPTZ NOT NULL,
    utilizado_em TIMESTAMPTZ,
    utilizado_por UUID UNIQUE REFERENCES auth.users(id)
        ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT tickets_cadastro_codigo_hash_valido
        CHECK (char_length(codigo_hash) = 64)
);

CREATE INDEX IF NOT EXISTS tickets_cadastro_convite_idx
ON public.tickets_cadastro_aluno (convite_id, criado_em DESC);

ALTER TABLE public.convites_aluno ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets_cadastro_aluno ENABLE ROW LEVEL SECURITY;

-- O navegador não consulta hashes nem escreve nessas tabelas diretamente.
REVOKE ALL ON TABLE public.convites_aluno FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tickets_cadastro_aluno FROM PUBLIC, anon, authenticated;

-- Funções privilegiadas ficam fora dos schemas expostos pela Data API.
CREATE SCHEMA IF NOT EXISTS examentech_private;
REVOKE ALL ON SCHEMA examentech_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA examentech_private TO anon, authenticated;

CREATE OR REPLACE FUNCTION examentech_private.criar_organizacao_com_codigo(p_nome TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_nome TEXT := btrim(COALESCE(p_nome, ''));
    v_codigo TEXT;
    v_id UUID;
BEGIN
    IF (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS (
           SELECT 1 FROM public.perfis
           WHERE id = auth.uid() AND perfil = 'ADMIN' AND situacao = 'ATIVO'
       ) THEN
        RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
    END IF;

    IF char_length(v_nome) < 3 OR char_length(v_nome) > 160 THEN
        RAISE EXCEPTION 'Informe um nome de organização entre 3 e 160 caracteres.'
            USING ERRCODE = '22023';
    END IF;

    -- UUID v4 aleatório convertido para 21 caracteres no alfabeto permitido
    -- pelo CHECK legado de organizacoes.token_login (base64url sem padding).
    v_codigo := left(
        translate(
            encode(decode(replace(gen_random_uuid()::TEXT, '-', ''), 'hex'), 'base64'),
            '+/', '-_'
        ),
        21
    );

    INSERT INTO public.organizacoes (
        nome, token_login, situacao, codigo_rotacionado_em
    ) VALUES (
        v_nome, v_codigo, 'ATIVO', NOW()
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'nome', v_nome, 'codigo', v_codigo);
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.listar_organizacoes_ativas()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS (
           SELECT 1 FROM public.perfis
           WHERE id = auth.uid() AND perfil = 'ADMIN' AND situacao = 'ATIVO'
       ) THEN
        RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
    END IF;

    RETURN (
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', o.id, 'nome', o.nome, 'situacao', o.situacao
                ) ORDER BY o.nome
            ),
            '[]'::jsonb
        )
        FROM public.organizacoes o
        WHERE o.situacao = 'ATIVO'
    );
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.rotacionar_codigo_organizacao(p_organizacao_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_codigo TEXT;
    v_nome TEXT;
BEGIN
    IF (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS (
           SELECT 1 FROM public.perfis
           WHERE id = auth.uid() AND perfil = 'ADMIN' AND situacao = 'ATIVO'
       ) THEN
        RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE = '42501';
    END IF;

    v_codigo := left(
        translate(
            encode(decode(replace(gen_random_uuid()::TEXT, '-', ''), 'hex'), 'base64'),
            '+/', '-_'
        ),
        21
    );

    UPDATE public.organizacoes
    SET token_login = v_codigo,
        codigo_rotacionado_em = NOW()
    WHERE id = p_organizacao_id AND situacao = 'ATIVO'
    RETURNING nome INTO v_nome;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Organização ativa não encontrada.' USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object(
        'id', p_organizacao_id, 'nome', v_nome, 'codigo', v_codigo
    );
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.emitir_convite_aluno(
    p_email TEXT, p_organizacao_id UUID
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

    SELECT perfil, situacao, organizacao_id
    INTO v_perfil, v_situacao, v_organizacao_usuario
    FROM public.perfis
    WHERE id = auth.uid();

    IF v_situacao IS DISTINCT FROM 'ATIVO'
       OR v_perfil NOT IN ('ADMIN', 'PROFESSOR')
       OR (v_perfil = 'PROFESSOR' AND
           v_organizacao_usuario IS DISTINCT FROM p_organizacao_id) THEN
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
        organizacao_id, email, codigo_hash, liberado_por, expira_em
    ) VALUES (
        p_organizacao_id,
        v_email,
        encode(sha256(convert_to(v_codigo, 'UTF8')), 'hex'),
        auth.uid(),
        v_expira_em
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'id', v_id,
        'email', v_email,
        'organizacao_id', p_organizacao_id,
        'codigo', v_codigo,
        'expira_em', v_expira_em
    );
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.preparar_cadastro_aluno(
    p_email TEXT, p_codigo_organizacao TEXT, p_codigo_convite TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_email TEXT := lower(btrim(COALESCE(p_email, '')));
    -- Código base64url diferencia letras maiúsculas e minúsculas.
    v_codigo_org TEXT := btrim(COALESCE(p_codigo_organizacao, ''));
    v_codigo_convite TEXT := lower(btrim(COALESCE(p_codigo_convite, '')));
    v_convite_id UUID;
    v_codigo_org_hash TEXT;
    v_ticket TEXT;
BEGIN
    -- Não liberar tickets enquanto o gatilho de 005 não estiver ativo.
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'auth.users'::regclass
          AND tgname = 'examentech_exigir_convite_aluno'
          AND tgenabled IN ('O', 'A')
    ) THEN
        RAISE EXCEPTION 'Cadastro por convite ainda não foi ativado.'
            USING ERRCODE = '55000';
    END IF;

    IF char_length(v_email) > 320
       OR v_codigo_org !~ '^[A-Za-z0-9_-]{21}$'
       OR v_codigo_convite !~ '^[0-9a-f]{64}$'
       OR v_email = '' THEN
        RAISE EXCEPTION 'Códigos inválidos ou expirados.' USING ERRCODE = '22023';
    END IF;

    SELECT c.id, encode(sha256(convert_to(o.token_login, 'UTF8')), 'hex')
    INTO v_convite_id, v_codigo_org_hash
    FROM public.convites_aluno c
    JOIN public.organizacoes o ON o.id = c.organizacao_id
    WHERE c.email = v_email
      AND c.codigo_hash = encode(sha256(convert_to(v_codigo_convite, 'UTF8')), 'hex')
      AND c.situacao = 'LIBERADO' AND c.utilizado_em IS NULL
      AND c.expira_em > NOW()
      AND o.situacao = 'ATIVO'
      AND o.codigo_rotacionado_em IS NOT NULL
      AND o.token_login COLLATE "C" = v_codigo_org COLLATE "C"
    FOR UPDATE OF c;

    IF v_convite_id IS NULL THEN
        RAISE EXCEPTION 'Códigos inválidos ou expirados.' USING ERRCODE = '22023';
    END IF;

    -- Limita reemissões mesmo para quem conhece os códigos. O lock acima
    -- serializa essa contagem para o mesmo convite.
    IF (
        SELECT count(*) FROM public.tickets_cadastro_aluno
        WHERE convite_id = v_convite_id
          AND criado_em > NOW() - INTERVAL '10 minutes'
    ) >= 5 THEN
        RAISE EXCEPTION 'Aguarde antes de tentar novamente.' USING ERRCODE = 'P2001';
    END IF;

    -- O ticket dura pouco e substitui os dois códigos no pedido ao Auth.
    v_ticket := replace(gen_random_uuid()::TEXT, '-', '') ||
                replace(gen_random_uuid()::TEXT, '-', '');

    INSERT INTO public.tickets_cadastro_aluno (
        convite_id, codigo_hash, organizacao_codigo_hash, expira_em
    ) VALUES (
        v_convite_id,
        encode(sha256(convert_to(v_ticket, 'UTF8')), 'hex'),
        v_codigo_org_hash,
        NOW() + INTERVAL '5 minutes'
    );

    RETURN jsonb_build_object('ticket', v_ticket);
END;
$$;

-- Wrappers invoker expostos à Data API. Toda autorização é repetida dentro
-- das funções privadas; não confiar apenas na tela ou no wrapper.
CREATE OR REPLACE FUNCTION public.criar_organizacao_com_codigo(p_nome TEXT)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.criar_organizacao_com_codigo(p_nome) $$;

CREATE OR REPLACE FUNCTION public.listar_organizacoes_ativas()
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.listar_organizacoes_ativas() $$;

CREATE OR REPLACE FUNCTION public.rotacionar_codigo_organizacao(p_organizacao_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.rotacionar_codigo_organizacao(p_organizacao_id) $$;

CREATE OR REPLACE FUNCTION public.emitir_convite_aluno(p_email TEXT, p_organizacao_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.emitir_convite_aluno(p_email, p_organizacao_id) $$;

CREATE OR REPLACE FUNCTION public.preparar_cadastro_aluno(
    p_email TEXT, p_codigo_organizacao TEXT, p_codigo_convite TEXT
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
    SELECT examentech_private.preparar_cadastro_aluno(
        p_email, p_codigo_organizacao, p_codigo_convite
    )
$$;

REVOKE ALL ON FUNCTION examentech_private.criar_organizacao_com_codigo(TEXT)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.listar_organizacoes_ativas()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.rotacionar_codigo_organizacao(UUID)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.emitir_convite_aluno(TEXT, UUID)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.preparar_cadastro_aluno(TEXT, TEXT, TEXT)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION examentech_private.criar_organizacao_com_codigo(TEXT)
TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.listar_organizacoes_ativas()
TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.rotacionar_codigo_organizacao(UUID)
TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.emitir_convite_aluno(TEXT, UUID)
TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.preparar_cadastro_aluno(TEXT, TEXT, TEXT)
TO anon;

REVOKE ALL ON FUNCTION public.criar_organizacao_com_codigo(TEXT)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listar_organizacoes_ativas()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rotacionar_codigo_organizacao(UUID)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emitir_convite_aluno(TEXT, UUID)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preparar_cadastro_aluno(TEXT, TEXT, TEXT)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.criar_organizacao_com_codigo(TEXT)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_organizacoes_ativas()
TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotacionar_codigo_organizacao(UUID)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.emitir_convite_aluno(TEXT, UUID)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.preparar_cadastro_aluno(TEXT, TEXT, TEXT)
TO anon;
