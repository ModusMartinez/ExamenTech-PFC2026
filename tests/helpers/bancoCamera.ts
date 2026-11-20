import { readFile } from 'node:fs/promises'
import type { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './bancoExecucao.ts'

export async function prepararBancoCamera(db: PGlite) {
  const base = await prepararBancoExecucao(db)
  // Storage e tabela de aceites mínimos, como no teste de fotos; as funções são as migrations reais.
  await db.exec(`CREATE SCHEMA storage; CREATE TABLE storage.objects(bucket_id TEXT,name TEXT);
    CREATE TABLE public.aceites_termos(usuario_id UUID,termos_versao TEXT,privacidade_versao TEXT,aceito_em TIMESTAMPTZ);
    CREATE FUNCTION examentech_private.registrar_aceite_termos() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER examentech_registrar_aceite_termos AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION examentech_private.registrar_aceite_termos()`)
  for (const file of ['031_fotos_tentativa.sql', '032_documentos_fotos.sql',
    '033_preparar_respostas_com_versao.sql', '034_salvar_resposta_com_versao.sql',
    '035_bloquear_resposta_sem_versao.sql', '036_registrar_falha_camera.sql']) {
    await db.exec(await readFile(new URL(`../../database/${file}`, import.meta.url), 'utf8'))
  }
  return base
}
