-- Primeiro bloco de turmas: criação pelo professor e consulta por responsável/ADMIN.
-- Aplicar depois de 010. Não altera contas, convites ou matrículas.
BEGIN;

CREATE TABLE IF NOT EXISTS public.turmas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL,
    professor_id UUID NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT,
    organizacao_id UUID NOT NULL REFERENCES public.organizacoes(id) ON DELETE RESTRICT,
    codigo_ingresso TEXT NOT NULL UNIQUE
        DEFAULT upper(substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 12)),
    situacao TEXT NOT NULL DEFAULT 'ATIVA' CHECK (situacao IN ('ATIVA', 'INATIVA')),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT turmas_nome_valido CHECK (
        nome = btrim(nome) AND char_length(nome) BETWEEN 3 AND 100
    ),
    CONSTRAINT turmas_codigo_valido CHECK (codigo_ingresso ~ '^[A-F0-9]{12}$')
);

CREATE INDEX IF NOT EXISTS turmas_professor_idx ON public.turmas (professor_id);
CREATE INDEX IF NOT EXISTS turmas_organizacao_idx ON public.turmas (organizacao_id);

ALTER TABLE public.turmas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.turmas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.turmas TO authenticated;
-- O cliente informa somente o nome. Identidade, organização e código vêm do banco.
GRANT INSERT (nome) ON public.turmas TO authenticated;

CREATE OR REPLACE FUNCTION examentech_private.pode_consultar_turma(
    p_professor_id UUID, p_organizacao_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT (auth.jwt() ->> 'aal') = 'aal2'
       AND EXISTS (
           SELECT 1 FROM auth.sessions s
           WHERE s.id::TEXT = (auth.jwt() ->> 'session_id') AND s.user_id = auth.uid()
       )
       AND EXISTS (
           SELECT 1 FROM public.perfis p
           WHERE p.id = auth.uid() AND p.situacao = 'ATIVO'
             AND (
                 p.perfil = 'ADMIN'
                 OR (
                     p.perfil = 'PROFESSOR' AND p.id = p_professor_id
                     AND p.organizacao_id = p_organizacao_id
                     AND EXISTS (
                         SELECT 1 FROM public.organizacoes o
                         WHERE o.id = p.organizacao_id AND o.situacao = 'ATIVO'
                     )
                 )
             )
       );
$$;

REVOKE ALL ON FUNCTION examentech_private.pode_consultar_turma(UUID, UUID)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.pode_consultar_turma(UUID, UUID)
TO authenticated;

DROP POLICY IF EXISTS turmas_consultar ON public.turmas;
CREATE POLICY turmas_consultar ON public.turmas
FOR SELECT TO authenticated
USING (examentech_private.pode_consultar_turma(professor_id, organizacao_id));

DROP POLICY IF EXISTS turmas_criar ON public.turmas;
CREATE POLICY turmas_criar ON public.turmas
FOR INSERT TO authenticated
WITH CHECK (
    professor_id = (SELECT auth.uid())
    AND examentech_private.pode_consultar_turma(professor_id, organizacao_id)
);

CREATE OR REPLACE FUNCTION examentech_private.preparar_nova_turma()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_professor public.perfis%ROWTYPE;
BEGIN
    SELECT * INTO v_professor FROM public.perfis
    WHERE id = auth.uid() AND perfil = 'PROFESSOR';

    IF NOT FOUND OR examentech_private.pode_consultar_turma(
        v_professor.id, v_professor.organizacao_id
    ) IS NOT TRUE THEN
        RAISE EXCEPTION 'Somente um professor ativo com MFA pode criar turma.'
            USING ERRCODE = '42501';
    END IF;

    NEW.nome := btrim(NEW.nome);
    NEW.professor_id := v_professor.id;
    NEW.organizacao_id := v_professor.organizacao_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.preparar_nova_turma()
FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS preparar_nova_turma ON public.turmas;
CREATE TRIGGER preparar_nova_turma BEFORE INSERT ON public.turmas
FOR EACH ROW EXECUTE FUNCTION examentech_private.preparar_nova_turma();

-- Preserva os eventos existentes e permite identificar a turma na auditoria.
ALTER TABLE public.eventos_seguranca
ADD COLUMN IF NOT EXISTS recurso_id UUID;
ALTER TABLE public.eventos_seguranca
DROP CONSTRAINT IF EXISTS eventos_seguranca_evento_valido,
DROP CONSTRAINT IF EXISTS eventos_seguranca_provedor_valido;
ALTER TABLE public.eventos_seguranca
ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO', 'TURNSTILE_REJEITADO', 'TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO', 'LOGIN_SUCESSO', 'LOGIN_NEGADO', 'TURMA_CRIADA'
)),
ADD CONSTRAINT eventos_seguranca_provedor_valido CHECK (
    provedor IN ('CLOUDFLARE_TURNSTILE', 'SUPABASE_AUTH', 'EXAMENTECH')
);

CREATE OR REPLACE FUNCTION examentech_private.registrar_criacao_turma()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.eventos_seguranca (
        solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id
    ) VALUES (
        gen_random_uuid(), 'TURMA_CRIADA', 'EXAMENTECH', 'criar_turma',
        TRUE, NEW.professor_id, NEW.id
    );
    -- Não registra o código de ingresso nem o nome da turma.
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.registrar_criacao_turma()
FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS registrar_criacao_turma ON public.turmas;
CREATE TRIGGER registrar_criacao_turma AFTER INSERT ON public.turmas
FOR EACH ROW EXECUTE FUNCTION examentech_private.registrar_criacao_turma();

COMMIT;
