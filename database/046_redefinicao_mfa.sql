-- Aplicar após 045. A redefinição usa a Admin API somente no servidor.
BEGIN;

DO $$
BEGIN
    IF to_regclass('auth.sessions') IS NULL THEN
        RAISE EXCEPTION 'Auth sem tabela de sessões compatível; nenhuma alteração aplicada.';
    END IF;
    -- A remoção da sessão precisa invalidar também os refresh tokens associados.
    IF to_regclass('auth.refresh_tokens') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = to_regclass('auth.refresh_tokens')
          AND c.confrelid = to_regclass('auth.sessions') AND c.contype = 'f' AND c.confdeltype = 'c'
    ) THEN
        RAISE EXCEPTION 'Confira a FK de refresh_tokens para sessions antes de ativar a redefinição.';
    END IF;
END;
$$;

CREATE TABLE examentech_private.redefinicoes_mfa (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    administrador_id UUID NOT NULL REFERENCES auth.users(id),
    sessao_id UUID NOT NULL,
    usuario_id UUID NOT NULL REFERENCES auth.users(id),
    organizacao_id UUID NOT NULL REFERENCES public.organizacoes(id),
    situacao TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (situacao IN ('PENDENTE','CONCLUIDA','FALHOU')),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(), concluido_em TIMESTAMPTZ
);
ALTER TABLE examentech_private.redefinicoes_mfa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON examentech_private.redefinicoes_mfa FROM PUBLIC, anon, authenticated, service_role;
CREATE UNIQUE INDEX redefinicoes_mfa_pendente ON examentech_private.redefinicoes_mfa(usuario_id)
WHERE situacao = 'PENDENTE';

-- Amplia a lista existente sem apagar eventos e sem relaxar sua validação.
DO $$
DECLARE v_regra TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO STRICT v_regra FROM pg_catalog.pg_constraint
    WHERE conrelid='public.eventos_seguranca'::regclass AND conname='eventos_seguranca_evento_valido';
    ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido;
    EXECUTE 'ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (('
        || substring(v_regra FROM 7) || ') OR evento IN (''MFA_REDEFINICAO_INICIADA'',''MFA_REDEFINIDO'',''MFA_REDEFINICAO_FALHOU''))';
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.organizacao_admin_mfa()
RETURNS UUID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_org UUID;
BEGIN
    IF auth.uid() IS NULL OR (auth.jwt()->>'aal') IS DISTINCT FROM 'aal2'
       OR NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.user_id=auth.uid() AND s.id::TEXT=auth.jwt()->>'session_id') THEN
        RAISE EXCEPTION 'Administrador ativo com MFA obrigatório.' USING ERRCODE='42501';
    END IF;
    SELECT p.organizacao_id INTO v_org FROM public.perfis p
    JOIN public.organizacoes o ON o.id=p.organizacao_id AND o.situacao='ATIVO'
    WHERE p.id=auth.uid() AND p.perfil='ADMIN' AND p.situacao='ATIVO';
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Administrador precisa estar vinculado à organização ativa.' USING ERRCODE='42501';
    END IF;
    RETURN v_org;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.organizacao_admin_mfa() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.listar_usuarios_redefinicao_mfa(p_busca TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_org UUID := examentech_private.organizacao_admin_mfa(); v_busca TEXT := btrim(coalesce(p_busca,''));
BEGIN
    IF char_length(v_busca)<3 OR char_length(v_busca)>120 THEN
        RAISE EXCEPTION 'Informe ao menos três caracteres do nome ou e-mail.' USING ERRCODE='22023';
    END IF;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM (
        SELECT id,nome,email,perfil FROM public.perfis
        WHERE organizacao_id=v_org AND situacao='ATIVO' AND perfil IN ('ALUNO','PROFESSOR')
          AND id<>auth.uid() AND (strpos(lower(nome),lower(v_busca))>0 OR strpos(lower(email),lower(v_busca))>0)
        ORDER BY nome,id LIMIT 50
    ) p),'[]'::JSONB);
END;
$$;

CREATE OR REPLACE FUNCTION public.autorizar_redefinicao_mfa(p_usuario_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_org UUID := examentech_private.organizacao_admin_mfa(); v_id UUID;
BEGIN
    IF p_usuario_id=auth.uid() OR NOT EXISTS (
        SELECT 1 FROM public.perfis WHERE id=p_usuario_id AND organizacao_id=v_org
        AND perfil IN ('ALUNO','PROFESSOR') AND situacao='ATIVO'
    ) THEN
        RAISE EXCEPTION 'Usuário não encontrado ou acesso não autorizado.' USING ERRCODE='42501';
    END IF;
    -- Operações interrompidas podem ser repetidas manualmente após cinco minutos.
    WITH expiradas AS (
        UPDATE examentech_private.redefinicoes_mfa SET situacao='FALHOU',concluido_em=now()
        WHERE usuario_id=p_usuario_id AND situacao='PENDENTE' AND criado_em<now()-INTERVAL '5 minutes'
        RETURNING administrador_id,usuario_id
    )
    INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id,codigos_erro)
    SELECT gen_random_uuid(),'MFA_REDEFINICAO_FALHOU','SUPABASE_AUTH','redefinir_mfa',FALSE,
        administrador_id,usuario_id,ARRAY['AUTORIZACAO_EXPIRADA']::TEXT[] FROM expiradas;
    INSERT INTO examentech_private.redefinicoes_mfa(administrador_id,sessao_id,usuario_id,organizacao_id)
    VALUES(auth.uid(),(auth.jwt()->>'session_id')::UUID,p_usuario_id,v_org) RETURNING id INTO v_id;
    INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id)
    VALUES(v_id,'MFA_REDEFINICAO_INICIADA','SUPABASE_AUTH','redefinir_mfa',TRUE,auth.uid(),p_usuario_id);
    RETURN v_id;
END;
$$;

-- Sem grant para authenticated: apenas o servidor pode concluir a autorização registrada.
CREATE OR REPLACE FUNCTION public.concluir_redefinicao_mfa(p_redefinicao_id UUID,p_sucesso BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_registro examentech_private.redefinicoes_mfa%ROWTYPE; v_autorizacao_valida BOOLEAN;
BEGIN
    SELECT * INTO v_registro FROM examentech_private.redefinicoes_mfa WHERE id=p_redefinicao_id FOR UPDATE;
    IF NOT FOUND OR v_registro.situacao<>'PENDENTE' OR p_sucesso IS NULL THEN
        RAISE EXCEPTION 'Redefinição pendente não encontrada.' USING ERRCODE='55000';
    END IF;
    IF v_registro.criado_em<now()-INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'Autorização expirada. Confira a auditoria.' USING ERRCODE='55000';
    END IF;
    v_autorizacao_valida := EXISTS (
        SELECT 1 FROM public.perfis p JOIN public.organizacoes o ON o.id=p.organizacao_id
        JOIN auth.sessions s ON s.user_id=p.id AND s.id=v_registro.sessao_id
        WHERE p.id=v_registro.administrador_id AND p.perfil='ADMIN' AND p.situacao='ATIVO'
        AND p.organizacao_id=v_registro.organizacao_id AND o.situacao='ATIVO'
    );
    p_sucesso := p_sucesso AND v_autorizacao_valida;
    -- JWTs emitidos não somem do navegador. Os RPCs conferem a existência da sessão.
    -- Executado também no erro: uma remoção parcial não deve conservar sessões antigas.
    DELETE FROM auth.sessions WHERE user_id=v_registro.usuario_id;
    UPDATE examentech_private.redefinicoes_mfa
    SET situacao=CASE WHEN p_sucesso THEN 'CONCLUIDA' ELSE 'FALHOU' END,concluido_em=now()
    WHERE id=v_registro.id;
    INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id,codigos_erro)
    VALUES(gen_random_uuid(),CASE WHEN p_sucesso THEN 'MFA_REDEFINIDO' ELSE 'MFA_REDEFINICAO_FALHOU' END,
       'SUPABASE_AUTH','redefinir_mfa',p_sucesso,v_registro.administrador_id,v_registro.usuario_id,
       CASE WHEN p_sucesso THEN ARRAY[]::TEXT[] ELSE ARRAY['REDEFINICAO_NAO_CONFIRMADA'] END);
    RETURN v_autorizacao_valida;
END;
$$;

REVOKE ALL ON FUNCTION public.listar_usuarios_redefinicao_mfa(TEXT),public.autorizar_redefinicao_mfa(UUID),
public.concluir_redefinicao_mfa(UUID,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_usuarios_redefinicao_mfa(TEXT),public.autorizar_redefinicao_mfa(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.concluir_redefinicao_mfa(UUID,BOOLEAN) TO service_role;

-- A emissão de convites também precisa recusar JWTs de sessões revogadas.
CREATE OR REPLACE FUNCTION examentech_private.emitir_convite(
    p_email TEXT, p_organizacao_id UUID, p_perfil_destino TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_email TEXT := lower(btrim(COALESCE(p_email,'')));
    v_perfil TEXT; v_situacao TEXT; v_organizacao_usuario UUID;
    v_codigo TEXT; v_id UUID; v_expira_em TIMESTAMPTZ := now()+INTERVAL '7 days';
BEGIN
    IF (auth.jwt()->>'aal') IS DISTINCT FROM 'aal2' OR auth.uid() IS NULL OR NOT EXISTS (
        SELECT 1 FROM auth.sessions WHERE user_id=auth.uid() AND id::TEXT=auth.jwt()->>'session_id'
    ) THEN
        RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
    END IF;
    IF p_perfil_destino IS NULL OR p_perfil_destino NOT IN ('ALUNO','PROFESSOR') THEN
        RAISE EXCEPTION 'Tipo de convite inválido.' USING ERRCODE='22023';
    END IF;
    SELECT perfil,situacao,organizacao_id INTO v_perfil,v_situacao,v_organizacao_usuario
    FROM public.perfis WHERE id=auth.uid();
    IF v_situacao IS DISTINCT FROM 'ATIVO' OR v_perfil IS NULL OR v_perfil NOT IN ('ADMIN','PROFESSOR')
       OR (v_perfil='PROFESSOR' AND (p_perfil_destino<>'ALUNO' OR v_organizacao_usuario IS DISTINCT FROM p_organizacao_id)) THEN
        RAISE EXCEPTION 'Acesso não autorizado.' USING ERRCODE='42501';
    END IF;
    IF p_organizacao_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizacoes
        WHERE id=p_organizacao_id AND situacao='ATIVO' AND codigo_rotacionado_em IS NOT NULL) THEN
        RAISE EXCEPTION 'Organização sem código ativo.' USING ERRCODE='22023';
    END IF;
    IF char_length(v_email)>320 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
        RAISE EXCEPTION 'Informe um e-mail válido.' USING ERRCODE='22023';
    END IF;
    v_codigo := replace(gen_random_uuid()::TEXT,'-','') || replace(gen_random_uuid()::TEXT,'-','');
    INSERT INTO public.convites_aluno(organizacao_id,email,codigo_hash,liberado_por,expira_em,perfil_destino)
    VALUES(p_organizacao_id,v_email,encode(sha256(convert_to(v_codigo,'UTF8')),'hex'),auth.uid(),v_expira_em,p_perfil_destino)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('id',v_id,'email',v_email,'organizacao_id',p_organizacao_id,
        'codigo',v_codigo,'expira_em',v_expira_em,'perfil_destino',p_perfil_destino);
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.emitir_convite(TEXT,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.emitir_convite(TEXT,UUID,TEXT) TO authenticated;
COMMIT;
