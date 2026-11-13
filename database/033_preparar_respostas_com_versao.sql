-- Para o banco da entrega0911, com 028_respostas_e_encerramento e 030 aplicadas.
-- Não aplicar a 028_salvar_resposta_tentativa neste banco.
BEGIN;

DO $$
BEGIN
    IF to_regclass('public.respostas_tentativa') IS NULL
       OR to_regprocedure('public.salvar_resposta_tentativa(uuid,uuid,uuid,text)') IS NULL
       OR to_regprocedure('public.consultar_respostas_tentativa(uuid)') IS NULL THEN
        RAISE EXCEPTION 'Confira o diagnóstico: esta query exige o modelo da entrega0911.';
    END IF;
    IF to_regclass('public.respostas') IS NOT NULL THEN
        RAISE EXCEPTION 'As duas tabelas de respostas existem. Conciliar os dados antes de aplicar esta query.';
    END IF;
END;
$$;

ALTER TABLE public.respostas_tentativa
    ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS versao INTEGER NOT NULL DEFAULT 1 CHECK (versao > 0),
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ;

-- Para respostas antigas, salva_em é o único horário disponível; não inventar o primeiro envio.
UPDATE public.respostas_tentativa SET criado_em = salva_em WHERE criado_em IS NULL;
ALTER TABLE public.respostas_tentativa
    ALTER COLUMN criado_em SET NOT NULL,
    ALTER COLUMN criado_em SET DEFAULT clock_timestamp();
CREATE UNIQUE INDEX IF NOT EXISTS respostas_tentativa_id_unico ON public.respostas_tentativa(id);

-- A tela atual ainda usa a RPC sem versão. O trigger mantém a sequência em suas gravações.
CREATE OR REPLACE FUNCTION examentech_private.versionar_resposta_tentativa()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.versao := 1;
        NEW.criado_em := NEW.salva_em;
    ELSE
        NEW.id := OLD.id;
        NEW.criado_em := OLD.criado_em;
        NEW.versao := OLD.versao + 1;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION examentech_private.versionar_resposta_tentativa() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER respostas_tentativa_versionar
BEFORE INSERT OR UPDATE ON public.respostas_tentativa
FOR EACH ROW EXECUTE FUNCTION examentech_private.versionar_resposta_tentativa();

CREATE OR REPLACE FUNCTION public.consultar_respostas_tentativa(p_tentativa_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tentativa public.tentativas%ROWTYPE;
BEGIN
    v_tentativa := examentech_private.tentativa_do_aluno(p_tentativa_id);
    IF v_tentativa.situacao <> 'EM_ANDAMENTO' OR clock_timestamp() >= v_tentativa.limite_em THEN
        RAISE EXCEPTION 'Tentativa encerrada ou fora do prazo.' USING ERRCODE = '55000';
    END IF;
    RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'tentativa_id', r.tentativa_id, 'questao_id', r.questao_id,
        'alternativa_id', r.alternativa_id, 'texto', r.texto, 'versao', r.versao,
        'criado_em', r.criado_em, 'atualizado_em', r.salva_em, 'salva_em', r.salva_em
    ) ORDER BY r.questao_id), '[]'::JSONB)
        FROM public.respostas_tentativa r WHERE r.tentativa_id = p_tentativa_id);
END;
$$;
REVOKE ALL ON FUNCTION public.consultar_respostas_tentativa(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consultar_respostas_tentativa(UUID) TO authenticated;

COMMENT ON COLUMN public.respostas_tentativa.versao IS
    'Inicia em 1 e avança a cada atualização. A RPC atual ainda não recebe a versão esperada pelo aluno.';
COMMENT ON COLUMN public.respostas_tentativa.criado_em IS
    'Primeiro envio após a 033. Para registros anteriores, preserva o salva_em conhecido na aplicação da 033.';

COMMIT;
