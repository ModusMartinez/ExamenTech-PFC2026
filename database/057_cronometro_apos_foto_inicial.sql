-- RF34: aplicar após 056. A foto inicial confirma o início do cronômetro no servidor.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = 'public.tentativas'::regclass AND attname = 'cronometro_iniciado_em' AND NOT attisdropped) THEN
        ALTER TABLE public.tentativas ADD COLUMN cronometro_iniciado_em TIMESTAMPTZ;
        UPDATE public.tentativas SET cronometro_iniciado_em = iniciada_em;
    END IF;
END;
$$;
ALTER TABLE public.tentativas ALTER COLUMN cronometro_iniciado_em SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION public.iniciar_tentativa_com_fotos(
    p_avaliacao_id UUID, p_aviso_versao TEXT, p_fotos_aviso_versao TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_resultado JSONB;
    v_tentativa public.tentativas%ROWTYPE;
    v_fim TIMESTAMPTZ;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM examentech_private.configuracao_fotos WHERE ativa)
       OR p_fotos_aviso_versao IS DISTINCT FROM '2026-11-08-fotos-v1' THEN
        RAISE EXCEPTION 'A coleta de fotografias não está habilitada ou o aviso não foi confirmado.' USING ERRCODE = '23514';
    END IF;
    v_resultado := examentech_private.iniciar_tentativa_sem_fotos(p_avaliacao_id, p_aviso_versao);
    SELECT fim_em INTO STRICT v_fim FROM public.avaliacoes WHERE id = p_avaliacao_id;
    IF v_fim - clock_timestamp() < interval '15 seconds' THEN
        RAISE EXCEPTION 'Restam menos de 15 segundos na janela da prova.' USING ERRCODE = '55000';
    END IF;
    -- A preparação reserva a tentativa única. Até a foto, somente o fim da janela limita o acesso.
    UPDATE public.tentativas SET cronometro_iniciado_em = NULL, limite_em = v_fim
    WHERE id = (v_resultado->>'id')::UUID RETURNING * INTO STRICT v_tentativa;
    INSERT INTO public.avisos_fotos_tentativa (tentativa_id, ciclo, aviso_versao)
    VALUES (v_tentativa.id, v_tentativa.ciclo, p_fotos_aviso_versao);
    INSERT INTO public.fotos_tentativa (tentativa_id, ciclo, momento, agendada_em)
    VALUES (v_tentativa.id, v_tentativa.ciclo, 'INICIAL', v_tentativa.iniciada_em);
    RETURN to_jsonb(v_tentativa);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirmar_envio_foto(p_captura_id UUID, p_upload_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_foto public.fotos_tentativa%ROWTYPE;
    v_tentativa public.tentativas%ROWTYPE;
    v_duracao DOUBLE PRECISION;
    v_recebida_em TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_foto FROM public.fotos_tentativa WHERE id = p_captura_id FOR UPDATE;
    IF NOT FOUND OR v_foto.upload_id IS DISTINCT FROM p_upload_id OR v_foto.situacao NOT IN ('ENVIANDO', 'DISPONIVEL') THEN
        RAISE EXCEPTION 'Reserva de envio não encontrada.' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'examentech-evidencias' AND name = v_foto.caminho) THEN
        RAISE EXCEPTION 'Arquivo não encontrado no armazenamento.' USING ERRCODE = '55000';
    END IF;
    IF v_foto.situacao = 'ENVIANDO' THEN
        SELECT te.* INTO v_tentativa FROM public.tentativas te
        JOIN examentech_private.execucoes_tentativa e ON e.tentativa_id = te.id
        JOIN auth.sessions s ON s.id = e.sessao_id AND s.user_id = te.aluno_id
        WHERE te.id = v_foto.tentativa_id AND te.situacao = 'EM_ANDAMENTO' AND te.ciclo = v_foto.ciclo
        FOR UPDATE OF te FOR KEY SHARE OF s;
        v_recebida_em := clock_timestamp();
        IF NOT FOUND OR v_recebida_em >= v_tentativa.limite_em THEN
            RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
        END IF;
        UPDATE public.fotos_tentativa SET situacao = 'DISPONIVEL', recebida_em = v_recebida_em
        WHERE id = p_captura_id RETURNING * INTO v_foto;

        IF v_foto.momento = 'INICIAL' AND v_tentativa.cronometro_iniciado_em IS NULL THEN
            UPDATE public.tentativas te SET cronometro_iniciado_em = v_foto.recebida_em,
                limite_em = LEAST(a.fim_em, v_foto.recebida_em + make_interval(mins => a.duracao_minutos))
            FROM public.avaliacoes a WHERE te.id = v_tentativa.id AND a.id = te.avaliacao_id
            RETURNING te.* INTO STRICT v_tentativa;
            v_duracao := extract(epoch FROM (v_tentativa.limite_em - v_foto.recebida_em));
            INSERT INTO public.fotos_tentativa (tentativa_id, ciclo, momento, agendada_em)
            SELECT v_tentativa.id, v_tentativa.ciclo, momento,
                v_foto.recebida_em + make_interval(secs => v_duracao * (inicio + (fim - inicio) * random()))
            FROM (VALUES ('PROVA_1', 0.10, 0.26), ('PROVA_2', 0.38, 0.56), ('PROVA_3', 0.68, 0.86)) janela(momento, inicio, fim);
        END IF;

        INSERT INTO public.eventos_seguranca (solicitacao_id, evento, provedor, acao, sucesso, usuario_id, recurso_id)
        VALUES (gen_random_uuid(), 'FOTO_RECEBIDA', 'EXAMENTECH', 'confirmar_envio_foto', TRUE, v_tentativa.aluno_id, v_foto.id);
    END IF;
    RETURN jsonb_build_object('id', v_foto.id, 'recebida_em', v_foto.recebida_em, 'expira_em', v_foto.expira_em);
END;
$$;

CREATE OR REPLACE FUNCTION public.consultar_plano_fotos(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO' OR clock_timestamp() >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada.' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('tentativa_id', v_tentativa.id, 'tentativa', to_jsonb(v_tentativa),
        'ciclo', v_tentativa.ciclo, 'retencao_dias', 90, 'servidor_em', clock_timestamp(),
        'capturas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'momento', f.momento,
            'agendada_em', f.agendada_em, 'recebida_em', f.recebida_em) ORDER BY f.agendada_em), '[]'::JSONB)
            FROM public.fotos_tentativa f WHERE f.tentativa_id = p_tentativa_id AND f.ciclo = v_tentativa.ciclo));
END;
$$;

REVOKE ALL ON FUNCTION public.iniciar_tentativa_com_fotos(UUID, TEXT, TEXT),
    public.consultar_plano_fotos(UUID), public.confirmar_envio_foto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_envio_foto(UUID, UUID) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
