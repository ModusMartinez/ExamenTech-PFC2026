import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'
import { lerRespostaTentativa } from '../src/services/respostaValidation.ts'

const preparar = await readFile(new URL('../database/033_preparar_respostas_com_versao.sql', import.meta.url), 'utf8')
const salvar = await readFile(new URL('../database/034_salvar_resposta_com_versao.sql', import.meta.url), 'utf8')
const bloquear = await readFile(new URL('../database/035_bloquear_resposta_sem_versao.sql', import.meta.url), 'utf8')

test('035 bloqueia o salvamento sem versão e preserva o fluxo atual e o histórico', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, admin, queryAs, criarProva } = await prepararBancoExecucao(db)
  await db.exec(preparar)
  await db.exec(salvar)
  await db.exec("CREATE TABLE public.respostas_prova (texto TEXT); INSERT INTO public.respostas_prova VALUES ('Histórico do protótipo')")
  const { avaliacaoId, questaoId } = await criarProva()
  const tentativa = (await queryAs<{ t: { id: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS t', [avaliacaoId, '2026-11-06-v2'])).rows[0].t.id
  const alternativas = (await db.query<{ alternativa_id: string }>(
    'SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 ORDER BY ordem', [tentativa])).rows
  const antiga = [tentativa, questaoId, alternativas[0].alternativa_id]
  await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)', antiga)
  const nova = (versao: number, alternativa = alternativas[1].alternativa_id) => queryAs<{ r: unknown }>(aluno,
    'SELECT public.salvar_resposta_tentativa($1,$2,$3,$4,NULL) AS r', [tentativa, questaoId, versao, alternativa])
  async function registros() {
    return {
      respostas: (await db.query('SELECT * FROM public.respostas_tentativa ORDER BY id')).rows,
      eventos: (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows,
      tentativas: (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows,
      historico: (await db.query('SELECT * FROM public.respostas_prova')).rows,
    }
  }

  await t.test('aplicação e reaplicação preservam todos os registros', async () => {
    const antes = await registros()
    // Confere também a revogação de concessões diretas a anon e da concessão geral a PUBLIC.
    await db.exec(`GRANT EXECUTE ON FUNCTION public.salvar_resposta_tentativa(UUID,UUID,UUID,TEXT) TO PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID,UUID,UUID,TEXT) TO PUBLIC, anon;`)
    for (let vez = 0; vez < 2; vez++) {
      await db.exec(bloquear)
      assert.deepEqual(await registros(), antes)
    }
    for (const schema of ['public', 'examentech_private']) {
      const privilegios = (await db.query(`SELECT
        has_function_privilege('anon', $1, 'EXECUTE') AS anon_antiga,
        has_function_privilege('authenticated', $1, 'EXECUTE') AS autenticado_antiga,
        has_function_privilege('anon', $2, 'EXECUTE') AS anon_nova,
        has_function_privilege('authenticated', $2, 'EXECUTE') AS autenticado_nova`, [
        `${schema}.salvar_resposta_tentativa(uuid,uuid,uuid,text)`,
        `${schema}.salvar_resposta_tentativa(uuid,uuid,integer,uuid,text)`,
      ])).rows[0]
      assert.deepEqual(privilegios, { anon_antiga: false, autenticado_antiga: false, anon_nova: false, autenticado_nova: true })
    }
  })

  await t.test('aluno, professor, admin e anônimo não executam nenhuma entrada antiga', async () => {
    const antes = await registros()
    for (const schema of ['public', 'examentech_private']) {
      const sql = `SELECT ${schema}.salvar_resposta_tentativa($1,$2,$3,NULL)`
      for (const usuario of [aluno, professor, admin]) {
        await assert.rejects(queryAs(usuario, sql, antiga), { code: '42501', message: /permission denied for function/ })
      }
      await assert.rejects(db.transaction(async tx => {
        await tx.exec('SET LOCAL ROLE anon')
        await tx.query(sql, antiga)
      }), { code: '42501' })
    }
    await assert.rejects(queryAs(aluno, 'UPDATE public.respostas_tentativa SET versao=99'), { code: '42501' })
    assert.deepEqual(await registros(), antes)
  })

  await t.test('versão seguinte, repetição e consulta continuam funcionando; conflito não escreve', async () => {
    const antes = (await db.query<{ id: string; criado_em: Date }>(
      'SELECT id, criado_em FROM public.respostas_tentativa WHERE tentativa_id=$1', [tentativa])).rows[0]
    const resposta = lerRespostaTentativa((await nova(2)).rows[0].r)
    assert.ok(resposta)
    assert.equal(resposta.id, antes.id)
    assert.equal(resposta.criado_em, antes.criado_em.toISOString())
    assert.equal(resposta.versao, 2)
    const confirmado = await registros()
    assert.deepEqual(lerRespostaTentativa((await nova(2)).rows[0].r), resposta)
    await assert.rejects(nova(1), { code: '55000' })
    await assert.rejects(nova(2, alternativas[0].alternativa_id), { code: '55000' })
    assert.deepEqual(await registros(), confirmado)
    const consulta = (await queryAs<{ r: unknown[] }>(aluno,
      'SELECT public.consultar_respostas_tentativa($1) AS r', [tentativa])).rows[0].r
    assert.deepEqual(lerRespostaTentativa(consulta[0]), resposta)
  })

  await t.test('encerramento continua disponível e impede novos salvamentos', async () => {
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'ENVIO')", [tentativa])
    const antes = await registros()
    await assert.rejects(nova(3), { code: '55000' })
    await db.exec(bloquear)
    assert.deepEqual(await registros(), antes)
  })
})

test('035 recusa preparação incompleta e permissão herdada sem aplicar bloqueio parcial', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await prepararBancoExecucao(db)
  await db.exec(preparar)
  const permissoes = async () => (await db.query(`SELECT
    has_function_privilege('authenticated', 'public.salvar_resposta_tentativa(uuid,uuid,uuid,text)', 'EXECUTE') AS publica,
    has_function_privilege('authenticated', 'examentech_private.salvar_resposta_tentativa(uuid,uuid,uuid,text)', 'EXECUTE') AS privada`)).rows[0]
  const antes = await permissoes()

  await assert.rejects(db.exec(bloquear), /Aplique as queries 033 e 034/)
  await db.exec('ROLLBACK')
  assert.deepEqual(await permissoes(), antes)
  await db.exec(salvar)
  await db.exec('REVOKE EXECUTE ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID,UUID,INTEGER,UUID,TEXT) FROM authenticated')
  await assert.rejects(db.exec(bloquear), /Confira as permissões da função com versão/)
  await db.exec('ROLLBACK')
  assert.deepEqual(await permissoes(), antes)
  await db.exec(salvar)

  await db.exec('CREATE TABLE public.respostas (texto TEXT)')
  await assert.rejects(db.exec(bloquear), /modelo único/)
  await db.exec('ROLLBACK')
  assert.deepEqual(await permissoes(), antes)
  await db.exec('DROP TABLE public.respostas')

  await db.exec(`CREATE ROLE acesso_legado;
    GRANT acesso_legado TO authenticated;
    GRANT EXECUTE ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID,UUID,UUID,TEXT) TO acesso_legado;`)
  await assert.rejects(db.exec(bloquear), /permissão herdada/)
  await db.exec('ROLLBACK')
  assert.deepEqual(await permissoes(), antes)
  await db.exec('REVOKE EXECUTE ON FUNCTION examentech_private.salvar_resposta_tentativa(UUID,UUID,UUID,TEXT) FROM acesso_legado')
  await db.exec(bloquear)
  assert.deepEqual(await permissoes(), { publica: false, privada: false })
})
