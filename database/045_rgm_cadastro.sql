-- Aplicar após 044 junto da nova tela de cadastro. Preserva contas anteriores.
-- O RGM é informado no cadastro, mas vinculado ao ticket validado no servidor.
BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('public.tickets_cadastro_aluno') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
           WHERE attrelid = 'public.convites_aluno'::regclass AND attname = 'perfil_destino' AND NOT attisdropped)
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
           WHERE tgrelid = 'auth.users'::regclass AND tgname = 'examentech_exigir_convite_aluno'
             AND tgenabled IN ('O','A')) THEN
        RAISE EXCEPTION 'Confira as migrações de convite e perfil antes da 045.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.perfis
        WHERE NULLIF(btrim(rgm), '') IS NOT NULL
        GROUP BY upper(btrim(rgm)) COLLATE "C" HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Existem RGMs duplicados após normalização. Revise os registros antes da 045.';
    END IF;
END;
$$;

ALTER TABLE public.tickets_cadastro_aluno ADD COLUMN IF NOT EXISTS rgm_validado TEXT;
COMMENT ON COLUMN public.tickets_cadastro_aluno.rgm_validado IS
    'RGM normalizado após validação do convite. Nunca é obtido dos metadados mutáveis do Auth.';

-- O índice anterior continua presente; este também protege contra variações de caixa e espaços.
CREATE UNIQUE INDEX IF NOT EXISTS perfis_rgm_normalizado_unico
ON public.perfis ((upper(btrim(rgm)) COLLATE "C"))
WHERE NULLIF(btrim(rgm), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION examentech_private.preparar_cadastro_com_rgm(
    p_email TEXT, p_codigo_organizacao TEXT, p_codigo_convite TEXT, p_rgm TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_resultado JSONB;
    v_ticket_id UUID;
    v_perfil TEXT;
    v_rgm TEXT := NULLIF(upper(btrim(COALESCE(p_rgm, ''))), '');
BEGIN
    -- Reutiliza validação de e-mail/códigos, bloqueio do convite e limite de reemissões.
    v_resultado := examentech_private.preparar_cadastro_aluno(
        p_email, p_codigo_organizacao, p_codigo_convite);
    SELECT t.id, c.perfil_destino INTO v_ticket_id, v_perfil
    FROM public.tickets_cadastro_aluno t JOIN public.convites_aluno c ON c.id = t.convite_id
    WHERE t.codigo_hash = encode(sha256(convert_to(v_resultado->>'ticket', 'UTF8')), 'hex');

    IF v_ticket_id IS NULL OR v_perfil NOT IN ('ALUNO', 'PROFESSOR') THEN
        RAISE EXCEPTION 'Códigos inválidos ou expirados.' USING ERRCODE = '22023';
    END IF;
    IF v_perfil = 'ALUNO' THEN
        IF v_rgm IS NULL THEN
            RAISE EXCEPTION 'Informe o RGM para o cadastro de aluno.' USING ERRCODE = 'P2010';
        END IF;
        IF v_rgm COLLATE "C" !~ '^[A-Z0-9][A-Z0-9._/-]{0,49}$' THEN
            RAISE EXCEPTION 'RGM inválido.' USING ERRCODE = 'P2011';
        END IF;
        IF EXISTS (SELECT 1 FROM public.perfis WHERE upper(btrim(rgm)) COLLATE "C" = v_rgm COLLATE "C") THEN
            RAISE EXCEPTION 'RGM já cadastrado.' USING ERRCODE = 'P2012';
        END IF;
        UPDATE public.tickets_cadastro_aluno SET rgm_validado = v_rgm WHERE id = v_ticket_id;
    END IF;
    -- Professores não recebem um RGM discente, mesmo se enviado pelo navegador.
    RETURN v_resultado;
END;
$$;

CREATE OR REPLACE FUNCTION public.preparar_cadastro_com_rgm(
    p_email TEXT, p_codigo_organizacao TEXT, p_codigo_convite TEXT, p_rgm TEXT
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT examentech_private.preparar_cadastro_com_rgm(
        p_email, p_codigo_organizacao, p_codigo_convite, p_rgm)
$$;
REVOKE ALL ON FUNCTION examentech_private.preparar_cadastro_com_rgm(TEXT,TEXT,TEXT,TEXT)
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preparar_cadastro_com_rgm(TEXT,TEXT,TEXT,TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.preparar_cadastro_com_rgm(TEXT,TEXT,TEXT,TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.preparar_cadastro_com_rgm(TEXT,TEXT,TEXT,TEXT) TO anon;

CREATE OR REPLACE FUNCTION public.criar_perfil_novo_usuario()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_nome TEXT;
    v_organizacao_id UUID;
    v_perfil TEXT;
    v_rgm TEXT;
    v_restricao TEXT;
BEGIN
    -- 005 já consumiu o ticket/convite na mesma transação do Auth.
    SELECT c.organizacao_id, c.perfil_destino, t.rgm_validado
    INTO v_organizacao_id, v_perfil, v_rgm
    FROM public.convites_aluno c
    JOIN public.organizacoes o ON o.id = c.organizacao_id
    JOIN public.tickets_cadastro_aluno t ON t.convite_id = c.id AND t.utilizado_por = NEW.id
    WHERE c.utilizado_por = NEW.id AND c.situacao = 'UTILIZADO'
      AND c.utilizado_em IS NOT NULL AND t.utilizado_em IS NOT NULL
      AND c.email = lower(btrim(NEW.email)) AND o.situacao = 'ATIVO';
    IF v_organizacao_id IS NULL OR v_perfil IS NULL OR v_perfil NOT IN ('ALUNO','PROFESSOR') THEN
        RAISE EXCEPTION 'Cadastro requer convite e organização válidos.' USING ERRCODE = '22023';
    END IF;
    IF v_perfil = 'ALUNO' AND (v_rgm IS NULL OR v_rgm COLLATE "C" !~ '^[A-Z0-9][A-Z0-9._/-]{0,49}$') THEN
        RAISE EXCEPTION 'Cadastro de aluno requer RGM validado no convite.' USING ERRCODE = 'P2010';
    END IF;
    v_nome := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'nome', '')), '');
    IF v_nome IS NULL THEN v_nome := split_part(COALESCE(NEW.email, 'usuario'), '@', 1); END IF;
    BEGIN
        INSERT INTO public.perfis(id,nome,email,rgm,perfil,situacao,organizacao_id)
        VALUES(NEW.id,v_nome,lower(NEW.email),CASE WHEN v_perfil='ALUNO' THEN v_rgm END,
            v_perfil,'ATIVO',v_organizacao_id);
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_restricao = CONSTRAINT_NAME;
        IF v_restricao IN ('perfis_rgm_unico','perfis_rgm_normalizado_unico') THEN
            RAISE EXCEPTION 'RGM já cadastrado.' USING ERRCODE = 'P2012';
        END IF;
        RAISE;
    END;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.criar_perfil_novo_usuario() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.criar_perfil_novo_usuario() TO supabase_auth_admin;
COMMIT;
