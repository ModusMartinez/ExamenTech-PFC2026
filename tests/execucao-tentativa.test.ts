import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'
const EXAM_NOTICE_VERSION = '2026-11-06-v2' // Aviso da migration histórica testada.

test('respostas, envio e interrupção respeitam a tentativa única', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { professor, aluno, admin, turmaId, queryAs } = await prepararBancoAvaliacoes(db)
  for (const file of [
    '023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql',
    '025_iniciar_tentativa.sql', '026_ordem_tentativa.sql',
    '027_consultar_conteudo_tentativa.sql', '028_respostas_e_encerramento.sql',
  ]) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }

  async function criarProva() {
    const avaliacaoId = (await queryAs<{ avaliacao: { id: string } }>(professor,
      `SELECT public.criar_avaliacao_rascunho($1,'Prova de teste','PROVA',
        now()-interval '5 minutes',now()+interval '2 hours',60) AS avaliacao`, [turmaId])).rows[0].avaliacao.id
    const objetiva = (await queryAs<{ questao: { id: string } }>(professor,
      "SELECT public.criar_questao_rascunho($1,'OBJETIVA','Quanto é 2 + 2?',1) AS questao",
      [avaliacaoId])).rows[0].questao.id
    await queryAs(professor, 'SELECT public.criar_alternativas_rascunho($1,$2,2)',
      [objetiva, ['3', '4', '5']])
    const dissertativa = (await queryAs<{ questao: { id: string } }>(professor,
      "SELECT public.criar_questao_rascunho($1,'DISSERTATIVA','Explique a solução.',2) AS questao",
      [avaliacaoId])).rows[0].questao.id
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [avaliacaoId])
    return { avaliacaoId, objetiva, dissertativa }
  }

  const { avaliacaoId, objetiva, dissertativa } = await criarProva()
  const tentativa = (await queryAs<{ tentativa: { id: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS tentativa', [avaliacaoId, EXAM_NOTICE_VERSION])).rows[0].tentativa
  const aviso = (await db.query<{ aviso_versao: string; aviso_aceito_em: string; iniciada_em: string }>(
    'SELECT aviso_versao,aviso_aceito_em,iniciada_em FROM public.tentativas WHERE id=$1', [tentativa.id])).rows[0]
  assert.equal(aviso.aviso_versao, EXAM_NOTICE_VERSION)
  assert.equal(new Date(aviso.aviso_aceito_em).getTime(), new Date(aviso.iniciada_em).getTime())

  await t.test('início sem aviso ou com versão antiga é recusado', async () => {
    await assert.rejects(queryAs(aluno, 'SELECT public.iniciar_tentativa($1)', [randomUUID()]), { code: '42501' })
    await assert.rejects(queryAs(aluno, 'SELECT public.iniciar_tentativa($1,$2)',
      [randomUUID(), 'versao-antiga']), { code: '23514' })
  })
  const alternativa = (await db.query<{ alternativa_id: string }>(
    'SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 AND questao_id=$2 LIMIT 1',
    [tentativa.id, objetiva])).rows[0].alternativa_id

  await t.test('salva apenas respostas da própria tentativa e gera auditoria', async () => {
    const objetivaSalva = (await queryAs<{ resposta: { alternativa_id: string } }>(aluno,
      'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL) AS resposta',
      [tentativa.id, objetiva, alternativa])).rows[0].resposta
    assert.equal(objetivaSalva.alternativa_id, alternativa)
    const textoSalvo = (await queryAs<{ resposta: { texto: string } }>(aluno,
      'SELECT public.salvar_resposta_tentativa($1,$2,NULL,$3) AS resposta',
      [tentativa.id, dissertativa, '  Quatro.  '])).rows[0].resposta
    assert.equal(textoSalvo.texto, 'Quatro.')
    await assert.rejects(queryAs(aluno,
      'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)',
      [tentativa.id, dissertativa, alternativa]), { code: '23514' })
    await assert.rejects(queryAs(aluno,
      'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)',
      [tentativa.id, objetiva, randomUUID()]), { code: '23514' })
    await assert.rejects(queryAs(admin,
      'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)',
      [tentativa.id, objetiva, alternativa]), { code: '42501' })
    assert.equal((await db.query<{ total: number }>("SELECT count(*)::int AS total FROM public.eventos_seguranca WHERE evento='RESPOSTA_SALVA' AND recurso_id=$1", [tentativa.id])).rows[0].total, 2)
  })

  await t.test('envio encerra uma vez e impede novas escritas ou reinício', async () => {
    const enviado = (await queryAs<{ resultado: { situacao: string } }>(aluno,
      "SELECT public.encerrar_tentativa($1,'ENVIO') AS resultado", [tentativa.id])).rows[0].resultado
    assert.equal(enviado.situacao, 'FINALIZADA')
    const repetido = (await queryAs<{ resultado: { situacao: string } }>(aluno,
      "SELECT public.encerrar_tentativa($1,'ENVIO') AS resultado", [tentativa.id])).rows[0].resultado
    assert.deepEqual(repetido, enviado)
    await assert.rejects(queryAs(aluno,
      'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)',
      [tentativa.id, objetiva, alternativa]), { code: '55000' })
    await assert.rejects(queryAs(aluno, 'SELECT public.iniciar_tentativa($1,$2)',
      [avaliacaoId, EXAM_NOTICE_VERSION]), { code: '55000' })
    assert.equal((await db.query<{ total: number }>("SELECT count(*)::int AS total FROM public.eventos_seguranca WHERE evento='TENTATIVA_FINALIZADA' AND recurso_id=$1", [tentativa.id])).rows[0].total, 1)
  })

  await t.test('falha da câmera interrompe definitivamente outra prova', async () => {
    const outra = await criarProva()
    const iniciada = (await queryAs<{ tentativa: { id: string } }>(aluno,
      'SELECT public.iniciar_tentativa($1,$2) AS tentativa',
      [outra.avaliacaoId, EXAM_NOTICE_VERSION])).rows[0].tentativa
    const interrompida = (await queryAs<{ resultado: { situacao: string; falhas_camera: number } }>(aluno,
      "SELECT public.encerrar_tentativa($1,'CAMERA') AS resultado", [iniciada.id])).rows[0].resultado
    assert.equal(interrompida.situacao, 'INTERROMPIDA')
    assert.equal(interrompida.falhas_camera, 1)
    await assert.rejects(queryAs(aluno, 'SELECT public.iniciar_tentativa($1,$2)',
      [outra.avaliacaoId, EXAM_NOTICE_VERSION]), { code: '55000' })
    assert.equal((await db.query<{ total: number }>("SELECT count(*)::int AS total FROM public.eventos_seguranca WHERE evento='TENTATIVA_INTERROMPIDA' AND recurso_id=$1", [iniciada.id])).rows[0].total, 1)
  })

  await t.test('prazo vencido finaliza no banco e impede novas respostas', async () => {
    const prova = await criarProva()
    const iniciada = (await queryAs<{ tentativa: { id: string } }>(aluno,
      'SELECT public.iniciar_tentativa($1,$2) AS tentativa',
      [prova.avaliacaoId, EXAM_NOTICE_VERSION])).rows[0].tentativa
    await assert.rejects(queryAs(aluno, "SELECT public.encerrar_tentativa($1,'PRAZO')", [iniciada.id]), { code: '55000' })
    await db.query(`UPDATE public.tentativas SET iniciada_em=now()-interval '2 hours',
      limite_em=now()-interval '1 second' WHERE id=$1`, [iniciada.id])
    const encerrada = (await queryAs<{ resultado: { situacao: string } }>(aluno,
      "SELECT public.encerrar_tentativa($1,'PRAZO') AS resultado", [iniciada.id])).rows[0].resultado
    assert.equal(encerrada.situacao, 'FINALIZADA')
    await assert.rejects(queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)',
      [iniciada.id, prova.objetiva, alternativa]), { code: '55000' })
  })
})
