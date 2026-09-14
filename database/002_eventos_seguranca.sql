-- ExamenTech-PFC2026
-- Auditoria da integração com o Cloudflare Turnstile


-- TABELA: eventos_seguranca
--
-- Registra somente o resultado técnico da validação anti-bot.
-- Tokens, chaves, endereço IP e dados do navegador não são armazenados.


CREATE TABLE public.eventos_seguranca
(
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    solicitacao_id  UUID NOT NULL UNIQUE,
    evento          TEXT NOT NULL,
    provedor        TEXT NOT NULL DEFAULT 'CLOUDFLARE_TURNSTILE',
    acao            TEXT NOT NULL DEFAULT 'login',
    sucesso         BOOLEAN NOT NULL,
    hostname        TEXT,
    codigos_erro    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT eventos_seguranca_evento_valido
        CHECK
        (
            evento IN
            (
                'TURNSTILE_VALIDADO',
                'TURNSTILE_REJEITADO',
                'TURNSTILE_INDISPONIVEL'
            )
        ),

    CONSTRAINT eventos_seguranca_provedor_valido
        CHECK (provedor = 'CLOUDFLARE_TURNSTILE')
);


CREATE INDEX eventos_seguranca_criado_em_idx
    ON public.eventos_seguranca (criado_em DESC);

CREATE INDEX eventos_seguranca_evento_idx
    ON public.eventos_seguranca (evento);


-- ROW LEVEL SECURITY - RLS


ALTER TABLE public.eventos_seguranca ENABLE ROW LEVEL SECURITY;


-- A consulta pela aplicação exige MFA e perfil administrativo ativo.


CREATE POLICY "eventos_seguranca_exigem_aal2"
ON public.eventos_seguranca
AS RESTRICTIVE
FOR SELECT
TO authenticated
USING
(
    (SELECT auth.jwt() ->> 'aal') = 'aal2'
);


CREATE POLICY "eventos_seguranca_consultar_como_administrador"
ON public.eventos_seguranca
FOR SELECT
TO authenticated
USING
(
    (SELECT public.eh_administrador())
);


-- O navegador não pode gravar, alterar ou apagar a auditoria.
-- A Vercel Function registra eventos usando a service role no servidor.


REVOKE ALL
ON TABLE public.eventos_seguranca
FROM anon;

REVOKE ALL
ON TABLE public.eventos_seguranca
FROM authenticated;

GRANT SELECT
ON TABLE public.eventos_seguranca
TO authenticated;

GRANT INSERT, SELECT
ON TABLE public.eventos_seguranca
TO service_role;


COMMENT ON TABLE public.eventos_seguranca IS
    'Eventos técnicos de segurança gerados por integrações externas.';

COMMENT ON COLUMN public.eventos_seguranca.solicitacao_id IS
    'Identificador de correlação gerado pelo back-end.';

COMMENT ON COLUMN public.eventos_seguranca.codigos_erro IS
    'Códigos não sensíveis retornados pelo provedor, sem armazenar o token.';
