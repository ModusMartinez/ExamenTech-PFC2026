import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'

test('ordem da tentativa: sorteio persistido, permissões e gravação atômica', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, aluno, admin, sessions, queryAs, turmaId } = await prepararBancoAvaliacoes(db)
  for (const file of ['023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql', '025_iniciar_tentativa.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  async function publicar(tipos = ['OBJETIVA', 'DISSERTATIVA', 'OBJETIVA', 'DISSERTATIVA', 'OBJETIVA', 'OBJETIVA', 'OBJETIVA', 'OBJETIVA']) {
    const id = (await queryAs<{ avaliacao: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Prova com sorteio','PROVA',now()-interval '5 minutes',now()+interval '2 hours',60
    ) AS avaliacao`, [turmaId])).rows[0].avaliacao.id
    for (const [index, tipo] of tipos.entries()) {
      const questao = (await queryAs<{ questao: { id: string } }>(professor,
        'SELECT public.criar_questao_rascunho($1,$2,$3,1) AS questao', [id, tipo, `Questão fictícia ${index + 1}`])).rows[0].questao.id
      if (tipo === 'OBJETIVA') {
        const textos = Array.from({ length: index === 0 ? 2 : 5 }, (_, i) => `Alternativa fictícia ${i + 1}`)
        await queryAs(professor, 'SELECT public.criar_alternativas_rascunho($1,$2,1)', [questao, textos])
      }
    }
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [id])
    return id
  }
  async function iniciar(id: string, usuario = aluno, aal = 'aal2') {
    return (await queryAs<{ tentativa: { id: string } }>(usuario,
      'SELECT public.iniciar_tentativa($1) AS tentativa', [id], aal)).rows[0].tentativa
  }
  async function ordens(id: string) {
    const questoes = (await db.query<{ questao_id: string; ordem: number }>(
      'SELECT questao_id,ordem FROM public.tentativa_questoes WHERE tentativa_id=$1 ORDER BY ordem', [id])).rows
    const alternativas = (await db.query<{ questao_id: string; alternativa_id: string; ordem: number }>(
      'SELECT questao_id,alternativa_id,ordem FROM public.tentativa_alternativas WHERE tentativa_id=$1 ORDER BY questao_id,ordem', [id])).rows
    return { questoes, alternativas }
  }
  async function registros() {
    return {
      tentativas: (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows,
      questoes: (await db.query('SELECT * FROM public.tentativa_questoes ORDER BY tentativa_id,ordem')).rows,
      alternativas: (await db.query('SELECT * FROM public.tentativa_alternativas ORDER BY tentativa_id,questao_id,ordem')).rows,
      eventos: (await db.query("SELECT * FROM public.eventos_seguranca WHERE evento='TENTATIVA_INICIADA' ORDER BY id")).rows,
    }
  }

  const antigaAvaliacao = await publicar(['DISSERTATIVA'])
  const antiga = await iniciar(antigaAvaliacao)
  const migration = await readFile(new URL('../database/026_ordem_tentativa.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await t.test('preserva a tentativa anterior sem inventar uma ordem ou permitir reinício', async () => {
    assert.deepEqual((await db.query<{ tentativa: unknown }>('SELECT to_jsonb(t) AS tentativa FROM public.tentativas t WHERE id=$1', [antiga.id])).rows[0].tentativa, antiga)
    assert.deepEqual(await ordens(antiga.id), { questoes: [], alternativas: [] })
    const antes = await registros()
    await assert.rejects(iniciar(antigaAvaliacao), { code: '55000' })
    assert.deepEqual(await registros(), antes)
  })

  const publicada = await publicar()
  const questoesOriginais = (await db.query<{ id: string; tipo: string; ordem: number }>(
    'SELECT * FROM public.questoes WHERE avaliacao_id=$1 ORDER BY ordem', [publicada])).rows
  const alternativasOriginais = (await db.query<{ id: string; questao_id: string; ordem: number }>(
    'SELECT a.* FROM public.alternativas a JOIN public.questoes q ON q.id=a.questao_id WHERE q.avaliacao_id=$1 ORDER BY a.id', [publicada])).rows
  // Sementes controladas apenas no teste; produção usa o estado aleatório do PostgreSQL.
  await db.exec('SELECT setseed(0.12)')
  const primeira = await iniciar(publicada)
  const primeiraOrdem = await ordens(primeira.id)
  await t.test('grava todas as questões e suas alternativas, sem lacunas ou duplicações', async () => {
    assert.deepEqual(primeiraOrdem.questoes.map(q => q.questao_id).sort(), questoesOriginais.map(q => q.id).sort())
    assert.deepEqual(primeiraOrdem.questoes.map(q => q.ordem), questoesOriginais.map((_, i) => i + 1))
    assert.equal(primeiraOrdem.alternativas.length, alternativasOriginais.length)
    for (const questao of questoesOriginais) {
      const salvas = primeiraOrdem.alternativas.filter(a => a.questao_id === questao.id)
      const originais = alternativasOriginais.filter(a => a.questao_id === questao.id)
      assert.deepEqual(salvas.map(a => a.alternativa_id).sort(), originais.map(a => a.id).sort())
      assert.deepEqual(salvas.map(a => a.ordem), originais.map((_, i) => i + 1))
      if (questao.tipo === 'DISSERTATIVA') assert.equal(salvas.length, 0)
    }
    assert.deepEqual((await db.query('SELECT * FROM public.questoes WHERE avaliacao_id=$1 ORDER BY ordem', [publicada])).rows, questoesOriginais)
    assert.deepEqual((await db.query('SELECT a.* FROM public.alternativas a JOIN public.questoes q ON q.id=a.questao_id WHERE q.avaliacao_id=$1 ORDER BY a.id', [publicada])).rows, alternativasOriginais)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='TENTATIVA_INICIADA' AND recurso_id=$1", [primeira.id])).rows.length, 1)
  })

  await t.test('cada aluno recebe seu sorteio e consultas não refazem a ordem', async () => {
    const outroAluno = randomUUID(), session = randomUUID()
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [outroAluno, 'outro-aluno@example.test'])
    await db.query("UPDATE public.perfis SET perfil='ALUNO',situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [org, outroAluno])
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [session, outroAluno])
    sessions.set(outroAluno, session)
    await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, outroAluno])
    await db.exec('SELECT setseed(0.87)')
    const segunda = await iniciar(publicada, outroAluno)
    const segundaOrdem = await ordens(segunda.id)
    assert.notEqual(segunda.id, primeira.id)
    assert.deepEqual(segundaOrdem.questoes.map(q => q.questao_id).sort(), primeiraOrdem.questoes.map(q => q.questao_id).sort())
    assert.deepEqual(segundaOrdem.alternativas.map(a => a.alternativa_id).sort(), primeiraOrdem.alternativas.map(a => a.alternativa_id).sort())
    // Essas sementes exercitam permutações diferentes; não há exigência de sorteios sempre únicos.
    assert.notDeepEqual(segundaOrdem.questoes, primeiraOrdem.questoes)
    assert.notDeepEqual(segundaOrdem.alternativas, primeiraOrdem.alternativas)
    assert.deepEqual(await ordens(primeira.id), primeiraOrdem)
    assert.deepEqual(await ordens(segunda.id), segundaOrdem)
  })

  await t.test('repetição e reaplicação da query preservam ordens, prazos e eventos', async () => {
    const antes = await registros()
    await assert.rejects(iniciar(publicada), { code: '55000' })
    assert.deepEqual(await registros(), antes)
    await db.exec(migration)
    assert.deepEqual(await registros(), antes)
  })

  await t.test('bloqueia leitura e escrita direta das ordens e mantém o gabarito protegido', async () => {
    for (const tabela of ['tentativa_questoes', 'tentativa_alternativas']) {
      for (const sql of [`SELECT * FROM public.${tabela}`, `DELETE FROM public.${tabela}`,
        `UPDATE public.${tabela} SET ordem=1`, `INSERT INTO public.${tabela} DEFAULT VALUES`]) {
        for (const usuario of [aluno, professor, admin]) await assert.rejects(queryAs(usuario, sql), { code: '42501' })
        await assert.rejects(db.transaction(async tx => {
          await tx.exec('SET LOCAL ROLE anon')
          await tx.query(sql)
        }), { code: '42501' })
      }
      const rls = await db.query<{ relrowsecurity: boolean }>('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [`public.${tabela}`])
      assert.equal(rls.rows[0].relrowsecurity, true)
    }
    await assert.rejects(queryAs(aluno, 'SELECT examentech_private.sortear_ordem_tentativa()'), { code: '42501' })
    for (const tabela of ['questoes', 'alternativas']) assert.deepEqual((await queryAs(aluno, `SELECT * FROM public.${tabela}`)).rows, [])
  })

  await t.test('constraints impedem posições repetidas, inválidas e exclusão do histórico', async () => {
    const [q1, q2] = primeiraOrdem.questoes
    await assert.rejects(db.query('UPDATE public.tentativa_questoes SET ordem=$1 WHERE tentativa_id=$2 AND questao_id=$3',
      [q1.ordem, primeira.id, q2.questao_id]), { code: '23505' })
    await assert.rejects(db.query('UPDATE public.tentativa_questoes SET ordem=0 WHERE tentativa_id=$1', [primeira.id]), { code: '23514' })
    const [a1, a2] = primeiraOrdem.alternativas.filter(a => a.questao_id === primeiraOrdem.alternativas[0].questao_id)
    await assert.rejects(db.query('UPDATE public.tentativa_alternativas SET ordem=$1 WHERE tentativa_id=$2 AND alternativa_id=$3',
      [a1.ordem, primeira.id, a2.alternativa_id]), { code: '23505' })
    await assert.rejects(db.query('UPDATE public.tentativa_alternativas SET ordem=6 WHERE tentativa_id=$1', [primeira.id]), { code: '23514' })
    await assert.rejects(db.query('UPDATE public.tentativa_alternativas SET questao_id=$1 WHERE tentativa_id=$2 AND alternativa_id=$3',
      [randomUUID(), primeira.id, a1.alternativa_id]), { code: '23503' })
    await assert.rejects(db.query('DELETE FROM public.tentativas WHERE id=$1', [primeira.id]), { code: '23001' })
    assert.deepEqual(await ordens(primeira.id), primeiraOrdem)
  })

  await t.test('falha no sorteio ou na auditoria desfaz tentativa e todas as ordens', async () => {
    await db.exec(`CREATE FUNCTION public.falhar_gravacao_teste() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Falha simulada de gravação'; END; $$`)
    for (const tabela of ['tentativa_alternativas', 'eventos_seguranca']) {
      const avaliacao = await publicar(['OBJETIVA', 'DISSERTATIVA'])
      const antes = await registros()
      await db.exec(`CREATE TRIGGER falha_teste BEFORE INSERT ON public.${tabela}
        FOR EACH ROW EXECUTE FUNCTION public.falhar_gravacao_teste()`)
      try {
        await assert.rejects(iniciar(avaliacao), { code: 'P0001', message: /Falha simulada/ })
        assert.deepEqual(await registros(), antes)
      } finally {
        await db.exec(`DROP TRIGGER falha_teste ON public.${tabela}`)
      }
      const tentativa = await iniciar(avaliacao)
      const salvas = await ordens(tentativa.id)
      assert.equal(salvas.questoes.length, 2)
      assert.equal(salvas.alternativas.length, 2)
    }
    await db.exec('DROP FUNCTION public.falhar_gravacao_teste()')
  })

  await t.test('recusa tentativa sem questões mesmo se dados forem removidos fora da aplicação', async () => {
    const avaliacao = await publicar(['DISSERTATIVA'])
    await db.query('DELETE FROM public.questoes WHERE avaliacao_id=$1', [avaliacao])
    const antes = await registros()
    await assert.rejects(iniciar(avaliacao), { code: '23514', message: /não possui questões/ })
    assert.deepEqual(await registros(), antes)
  })

  await t.test('início sem MFA ou matrícula ativa não grava tentativa ou ordens', async () => {
    const avaliacao = await publicar(['DISSERTATIVA'])
    const antes = await registros()
    await assert.rejects(iniciar(avaliacao, aluno, 'aal1'), { code: '42501' })
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    await assert.rejects(iniciar(avaliacao), { code: 'P0002' })
    assert.deepEqual(await registros(), antes)
  })
})
