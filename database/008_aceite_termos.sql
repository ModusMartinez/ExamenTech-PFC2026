-- Aplicar depois de 007, no mesmo Supabase usado pelo site.
-- Exige aceite somente em novos cadastros. Não inventa aceite para contas antigas.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'auth.users'::regclass
          AND tgname = 'examentech_exigir_convite_aluno'
          AND tgenabled IN ('O', 'A')
    ) THEN
        RAISE EXCEPTION 'A exigência de convite de 005 precisa estar ativa.';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.aceites_termos (
    usuario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    termos_versao TEXT NOT NULL,
    privacidade_versao TEXT NOT NULL,
    aceito_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (usuario_id, termos_versao)
);

ALTER TABLE public.aceites_termos ENABLE ROW LEVEL SECURITY;

-- A gravação pertence ao gatilho. O navegador só pode consultar.
REVOKE ALL ON public.aceites_termos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.aceites_termos TO authenticated;

DROP POLICY IF EXISTS aceites_termos_leitura ON public.aceites_termos;
CREATE POLICY aceites_termos_leitura
ON public.aceites_termos
FOR SELECT TO authenticated
USING (
    (SELECT auth.jwt() ->> 'aal') = 'aal2'
    AND ((SELECT auth.uid()) = usuario_id OR (SELECT public.eh_administrador()))
);

CREATE OR REPLACE FUNCTION examentech_private.registrar_aceite_termos()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Exige booleano true e as versões publicadas, não a string "true".
    IF (NEW.raw_user_meta_data -> 'termos_aceitos') IS DISTINCT FROM 'true'::jsonb
       OR (NEW.raw_user_meta_data ->> 'termos_versao') IS DISTINCT FROM '2026-09-27'
       OR (NEW.raw_user_meta_data ->> 'privacidade_versao') IS DISTINCT FROM '2026-09-27' THEN
        RAISE EXCEPTION 'Cadastro requer aceite da versão atual dos Termos de Uso.'
            USING ERRCODE = '22023';
    END IF;

    -- Usuário e horário vêm do banco, não de campos enviados pelo navegador.
    INSERT INTO public.aceites_termos (
        usuario_id, termos_versao, privacidade_versao, aceito_em
    ) VALUES (
        NEW.id, '2026-09-27', '2026-09-27', NOW()
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_aceite_termos()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_aceite_termos()
TO supabase_auth_admin;

-- Perfil, convite, aceite e auditoria fazem parte da mesma transação.
-- Se qualquer etapa falhar, todas são desfeitas.
DROP TRIGGER IF EXISTS examentech_registrar_aceite_termos ON auth.users;
CREATE TRIGGER examentech_registrar_aceite_termos
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION examentech_private.registrar_aceite_termos();

COMMENT ON TABLE public.aceites_termos IS
    'Declaração de aceite no cadastro; não é consentimento genérico de tratamento de dados.';
COMMENT ON COLUMN public.aceites_termos.privacidade_versao IS
    'Versão da Política de Privacidade apresentada junto aos termos.';
COMMENT ON COLUMN public.aceites_termos.aceito_em IS
    'Data do registro no servidor durante a criação da conta, não do clique na caixa.';

COMMIT;
