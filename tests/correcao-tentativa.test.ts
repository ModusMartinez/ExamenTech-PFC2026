import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'

const migracao = (nome: string) => readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8')

type Correcao = {
  pontos_obtidos: number; pontos_totais: number; pendentes: number; nota: number | null
  questoes: { id: string; resposta: string | null; pontos: number | null; comentario: string | null; versao: number }[]
}

test('039 corrige tentativas finalizadas e protege a nota e a revisão das dissertativas', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, colega, admin, queryAs, turmaId, criarProva } = await prepararBancoCamera(db)
  for (const nome of ['037_camera_sem_interrupcao', '038_tentativa_sessao']) await db.exec(await migracao(nome))

  const chave = randomUUID()
  const iniciar = async (avaliacaoId: string) => (await queryAs<{ id: string }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2,$3)->>\'id\' AS id', [avaliacaoId, EXAM_NOTICE_VERSION, chave])).rows[0].id
  const encerrar = (id: string, motivo: string) => queryAs(aluno, 'SELECT public.encerrar_tentativa($1,$2,$3)', [id, motivo, chave])
  const consultar = async (id: string, autor = professor, aal = 'aal2') => (await queryAs<{ resultado: Correcao }>(autor,
    'SELECT public.consultar_correcao_tentativa($1) AS resultado', [id], aal)).rows[0].resultado
  const corrigir = async (id: string, questaoId: string, pontos: number, comentario: string | null, versao: number, autor = professor) =>
    (await queryAs<{ resultado: Correcao }>(autor, 'SELECT public.corrigir_dissertativa($1,$2,$3,$4,$5) AS resultado',
      [id, questaoId, pontos, comentario, versao])).rows[0].resultado

  const provaAntiga = await criarProva()
  const antiga = await iniciar(provaAntiga.avaliacaoId)
  await encerrar(antiga, 'ENVIO')
  await db.exec(await migracao('039_correcao_tentativa'))
  assert.equal((await consultar(antiga)).nota, 0)

  const { id: avaliacao } = (await queryAs<{ id: string }>(professor, `SELECT public.criar_avaliacao_rascunho(
    $1,'Prova para correção','PROVA',now()-interval '1 minute',now()+interval '1 hour',20
  )->>'id' AS id`, [turmaId])).rows[0]
  const questoes: string[] = []
  for (const [tipo, pontos] of [['OBJETIVA', 2.5], ['OBJETIVA', 1.5], ['OBJETIVA', 0.5], ['DISSERTATIVA', 4.5], ['DISSERTATIVA', 3]] as const) {
    const { id } = (await queryAs<{ id: string }>(professor, "SELECT public.criar_questao_rascunho($1,$2,'Enunciado da correção',$3)->>'id' AS id",
      [avaliacao, tipo, pontos])).rows[0]
    if (tipo === 'OBJETIVA') {
      await queryAs(professor, "SELECT public.criar_alternativas_rascunho($1,ARRAY['Correta','Incorreta'],1)", [id])
    }
    questoes.push(id)
  }
  await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [avaliacao])
  const id = await iniciar(avaliacao)
  const salvar = (questao: string, alternativa: string | null, texto: string | null, versao = 1) => queryAs(aluno,
    'SELECT public.salvar_resposta_tentativa($1,$2,$3,$4,$5,$6)', [id, questao, versao, alternativa, texto, chave])
  const alternativa = async (questao: string, correta: boolean) => (await db.query<{ id: string }>(
    'SELECT id FROM public.alternativas WHERE questao_id=$1 AND correta=$2', [questao, correta])).rows[0].id
  await salvar(questoes[0], await alternativa(questoes[0], false), null)
  await salvar(questoes[0], await alternativa(questoes[0], true), null, 2)
  await salvar(questoes[1], await alternativa(questoes[1], false), null)
  await salvar(questoes[3], null, 'Minha justificativa')
  await salvar(questoes[4], null, ' \t\n')

  await t.test('apenas tentativa finalizada tem correção, sem vazar nota ou gabarito ao aluno', async () => {
    await assert.rejects(consultar(id), { code: '55000' })
    const resultado = await queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [id, chave])
    assert.doesNotMatch(JSON.stringify(resultado.rows), /gabarito|correta"\s*:/i)
    await encerrar(id, 'ENVIO')
    await encerrar(id, 'ENVIO')
    const pendente = await consultar(id)
    assert.deepEqual(pendente.questoes.map(questao => questao.pontos), [2.5, 0, 0, null, 0])
    assert.equal(pendente.questoes[4].resposta, null)
    assert.equal(pendente.pontos_obtidos, 2.5)
    assert.equal(pendente.pontos_totais, 12)
    assert.equal(pendente.nota, null)
    assert.equal(pendente.pendentes, 1)
    for (const pessoa of [aluno, colega, admin]) {
      await assert.rejects(consultar(id, pessoa), { code: '42501' })
      await assert.rejects(corrigir(id, questoes[3], 1, null, 0, pessoa), { code: '42501' })
    }
    await assert.rejects(consultar(id, professor, 'aal1'), { code: '42501' })
    await assert.rejects(queryAs(aluno, 'SELECT * FROM examentech_private.pontuacoes_tentativa'), { code: '42501' })
  })

  await t.test('autor pode corrigir de zero ao máximo, com reenvio idempotente e revisão protegida', async () => {
    for (const pontos of [-1, 4.51, 1.005, NaN]) await assert.rejects(corrigir(id, questoes[3], pontos, null, 0), { code: '23514' })
    for (const questao of [questoes[0], questoes[4], provaAntiga.questaoId]) {
      await assert.rejects(corrigir(id, questao, 0, null, 0), { code: '23514' })
    }
    await assert.rejects(corrigir(id, questoes[3], 3.25, 'x'.repeat(2001), 0), { code: '23514' })
    const nota = await corrigir(id, questoes[3], 3.25, ' Boa justificativa ', 0)
    assert.equal(nota.pendentes, 0)
    assert.equal(nota.pontos_obtidos, 5.75)
    assert.equal(nota.nota, 4.79)
    assert.equal(nota.questoes[3].comentario, 'Boa justificativa')
    assert.equal(nota.questoes[3].versao, 1)
    assert.deepEqual(await corrigir(id, questoes[3], 3.25, 'Boa justificativa', 0), nota)
    await assert.rejects(corrigir(id, questoes[3], 4.5, null, 0), { code: '40001' })
    const maxima = await corrigir(id, questoes[3], 4.5, null, 1)
    assert.equal(maxima.nota, 5.83)
    assert.equal(maxima.questoes[3].comentario, null)
    const zerada = await corrigir(id, questoes[3], 0, null, 2)
    assert.equal(zerada.nota, 2.08)
    await db.exec(await migracao('039_correcao_tentativa'))
    assert.deepEqual(await consultar(id), zerada)
  })

  await t.test('prazo usa a mesma correção e saída preserva a tentativa sem gerar nota', async () => {
    const provaPrazo = await criarProva()
    const prazo = await iniciar(provaPrazo.avaliacaoId)
    await db.query("UPDATE public.tentativas SET iniciada_em=now()-interval '2 minutes', limite_em=now()-interval '1 second' WHERE id=$1", [prazo])
    await encerrar(prazo, 'PRAZO')
    assert.equal((await consultar(prazo)).nota, 0)
    const interrompida = await iniciar((await criarProva()).avaliacaoId)
    await encerrar(interrompida, 'SAIDA')
    await assert.rejects(consultar(interrompida), { code: '55000' })
  })
})
