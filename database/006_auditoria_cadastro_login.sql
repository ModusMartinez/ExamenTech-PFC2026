-- Aplicar depois de 001 e 002, antes de usar o front-end atualizado.
-- Mantém os eventos antigos e não altera os gatilhos de perfil/convite.
BEGIN;

ALTER TABLE public.eventos_seguranca
    ADD COLUMN IF NOT EXISTS usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sessao_id UUID;

ALTER TABLE public.eventos_seguranca
    DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido,
    DROP CONSTRAINT IF EXISTS eventos_seguranca_provedor_valido;

ALTER TABLE public.eventos_seguranca
    ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
        'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
        'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO'
    )),
    ADD CONSTRAINT eventos_seguranca_provedor_valido CHECK (
        provedor IN ('CLOUDFLARE_TURNSTILE', 'SUPABASE_AUTH')
    );

-- O mesmo resultado só é registrado uma vez por sessão, mesmo com F5,
-- troca de aba, renovação de token ou chamadas simultâneas.
CREATE UNIQUE INDEX IF NOT EXISTS eventos_seguranca_sessao_evento_unico
ON public.eventos_seguranca (sessao_id, evento)
WHERE sessao_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS eventos_seguranca_usuario_idx
ON public.eventos_seguranca (usuario_id);

-- Não liberar INSERT no navegador para registrar auditoria.
REVOKE INSERT, UPDATE, DELETE ON public.eventos_seguranca
FROM PUBLIC, anon, authenticated;

CREATE SCHEMA IF NOT EXISTS examentech_private;
REVOKE ALL ON SCHEMA examentech_private FROM PUBLIC;
-- Preserva o USAGE de anon usado pelos convites de 004.
GRANT USAGE ON SCHEMA examentech_private TO authenticated, supabase_auth_admin;

CREATE OR REPLACE FUNCTION examentech_private.registrar_cadastro()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id
    ) VALUES (
        gen_random_uuid(), 'CADASTRO_REALIZADO', 'SUPABASE_AUTH',
        'cadastro', TRUE, NEW.id
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_cadastro()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_cadastro()
TO supabase_auth_admin;

-- O evento só permanece se a transação inteira do cadastro for concluída.
-- Funciona mesmo quando o cadastro ainda depende da confirmação do e-mail.
DROP TRIGGER IF EXISTS examentech_registrar_cadastro ON auth.users;
CREATE TRIGGER examentech_registrar_cadastro
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION examentech_private.registrar_cadastro();

CREATE OR REPLACE FUNCTION examentech_private.registrar_acesso()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_usuario_id UUID := auth.uid();
    v_sessao_id UUID := NULLIF(auth.jwt() ->> 'session_id', '')::UUID;
    v_perfil public.perfis%ROWTYPE;
    v_evento TEXT;
    v_erro TEXT;
    v_permitido BOOLEAN;
BEGIN
    -- Identidade, sessão e MFA vêm do JWT verificado pelo Supabase.
    -- O navegador não informa usuário, resultado nem conteúdo do evento.
    IF v_usuario_id IS NULL
       OR (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2'
       OR v_sessao_id IS NULL THEN
        RAISE EXCEPTION 'Sessão com MFA obrigatório.' USING ERRCODE = '42501';
    END IF;

    -- Não aceitar um JWT de uma sessão que já foi encerrada.
    IF NOT EXISTS (
        SELECT 1 FROM auth.sessions
        WHERE id = v_sessao_id AND user_id = v_usuario_id
    ) THEN
        RAISE EXCEPTION 'Sessão encerrada ou inválida.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_perfil
    FROM public.perfis
    WHERE id = v_usuario_id;

    IF NOT FOUND THEN
        v_erro := 'PERFIL_NAO_ENCONTRADO';
    ELSIF v_perfil.situacao = 'PENDENTE' THEN
        v_erro := 'PERFIL_PENDENTE';
    ELSIF v_perfil.situacao IS DISTINCT FROM 'ATIVO' THEN
        v_erro := 'PERFIL_INATIVO';
    ELSIF v_perfil.perfil IS NULL
          OR v_perfil.perfil NOT IN ('ADMIN', 'PROFESSOR', 'ALUNO') THEN
        v_erro := 'PERFIL_INVALIDO';
    END IF;

    v_permitido := v_erro IS NULL;
    v_evento := CASE WHEN v_permitido THEN 'LOGIN_SUCESSO' ELSE 'LOGIN_NEGADO' END;

    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso,
        usuario_id, sessao_id, codigos_erro
    ) VALUES (
        gen_random_uuid(), v_evento, 'SUPABASE_AUTH', 'login', v_permitido,
        v_usuario_id, v_sessao_id,
        CASE WHEN v_erro IS NULL THEN ARRAY[]::TEXT[] ELSE ARRAY[v_erro] END
    )
    ON CONFLICT (sessao_id, evento) WHERE sessao_id IS NOT NULL DO NOTHING;

    -- Retornar o mesmo perfil usado na decisão evita uma consulta separada.
    -- Não lançar erro após um LOGIN_NEGADO: isso desfaria o registro.
    IF v_perfil.id IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN jsonb_build_object(
        'nome', v_perfil.nome,
        'email', v_perfil.email,
        'perfil', v_perfil.perfil,
        'situacao', v_perfil.situacao
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_acesso()
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.registrar_acesso() $$;

REVOKE ALL ON FUNCTION examentech_private.registrar_acesso()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.registrar_acesso()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_acesso() TO authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_acesso() TO authenticated;

COMMENT ON TABLE public.eventos_seguranca IS
    'Auditoria de cadastro, acesso após MFA e validações técnicas do Turnstile.';
COMMENT ON COLUMN public.eventos_seguranca.usuario_id IS
    'Usuário do evento; fica nulo se a conta for excluída.';
COMMENT ON COLUMN public.eventos_seguranca.sessao_id IS
    'ID da sessão, não é um token. Mantido no histórico após a saída.';

COMMIT;
