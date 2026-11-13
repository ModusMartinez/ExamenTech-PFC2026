-- Ponte para o Supabase de TESTE que recebeu o protótipo antigo de tentativas.
-- Aplicar somente após conferir docs/diagnostico-banco-provas[-2].sql.
-- Pressupõe que 023_publicar_avaliacao até 027_consultar_conteudo_tentativa
-- já foram executadas. Depois desta ponte, executar 028_respostas_e_encerramento.
-- Desativa as RPCs do protótipo antigo; não apaga tentativas ou respostas.
BEGIN;

LOCK TABLE public.tentativas IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF to_regclass('public.respostas_prova') IS NULL
       OR to_regclass('public.tentativa_questoes') IS NULL
       OR to_regclass('public.tentativa_alternativas') IS NULL
       OR to_regprocedure('public.consultar_conteudo_tentativa(uuid)') IS NULL
       OR to_regclass('public.respostas_tentativa') IS NOT NULL
       OR EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'tentativas'
             AND column_name = 'limite_em'
       ) THEN
        RAISE EXCEPTION 'Estrutura diferente do diagnóstico. Nenhuma alteração foi aplicada.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tentativas WHERE situacao <> 'FINALIZADA') THEN
        RAISE EXCEPTION 'Há tentativas não finalizadas. Revisar antes de conciliar.';
    END IF;
END;
$$;

-- Os registros antigos permanecem na mesma tabela e as respostas em
-- respostas_prova. O prazo abaixo é apenas um marco histórico para linhas
-- finalizadas; não reabre uma prova nem altera o prazo que constava antes.
ALTER TABLE public.tentativas ADD COLUMN limite_em TIMESTAMPTZ;
ALTER TABLE public.tentativas ADD COLUMN encerrada_em TIMESTAMPTZ;
ALTER TABLE public.tentativas ADD COLUMN aviso_aceito_em TIMESTAMPTZ;
ALTER TABLE public.tentativas ADD COLUMN falhas_camera_historico INTEGER;

UPDATE public.tentativas te
SET limite_em = GREATEST(
        te.iniciada_em + interval '1 second',
        LEAST(a.fim_em, te.iniciada_em + make_interval(mins => a.duracao_minutos))
    ),
    encerrada_em = te.finalizada_em,
    aviso_aceito_em = te.ciencia_registrada_em,
    falhas_camera_historico = CASE WHEN te.falhas_camera > 1 THEN te.falhas_camera END,
    falhas_camera = LEAST(te.falhas_camera, 1)
FROM public.avaliacoes a
WHERE a.id = te.avaliacao_id;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tentativas
               WHERE limite_em IS NULL OR encerrada_em IS NULL
                  OR aviso_aceito_em IS NULL) THEN
        RAISE EXCEPTION 'Não foi possível completar todos os registros históricos.';
    END IF;
END;
$$;

ALTER TABLE public.tentativas ALTER COLUMN limite_em SET NOT NULL;
ALTER TABLE public.tentativas ADD CONSTRAINT tentativas_prazo_valido CHECK (
    isfinite(iniciada_em) AND isfinite(limite_em) AND limite_em > iniciada_em
);

-- O novo início fornece aviso e aceite na mesma transação, depois do INSERT.
-- As colunas legadas deixam de ser exigidas para tentativas novas.
ALTER TABLE public.tentativas ALTER COLUMN situacao SET DEFAULT 'EM_ANDAMENTO';
ALTER TABLE public.tentativas ALTER COLUMN aviso_versao DROP NOT NULL;
ALTER TABLE public.tentativas ALTER COLUMN ciencia_registrada_em DROP NOT NULL;
ALTER TABLE public.tentativas ALTER COLUMN ciencia_registrada_em DROP DEFAULT;
ALTER TABLE public.tentativas ALTER COLUMN tempo_restante_segundos DROP NOT NULL;
ALTER TABLE public.tentativas DROP CONSTRAINT IF EXISTS tentativas_estado_valido;

-- Fecha o caminho antigo durante a troca de modelo. A 028 libera somente
-- iniciar_tentativa(uuid,text), salvar_resposta_tentativa e encerrar_tentativa.
DO $$
DECLARE
    assinatura TEXT;
BEGIN
    FOREACH assinatura IN ARRAY ARRAY[
        'public.iniciar_tentativa(uuid)',
        'examentech_private.iniciar_tentativa(uuid)',
        'public.iniciar_tentativa(uuid,text)',
        'public.retomar_tentativa(uuid)',
        'public.carregar_tentativa(uuid)',
        'public.salvar_resposta_prova(uuid,uuid,uuid,text)',
        'public.finalizar_tentativa(uuid)',
        'public.reportar_falha_camera(uuid)',
        'public.interromper_tentativa(uuid)',
        'public.desbloquear_tentativa(uuid)',
        'public.listar_provas_aluno()',
        'public.listar_tentativas_bloqueadas()'
    ] LOOP
        IF to_regprocedure(assinatura) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', assinatura);
        END IF;
    END LOOP;
END;
$$;

COMMIT;
