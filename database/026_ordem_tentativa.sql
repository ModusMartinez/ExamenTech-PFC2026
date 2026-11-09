-- Aplicar depois de 025. Sorteio apenas para novas tentativas, sem alterar as anteriores.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tentativa_questoes (
    tentativa_id UUID NOT NULL REFERENCES public.tentativas(id) ON DELETE RESTRICT,
    questao_id UUID NOT NULL REFERENCES public.questoes(id) ON DELETE RESTRICT,
    ordem INTEGER NOT NULL CHECK (ordem > 0),
    PRIMARY KEY (tentativa_id, questao_id),
    CONSTRAINT tentativa_questoes_ordem_unica UNIQUE (tentativa_id, ordem)
);

CREATE TABLE IF NOT EXISTS public.tentativa_alternativas (
    tentativa_id UUID NOT NULL,
    questao_id UUID NOT NULL,
    alternativa_id UUID NOT NULL REFERENCES public.alternativas(id) ON DELETE RESTRICT,
    ordem INTEGER NOT NULL CHECK (ordem BETWEEN 1 AND 5),
    PRIMARY KEY (tentativa_id, alternativa_id),
    FOREIGN KEY (tentativa_id, questao_id)
        REFERENCES public.tentativa_questoes(tentativa_id, questao_id) ON DELETE RESTRICT,
    CONSTRAINT tentativa_alternativas_ordem_unica UNIQUE (tentativa_id, questao_id, ordem)
);

-- A consulta do conteúdo será feita em função própria, sem liberar gabarito ou escrita direta.
ALTER TABLE public.tentativa_questoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tentativa_alternativas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tentativa_questoes, public.tentativa_alternativas FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION examentech_private.sortear_ordem_tentativa()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    -- A 025 já valida o acesso e bloqueia a avaliação durante o início.
    INSERT INTO public.tentativa_questoes (tentativa_id, questao_id, ordem)
    SELECT NEW.id, q.id, row_number() OVER (ORDER BY random(), q.id)::INTEGER
    FROM public.questoes q
    WHERE q.avaliacao_id = NEW.avaliacao_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'A avaliação não possui questões para a tentativa.' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.tentativa_alternativas (tentativa_id, questao_id, alternativa_id, ordem)
    SELECT NEW.id, q.id, a.id,
           row_number() OVER (PARTITION BY q.id ORDER BY random(), a.id)::INTEGER
    FROM public.tentativa_questoes tq
    JOIN public.questoes q ON q.id = tq.questao_id
    JOIN public.alternativas a ON a.questao_id = q.id
    WHERE tq.tentativa_id = NEW.id AND q.tipo = 'OBJETIVA';

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION examentech_private.sortear_ordem_tentativa() FROM PUBLIC, anon, authenticated;

-- AFTER INSERT só executa quando a tentativa é criada; conflito não refaz o sorteio.
-- Falha no sorteio ou na auditoria desfaz toda a operação da 025.
DROP TRIGGER IF EXISTS tentativas_sortear_ordem ON public.tentativas;
CREATE TRIGGER tentativas_sortear_ordem
AFTER INSERT ON public.tentativas
FOR EACH ROW EXECUTE FUNCTION examentech_private.sortear_ordem_tentativa();

COMMENT ON TABLE public.tentativa_questoes IS
    'Questões e ordem sorteada no início de cada tentativa. Não altera a ordem cadastrada pelo professor.';
COMMENT ON TABLE public.tentativa_alternativas IS
    'Alternativas e ordem sorteada por questão da tentativa. Não copia textos nem gabarito.';

COMMIT;
