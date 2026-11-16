-- Aplicar depois de 046. A conta continua ativa para solicitar a primeira matrícula.
-- A primeira aprovação libera o ingresso. Vínculos inativados preservam o histórico.
-- Cada avaliação continua exigindo matrícula e turma ativas pelas RPCs próprias.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.consultar_ingresso_aluno()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_organizacao_id UUID;
    v_aprovadas BIGINT;
    v_pendentes BIGINT;
    v_fase TEXT;
BEGIN
    SELECT p.organizacao_id INTO v_organizacao_id
    FROM public.perfis p
    JOIN public.organizacoes o ON o.id = p.organizacao_id
    WHERE p.id = auth.uid() AND p.perfil = 'ALUNO'
      AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
      AND (auth.jwt() ->> 'aal') = 'aal2'
      AND EXISTS (
          SELECT 1 FROM auth.sessions s
          WHERE s.user_id = p.id AND s.id::TEXT = (auth.jwt() ->> 'session_id')
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ingresso exige aluno ativo, organização ativa, sessão e MFA.'
            USING ERRCODE = '42501';
    END IF;

    -- Consulta todos os vínculos; a listagem paginada não determina o acesso.
    -- A rotina 018 só inativa vínculos anteriormente ATIVA. Uma turma encerrada
    -- não deve impedir que um aluno já admitido consulte seus resultados antigos.
    SELECT count(*) FILTER (WHERE m.situacao IN ('ATIVA', 'INATIVA')),
           count(*) FILTER (WHERE m.situacao = 'PENDENTE' AND t.situacao = 'ATIVA')
    INTO v_aprovadas, v_pendentes
    FROM public.turma_alunos m
    JOIN public.turmas t ON t.id = m.turma_id
    WHERE m.aluno_id = auth.uid() AND t.organizacao_id = v_organizacao_id;

    v_fase := CASE WHEN v_aprovadas > 0 THEN 'LIBERADO'
                   WHEN v_pendentes > 0 THEN 'PENDENTE'
                   ELSE 'SEM_MATRICULA' END;
    RETURN jsonb_build_object(
        'fase', v_fase, 'acesso_liberado', v_aprovadas > 0,
        'matriculas_pendentes', v_pendentes
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_ingresso_aluno()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.consultar_ingresso_aluno() $$;

REVOKE ALL ON FUNCTION examentech_private.consultar_ingresso_aluno()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consultar_ingresso_aluno()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.consultar_ingresso_aluno() TO authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_ingresso_aluno() TO authenticated;

COMMENT ON FUNCTION public.consultar_ingresso_aluno() IS
    'Situação de ingresso do próprio aluno. Não aprova matrícula nem altera perfis; avaliações continuam verificando o vínculo no banco.';

COMMIT;
