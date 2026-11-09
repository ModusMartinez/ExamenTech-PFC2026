import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'

type Publicacao = { estado: string; publicado_em: string | null }
type Resultado = { nota: number; questoes: { id: string; resposta: string; pontos: number; comentario: string;
  alternativas: { id: string; marcada: boolean; correta: boolean }[] }[] }

test('o servidor finaliza pelo prazo e publica apenas resultados autorizados e completos', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, colega, admin, queryAs, turmaId, criarProva } = await prepararBancoCamera(db)
  for (const nome of ['037_camera_sem_interrupcao', '038_tentativa_sessao', '039_correcao_tentativa', '040_finalizacao_e_resultados']) {
    await db.exec(await readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8'))
  }

  const chave = randomUUID()
  const criarAvaliacao = async () => {
    const { id } = (await queryAs<{ id: string }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1, 'Avaliação de resultados', 'PROVA', now()-interval '10 minutes', now()+interval '2 hours', 30
    )->>'id' AS id`, [turmaId])).rows[0]
    const questao = async (tipo: string, pontos: number) => (await queryAs<{ id: string }>(professor,
      "SELECT public.criar_questao_rascunho($1,$2,'Questão do teste de resultados',$3)->>'id' AS id", [id, tipo, pontos])).rows[0].id
    const objetiva = await questao('OBJETIVA', 3)
    const dissertativa = await questao('DISSERTATIVA', 7)
    await queryAs(professor, "SELECT public.criar_alternativas_rascunho($1,ARRAY['Correta','Outra opção'],1)", [objetiva])
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [id])
    return { id, objetiva, dissertativa }
  }
  const iniciar = async (avaliacaoId: string) => (await queryAs<{ id: string }>(aluno,
    "SELECT public.iniciar_tentativa($1,$2,$3)->>'id' AS id", [avaliacaoId, EXAM_NOTICE_VERSION, chave])).rows[0].id
  const encerrar = (id: string, motivo: string) => queryAs(aluno, 'SELECT public.encerrar_tentativa($1,$2,$3)', [id, motivo, chave])
  const publicar = async (id: string, usuario = professor) => (await queryAs<{ publicacao: Publicacao }>(usuario,
    'SELECT public.publicar_resultados_avaliacao($1) AS publicacao', [id])).rows[0].publicacao
  const estado = async (id: string) => (await queryAs<{ estado: string }>(professor,
    "SELECT public.consultar_publicacao_resultados($1)->>'estado' AS estado", [id])).rows[0].estado
  const ler = async (id: string, usuario = aluno, aal = 'aal2') => (await queryAs<{ resultado: Resultado }>(usuario,
    'SELECT public.consultar_meu_resultado($1) AS resultado', [id], aal)).rows[0].resultado
  const lista = async (usuario = aluno) => (await queryAs<{ resultados: { tentativa_id: string }[] }>(usuario,
    'SELECT public.listar_meus_resultados() AS resultados')).rows[0].resultados
  const rodarJob = async () => (await db.query<{ total: number }>(
    'SELECT examentech_private.finalizar_tentativas_vencidas() AS total')).rows[0].total
  const registrarPrazoVencido = async (id: string) => db.query(
    "UPDATE public.tentativas SET iniciada_em=now()-interval '3 minutes',limite_em=now()-interval '2 minutes' WHERE id=$1", [id])

  const avaliacao = await criarAvaliacao()
  const id = await iniciar(avaliacao.id)
  const alternativa = (await db.query<{ id: string }>('SELECT id FROM public.alternativas WHERE questao_id=$1 AND correta',
    [avaliacao.objetiva])).rows[0].id
  await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,1,$3,NULL,$4)', [id, avaliacao.objetiva, alternativa, chave])
  await queryAs(aluno, "SELECT public.salvar_resposta_tentativa($1,$2,1,NULL,'Resposta já salva',$3)", [id, avaliacao.dissertativa, chave])

  await t.test('job interno respeita o prazo e é idempotente, inclusive se a página tentar fechar depois', async () => {
    assert.equal(await estado(avaliacao.id), 'JANELA_ABERTA')
    assert.equal(await rodarJob(), 0)
    await assert.rejects(queryAs(aluno, 'SELECT examentech_private.finalizar_tentativas_vencidas()'), { code: '42501' })
    await registrarPrazoVencido(id)
    await db.query("UPDATE public.avaliacoes SET fim_em=now()-interval '2 minutes' WHERE id=$1", [avaliacao.id])
    assert.equal(await estado(avaliacao.id), 'ENCERRAMENTO_PENDENTE')
    await assert.rejects(publicar(avaliacao.id), { code: '55000' })
    assert.equal(await rodarJob(), 1)
    assert.equal(await rodarJob(), 0)
    await encerrar(id, 'PRAZO')
    await encerrar(id, 'SAIDA')
    const { rows } = await db.query('SELECT situacao, encerrada_em=limite_em AS no_prazo FROM public.tentativas WHERE id=$1', [id])
    assert.deepEqual(rows, [{ situacao: 'FINALIZADA', no_prazo: true }])
    const eventos = await db.query('SELECT acao, usuario_id FROM public.eventos_seguranca WHERE recurso_id=$1 AND evento=\'TENTATIVA_FINALIZADA\'', [id])
    assert.deepEqual(eventos.rows, [{ acao: 'prazo_tentativa', usuario_id: null }])
    const pontos = await db.query<{ pontos: string }>('SELECT pontos FROM examentech_private.pontuacoes_tentativa WHERE tentativa_id=$1', [id])
    assert.equal(Number(pontos.rows[0].pontos), 3)
    assert.equal(await estado(avaliacao.id), 'CORRECAO_PENDENTE')
  })

  await t.test('publicação exige autor, janela encerrada e todas as correções e bloqueia edições posteriores', async () => {
    assert.deepEqual(await lista(), [])
    await assert.rejects(ler(id), { code: 'P0002' })
    for (const pessoa of [aluno, colega, admin]) await assert.rejects(publicar(avaliacao.id, pessoa), { code: '42501' })
    await assert.rejects(publicar(avaliacao.id), { code: '55000' })
    await queryAs(professor, "SELECT public.corrigir_dissertativa($1,$2,4.5,'Boa justificativa',0)", [id, avaliacao.dissertativa])
    assert.equal(await estado(avaliacao.id), 'PRONTO')
    await assert.rejects(ler(id), { code: 'P0002' })
    const publicacao = await publicar(avaliacao.id)
    assert.equal(publicacao.estado, 'PUBLICADO')
    assert.ok(publicacao.publicado_em)
    assert.deepEqual(await publicar(avaliacao.id), publicacao)
    await assert.rejects(queryAs(professor, "SELECT public.corrigir_dissertativa($1,$2,5,'Outro comentário',1)",
      [id, avaliacao.dissertativa]), { code: '55000' })
  })

  await t.test('somente o aluno titular com MFA vê o gabarito, a própria nota e a correção publicada', async () => {
    assert.deepEqual((await lista()).map(r => r.tentativa_id), [id])
    for (const pessoa of [colega, professor, admin]) {
      assert.deepEqual(await lista(pessoa), [])
      await assert.rejects(ler(id, pessoa), { code: 'P0002' })
    }
    await assert.rejects(ler(id, aluno, 'aal1'), { code: 'P0002' })
    const resultado = await ler(id)
    assert.equal(resultado.nota, 7.5)
    assert.equal(resultado.questoes.find(q => q.id === avaliacao.dissertativa)?.resposta, 'Resposta já salva')
    assert.equal(resultado.questoes.find(q => q.id === avaliacao.dissertativa)?.comentario, 'Boa justificativa')
    assert.deepEqual(resultado.questoes.find(q => q.id === avaliacao.objetiva)?.alternativas.find(a => a.marcada),
      { id: alternativa, texto: 'Correta', marcada: true, correta: true })
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE aluno_id=$1 AND turma_id=$2", [aluno, turmaId])
    assert.equal((await ler(id)).nota, 7.5)
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE aluno_id=$1 AND turma_id=$2", [aluno, turmaId])
  })

  await t.test('saída anterior ao prazo permanece interrompida; saída tardia finaliza por prazo', async () => {
    const interrompida = await iniciar((await criarProva()).avaliacaoId)
    await encerrar(interrompida, 'SAIDA')
    const atrasada = await iniciar((await criarProva()).avaliacaoId)
    await registrarPrazoVencido(interrompida)
    await registrarPrazoVencido(atrasada)
    await encerrar(atrasada, 'SAIDA')
    assert.equal(await rodarJob(), 0)
    const { rows } = await db.query<{ id: string; situacao: string }>('SELECT id,situacao FROM public.tentativas WHERE id IN ($1,$2)', [interrompida, atrasada])
    assert.equal(rows.find(row => row.id === interrompida)?.situacao, 'INTERROMPIDA')
    assert.equal(rows.find(row => row.id === atrasada)?.situacao, 'FINALIZADA')
  })
})
