import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'
import { lerRespostaTentativa } from '../src/services/respostaValidation.ts'

const preparar = await readFile(new URL('../database/033_preparar_respostas_com_versao.sql', import.meta.url), 'utf8')
const salvar = await readFile(new URL('../database/034_salvar_resposta_com_versao.sql', import.meta.url), 'utf8')

test('034 mantém dados e compatibilidade entre as duas assinaturas de salvamento', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, queryAs, criarProva } = await prepararBancoExecucao(db)
  await db.exec(preparar)
  const { avaliacaoId, questaoId } = await criarProva()
  const tentativa = (await queryAs<{ t: { id: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS t', [avaliacaoId, '2026-11-06-v2'])).rows[0].t.id
  const alternativas = (await db.query<{ alternativa_id: string }>(
    'SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 ORDER BY ordem', [tentativa])).rows
  const antiga = () => queryAs<{ r: Record<string, unknown> }>(aluno,
    'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL) AS r', [tentativa, questaoId, alternativas[0].alternativa_id])
  const nova = (versao: number | null, alternativa = alternativas[1].alternativa_id) => queryAs<{ r: unknown }>(aluno,
    'SELECT public.salvar_resposta_tentativa($1,$2,$3,$4,NULL) AS r', [tentativa, questaoId, versao, alternativa])
  async function registros() {
    return {
      respostas: (await db.query('SELECT * FROM public.respostas_tentativa ORDER BY id')).rows,
      eventos: (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows,
      tentativas: (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows,
    }
  }
  await antiga()

  await t.test('aplicação e reaplicação preservam respostas já gravadas, permissões e histórico', async () => {
    const antes = await registros()
    for (let vez = 0; vez < 2; vez++) {
      await db.exec(salvar)
      assert.deepEqual(await registros(), antes)
    }
    const permissoes = (await db.query<{ anonimo: boolean; privada_anonima: boolean; escrita: boolean; tabela_local: string | null }>(`SELECT
      has_function_privilege('anon','public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)','EXECUTE') AS anonimo,
      has_function_privilege('anon','examentech_private.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)','EXECUTE') AS privada_anonima,
      has_table_privilege('authenticated','public.respostas_tentativa','UPDATE') AS escrita,
      to_regclass('public.respostas')::text AS tabela_local`)).rows[0]
    assert.deepEqual(permissoes, { anonimo: false, privada_anonima: false, escrita: false, tabela_local: null })
  })

  await t.test('versão nula, atual com outro conteúdo e futura são recusadas sem escrita', async () => {
    const antes = await registros()
    for (const versao of [null, 0, -1]) await assert.rejects(nova(versao), { code: '23514' })
    for (const versao of [1, 3]) await assert.rejects(nova(versao), { code: '55000' })
    assert.deepEqual(await registros(), antes)
  })

  await t.test('versão seguinte altera a mesma linha; repetição não muda versão, horário nem auditoria', async () => {
    const r = lerRespostaTentativa((await nova(2)).rows[0].r)
    assert.ok(r)
    assert.equal(r.versao, 2)
    const antes = await registros()
    assert.deepEqual(lerRespostaTentativa((await nova(2)).rows[0].r), r)
    assert.deepEqual(await registros(), antes)
    const consulta = (await queryAs<{ r: unknown[] }>(aluno,
      'SELECT public.consultar_respostas_tentativa($1) AS r', [tentativa])).rows[0].r
    assert.deepEqual(lerRespostaTentativa(consulta[0]), r)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='RESPOSTA_SALVA' AND recurso_id=$1", [tentativa])).rows.length, 2)
  })

  await t.test('pedidos disputando uma versão não sobrescrevem o primeiro confirmado', async () => {
    // PGlite serializa as transações; este teste não simula duas conexões reais.
    const resultados = await Promise.allSettled([nova(3), nova(3, alternativas[0].alternativa_id)])
    assert.deepEqual(resultados.map(r => r.status), ['fulfilled', 'rejected'])
    const antes = await registros()
    await assert.rejects(nova(2), { code: '55000' })
    assert.deepEqual(await registros(), antes)
  })

  await t.test('chamada antiga continua funcionando e sua gravação invalida versões anteriores', async () => {
    const { r } = (await antiga()).rows[0]
    assert.deepEqual(Object.keys(r).sort(), ['questao_id', 'alternativa_id', 'texto', 'salva_em'].sort())
    const antes = await registros()
    await assert.rejects(nova(3), { code: '55000' })
    assert.deepEqual(await registros(), antes)
    assert.equal(lerRespostaTentativa((await nova(5)).rows[0].r)?.versao, 5)
  })

  await t.test('encerramento bloqueia tanto novas versões como repetição da atual', async () => {
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'ENVIO')", [tentativa])
    const antes = await registros()
    for (const versao of [5, 6]) await assert.rejects(nova(versao), { code: '55000' })
    await assert.rejects(antiga(), { code: '55000' })
    await db.exec(salvar)
    assert.deepEqual(await registros(), antes)
  })
})

test('034 recusa base sem 033 e banco com duas tabelas sem alterar dados', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await prepararBancoExecucao(db)
  await assert.rejects(db.exec(salvar), /Aplique a query 033/)
  await db.exec('ROLLBACK')
  await db.exec(preparar)
  await db.exec("CREATE TABLE public.respostas (texto TEXT); INSERT INTO public.respostas VALUES ('Histórico')")
  await assert.rejects(db.exec(salvar), /Conciliar as duas tabelas/)
  await db.exec('ROLLBACK')
  assert.deepEqual((await db.query('SELECT * FROM public.respostas')).rows, [{ texto: 'Histórico' }])
  assert.equal((await db.query<{ existe: boolean }>("SELECT to_regprocedure('public.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)') IS NOT NULL AS existe")).rows[0].existe, false)
})
