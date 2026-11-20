-- Aplicar após 030. A coleta começa DESLIGADA. Criar bucket privado pela API/painel.
BEGIN;

-- Esta regra restritiva protege o novo bucket mesmo se houver uma política
-- permissiva antiga que permita acesso genérico ao Storage. O serviço privado
-- continua transferindo arquivos depois da autorização pelas funções abaixo.
CREATE POLICY evidencias_sem_acesso_direto ON storage.objects AS RESTRICTIVE
FOR ALL TO anon,authenticated
USING (bucket_id <> 'examentech-evidencias')
WITH CHECK (bucket_id <> 'examentech-evidencias');

CREATE TABLE examentech_private.configuracao_fotos (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    ativa BOOLEAN NOT NULL DEFAULT FALSE,
    retencao_dias INTEGER NOT NULL DEFAULT 90 CHECK (retencao_dias = 90)
);
INSERT INTO examentech_private.configuracao_fotos(id) VALUES(TRUE);
ALTER TABLE examentech_private.configuracao_fotos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON examentech_private.configuracao_fotos FROM PUBLIC,anon,authenticated;

CREATE TABLE public.avisos_fotos_tentativa (
    tentativa_id UUID NOT NULL REFERENCES public.tentativas(id) ON DELETE RESTRICT,
    ciclo INTEGER NOT NULL,
    aviso_versao TEXT NOT NULL,
    termos_versao TEXT NOT NULL DEFAULT '2026-11-08-v6',
    privacidade_versao TEXT NOT NULL DEFAULT '2026-11-08-v5',
    revogado_em TIMESTAMPTZ,
    aceito_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tentativa_id,ciclo)
);
CREATE TABLE public.fotos_tentativa (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tentativa_id UUID NOT NULL REFERENCES public.tentativas(id) ON DELETE RESTRICT,
    ciclo INTEGER NOT NULL,
    momento TEXT NOT NULL CHECK (momento IN ('INICIAL','PROVA_1','PROVA_2','PROVA_3')),
    agendada_em TIMESTAMPTZ NOT NULL,
    situacao TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (situacao IN ('PENDENTE','ENVIANDO','DISPONIVEL','EXCLUIDA')),
    caminho TEXT UNIQUE,
    upload_id UUID,
    sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
    tamanho_bytes INTEGER CHECK (tamanho_bytes BETWEEN 1 AND 1048576),
    largura INTEGER CHECK (largura BETWEEN 1 AND 960),
    altura INTEGER CHECK (altura BETWEEN 1 AND 720),
    reservada_em TIMESTAMPTZ,
    recebida_em TIMESTAMPTZ,
    expira_em TIMESTAMPTZ,
    excluida_em TIMESTAMPTZ,
    UNIQUE(tentativa_id,ciclo,momento),
    FOREIGN KEY(tentativa_id,ciclo) REFERENCES public.avisos_fotos_tentativa(tentativa_id,ciclo),
    CHECK (situacao <> 'DISPONIVEL' OR (recebida_em IS NOT NULL AND expira_em IS NOT NULL AND caminho IS NOT NULL))
);
CREATE INDEX fotos_tentativa_expira_idx ON public.fotos_tentativa(expira_em) WHERE situacao <> 'EXCLUIDA';
ALTER TABLE public.fotos_tentativa ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.avisos_fotos_tentativa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fotos_tentativa,public.avisos_fotos_tentativa FROM PUBLIC,anon,authenticated;

ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido;
ALTER TABLE public.eventos_seguranca ADD CONSTRAINT eventos_seguranca_evento_valido CHECK (evento IN (
    'TURNSTILE_VALIDADO','TURNSTILE_REJEITADO','TURNSTILE_INDISPONIVEL',
    'CADASTRO_REALIZADO','LOGIN_SUCESSO','LOGIN_NEGADO','TURMA_CRIADA',
    'MATRICULA_SOLICITADA','MATRICULA_APROVADA','MATRICULA_INATIVADA',
    'AVALIACAO_CRIADA','AVALIACAO_EDITADA','QUESTAO_CRIADA','ALTERNATIVAS_CRIADAS',
    'AVALIACAO_PUBLICADA','TENTATIVA_INICIADA','RESPOSTA_SALVA','TENTATIVA_FINALIZADA',
    'TENTATIVA_INTERROMPIDA','TENTATIVA_RETOMADA','CAMERA_FALHA','TENTATIVA_DESBLOQUEADA',
    'REATIVACAO_AUTORIZADA','TENTATIVAS_CONSULTADAS','FOTO_RECEBIDA','FOTO_CONSULTADA','FOTO_EXCLUIDA'
));

-- Fecha o início antigo quando a coleta é ativada. Nenhuma chamada direta do
-- navegador pode iniciar uma prova com fotos sem registrar o aviso específico.
ALTER FUNCTION examentech_private.iniciar_tentativa_com_aviso(UUID,TEXT) RENAME TO iniciar_tentativa_sem_fotos;
REVOKE ALL ON FUNCTION examentech_private.iniciar_tentativa_sem_fotos(UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION examentech_private.iniciar_tentativa(UUID) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION examentech_private.iniciar_tentativa_com_aviso(p_avaliacao_id UUID,p_aviso_versao TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM examentech_private.configuracao_fotos WHERE ativa) THEN
        RAISE EXCEPTION 'Confirme o aviso específico das fotografias.' USING ERRCODE = '23514';
    END IF;
    RETURN examentech_private.iniciar_tentativa_sem_fotos(p_avaliacao_id,p_aviso_versao);
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.iniciar_tentativa_com_aviso(UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.iniciar_tentativa_com_aviso(UUID,TEXT) TO authenticated;
CREATE OR REPLACE FUNCTION public.iniciar_tentativa(p_avaliacao_id UUID,p_aviso_versao TEXT)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT examentech_private.iniciar_tentativa_com_aviso(p_avaliacao_id,p_aviso_versao)
$$;

CREATE FUNCTION public.iniciar_tentativa_com_fotos(p_avaliacao_id UUID,p_aviso_versao TEXT,p_fotos_aviso_versao TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_resultado JSONB; v_tentativa public.tentativas%ROWTYPE; v_duracao DOUBLE PRECISION;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM examentech_private.configuracao_fotos WHERE ativa)
       OR p_fotos_aviso_versao IS DISTINCT FROM '2026-11-08-fotos-v1' THEN
        RAISE EXCEPTION 'A coleta de fotografias não está habilitada ou o aviso não foi confirmado.' USING ERRCODE = '23514';
    END IF;
    v_resultado := examentech_private.iniciar_tentativa_sem_fotos(p_avaliacao_id,p_aviso_versao);
    SELECT * INTO v_tentativa FROM public.tentativas WHERE id = (v_resultado->>'id')::UUID;
    v_duracao := extract(epoch FROM(v_tentativa.limite_em-v_tentativa.ciclo_iniciado_em));
    IF v_duracao < 15 THEN
        RAISE EXCEPTION 'Restam menos de 15 segundos na janela da prova.' USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.avisos_fotos_tentativa(tentativa_id,ciclo,aviso_versao)
    VALUES(v_tentativa.id,v_tentativa.ciclo,p_fotos_aviso_versao);
    INSERT INTO public.fotos_tentativa(tentativa_id,ciclo,momento,agendada_em)
    SELECT v_tentativa.id,v_tentativa.ciclo,momento,
        v_tentativa.ciclo_iniciado_em+make_interval(secs=>v_duracao*(inicio+(fim-inicio)*random()))
    FROM (VALUES('INICIAL',0.0,0.0),('PROVA_1',0.10,0.26),('PROVA_2',0.38,0.56),('PROVA_3',0.68,0.86)) janela(momento,inicio,fim);
    RETURN v_resultado;
END;
$$;

CREATE FUNCTION public.consultar_plano_fotos(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    v_tentativa:=examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao<>'EM_ANDAMENTO' OR clock_timestamp()>=v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada.' USING ERRCODE='55000';
    END IF;
    RETURN jsonb_build_object('tentativa_id',v_tentativa.id,'ciclo',v_tentativa.ciclo,'retencao_dias',90,
        'servidor_em',clock_timestamp(),
        'capturas',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'momento',f.momento,
            'agendada_em',f.agendada_em,'recebida_em',f.recebida_em) ORDER BY f.agendada_em),'[]'::JSONB)
            FROM public.fotos_tentativa f WHERE f.tentativa_id=p_tentativa_id AND f.ciclo=v_tentativa.ciclo));
END;
$$;

-- A foto inicial também é exigida no banco, não só pela tela do aluno.
ALTER FUNCTION examentech_private.consultar_conteudo_tentativa(UUID) RENAME TO consultar_conteudo_sem_fotos;
REVOKE ALL ON FUNCTION examentech_private.consultar_conteudo_sem_fotos(UUID) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION examentech_private.consultar_conteudo_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    v_tentativa:=examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF EXISTS(SELECT 1 FROM public.avisos_fotos_tentativa WHERE tentativa_id=p_tentativa_id
        AND ciclo=v_tentativa.ciclo AND revogado_em IS NOT NULL) THEN
        RAISE EXCEPTION 'O consentimento das fotos foi revogado.' USING ERRCODE='55000';
    END IF;
    IF EXISTS(SELECT 1 FROM public.avisos_fotos_tentativa WHERE tentativa_id=p_tentativa_id AND ciclo=v_tentativa.ciclo)
       AND NOT EXISTS(SELECT 1 FROM public.fotos_tentativa WHERE tentativa_id=p_tentativa_id
         AND ciclo=v_tentativa.ciclo AND momento='INICIAL' AND situacao='DISPONIVEL') THEN
        RAISE EXCEPTION 'Confirme o envio da foto inicial antes de consultar as questões.' USING ERRCODE='55000';
    END IF;
    RETURN examentech_private.consultar_conteudo_sem_fotos(p_tentativa_id);
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.consultar_conteudo_tentativa(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION examentech_private.consultar_conteudo_tentativa(UUID) TO authenticated;
CREATE OR REPLACE FUNCTION public.consultar_conteudo_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    SELECT examentech_private.consultar_conteudo_tentativa(p_tentativa_id)
$$;

CREATE FUNCTION public.reservar_envio_foto(p_captura_id UUID,p_upload_id UUID,p_sha256 TEXT,
    p_tamanho INTEGER,p_largura INTEGER,p_altura INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_foto public.fotos_tentativa%ROWTYPE; v_tentativa public.tentativas%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM examentech_private.configuracao_fotos WHERE ativa) THEN
        RAISE EXCEPTION 'Coleta desabilitada.' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_foto FROM public.fotos_tentativa WHERE id=p_captura_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Captura não encontrada.' USING ERRCODE='P0002'; END IF;
    v_tentativa:=examentech_private.tentativa_do_aluno(v_foto.tentativa_id);
    IF v_tentativa.situacao<>'EM_ANDAMENTO' OR v_foto.ciclo<>v_tentativa.ciclo
       OR clock_timestamp()>=v_tentativa.limite_em OR clock_timestamp()<v_foto.agendada_em
       OR v_foto.situacao='EXCLUIDA' THEN
        RAISE EXCEPTION 'Captura fora da tentativa ou do período permitido.' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.avisos_fotos_tentativa WHERE tentativa_id=v_foto.tentativa_id
        AND ciclo=v_foto.ciclo AND revogado_em IS NULL) THEN
        RAISE EXCEPTION 'O consentimento das fotos foi revogado.' USING ERRCODE='55000';
    END IF;
    IF p_upload_id IS NULL OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
       OR p_tamanho IS NULL OR p_tamanho NOT BETWEEN 1 AND 1048576
       OR p_largura IS NULL OR p_largura NOT BETWEEN 1 AND 960
       OR p_altura IS NULL OR p_altura NOT BETWEEN 1 AND 720 THEN
        RAISE EXCEPTION 'Fotografia inválida.' USING ERRCODE='23514';
    END IF;
    IF v_foto.upload_id IS NOT NULL AND (v_foto.upload_id<>p_upload_id OR v_foto.sha256<>p_sha256) THEN
        RAISE EXCEPTION 'A captura já possui outro envio. Repita somente o mesmo arquivo.' USING ERRCODE='55000';
    END IF;
    IF v_foto.upload_id IS NULL THEN
        UPDATE public.fotos_tentativa SET situacao='ENVIANDO',upload_id=p_upload_id,sha256=p_sha256,
            tamanho_bytes=p_tamanho,largura=p_largura,altura=p_altura,reservada_em=clock_timestamp(),
            caminho=tentativa_id::TEXT||'/'||ciclo::TEXT||'/'||id::TEXT||'.jpg',
            -- Atrasos de envio nunca estendem a conservação. A programação do
            -- servidor antecede a captura e dá um limite conservador de 90 dias.
            expira_em=agendada_em+interval '90 days'
        WHERE id=p_captura_id RETURNING * INTO v_foto;
    END IF;
    RETURN jsonb_build_object('id',v_foto.id,'caminho',v_foto.caminho,
        'ja_recebida',v_foto.situacao='DISPONIVEL');
END;
$$;

CREATE FUNCTION public.confirmar_envio_foto(p_captura_id UUID,p_upload_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_foto public.fotos_tentativa%ROWTYPE; v_aluno UUID;
BEGIN
    SELECT * INTO v_foto FROM public.fotos_tentativa WHERE id=p_captura_id FOR UPDATE;
    IF NOT FOUND OR v_foto.upload_id IS DISTINCT FROM p_upload_id OR v_foto.situacao NOT IN ('ENVIANDO','DISPONIVEL') THEN
        RAISE EXCEPTION 'Reserva de envio não encontrada.' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='examentech-evidencias' AND name=v_foto.caminho) THEN
        RAISE EXCEPTION 'Arquivo não encontrado no armazenamento.' USING ERRCODE='55000';
    END IF;
    IF v_foto.situacao='ENVIANDO' THEN
        UPDATE public.fotos_tentativa SET situacao='DISPONIVEL',recebida_em=clock_timestamp()
        WHERE id=p_captura_id RETURNING * INTO v_foto;
        SELECT aluno_id INTO v_aluno FROM public.tentativas WHERE id=v_foto.tentativa_id;
        INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id)
        VALUES(gen_random_uuid(),'FOTO_RECEBIDA','EXAMENTECH','confirmar_envio_foto',TRUE,v_aluno,v_foto.id);
    END IF;
    RETURN jsonb_build_object('id',v_foto.id,'recebida_em',v_foto.recebida_em,'expira_em',v_foto.expira_em);
END;
$$;

CREATE FUNCTION public.listar_fotos_responsavel(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.tentativas te WHERE te.id=p_tentativa_id
        AND examentech_private.responsavel_pode_gerir_avaliacao(te.avaliacao_id)) THEN
        RAISE EXCEPTION 'Tentativa não encontrada ou sem acesso.' USING ERRCODE='42501';
    END IF;
    RETURN (SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.ciclo DESC,item.agendada_em),'[]'::JSONB) FROM (
        SELECT id,ciclo,momento,agendada_em,recebida_em,expira_em,
            CASE WHEN expira_em<=clock_timestamp() THEN 'EXCLUIDA' ELSE situacao END AS situacao
        FROM public.fotos_tentativa WHERE tentativa_id=p_tentativa_id ORDER BY ciclo DESC,agendada_em LIMIT 100
    ) item);
END;
$$;

CREATE FUNCTION public.autorizar_leitura_foto(p_captura_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_foto public.fotos_tentativa%ROWTYPE;
BEGIN
    SELECT f.* INTO v_foto FROM public.fotos_tentativa f JOIN public.tentativas te ON te.id=f.tentativa_id
    WHERE f.id=p_captura_id AND examentech_private.responsavel_pode_gerir_avaliacao(te.avaliacao_id)
      AND f.situacao='DISPONIVEL' AND f.expira_em>clock_timestamp();
    IF FOUND AND EXISTS(SELECT 1 FROM public.avisos_fotos_tentativa WHERE tentativa_id=v_foto.tentativa_id
        AND ciclo=v_foto.ciclo AND revogado_em IS NOT NULL) THEN
        RAISE EXCEPTION 'Foto indisponível ou sem acesso.' USING ERRCODE='42501';
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'Foto indisponível ou sem acesso.' USING ERRCODE='42501'; END IF;
    INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id)
    VALUES(gen_random_uuid(),'FOTO_CONSULTADA','EXAMENTECH','autorizar_leitura_foto',TRUE,auth.uid(),v_foto.id);
    RETURN jsonb_build_object('id',v_foto.id,'caminho',v_foto.caminho,'expira_em',v_foto.expira_em);
END;
$$;

-- A limpeza diária trabalha com antecedência para não ultrapassar o prazo de
-- até 90 dias por causa da janela de execução do agendador. O arquivo é
-- removido pela API do Storage antes de marcar seu metadado como excluído.
CREATE FUNCTION public.listar_fotos_para_limpeza()
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(item)),'[]'::JSONB) FROM (
        SELECT id,caminho FROM public.fotos_tentativa WHERE situacao<>'EXCLUIDA' AND caminho IS NOT NULL
          AND (expira_em<=clock_timestamp()+interval '26 hours'
               OR (situacao='ENVIANDO' AND reservada_em<clock_timestamp()-interval '1 day')
               OR EXISTS(SELECT 1 FROM public.avisos_fotos_tentativa av WHERE av.tentativa_id=fotos_tentativa.tentativa_id
                    AND av.ciclo=fotos_tentativa.ciclo AND av.revogado_em IS NOT NULL))
        ORDER BY expira_em,id LIMIT 100
    ) item;
$$;
CREATE FUNCTION public.confirmar_limpeza_fotos(p_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_foto RECORD; v_total INTEGER:=0;
BEGIN
    FOR v_foto IN UPDATE public.fotos_tentativa SET situacao='EXCLUIDA',caminho=NULL,sha256=NULL,
        tamanho_bytes=NULL,largura=NULL,altura=NULL,excluida_em=clock_timestamp()
        WHERE id=ANY(p_ids) AND situacao<>'EXCLUIDA'
          AND (expira_em<=clock_timestamp()+interval '26 hours'
               OR (situacao='ENVIANDO' AND reservada_em<clock_timestamp()-interval '1 day')
               OR EXISTS(SELECT 1 FROM public.avisos_fotos_tentativa av WHERE av.tentativa_id=fotos_tentativa.tentativa_id
                    AND av.ciclo=fotos_tentativa.ciclo AND av.revogado_em IS NOT NULL))
        RETURNING id
    LOOP
        v_total:=v_total+1;
        INSERT INTO public.eventos_seguranca(solicitacao_id,evento,provedor,acao,sucesso,recurso_id)
        VALUES(gen_random_uuid(),'FOTO_EXCLUIDA','EXAMENTECH','limpeza_fotos',TRUE,v_foto.id);
    END LOOP;
    RETURN v_total;
END;
$$;

DO $$ DECLARE assinatura TEXT;
BEGIN
    FOREACH assinatura IN ARRAY ARRAY[
      'public.iniciar_tentativa_com_fotos(uuid,text,text)','public.consultar_plano_fotos(uuid)',
      'public.reservar_envio_foto(uuid,uuid,text,integer,integer,integer)',
      'public.listar_fotos_responsavel(uuid)','public.autorizar_leitura_foto(uuid)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',assinatura);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',assinatura);
    END LOOP;
    FOREACH assinatura IN ARRAY ARRAY[
      'public.confirmar_envio_foto(uuid,uuid)','public.listar_fotos_para_limpeza()','public.confirmar_limpeza_fotos(uuid[])'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',assinatura);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',assinatura);
    END LOOP;
END;
$$;
COMMIT;
