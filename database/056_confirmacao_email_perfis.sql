-- RF03: aplicar depois de 055. A confirmação é informada pelo Supabase Auth.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION examentech_private.exigir_email_confirmado_perfil()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.situacao = 'ATIVO' AND NOT EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id = NEW.id AND u.email_confirmed_at IS NOT NULL
    ) THEN
        IF TG_OP = 'INSERT' THEN
            -- O cadastro existente solicita ATIVO para alunos. A confirmação libera esse perfil depois.
            NEW.situacao := 'PENDENTE';
        ELSE
            RAISE EXCEPTION 'Confirme o e-mail antes de ativar o perfil.' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.exigir_email_confirmado_perfil()
    FROM PUBLIC, anon, authenticated, service_role, supabase_auth_admin;

DROP TRIGGER IF EXISTS perfis_exigir_email_confirmado ON public.perfis;
CREATE TRIGGER perfis_exigir_email_confirmado
    BEFORE INSERT OR UPDATE OF situacao, id ON public.perfis
    FOR EACH ROW EXECUTE FUNCTION examentech_private.exigir_email_confirmado_perfil();

CREATE OR REPLACE FUNCTION examentech_private.sincronizar_confirmacao_email()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.email_confirmed_at IS NULL THEN
        UPDATE public.perfis SET situacao = 'PENDENTE' WHERE id = NEW.id AND situacao = 'ATIVO';
    ELSE
        -- Professores ainda dependem da aprovação administrativa. INATIVO não é reativado.
        UPDATE public.perfis SET situacao = 'ATIVO'
        WHERE id = NEW.id AND perfil = 'ALUNO' AND situacao = 'PENDENTE';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.sincronizar_confirmacao_email()
    FROM PUBLIC, anon, authenticated, service_role, supabase_auth_admin;

DROP TRIGGER IF EXISTS ao_confirmar_email_perfil ON auth.users;
CREATE TRIGGER ao_confirmar_email_perfil
    AFTER UPDATE OF email_confirmed_at ON auth.users
    FOR EACH ROW WHEN (OLD.email_confirmed_at IS DISTINCT FROM NEW.email_confirmed_at)
    EXECUTE FUNCTION examentech_private.sincronizar_confirmacao_email();

CREATE OR REPLACE FUNCTION public.listar_professores_pendentes()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.exigir_admin_aprovacao_professor();
    RETURN COALESCE((
        SELECT jsonb_agg(to_jsonb(pendente) ORDER BY pendente.criado_em, pendente.id)
        FROM (
            SELECT p.id, p.nome, p.email, o.nome AS organizacao, p.criado_em
            FROM public.perfis p
            JOIN public.organizacoes o ON o.id = p.organizacao_id AND o.situacao = 'ATIVO'
            JOIN auth.users u ON u.id = p.id AND u.email_confirmed_at IS NOT NULL
            WHERE p.perfil = 'PROFESSOR' AND p.situacao = 'PENDENTE'
            ORDER BY p.criado_em, p.id LIMIT 50
        ) pendente
    ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.aprovar_professor(p_professor_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.exigir_admin_aprovacao_professor();
    UPDATE public.perfis p SET situacao = 'ATIVO'
    FROM public.organizacoes o, auth.users u
    WHERE p.id = p_professor_id AND p.perfil = 'PROFESSOR' AND p.situacao = 'PENDENTE'
      AND o.id = p.organizacao_id AND o.situacao = 'ATIVO'
      AND u.id = p.id AND u.email_confirmed_at IS NOT NULL;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(), 'PROFESSOR_APROVADO', 'EXAMENTECH', 'aprovar_professor', TRUE, auth.uid(), p_professor_id);
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.listar_professores_pendentes(), public.aprovar_professor(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_professores_pendentes(), public.aprovar_professor(UUID) TO authenticated;

-- Concilia os perfis anteriores com a confirmação que já consta no Auth.
UPDATE public.perfis p SET situacao = 'PENDENTE'
FROM auth.users u WHERE u.id = p.id AND u.email_confirmed_at IS NULL AND p.situacao = 'ATIVO';
UPDATE public.perfis p SET situacao = 'ATIVO'
FROM auth.users u WHERE u.id = p.id AND u.email_confirmed_at IS NOT NULL
    AND p.perfil = 'ALUNO' AND p.situacao = 'PENDENTE';

NOTIFY pgrst, 'reload schema';
COMMIT;
