import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PROVA_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'

test('061 exige as versões revisadas e preserva o histórico de cadastro e fotos', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, queryAs, criarProva } = await prepararBancoCamera(db)
  for (const nome of ['037_camera_sem_interrupcao', '038_tentativa_sessao', '039_correcao_tentativa',
    '040_finalizacao_e_resultados', '042_cancelamento_avaliacao', '043_execucao_segura_prova',
    '049_linha_tempo_tentativa', '052_pausa_prova', '057_cronometro_apos_foto_inicial']) {
    await db.exec(await readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8'))
  }
  await db.exec('GRANT INSERT, SELECT ON auth.users TO supabase_auth_admin; UPDATE examentech_private.configuracao_fotos SET ativa=TRUE')
  async function cadastrar(termos: string | null, privacidade: string | null, aceite: unknown = true) {
    const id = randomUUID()
    await db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE supabase_auth_admin')
      await tx.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',
        [id, `${id}@example.test`, JSON.stringify({ termos_aceitos: aceite, termos_versao: termos, privacidade_versao: privacidade })])
    })
    return id
  }
  async function iniciarProva() {
    const prova = await criarProva()
    return (await queryAs<{ id: string }>(aluno,
      "SELECT public.iniciar_tentativa_com_fotos($1,$2,'2026-11-08-fotos-v1',$3)->>'id' AS id",
      [prova.avaliacaoId, PROVA_NOTICE_VERSION, randomUUID()])).rows[0].id
  }
  const aceites = async () => (await db.query('SELECT * FROM public.aceites_termos ORDER BY usuario_id')).rows
  const avisos = async () => (await db.query('SELECT * FROM public.avisos_fotos_tentativa ORDER BY tentativa_id,ciclo')).rows
  await cadastrar('2026-11-08-v9', '2026-11-08-v6')
  await iniciarProva()
  const cadastrosAnteriores = await aceites()
  const avisosAnteriores = await avisos()
  const migracao = await readFile(new URL('../database/061_versoes_documentos_notas_cronometro.sql', import.meta.url), 'utf8')
  await db.exec(migracao)

  await t.test('preserva os registros antigos e grava as duas variantes novas de cadastro', async () => {
    assert.deepEqual(await aceites(), cadastrosAnteriores)
    assert.deepEqual(await avisos(), avisosAnteriores)
    for (const [termos, privacidade] of [['2026-11-18-v13', '2026-11-18-v10'], ['2026-11-18-v14', '2026-11-18-v11']]) {
      const id = await cadastrar(termos, privacidade)
      assert.deepEqual((await db.query('SELECT termos_versao,privacidade_versao FROM public.aceites_termos WHERE usuario_id=$1', [id])).rows,
        [{ termos_versao: termos, privacidade_versao: privacidade }])
    }
    const tentativa = await iniciarProva()
    assert.deepEqual((await db.query(`SELECT termos_versao,privacidade_versao FROM public.avisos_fotos_tentativa
      WHERE tentativa_id=$1`, [tentativa])).rows, [{ termos_versao: '2026-11-18-v13', privacidade_versao: '2026-11-18-v10' }])
  })

  await t.test('recusa versões antigas, combinações trocadas e ausência de aceite sem criar conta', async () => {
    const usuariosAntes = (await db.query('SELECT id FROM auth.users ORDER BY id')).rows
    const aceitesAntes = await aceites()
    for (const [termos, privacidade] of [
      ['2026-11-12-v11', '2026-11-12-v8'], ['2026-11-12-v12', '2026-11-12-v9'],
      ['2026-11-18-v13', '2026-11-18-v11'], ['2026-11-18-v14', '2026-11-18-v10'],
      [null, '2026-11-18-v10'], ['2026-11-18-v13', null],
    ]) await assert.rejects(cadastrar(termos, privacidade), { code: '22023' })
    for (const aceite of [false, null, 'true']) {
      await assert.rejects(cadastrar('2026-11-18-v13', '2026-11-18-v10', aceite), { code: '22023' })
    }
    assert.deepEqual((await db.query('SELECT id FROM auth.users ORDER BY id')).rows, usuariosAntes)
    assert.deepEqual(await aceites(), aceitesAntes)
  })

  await t.test('reaplicar não altera aceites e a função continua restrita ao Auth', async () => {
    const antes = await aceites()
    const fotosAntes = await avisos()
    await db.exec(migracao)
    assert.deepEqual(await aceites(), antes)
    assert.deepEqual(await avisos(), fotosAntes)
    for (const papel of ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']) {
      const [{ permitido }] = (await db.query<{ permitido: boolean }>(
        "SELECT has_function_privilege($1,'examentech_private.registrar_aceite_termos()','EXECUTE') AS permitido", [papel])).rows
      assert.equal(permitido, papel === 'supabase_auth_admin')
    }
  })
})
