-- RF02: cadastro por convite seguido da aprovação administrativa.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE v_regra TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO STRICT v_regra FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.eventos_seguranca'::regclass AND conname = 'eventos_seguranca_evento_valido';
    ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido;
    EXECUTE 'ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (('
        || substring(v_regra FROM 7) || ') OR evento = ''PROFESSOR_APROVADO'')';
END;
$$;

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
            v_perfil,CASE WHEN v_perfil='PROFESSOR' THEN 'PENDENTE' ELSE 'ATIVO' END,v_organizacao_id);
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

-- O administrador segue o mesmo alcance institucional da emissão de convites.
CREATE FUNCTION examentech_private.exigir_admin_aprovacao_professor()
RETURNS VOID LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
    IF NOT public.eh_administrador() OR (auth.jwt()->>'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS (
           SELECT 1 FROM auth.sessions s
           WHERE s.user_id = auth.uid() AND s.id::text = auth.jwt()->>'session_id'
       ) THEN
        RAISE EXCEPTION 'Aprovar professores exige administrador ativo com MFA.' USING ERRCODE = '42501';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.exigir_admin_aprovacao_professor() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.listar_professores_pendentes()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.exigir_admin_aprovacao_professor();
    RETURN COALESCE((
        SELECT jsonb_agg(to_jsonb(pendente) ORDER BY pendente.criado_em, pendente.id)
        FROM (
            SELECT p.id, p.nome, p.email, o.nome AS organizacao, p.criado_em
            FROM public.perfis p
            JOIN public.organizacoes o ON o.id = p.organizacao_id AND o.situacao = 'ATIVO'
            WHERE p.perfil = 'PROFESSOR' AND p.situacao = 'PENDENTE'
            ORDER BY p.criado_em, p.id LIMIT 50
        ) pendente
    ), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.aprovar_professor(p_professor_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM examentech_private.exigir_admin_aprovacao_professor();
    UPDATE public.perfis p SET situacao = 'ATIVO'
    FROM public.organizacoes o
    WHERE p.id = p_professor_id AND p.perfil = 'PROFESSOR' AND p.situacao = 'PENDENTE'
      AND o.id = p.organizacao_id AND o.situacao = 'ATIVO';
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
    VALUES (gen_random_uuid(), 'PROFESSOR_APROVADO', 'EXAMENTECH', 'aprovar_professor', TRUE, auth.uid(), p_professor_id);
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.listar_professores_pendentes(), public.aprovar_professor(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_professores_pendentes(), public.aprovar_professor(UUID) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
