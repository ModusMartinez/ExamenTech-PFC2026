-- Aplicar após 035. Prepara o registro de câmera sem mudar o encerramento atual da tela.
BEGIN;

CREATE OR REPLACE FUNCTION examentech_private.registrar_falha_camera(
    p_tentativa_id UUID, p_solicitacao_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_tentativa public.tentativas%ROWTYPE;
    v_evento public.eventos_seguranca%ROWTYPE;
BEGIN
    IF p_solicitacao_id IS NULL THEN
        RAISE EXCEPTION 'Identificador da ocorrência obrigatório.' USING ERRCODE = '23514';
    END IF;
    -- Reutiliza a autorização e o bloqueio de linha das operações da tentativa.
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO'
       OR clock_timestamp() >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.eventos_seguranca
        (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id, criado_em)
    VALUES (p_solicitacao_id, 'CAMERA_FALHA', 'EXAMENTECH', 'falha_camera',
        FALSE, auth.uid(), p_tentativa_id, clock_timestamp())
    ON CONFLICT (solicitacao_id) DO NOTHING;

    -- Repetir o identificador confirma a mesma ocorrência, sem duplicar o histórico.
    SELECT * INTO v_evento FROM public.eventos_seguranca
    WHERE solicitacao_id = p_solicitacao_id;
    IF NOT FOUND OR v_evento.evento IS DISTINCT FROM 'CAMERA_FALHA'
       OR v_evento.provedor IS DISTINCT FROM 'EXAMENTECH'
       OR v_evento.acao IS DISTINCT FROM 'falha_camera'
       OR v_evento.sucesso IS DISTINCT FROM FALSE
       OR v_evento.usuario_id IS DISTINCT FROM auth.uid()
       OR v_evento.recurso_id IS DISTINCT FROM p_tentativa_id THEN
        RAISE EXCEPTION 'Identificador da ocorrência já utilizado.' USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object('solicitacao_id', v_evento.solicitacao_id,
        'tentativa_id', v_evento.recurso_id, 'registrado_em', v_evento.criado_em);
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_falha_camera(
    p_tentativa_id UUID, p_solicitacao_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT examentech_private.registrar_falha_camera(p_tentativa_id, p_solicitacao_id) $$;

REVOKE ALL ON FUNCTION public.registrar_falha_camera(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION examentech_private.registrar_falha_camera(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_falha_camera(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.registrar_falha_camera(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.registrar_falha_camera(UUID, UUID) IS
    'Registra indisponibilidade de câmera informada pelo aluno, sem encerrar a tentativa. Reenvio usa o mesmo solicitacao_id.';

NOTIFY pgrst, 'reload schema';
COMMIT;
