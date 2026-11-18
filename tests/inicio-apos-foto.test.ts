import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'
import { EXAM_NOTICE_VERSION, PROVA_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import type { TentativaIniciada } from '../src/services/tentativaValidation.ts'

test('RF34 inicia o cronômetro e sorteia as capturas depois de confirmar a foto inicial', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, queryAs, criarProva, turmaId } = await prepararBancoCamera(db)
  for (const nome of ['037_camera_sem_interrupcao', '038_tentativa_sessao', '039_correcao_tentativa',
    '040_finalizacao_e_resultados', '042_cancelamento_avaliacao', '043_execucao_segura_prova',
    '049_linha_tempo_tentativa', '052_pausa_prova', '055_cancelamento_avaliacao_em_qualquer_estado']) {
    await db.exec(await readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8'))
  }
  await db.exec('UPDATE examentech_private.configuracao_fotos SET ativa=TRUE')
  const chave = randomUUID()
  const iniciar = async (avaliacaoId: string) => (await queryAs<{ tentativa: TentativaIniciada }>(aluno,
    "SELECT public.iniciar_tentativa_com_fotos($1,$2,'2026-11-08-fotos-v1',$3) AS tentativa",
    [avaliacaoId, PROVA_NOTICE_VERSION, chave])).rows[0].tentativa
  const plano = async (id: string) => (await queryAs<{ plano: {
    tentativa: TentativaIniciada; capturas: { id: string; agendada_em: string; recebida_em: string | null }[]
  } }>(aluno, 'SELECT public.consultar_plano_fotos($1,$2) AS plano', [id, chave])).rows[0].plano
  const confirmar = (fotoId: string, uploadId: string) => db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE service_role')
    return tx.query('SELECT public.confirmar_envio_foto($1,$2)', [fotoId, uploadId])
  })
  async function reservar(id: string) {
    const foto = (await plano(id)).capturas[0]
    const upload = randomUUID()
    const reserve = (await queryAs<{ reserva: { caminho: string } }>(aluno,
      'SELECT public.reservar_envio_foto($1,$2,$3,1024,640,480,$4) AS reserva',
      [foto.id, upload, 'a'.repeat(64), chave])).rows[0].reserva
    return { foto, upload, caminho: reserve.caminho }
  }
  const anterior = await iniciar((await criarProva()).avaliacaoId)
  const migration = await readFile(new URL('../database/057_cronometro_apos_foto_inicial.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  const legado = (await plano(anterior.id)).tentativa
  assert.equal(legado.limite_em, anterior.limite_em)
  assert.equal(legado.cronometro_iniciado_em, anterior.iniciada_em)

  await t.test('o preparo usa a janela final e não consome a duração da prova', async () => {
    const prova = await criarProva()
    const tentativa = await iniciar(prova.avaliacaoId)
    const antes = await plano(tentativa.id)
    assert.equal(tentativa.cronometro_iniciado_em, null)
    assert.equal(antes.capturas.length, 1)
    const window = (await db.query<{ fim_em: Date }>('SELECT fim_em FROM public.avaliacoes WHERE id=$1', [prova.avaliacaoId])).rows[0]
    assert.equal(Date.parse(tentativa.limite_em), window.fim_em.getTime())
    await assert.rejects(iniciar(prova.avaliacaoId), { code: '55000' })
    await assert.rejects(queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [tentativa.id, chave]), { code: '55000' })
    const { foto, upload, caminho } = await reservar(tentativa.id)
    await assert.rejects(confirmar(foto.id, upload), { code: '55000' })
    assert.equal((await plano(tentativa.id)).tentativa.cronometro_iniciado_em, null)
    await assert.rejects(queryAs(aluno, 'SELECT public.confirmar_envio_foto($1,$2)', [foto.id, upload]), { code: '42501' })
    await db.query("UPDATE public.tentativas SET iniciada_em=iniciada_em-interval '70 minutes' WHERE id=$1", [tentativa.id])
    const job = await db.query<{ total: number }>('SELECT examentech_private.finalizar_tentativas_vencidas() AS total')
    assert.equal(job.rows[0].total, 0)
    await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['examentech-evidencias', caminho])
    await confirmar(foto.id, upload)
    const depois = await plano(tentativa.id)
    const inicio = Date.parse(depois.tentativa.cronometro_iniciado_em!)
    assert.equal(Date.parse(depois.tentativa.limite_em) - inicio, 60 * 60 * 1000)
    assert.equal(depois.capturas.length, 4)
    assert.equal(Date.parse(depois.capturas[0].recebida_em!), inicio)
    assert.ok(depois.capturas.slice(1).every(f => Date.parse(f.agendada_em) > inicio && Date.parse(f.agendada_em) < Date.parse(depois.tentativa.limite_em)))
    await confirmar(foto.id, upload)
    assert.deepEqual((await plano(tentativa.id)).tentativa, depois.tentativa)
    await queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [tentativa.id, chave])
    await assert.rejects(queryAs(aluno, 'SELECT public.consultar_plano_fotos($1,$2)', [tentativa.id, randomUUID()]), { code: '42501' })
  })

  await t.test('a confirmação respeita o fim da janela e não reinicia tentativa cancelada', async () => {
    for (const motivo of ['JANELA', 'CANCELAMENTO']) {
      const prova = await criarProva()
      const tentativa = await iniciar(prova.avaliacaoId)
      const { foto, upload, caminho } = await reservar(tentativa.id)
      await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['examentech-evidencias', caminho])
      if (motivo === 'JANELA') {
        await db.query("UPDATE public.tentativas SET iniciada_em=now()-interval '2 minutes',limite_em=now()-interval '1 minute' WHERE id=$1", [tentativa.id])
      } else {
        await queryAs(professor, 'SELECT public.cancelar_avaliacao($1)', [prova.avaliacaoId])
      }
      await assert.rejects(confirmar(foto.id, upload), { code: '55000' })
      const row = (await db.query<{ cronometro_iniciado_em: Date | null }>('SELECT cronometro_iniciado_em FROM public.tentativas WHERE id=$1', [tentativa.id])).rows[0]
      assert.equal(row.cronometro_iniciado_em, null)
    }
  })

  await t.test('duração após a foto é limitada ao fim da janela e atividade começa imediatamente', async () => {
    const prova = await criarProva()
    await db.query("UPDATE public.avaliacoes SET fim_em=now()+interval '10 minutes' WHERE id=$1", [prova.avaliacaoId])
    const tentativa = await iniciar(prova.avaliacaoId)
    const { foto, upload, caminho } = await reservar(tentativa.id)
    await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['examentech-evidencias', caminho])
    await confirmar(foto.id, upload)
    assert.equal((await plano(tentativa.id)).tentativa.limite_em, tentativa.limite_em)

    const atividade = (await queryAs<{ a: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Atividade sem fotos','ATIVIDADE',now()-interval '1 minute',now()+interval '2 hours',60) AS a`, [turmaId])).rows[0].a
    await queryAs(professor, "SELECT public.criar_questao_rascunho($1,'DISSERTATIVA','Descreva o resultado.',1)", [atividade.id])
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [atividade.id])
    const result = (await queryAs<{ t: TentativaIniciada }>(aluno, 'SELECT public.iniciar_tentativa($1,$2,$3) AS t',
      [atividade.id, EXAM_NOTICE_VERSION, randomUUID()])).rows[0].t
    assert.ok(result.cronometro_iniciado_em)
    assert.equal(Date.parse(result.limite_em) - Date.parse(result.iniciada_em), 60 * 60 * 1000)
  })

  await t.test('reaplicar a migração preserva preparos pendentes e prazos confirmados', async () => {
    const before = (await db.query('SELECT id,limite_em,cronometro_iniciado_em FROM public.tentativas ORDER BY id')).rows
    await db.exec(migration)
    assert.deepEqual((await db.query('SELECT id,limite_em,cronometro_iniciado_em FROM public.tentativas ORDER BY id')).rows, before)
  })
})
