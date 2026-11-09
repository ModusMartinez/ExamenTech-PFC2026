import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments.ts'

const migration = await readFile(new URL('../database/037_camera_sem_interrupcao.sql', import.meta.url), 'utf8')
test('037 integra câmera, início com aviso atual e encerramento sem motivo CAMERA', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, queryAs, criarProva } = await prepararBancoCamera(db)
  const anterior = await criarProva()
  const iniciar = async (id: string, versao = EXAM_NOTICE_VERSION, fotos = false) => (await queryAs<{ t: { id: string } }>(aluno,
    fotos ? 'SELECT public.iniciar_tentativa_com_fotos($1,$2,\'2026-11-08-fotos-v1\') AS t'
      : 'SELECT public.iniciar_tentativa($1,$2) AS t', [id, versao])).rows[0].t.id
  const idAnterior = await iniciar(anterior.avaliacaoId, '2026-11-06-v2')
  await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'CAMERA')", [idAnterior])
  const registros = async () => ({
    tentativas: (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows,
    eventos: (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows,
    aceites: (await db.query('SELECT * FROM public.aceites_termos ORDER BY usuario_id')).rows,
    respostas: (await db.query('SELECT * FROM public.respostas_tentativa ORDER BY id')).rows,
  })
  const historico = await registros()
  await db.exec(migration)
  assert.deepEqual(await registros(), historico)

  await t.test('recusa aviso anterior e grava a nova versão sem exigir fotos quando desativadas', async () => {
    const prova = await criarProva()
    await assert.rejects(iniciar(prova.avaliacaoId, '2026-11-06-v2'), { code: '23514' })
    const id = await iniciar(prova.avaliacaoId)
    assert.deepEqual((await db.query('SELECT aviso_versao,situacao FROM public.tentativas WHERE id=$1', [id])).rows,
      [{ aviso_versao: EXAM_NOTICE_VERSION, situacao: 'EM_ANDAMENTO' }])
    const antes = await registros()
    for (const schema of ['public', 'examentech_private']) {
      await assert.rejects(queryAs(aluno, `SELECT ${schema}.encerrar_tentativa($1,'CAMERA')`, [id]), { code: '23514' })
    }
    assert.deepEqual(await registros(), antes)
    await queryAs(aluno, 'SELECT public.registrar_falha_camera($1,$2)', [id, randomUUID()])
    await queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1)', [id])
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'SAIDA')", [id])
    assert.equal((await db.query<{ situacao: string }>('SELECT situacao FROM public.tentativas WHERE id=$1', [id])).rows[0].situacao, 'INTERROMPIDA')
  })

  await t.test('exige foto inicial, mas falhas posteriores permitem conteúdo, resposta e envio', async () => {
    await db.exec('UPDATE examentech_private.configuracao_fotos SET ativa=TRUE')
    const prova = await criarProva()
    await assert.rejects(iniciar(prova.avaliacaoId), { code: '23514' })
    await assert.rejects(iniciar(prova.avaliacaoId, '2026-11-06-v2', true), { code: '23514' })
    const id = await iniciar(prova.avaliacaoId, EXAM_NOTICE_VERSION, true)
    await queryAs(aluno, 'SELECT public.registrar_falha_camera($1,$2)', [id, randomUUID()])
    await assert.rejects(queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1)', [id]), { code: '55000' })
    const foto = (await db.query<{ id: string }>("SELECT id FROM public.fotos_tentativa WHERE tentativa_id=$1 AND momento='INICIAL'", [id])).rows[0].id
    const upload = randomUUID()
    const reserva = (await queryAs<{ r: { caminho: string } }>(aluno,
      'SELECT public.reservar_envio_foto($1,$2,$3,1024,640,480) AS r', [foto, upload, 'a'.repeat(64)])).rows[0].r
    await db.query('INSERT INTO storage.objects VALUES($1,$2)', ['examentech-evidencias', reserva.caminho])
    await db.query('SELECT public.confirmar_envio_foto($1,$2)', [foto, upload])
    const antes = (await db.query('SELECT * FROM public.tentativas WHERE id=$1', [id])).rows
    await queryAs(aluno, 'SELECT public.registrar_falha_camera($1,$2)', [id, randomUUID()])
    assert.deepEqual((await db.query('SELECT * FROM public.tentativas WHERE id=$1', [id])).rows, antes)
    await queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1)', [id])
    const alternativa = (await db.query<{ alternativa_id: string }>('SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 LIMIT 1', [id])).rows[0].alternativa_id
    await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,1,$3,NULL)', [id, prova.questaoId, alternativa])
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'ENVIO')", [id])
    assert.equal((await db.query<{ situacao: string }>('SELECT situacao FROM public.tentativas WHERE id=$1', [id])).rows[0].situacao, 'FINALIZADA')
  })

  await t.test('prazo continua encerrando a prova', async () => {
    await db.exec('UPDATE examentech_private.configuracao_fotos SET ativa=FALSE')
    const prova = await criarProva()
    const id = await iniciar(prova.avaliacaoId)
    await assert.rejects(queryAs(aluno, "SELECT public.encerrar_tentativa($1,'PRAZO')", [id]), { code: '55000' })
    await db.query("UPDATE public.tentativas SET iniciada_em=now()-interval '2 hours',limite_em=now()-interval '1 second' WHERE id=$1", [id])
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'PRAZO')", [id])
    await assert.rejects(queryAs(aluno, 'SELECT public.registrar_falha_camera($1,$2)', [id, randomUUID()]), { code: '55000' })
  })

  await t.test('aceites novos exigem os termos atualizados e preservam a versão apresentada', async () => {
    const novo = (termos: string, privacidade: string, aceite = true) => db.query(
      'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',
      [randomUUID(), `${randomUUID()}@example.test`, { termos_aceitos: aceite, termos_versao: termos, privacidade_versao: privacidade }])
    await assert.rejects(novo('2026-11-08-v6', '2026-11-08-v5'), { code: '22023' })
    await assert.rejects(novo('2026-11-08-v7', '2026-11-06-v4'), { code: '22023' })
    await assert.rejects(novo('2026-11-08-v7', '2026-11-08-v5', false), { code: '22023' })
    await novo('2026-11-08-v7', '2026-11-08-v5')
    await novo('2026-11-08-v8', '2026-11-06-v4')
    assert.deepEqual((await db.query('SELECT termos_versao,privacidade_versao FROM public.aceites_termos ORDER BY termos_versao')).rows,
      [{ termos_versao: '2026-11-08-v7', privacidade_versao: '2026-11-08-v5' },
        { termos_versao: '2026-11-08-v8', privacidade_versao: '2026-11-06-v4' }])
  })
  const antes = await registros()
  await db.exec(migration)
  assert.deepEqual(await registros(), antes)
  assert.equal((await db.query<{ situacao: string }>('SELECT situacao FROM public.tentativas WHERE id=$1', [idAnterior])).rows[0].situacao, 'INTERROMPIDA')
  await assert.rejects(queryAs(aluno, 'SELECT examentech_private.iniciar_tentativa_sem_fotos($1,$2)',
    [anterior.avaliacaoId, EXAM_NOTICE_VERSION]), { code: '42501' })
})
