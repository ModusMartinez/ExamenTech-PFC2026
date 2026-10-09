
-- ExamenTech-PFC2026
-- Estrutura inicial de perfis de usuários
--------
-- TABELA: perfis
-- Complementa os usuários gerenciados pelo Supabase Auth


CREATE TABLE public.perfis
(
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    nome        TEXT NOT NULL,
    email       TEXT NOT NULL,
    rgm         TEXT,
    perfil      TEXT NOT NULL DEFAULT 'ALUNO',
    situacao    TEXT NOT NULL DEFAULT 'PENDENTE',
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT perfis_perfil_valido
        CHECK (perfil IN ('ADMIN', 'PROFESSOR', 'ALUNO')),

    CONSTRAINT perfis_situacao_valida
        CHECK (situacao IN ('PENDENTE', 'ATIVO', 'INATIVO'))
);


-- ÍNDICES


CREATE UNIQUE INDEX perfis_email_unico
    ON public.perfis (LOWER(email));

CREATE UNIQUE INDEX perfis_rgm_unico
    ON public.perfis (rgm)
    WHERE rgm IS NOT NULL;



-- FUNÇÃO: criação automática do perfil
--
-- IMPORTANTE:
-- O usuário pode solicitar apenas ALUNO ou PROFESSOR.
-- ADMIN nunca poderá ser criado através do cadastro público.


CREATE OR REPLACE FUNCTION public.criar_perfil_novo_usuario()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE

    v_perfil TEXT;
    v_nome   TEXT;
    v_rgm    TEXT;

BEGIN

    -- Perfil solicitado no cadastro
    v_perfil := UPPER(
        COALESCE(
            NEW.raw_user_meta_data ->> 'perfil',
            'ALUNO'
        )
    );

    -- Por segurança, cadastro público nunca poderá criar ADMIN
    IF v_perfil NOT IN ('ALUNO', 'PROFESSOR') THEN
        v_perfil := 'ALUNO';
    END IF;


    -- Nome informado no cadastro
    v_nome := NULLIF(
        TRIM(
            COALESCE(
                NEW.raw_user_meta_data ->> 'nome',
                ''
            )
        ),
        ''
    );

    -- Valor alternativo para evitar falha na criação do usuário
    IF v_nome IS NULL THEN

        v_nome := SPLIT_PART(
            COALESCE(NEW.email, 'usuario'),
            '@',
            1
        );

    END IF;


    -- RGM é opcional para determinados perfis
    v_rgm := NULLIF(
        TRIM(
            COALESCE(
                NEW.raw_user_meta_data ->> 'rgm',
                ''
            )
        ),
        ''
    );


    INSERT INTO public.perfis
    (
        id,
        nome,
        email,
        rgm,
        perfil,
        situacao
    )
    VALUES
    (
        NEW.id,
        v_nome,
        LOWER(NEW.email),
        v_rgm,
        v_perfil,
        'PENDENTE'
    );


    RETURN NEW;

END;
$$;



-- TRIGGER
-- Cria automaticamente o perfil após a criação do usuário em auth.users


DROP TRIGGER IF EXISTS ao_criar_usuario ON auth.users;

CREATE TRIGGER ao_criar_usuario
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE PROCEDURE public.criar_perfil_novo_usuario();



-- ROW LEVEL SECURITY - RLS


ALTER TABLE public.perfis ENABLE ROW LEVEL SECURITY;



-- FUNÇÃO AUXILIAR
-- Verifica se o usuário autenticado é administrador ativo


CREATE OR REPLACE FUNCTION public.eh_administrador()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$

    SELECT EXISTS
    (
        SELECT 1

        FROM public.perfis P

        WHERE P.id = (SELECT auth.uid())
          AND P.perfil = 'ADMIN'
          AND P.situacao = 'ATIVO'
    );

$$;


-- A função não ficará disponível para usuários anônimos

REVOKE ALL
ON FUNCTION public.eh_administrador()
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.eh_administrador()
TO authenticated;



-- POLÍTICA GLOBAL DE MFA
--
-- Qualquer acesso à tabela perfis através da aplicação exige AAL2,
-- ou seja, senha + segundo fator de autenticação.


CREATE POLICY "perfis_exigem_aal2"
ON public.perfis
AS RESTRICTIVE
FOR ALL
TO authenticated
USING
(
    (SELECT auth.jwt() ->> 'aal') = 'aal2'
)
WITH CHECK
(
    (SELECT auth.jwt() ->> 'aal') = 'aal2'
);



-- LEITURA
--
-- O usuário pode visualizar seu próprio perfil.
-- O administrador pode visualizar todos os perfis.


CREATE POLICY "perfis_consultar_proprio_ou_administrador"
ON public.perfis
FOR SELECT
TO authenticated
USING
(
       (SELECT auth.uid()) = id
    OR (SELECT public.eh_administrador())
);



-- ALTERAÇÃO
--
-- Neste primeiro momento somente ADMIN poderá alterar perfis.
-- Isso impede que um usuário altere seu próprio perfil para ADMIN.


CREATE POLICY "perfis_alterar_como_administrador"
ON public.perfis
FOR UPDATE
TO authenticated
USING
(
    (SELECT public.eh_administrador())
)
WITH CHECK
(
    (SELECT public.eh_administrador())
);



-- PERMISSÕES


REVOKE ALL
ON TABLE public.perfis
FROM anon;

REVOKE ALL
ON TABLE public.perfis
FROM authenticated;

GRANT SELECT, UPDATE
ON TABLE public.perfis
TO authenticated;