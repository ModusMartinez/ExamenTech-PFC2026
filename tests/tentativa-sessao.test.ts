import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'

const migrations = '../database/'
const cameraMigration = await readFile(new URL(`${migrations}037_camera_sem_interrupcao.sql`, import.meta.url), 'utf8')
const sessionMigration = await readFile(new URL(`${migrations}038_tentativa_sessao.sql`, import.meta.url), 'utf8')

test('038 vincula a tentativa à sessão e à página, preservando o histórico sem retomada', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, admin, professor, sessions, queryAs, criarProva } = await prepararBancoCamera(db)
  await db.exec(cameraMigration)

  const alternativas = async (id: string) => (await db.query<{ alternativa_id: string }>(
    'SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 ORDER BY ordem', [id],
  )).rows
  const respostas = async (id: string) => (await db.query(
    'SELECT * FROM public.respostas_tentativa WHERE tentativa_id=$1', [id],
  )).rows
  const situacao = async (id: string) => (await db.query<{ situacao: string }>(
    'SELECT situacao FROM public.tentativas WHERE id=$1', [id],
  )).rows[0].situacao
  const iniciar = async (avaliacaoId: string, chave: string) => (await queryAs<{ tentativa: { id: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2,$3) AS tentativa', [avaliacaoId, EXAM_NOTICE_VERSION, chave],
  )).rows[0].tentativa.id

  const antiga = await criarProva()
  const idAntigo = (await queryAs<{ tentativa: { id: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS tentativa', [antiga.avaliacaoId, '2026-11-08-v3'],
  )).rows[0].tentativa.id
  const ordemAntiga = await alternativas(idAntigo)
  await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,1,$3,NULL)',
    [idAntigo, antiga.questaoId, ordemAntiga[0].alternativa_id])
  const respostasAntigas = await respostas(idAntigo)
  await db.exec(sessionMigration)

  await t.test('encerra a execução legada sem remover ordem, respostas ou tentativa única', async () => {
    assert.equal(await situacao(idAntigo), 'INTERROMPIDA')
    assert.deepEqual(await alternativas(idAntigo), ordemAntiga)
    assert.deepEqual(await respostas(idAntigo), respostasAntigas)
    for (const responsavel of [professor, admin]) {
      await assert.rejects(queryAs(responsavel,
        "SELECT public.reativar_tentativa($1,'Problema técnico confirmado',30)", [idAntigo]), { code: '42501' })
      await queryAs(responsavel, 'SELECT public.listar_tentativas_responsavel($1)', [antiga.avaliacaoId])
    }
    await assert.rejects(iniciar(antiga.avaliacaoId, randomUUID()), { code: '55000' })
  })

  await t.test('recarregar ou usar outra sessão não permite ler, salvar, registrar ocorrência nem encerrar', async () => {
    const { avaliacaoId, questaoId } = await criarProva()
    const chave = randomUUID()
    await assert.rejects(queryAs(aluno, 'SELECT public.iniciar_tentativa($1,$2,NULL)',
      [avaliacaoId, EXAM_NOTICE_VERSION]), { code: '23514' })
    const id = await iniciar(avaliacaoId, chave)
    const [{ alternativa_id: alternativa }] = await alternativas(id)
    const ocorrencia = randomUUID()
    const operacoes = (credencial: string) => [
      ['SELECT public.consultar_conteudo_tentativa($1,$2)', [id, credencial]],
      ['SELECT public.consultar_respostas_tentativa($1,$2)', [id, credencial]],
      ['SELECT public.salvar_resposta_tentativa($1,$2,1,$3,NULL,$4)', [id, questaoId, alternativa, credencial]],
      ['SELECT public.registrar_falha_camera($1,$2,$3)', [id, ocorrencia, credencial]],
      ["SELECT public.encerrar_tentativa($1,'ENVIO',$2)", [id, credencial]],
    ] as const

    for (const [sql, params] of operacoes(randomUUID())) {
      await assert.rejects(queryAs(aluno, sql, [...params]), { code: '42501' })
    }
    const sessaoOriginal = sessions.get(aluno)
    assert.ok(sessaoOriginal)
    const segundaSessao = randomUUID()
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [segundaSessao, aluno])
    sessions.set(aluno, segundaSessao)
    try {
      for (const [sql, params] of operacoes(chave)) {
        await assert.rejects(queryAs(aluno, sql, [...params]), { code: '42501' })
      }
    } finally {
      sessions.set(aluno, sessaoOriginal)
    }
    const rpcAntigas = [
      ['SELECT public.consultar_conteudo_tentativa($1)', [id]],
      ['SELECT public.consultar_respostas_tentativa($1)', [id]],
      ['SELECT public.salvar_resposta_tentativa($1,$2,1,$3,NULL)', [id, questaoId, alternativa]],
      ["SELECT public.encerrar_tentativa($1,'ENVIO')", [id]],
      ['SELECT public.registrar_falha_camera($1,$2)', [id, ocorrencia]],
      ['SELECT examentech_private.tentativa_do_aluno($1)', [id]],
    ] as const
    for (const [sql, params] of rpcAntigas) {
      await assert.rejects(queryAs(aluno, sql, [...params]), { code: '42501' })
    }
    assert.deepEqual(await respostas(id), [])
    assert.equal(await situacao(id), 'EM_ANDAMENTO')

    for (const [sql, params] of operacoes(chave)) await queryAs(aluno, sql, [...params])
    assert.equal((await respostas(id)).length, 1)
    assert.equal(await situacao(id), 'FINALIZADA')
  })

  await t.test('saída encerra o acesso sem apagar a resposta que foi salva', async () => {
    const { avaliacaoId, questaoId } = await criarProva()
    const chave = randomUUID()
    const id = await iniciar(avaliacaoId, chave)
    const [{ alternativa_id: alternativa }] = await alternativas(id)
    await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,1,$3,NULL,$4)', [id, questaoId, alternativa, chave])
    const salvas = await respostas(id)
    const consultaDireta = (usuario: string) => queryAs(usuario,
      'SELECT * FROM public.respostas_tentativa WHERE tentativa_id=$1', [id])
    assert.deepEqual((await consultaDireta(aluno)).rows, [])
    assert.deepEqual((await consultaDireta(professor)).rows, salvas)
    await db.exec(sessionMigration)
    assert.equal(await situacao(id), 'EM_ANDAMENTO')
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'SAIDA',$2)", [id, chave])
    assert.equal(await situacao(id), 'INTERROMPIDA')
    await assert.rejects(queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [id, chave]), { code: '55000' })
    await assert.rejects(iniciar(avaliacaoId, randomUUID()), { code: '55000' })
    assert.deepEqual(await respostas(id), salvas)
  })

  await t.test('protege plano e reserva de fotos e mantém a confirmação de Storage', async () => {
    await db.exec('UPDATE examentech_private.configuracao_fotos SET ativa=TRUE')
    const { avaliacaoId } = await criarProva()
    const chave = randomUUID()
    const id = (await queryAs<{ tentativa: { id: string } }>(aluno,
      'SELECT public.iniciar_tentativa_com_fotos($1,$2,$3,$4) AS tentativa',
      [avaliacaoId, EXAM_NOTICE_VERSION, '2026-11-08-fotos-v1', chave],
    )).rows[0].tentativa.id
    const foto = (await db.query<{ id: string }>(
      "SELECT id FROM public.fotos_tentativa WHERE tentativa_id=$1 AND momento='INICIAL'", [id],
    )).rows[0].id
    const consultarPlano = (credencial: string) => queryAs(aluno, 'SELECT public.consultar_plano_fotos($1,$2)', [id, credencial])
    const envio = randomUUID()
    const reservar = (credencial: string) => queryAs<{ reserva: { caminho: string } }>(aluno,
      'SELECT public.reservar_envio_foto($1,$2,$3,1024,640,480,$4) AS reserva', [foto, envio, 'a'.repeat(64), credencial],
    )
    await assert.rejects(consultarPlano(randomUUID()), { code: '42501' })
    await assert.rejects(reservar(randomUUID()), { code: '42501' })
    await consultarPlano(chave)
    const { caminho } = (await reservar(chave)).rows[0].reserva
    await db.query('INSERT INTO storage.objects VALUES($1,$2)', ['examentech-evidencias', caminho])
    const confirmar = () => db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE service_role')
      return tx.query('SELECT public.confirmar_envio_foto($1,$2)', [foto, envio])
    })
    const sessao = sessions.get(aluno)
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [sessao])
    await assert.rejects(confirmar(), { code: '55000' })
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessao, aluno])
    await confirmar()
    await queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [id, chave])
  })
})
