import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'
import { lerRespostaTentativa } from '../src/services/respostaValidation.ts'

const migration = await readFile(new URL('../database/033_preparar_respostas_com_versao.sql', import.meta.url), 'utf8')

test('033 prepara a tabela da entrega sem perder respostas ou quebrar a tela atual', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, colega, admin, queryAs, criarProva } = await prepararBancoExecucao(db)
  await db.exec("CREATE TABLE public.respostas_prova (texto TEXT); INSERT INTO public.respostas_prova VALUES ('Resposta do protótipo')")
  const { avaliacaoId, questaoId } = await criarProva()
  const tentativa = (await queryAs<{ tentativa: { id: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS tentativa', [avaliacaoId, '2026-11-06-v2'])).rows[0].tentativa.id
  const alternativas = (await db.query<{ alternativa_id: string }>(
    'SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 ORDER BY ordem', [tentativa])).rows
  const salvar = (alternativa = alternativas[0].alternativa_id) => queryAs<{ resposta: Record<string, unknown> }>(aluno,
    'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL) AS resposta', [tentativa, questaoId, alternativa])
  const consultar = async () => (await queryAs<{ respostas: unknown[] }>(aluno,
    'SELECT public.consultar_respostas_tentativa($1) AS respostas', [tentativa])).rows[0].respostas
  const respostas = async () => (await db.query<Record<string, unknown>>('SELECT * FROM public.respostas_tentativa ORDER BY tentativa_id,questao_id')).rows
  const eventos = async () => (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
  await salvar()
  const antes = await respostas()
  const eventosAntes = await eventos()
  const tentativasAntes = (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows
  await db.exec(migration)

  await t.test('preserva conteúdo, horários, tentativas e eventos; reaplicação não altera registros', async () => {
    const depois = await respostas()
    assert.equal(depois.length, antes.length)
    for (const [campo, valor] of Object.entries(antes[0])) assert.deepEqual(depois[0][campo], valor)
    assert.equal(depois[0].versao, 1)
    assert.deepEqual(depois[0].criado_em, antes[0].salva_em)
    assert.equal(typeof depois[0].id, 'string')
    assert.deepEqual(await eventos(), eventosAntes)
    assert.deepEqual((await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows, tentativasAntes)
    assert.deepEqual((await db.query('SELECT * FROM public.respostas_prova')).rows, [{ texto: 'Resposta do protótipo' }])
    await db.exec(migration)
    assert.deepEqual(await respostas(), depois)
    assert.deepEqual(await eventos(), eventosAntes)
    assert.equal((await db.query<{ tabela: string | null }>("SELECT to_regclass('public.respostas')::text AS tabela")).rows[0].tabela, null)
  })

  await t.test('RPC atual conserva o retorno e avança versão sem trocar ID ou data inicial', async () => {
    const primeira = lerRespostaTentativa((await consultar())[0])
    assert.ok(primeira)
    const { resposta } = (await salvar(alternativas[1].alternativa_id)).rows[0]
    assert.deepEqual(Object.keys(resposta).sort(), ['questao_id', 'alternativa_id', 'texto', 'salva_em'].sort())
    const segunda = lerRespostaTentativa((await consultar())[0])
    assert.ok(segunda)
    assert.equal(segunda.id, primeira.id)
    assert.equal(segunda.criado_em, primeira.criado_em)
    assert.equal(segunda.versao, 2)
    assert.equal(segunda.alternativa_id, alternativas[1].alternativa_id)
    assert.ok(typeof resposta.salva_em === 'string')
    assert.equal(segunda.atualizado_em, new Date(resposta.salva_em).toISOString())
    assert.equal((await eventos()).length, eventosAntes.length + 1)
    await salvar(alternativas[1].alternativa_id)
    assert.equal(lerRespostaTentativa((await consultar())[0])?.versao, 3)
    await db.exec(migration)
    assert.equal(lerRespostaTentativa((await consultar())[0])?.versao, 3)
  })

  await t.test('preserva autorização, MFA e bloqueio de escrita direta', async () => {
    const antes = await respostas()
    for (const usuario of [professor, colega, admin]) {
      await assert.rejects(queryAs(usuario, 'SELECT public.consultar_respostas_tentativa($1)', [tentativa]), { code: '42501' })
    }
    await assert.rejects(queryAs(aluno, 'SELECT public.consultar_respostas_tentativa($1)', [tentativa], 'aal1'), { code: '42501' })
    await assert.rejects(queryAs(aluno, 'UPDATE public.respostas_tentativa SET versao=50'), { code: '42501' })
    await assert.rejects(queryAs(admin, 'DELETE FROM public.respostas_tentativa'), { code: '42501' })
    const privilegios = (await db.query<{ anonimo: boolean; rls: boolean }>(`SELECT
      has_function_privilege('anon','public.consultar_respostas_tentativa(uuid)','EXECUTE') AS anonimo,
      relrowsecurity AS rls FROM pg_class WHERE oid='public.respostas_tentativa'::regclass`)).rows[0]
    assert.deepEqual(privilegios, { anonimo: false, rls: true })
    assert.deepEqual(await respostas(), antes)
  })

  await t.test('falha de auditoria desfaz a resposta e o incremento da versão', async () => {
    const antes = await respostas(), logs = await eventos()
    await db.exec(`CREATE FUNCTION public.falhar_evento_033() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Falha de teste'; END $$;
      CREATE TRIGGER falhar_evento_033 BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_evento_033()`)
    try {
      await assert.rejects(salvar(), { code: 'P0001' })
      assert.deepEqual(await respostas(), antes)
      assert.deepEqual(await eventos(), logs)
    } finally {
      await db.exec('DROP TRIGGER falhar_evento_033 ON public.eventos_seguranca; DROP FUNCTION public.falhar_evento_033()')
    }
  })

  await t.test('novas respostas começam na versão 1 e o encerramento continua bloqueando a escrita', async () => {
    const prova = await criarProva()
    const nova = (await queryAs<{ tentativa: { id: string } }>(aluno,
      'SELECT public.iniciar_tentativa($1,$2) AS tentativa', [prova.avaliacaoId, '2026-11-06-v2'])).rows[0].tentativa.id
    const alternativa = (await db.query<{ alternativa_id: string }>(
      'SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 LIMIT 1', [nova])).rows[0].alternativa_id
    await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)', [nova, prova.questaoId, alternativa])
    const resposta = (await queryAs<{ respostas: unknown[] }>(aluno,
      'SELECT public.consultar_respostas_tentativa($1) AS respostas', [nova])).rows[0].respostas[0]
    const lida = lerRespostaTentativa(resposta)
    assert.ok(lida)
    assert.equal(lida.versao, 1)
    assert.equal(lida.criado_em, lida.atualizado_em)
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'ENVIO')", [tentativa])
    const antes = await respostas()
    await assert.rejects(salvar(), { code: '55000' })
    await assert.rejects(consultar(), { code: '55000' })
    await db.exec(migration)
    assert.deepEqual(await respostas(), antes)
  })
})

test('033 recusa banco sem a base exigida ou com a segunda tabela, sem alteração parcial', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await assert.rejects(db.exec(migration), /exige o modelo da entrega0911/)
  await db.exec('ROLLBACK')
  await prepararBancoExecucao(db)
  await db.exec('CREATE TABLE public.respostas (texto TEXT); INSERT INTO public.respostas VALUES (\'Preservar\')')
  await assert.rejects(db.exec(migration), /As duas tabelas de respostas existem/)
  await db.exec('ROLLBACK')
  assert.deepEqual((await db.query('SELECT * FROM public.respostas')).rows, [{ texto: 'Preservar' }])
  assert.equal((await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='respostas_tentativa' AND column_name='versao'`)).rows.length, 0)
})
