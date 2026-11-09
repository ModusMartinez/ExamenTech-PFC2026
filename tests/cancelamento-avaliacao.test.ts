import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'

test('RF28–RF29 cancelam a avaliação e preservam respostas e tentativas já encerradas', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, colega, admin, org, sessions, turmaId, queryAs, criarProva, avaliacaoId } = await prepararBancoCamera(db)
  const segundoAluno = randomUUID()
  const sessao = randomUUID()
  sessions.set(segundoAluno, sessao)
  await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ($1,$2,$3)', [
    segundoAluno, `${segundoAluno}@example.test`,
    JSON.stringify({ termos_aceitos: true, termos_versao: '2026-11-08-v6', privacidade_versao: '2026-11-08-v5' }),
  ])
  await db.query("UPDATE public.perfis SET perfil='ALUNO',situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [org, segundoAluno])
  await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessao, segundoAluno])
  await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, segundoAluno])

  for (const nome of ['037_camera_sem_interrupcao', '038_tentativa_sessao', '039_correcao_tentativa',
    '040_finalizacao_e_resultados', '042_cancelamento_avaliacao']) {
    await db.exec(await readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8'))
  }

  const prova = await criarProva()
  const chave = randomUUID()
  const iniciar = async (id: string, usuario = aluno) => (await queryAs<{ id: string }>(usuario,
    "SELECT public.iniciar_tentativa($1,$2,$3)->>'id' AS id", [id, EXAM_NOTICE_VERSION, chave])).rows[0].id
  const cancelar = async (id: string, usuario = professor, aal = 'aal2') => (await queryAs<{ cancelada: unknown }>(
    usuario, 'SELECT public.cancelar_avaliacao($1) AS cancelada', [id], aal)).rows[0].cancelada
  const id = await iniciar(prova.avaliacaoId)
  const finalizada = await iniciar(prova.avaliacaoId, segundoAluno)
  await queryAs(segundoAluno, "SELECT public.encerrar_tentativa($1,'ENVIO',$2)", [finalizada, chave])
  const alternativa = (await db.query<{ id: string }>(
    'SELECT id FROM public.alternativas WHERE questao_id=$1 AND correta', [prova.questaoId])).rows[0].id
  const salvar = (versao: number) => queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,$3,$4,NULL,$5)',
    [id, prova.questaoId, versao, alternativa, chave])
  await salvar(1)

  await t.test('só o autor com MFA cancela e o rascunho continua editável', async () => {
    for (const usuario of [colega, admin, aluno]) await assert.rejects(cancelar(prova.avaliacaoId, usuario), { code: '42501' })
    await assert.rejects(cancelar(prova.avaliacaoId, professor, 'aal1'), { code: '42501' })
    await assert.rejects(cancelar(avaliacaoId), { code: '55000' })
    assert.deepEqual((await db.query('SELECT situacao FROM public.avaliacoes WHERE id=$1', [avaliacaoId])).rows, [{ situacao: 'RASCUNHO' }])
  })

  await t.test('fecha somente tentativas ativas, audita uma vez e mantém a resposta recebida', async () => {
    const cancelada = await cancelar(prova.avaliacaoId)
    assert.deepEqual(await cancelar(prova.avaliacaoId), cancelada)
    const estados = await db.query<{ id: string; situacao: string; encerrada: boolean }>(
      'SELECT id,situacao,encerrada_em IS NOT NULL AS encerrada FROM public.tentativas WHERE avaliacao_id=$1', [prova.avaliacaoId])
    assert.deepEqual(estados.rows.find(row => row.id === id), { id, situacao: 'CANCELADA', encerrada: true })
    assert.deepEqual(estados.rows.find(row => row.id === finalizada), { id: finalizada, situacao: 'FINALIZADA', encerrada: true })
    await assert.rejects(salvar(2), { code: '55000' })
    assert.deepEqual((await db.query('SELECT alternativa_id,versao FROM public.respostas_tentativa WHERE tentativa_id=$1', [id])).rows,
      [{ alternativa_id: alternativa, versao: 1 }])
    assert.deepEqual((await db.query("SELECT usuario_id FROM public.eventos_seguranca WHERE recurso_id=$1 AND evento='AVALIACAO_CANCELADA'", [prova.avaliacaoId])).rows,
      [{ usuario_id: professor }])
    assert.deepEqual((await db.query('SELECT pontos FROM examentech_private.pontuacoes_tentativa WHERE tentativa_id=$1', [id])).rows, [])
  })

  await t.test('bloqueia início, execução, reabertura e publicação de resultados', async () => {
    const antesDoInicio = (await criarProva()).avaliacaoId
    await cancelar(antesDoInicio)
    await assert.rejects(iniciar(antesDoInicio), { code: '55000' })
    await assert.rejects(queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [id, chave]), { code: 'P0002' })
    await assert.rejects(queryAs(aluno, "SELECT public.encerrar_tentativa($1,'ENVIO',$2)", [id, chave]), { code: 'P0002' })
    await assert.rejects(queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [prova.avaliacaoId]), { code: '55000' })
    await assert.rejects(queryAs(professor, 'SELECT public.publicar_resultados_avaliacao($1)', [prova.avaliacaoId]), { code: '42501' })
    assert.deepEqual((await queryAs(aluno, 'SELECT public.listar_minhas_avaliacoes() AS avaliacoes')).rows, [{ avaliacoes: [] }])
  })

  await t.test('publicação Realtime mantém a RLS dos metadados e dos resultados', async () => {
    const publicada = await db.query("SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='tentativas'")
    assert.equal(publicada.rows.length, 1)
    const situacao = 'SELECT situacao FROM public.tentativas WHERE id=$1'
    assert.deepEqual((await queryAs(aluno, situacao, [id])).rows, [{ situacao: 'CANCELADA' }])
    assert.deepEqual((await queryAs(segundoAluno, situacao, [id])).rows, [])
    assert.deepEqual((await queryAs(aluno, 'SELECT public.listar_meus_resultados() AS resultados')).rows, [{ resultados: [] }])
    const divulgada = (await criarProva()).avaliacaoId
    await db.query('INSERT INTO examentech_private.resultados_publicados(avaliacao_id,publicado_por) VALUES ($1,$2)', [divulgada, professor])
    await assert.rejects(cancelar(divulgada), { code: '55000' })
  })
})
