-- Aplicar após 028. Liberação excepcional preservando tentativa, respostas e eventos.
BEGIN;

ALTER TABLE public.tentativas ADD COLUMN ciclo INTEGER NOT NULL DEFAULT 1 CHECK (ciclo > 0);
ALTER TABLE public.tentativas ADD COLUMN ciclo_iniciado_em TIMESTAMPTZ;
UPDATE public.tentativas SET ciclo_iniciado_em = iniciada_em;
ALTER TABLE public.tentativas ALTER COLUMN ciclo_iniciado_em SET NOT NULL;
ALTER TABLE public.tentativas ALTER COLUMN ciclo_iniciado_em SET DEFAULT clock_timestamp();
ALTER TABLE public.tentativas ADD COLUMN retomada_autorizada BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE public.liberacoes_tentativa (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tentativa_id UUID NOT NULL REFERENCES public.tentativas(id) ON DELETE RESTRICT,
    ciclo_anterior INTEGER NOT NULL,
    autorizado_por UUID NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT,
    motivo TEXT NOT NULL CHECK (length(btrim(motivo)) BETWEEN 5 AND 500),
    minutos INTEGER NOT NULL CHECK (minutos BETWEEN 1 AND 1440),
    criada_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    utilizada_em TIMESTAMPTZ,
    encerramento_anterior TIMESTAMPTZ NOT NULL,
    limite_anterior TIMESTAMPTZ NOT NULL,
    falhas_camera_anteriores INTEGER NOT NULL,
    UNIQUE (tentativa_id, ciclo_anterior)
);
ALTER TABLE public.liberacoes_tentativa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.liberacoes_tentativa FROM PUBLIC, anon, authenticated;

ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO','TURNSTILE_REJEITADO','TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO','LOGIN_SUCESSO','LOGIN_NEGADO','TURMA_CRIADA',
    'MATRICULA_SOLICITADA','MATRICULA_APROVADA','MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA','AVALIACAO_EDITADA','QUESTAO_CRIADA','ALTERNATIVAS_CRIADAS',
    'AVALIACAO_PUBLICADA','TENTATIVA_INICIADA','RESPOSTA_SALVA','TENTATIVA_FINALIZADA',
    'TENTATIVA_INTERROMPIDA','TENTATIVA_RETOMADA','CAMERA_FALHA','TENTATIVA_DESBLOQUEADA',
    'REATIVACAO_AUTORIZADA','TENTATIVAS_CONSULTADAS'
));

CREATE FUNCTION examentech_private.responsavel_pode_gerir_avaliacao(p_avaliacao_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.avaliacoes a
        JOIN public.turmas t ON t.id = a.turma_id
        JOIN public.perfis p ON p.id = auth.uid() AND p.organizacao_id = t.organizacao_id
        JOIN public.organizacoes o ON o.id = p.organizacao_id
        JOIN auth.sessions s ON s.user_id = p.id
        WHERE a.id = p_avaliacao_id AND p.situacao = 'ATIVO' AND o.situacao = 'ATIVO'
          AND (auth.jwt() ->> 'aal') = 'aal2'
          AND s.id::TEXT = (auth.jwt() ->> 'session_id')
          AND (p.perfil = 'ADMIN' OR (p.perfil = 'PROFESSOR'
               AND p.id = t.professor_id AND p.id = a.professor_id))
    );
$$;
REVOKE ALL ON FUNCTION examentech_private.responsavel_pode_gerir_avaliacao(UUID) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.listar_tentativas_responsavel(p_avaliacao_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_resultado JSONB;
BEGIN
    IF examentech_private.responsavel_pode_gerir_avaliacao(p_avaliacao_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Avaliação não encontrada ou sem acesso.' USING ERRCODE = '42501';
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.iniciada_em DESC,item.id), '[]'::JSONB)
    INTO v_resultado FROM (
        SELECT te.id,te.avaliacao_id,te.aluno_id,p.nome AS aluno_nome,te.situacao,
               te.iniciada_em,te.limite_em,te.encerrada_em,te.ciclo,te.retomada_autorizada
        FROM public.tentativas te JOIN public.perfis p ON p.id = te.aluno_id
        WHERE te.avaliacao_id = p_avaliacao_id ORDER BY te.iniciada_em DESC,te.id LIMIT 50
    ) item;
    INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id)
    VALUES (gen_random_uuid(),'TENTATIVAS_CONSULTADAS','EXAMENTECH','listar_tentativas_responsavel',TRUE,auth.uid(),p_avaliacao_id);
    RETURN v_resultado;
END;
$$;

CREATE FUNCTION public.reativar_tentativa(p_tentativa_id UUID,p_motivo TEXT,p_minutos INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE; v_avaliacao public.avaliacoes%ROWTYPE; v_id UUID;
BEGIN
    SELECT * INTO v_tentativa FROM public.tentativas WHERE id = p_tentativa_id FOR UPDATE;
    IF NOT FOUND OR examentech_private.responsavel_pode_gerir_avaliacao(v_tentativa.avaliacao_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Tentativa não encontrada ou sem acesso.' USING ERRCODE = '42501';
    END IF;
    SELECT a.* INTO v_avaliacao FROM public.avaliacoes a
    JOIN public.turmas t ON t.id = a.turma_id
    JOIN public.turma_alunos m ON m.turma_id = t.id AND m.aluno_id = v_tentativa.aluno_id
    JOIN public.perfis p ON p.id = m.aluno_id AND p.organizacao_id = t.organizacao_id
    WHERE a.id = v_tentativa.avaliacao_id AND a.situacao = 'PUBLICADA'
      AND t.situacao = 'ATIVA' AND m.situacao = 'ATIVA' AND p.situacao = 'ATIVO' AND p.perfil = 'ALUNO'
    FOR SHARE OF a,t,m,p;
    IF NOT FOUND OR clock_timestamp() >= v_avaliacao.fim_em
       OR clock_timestamp() < v_avaliacao.inicio_em THEN
        RAISE EXCEPTION 'A avaliação ou matrícula não permite a liberação neste período.' USING ERRCODE = '55000';
    END IF;
    IF v_tentativa.situacao <> 'INTERROMPIDA' OR v_tentativa.retomada_autorizada THEN
        RAISE EXCEPTION 'Somente uma tentativa interrompida, ainda não liberada, pode ser reativada.' USING ERRCODE = '55000';
    END IF;
    IF p_motivo IS NULL OR length(btrim(p_motivo)) NOT BETWEEN 5 AND 500
       OR p_minutos IS NULL OR p_minutos NOT BETWEEN 1 AND LEAST(1440,v_avaliacao.duracao_minutos) THEN
        RAISE EXCEPTION 'Informe justificativa e minutos dentro da duração da avaliação.' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.liberacoes_tentativa(tentativa_id,ciclo_anterior,autorizado_por,motivo,minutos,
        encerramento_anterior,limite_anterior,falhas_camera_anteriores)
    VALUES (v_tentativa.id,v_tentativa.ciclo,auth.uid(),btrim(p_motivo),p_minutos,
        v_tentativa.encerrada_em,v_tentativa.limite_em,v_tentativa.falhas_camera) RETURNING id INTO v_id;
    UPDATE public.tentativas SET retomada_autorizada = TRUE WHERE id = v_tentativa.id;
    INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id)
    VALUES (gen_random_uuid(),'REATIVACAO_AUTORIZADA','EXAMENTECH','reativar_tentativa',TRUE,auth.uid(),v_tentativa.id);
    RETURN jsonb_build_object('id',v_tentativa.id,'liberacao_id',v_id,'retomada_autorizada',TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION examentech_private.iniciar_tentativa_com_aviso(p_avaliacao_id UUID,p_aviso_versao TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_liberacao public.liberacoes_tentativa%ROWTYPE;
    v_avaliacao public.avaliacoes%ROWTYPE;
    v_agora TIMESTAMPTZ; v_resultado JSONB;
BEGIN
    IF p_aviso_versao IS DISTINCT FROM '2026-11-06-v2' THEN
        RAISE EXCEPTION 'Aviso da prova não confirmado.' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_tentativa FROM public.tentativas
    WHERE avaliacao_id = p_avaliacao_id AND aluno_id = auth.uid() FOR UPDATE;
    IF FOUND THEN
        v_tentativa := examentech_private.tentativa_do_aluno(v_tentativa.id);
        IF v_tentativa.situacao <> 'INTERROMPIDA' OR NOT v_tentativa.retomada_autorizada THEN
            RAISE EXCEPTION 'Já existe uma tentativa. A retomada exige autorização do responsável.' USING ERRCODE = '55000';
        END IF;
        SELECT * INTO v_liberacao FROM public.liberacoes_tentativa
        WHERE tentativa_id = v_tentativa.id AND ciclo_anterior = v_tentativa.ciclo AND utilizada_em IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Liberação não encontrada.' USING ERRCODE = '55000'; END IF;
        SELECT * INTO v_avaliacao FROM public.avaliacoes WHERE id = p_avaliacao_id FOR SHARE;
        v_agora := clock_timestamp();
        IF v_agora < v_avaliacao.inicio_em OR v_agora >= v_avaliacao.fim_em THEN
            RAISE EXCEPTION 'O período da avaliação terminou ou ainda não começou.' USING ERRCODE = '55000';
        END IF;
        UPDATE public.liberacoes_tentativa SET utilizada_em = v_agora WHERE id = v_liberacao.id;
        UPDATE public.tentativas SET situacao = 'EM_ANDAMENTO', encerrada_em = NULL,
            ciclo = ciclo + 1, ciclo_iniciado_em = v_agora, retomada_autorizada = FALSE,
            limite_em = LEAST(v_avaliacao.fim_em,v_agora + make_interval(mins => v_liberacao.minutos)),
            falhas_camera = 0,aviso_versao = p_aviso_versao,aviso_aceito_em = v_agora
        WHERE id = v_tentativa.id RETURNING * INTO v_tentativa;
        INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id)
        VALUES (gen_random_uuid(),'TENTATIVA_RETOMADA','EXAMENTECH','retomada_autorizada',TRUE,auth.uid(),v_tentativa.id);
    ELSE
        v_resultado := examentech_private.iniciar_tentativa(p_avaliacao_id);
        UPDATE public.tentativas SET aviso_versao = p_aviso_versao,aviso_aceito_em = iniciada_em,
            ciclo_iniciado_em = iniciada_em
        WHERE id = (v_resultado ->> 'id')::UUID RETURNING * INTO v_tentativa;
    END IF;
    RETURN to_jsonb(v_tentativa);
END;
$$;

CREATE FUNCTION public.consultar_respostas_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO' OR clock_timestamp() >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
    END IF;
    RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('questao_id',r.questao_id,
        'alternativa_id',r.alternativa_id,'texto',r.texto,'salva_em',r.salva_em) ORDER BY r.questao_id),'[]'::JSONB)
        FROM public.respostas_tentativa r WHERE r.tentativa_id = p_tentativa_id);
END;
$$;

REVOKE ALL ON FUNCTION public.listar_tentativas_responsavel(UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reativar_tentativa(UUID,TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.consultar_respostas_tentativa(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.listar_tentativas_responsavel(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reativar_tentativa(UUID,TEXT,INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_respostas_tentativa(UUID) TO authenticated;

COMMIT;
