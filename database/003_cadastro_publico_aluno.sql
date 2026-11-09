-- Aplicar depois de 001_perfis.sql, inclusive em bancos onde 001 já foi aplicado.
-- Metadados enviados no cadastro público podem ser alterados pelo cliente.
-- Portanto, o perfil inicial nunca deve vir de raw_user_meta_data.

CREATE OR REPLACE FUNCTION public.criar_perfil_novo_usuario()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_nome TEXT;
BEGIN
    v_nome := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data ->> 'nome', '')), '');

    IF v_nome IS NULL THEN
        v_nome := SPLIT_PART(COALESCE(NEW.email, 'usuario'), '@', 1);
    END IF;

    -- RGM também não deve ser reservado a partir de metadados públicos.
    -- Um administrador poderá preenchê-lo após conferir a identidade.
    INSERT INTO public.perfis (id, nome, email, perfil, situacao)
    VALUES (NEW.id, v_nome, LOWER(NEW.email), 'ALUNO', 'PENDENTE');

    RETURN NEW;
END;
$$;

-- Esta migração afeta apenas novos cadastros. Se 001 foi usado antes,
-- revisar perfis PROFESSOR já criados e aprovados pela equipe.
