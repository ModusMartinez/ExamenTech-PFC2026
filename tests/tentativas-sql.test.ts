import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'

type Tentativa = {
  id: string; avaliacao_id: string; aluno_id: string; situacao: string; iniciada_em: string; limite_em: string
}

test('025 preserva eventos de execução já existentes e continua recusando eventos desconhecidos', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await prepararBancoAvaliacoes(db)
  for (const file of ['023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  // Reproduz os três tipos de evento encontrados no Supabase antes de aplicar a 025.
  await db.exec('ALTER TABLE public.eventos_seguranca DROP CONSTRAINT eventos_seguranca_evento_valido')
  for (const evento of ['RESPOSTA_SALVA', 'TENTATIVA_FINALIZADA', 'TENTATIVA_RETOMADA']) {
    await db.query(`INSERT INTO public.eventos_seguranca (solicitacao_id,evento,provedor,acao,sucesso)
      VALUES (gen_random_uuid(),$1,'EXAMENTECH','registro_anterior',true)`, [evento])
  }
  const anteriores = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
  const migration = await readFile(new URL('../database/025_iniciar_tentativa.sql', import.meta.url), 'utf8')
  for (let aplicacao = 0; aplicacao < 2; aplicacao++) {
    await db.exec(migration)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, anteriores)
  }
  const constraint = await db.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint
    WHERE conrelid='public.eventos_seguranca'::regclass AND conname='eventos_seguranca_evento_valido'`)
  assert.equal(constraint.rows[0].convalidated, true)
  await assert.rejects(db.query(`INSERT INTO public.eventos_seguranca (solicitacao_id,evento,sucesso)
    VALUES (gen_random_uuid(),'EVENTO_DESCONHECIDO',true)`), { code: '23514', constraint: 'eventos_seguranca_evento_valido' })
})

test('tentativas: início único, prazo, permissões e auditoria no PostgreSQL local', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, colega, aluno, admin, sessions, queryAs, turmaId, avaliacaoId } = await prepararBancoAvaliacoes(db)
  for (const file of ['023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  const migration = await readFile(new URL('../database/025_iniciar_tentativa.sql', import.meta.url), 'utf8')
  const before = (await db.query('SELECT * FROM public.avaliacoes ORDER BY id')).rows
  await db.exec(migration)
  const iniciarSql = 'SELECT public.iniciar_tentativa($1) AS tentativa'
  async function iniciar(id: string, usuario = aluno, aal = 'aal2') {
    return (await queryAs<{ tentativa: Tentativa }>(usuario, iniciarSql, [id], aal)).rows[0].tentativa
  }
  async function publicar(turma = turmaId, autor = professor, tipo = 'PROVA') {
    const id = (await queryAs<{ avaliacao: { id: string } }>(autor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Avaliação para tentativa',$2,now()-interval '5 minutes',now()+interval '2 hours',60
    ) AS avaliacao`, [turma, tipo])).rows[0].avaliacao.id
    await queryAs(autor, "SELECT public.criar_questao_rascunho($1,'DISSERTATIVA','Questão de teste',2)", [id])
    await queryAs(autor, 'SELECT public.publicar_avaliacao($1)', [id])
    return id
  }
  const eventos = async () => (await db.query("SELECT * FROM public.eventos_seguranca WHERE evento='TENTATIVA_INICIADA' ORDER BY id")).rows

  await t.test('migração preserva avaliações existentes e não cria tentativas', async () => {
    assert.deepEqual((await db.query('SELECT * FROM public.avaliacoes ORDER BY id')).rows, before)
    assert.deepEqual((await db.query('SELECT * FROM public.tentativas')).rows, [])
  })

  const publicada = await publicar()
  let primeira: Tentativa
  await t.test('inicia prova/atividade com identidade e prazo do banco e registra o evento', async () => {
    for (const id of [publicada, await publicar(turmaId, professor, 'ATIVIDADE')]) {
      const tentativa = await iniciar(id)
      if (id === publicada) primeira = tentativa
      assert.deepEqual(Object.keys(tentativa).sort(), ['aluno_id', 'avaliacao_id', 'id', 'iniciada_em', 'limite_em', 'situacao'])
      assert.equal(tentativa.aluno_id, aluno)
      assert.equal(tentativa.avaliacao_id, id)
      assert.equal(tentativa.situacao, 'EM_ANDAMENTO')
      assert.equal(Date.parse(tentativa.limite_em) - Date.parse(tentativa.iniciada_em), 60 * 60 * 1000)
      assert.deepEqual((await db.query(`SELECT usuario_id,recurso_id,acao,sucesso FROM public.eventos_seguranca
        WHERE evento='TENTATIVA_INICIADA' AND recurso_id=$1`, [tentativa.id])).rows,
      [{ usuario_id: aluno, recurso_id: tentativa.id, acao: 'iniciar_tentativa', sucesso: true }])
    }
    for (const table of ['avaliacoes', 'questoes', 'alternativas']) {
      assert.deepEqual((await queryAs(aluno, `SELECT * FROM public.${table}`)).rows, [])
    }
  })

  await t.test('entrada tardia termina no fim da janela, sem conceder duração extra', async () => {
    const id = await publicar()
    await db.query("UPDATE public.avaliacoes SET inicio_em=now()-interval '2 hours',fim_em=now()+interval '10 minutes' WHERE id=$1", [id])
    const tentativa = await iniciar(id)
    const fim = (await db.query<{ fim_em: Date }>('SELECT fim_em FROM public.avaliacoes WHERE id=$1', [id])).rows[0].fim_em
    assert.equal(Date.parse(tentativa.limite_em), fim.getTime())
    assert.ok(Date.parse(tentativa.limite_em) - Date.parse(tentativa.iniciada_em) <= 10 * 60 * 1000)
  })

  await t.test('repetição recusa reinício sem alterar a tentativa ou duplicar a auditoria', async () => {
    const audit = await eventos()
    const original = (await db.query('SELECT * FROM public.tentativas WHERE avaliacao_id=$1', [publicada])).rows
    await assert.rejects(iniciar(publicada), { code: '55000', message: /Não é permitido reiniciar/ })
    assert.deepEqual((await db.query('SELECT * FROM public.tentativas WHERE avaliacao_id=$1', [publicada])).rows, original)
    assert.deepEqual(await eventos(), audit)
    // A constraint também impede duplicação fora da função, independentemente da RLS.
    await assert.rejects(db.query(`INSERT INTO public.tentativas(avaliacao_id,aluno_id,iniciada_em,limite_em)
      VALUES ($1,$2,now(),now()+interval '1 hour')`, [publicada, aluno]), { code: '23505' })
  })

  await t.test('chamadas repetidas enfileiradas produzem uma única tentativa', async () => {
    const id = await publicar()
    // PGlite serializa transações; este teste não simula conexões simultâneas do Supabase.
    const results = await Promise.allSettled([iniciar(id), iniciar(id), iniciar(id)])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, '55000')
    const rows = (await db.query<{ id: string }>('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [id])).rows
    assert.equal(rows.length, 1)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='TENTATIVA_INICIADA' AND recurso_id=$1", [rows[0].id])).rows.length, 1)
  })

  await t.test('recusa rascunho, turma inativa, avaliação futura e janela encerrada', async () => {
    const id = await publicar()
    await assert.rejects(iniciar(avaliacaoId), { code: '55000' })
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    await assert.rejects(iniciar(id), { code: '55000' })
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [turmaId])
    await db.query("UPDATE public.avaliacoes SET inicio_em=now()+interval '1 hour',fim_em=now()+interval '2 hours' WHERE id=$1", [id])
    await assert.rejects(iniciar(id), { code: '55000' })
    await db.query("UPDATE public.avaliacoes SET inicio_em=now()-interval '2 hours',fim_em=now() WHERE id=$1", [id])
    await assert.rejects(iniciar(id), { code: '55000' })
    assert.deepEqual((await db.query('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [id])).rows, [])
  })

  await t.test('confere horário atual mesmo quando a transação começou dentro da janela', async () => {
    const id = await publicar()
    await assert.rejects(db.transaction(async (tx) => {
      await tx.query("UPDATE public.avaliacoes SET fim_em=now()+interval '20 milliseconds' WHERE id=$1", [id])
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: aluno, aal: 'aal2', session_id: sessions.get(aluno) })])
      await tx.exec('SET LOCAL ROLE authenticated')
      await tx.query('SELECT pg_sleep(0.05)')
      await tx.query(iniciarSql, [id])
    }), { code: '55000', message: /fora do horário/ })
    assert.deepEqual((await db.query('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [id])).rows, [])
  })

  await t.test('exige matrícula ativa e isola avaliações de outra organização ou turma', async () => {
    const id = await publicar()
    for (const situacao of ['PENDENTE', 'INATIVA']) {
      await db.query('UPDATE public.turma_alunos SET situacao=$1 WHERE turma_id=$2 AND aluno_id=$3', [situacao, turmaId, aluno])
      await assert.rejects(iniciar(id), { code: 'P0002' })
    }
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    const outraTurma = (await queryAs<{ id: string }>(colega, "INSERT INTO public.turmas(nome) VALUES ('Outra turma') RETURNING id")).rows[0].id
    await assert.rejects(iniciar(await publicar(outraTurma, colega)), { code: 'P0002' })
    const outraOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Outra escola','outra-organizacao')", [outraOrg])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [outraOrg, aluno])
    await assert.rejects(iniciar(id), { code: 'P0002' })
    assert.deepEqual((await queryAs(aluno, 'SELECT * FROM public.tentativas')).rows, [])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, aluno])
    for (const invalidId of [randomUUID(), null]) {
      await assert.rejects(queryAs(aluno, iniciarSql, [invalidId]), { code: 'P0002' })
    }
  })

  await t.test('perfil, organização, MFA e sessão são obrigatórios inclusive na chamada direta', async () => {
    for (const usuario of [professor, admin, randomUUID()]) await assert.rejects(iniciar(publicada, usuario), { code: '42501' })
    await assert.rejects(iniciar(publicada, aluno, 'aal1'), { code: '42501' })
    assert.deepEqual((await queryAs(aluno, 'SELECT * FROM public.tentativas', [], 'aal1')).rows, [])
    for (const table of ['perfis', 'organizacoes']) {
      const id = table === 'perfis' ? aluno : org
      await db.query(`UPDATE public.${table} SET situacao='INATIVO' WHERE id=$1`, [id])
      await assert.rejects(iniciar(publicada), { code: '42501' })
      assert.deepEqual((await queryAs(aluno, 'SELECT * FROM public.tentativas')).rows, [])
      await db.query(`UPDATE public.${table} SET situacao='ATIVO' WHERE id=$1`, [id])
    }
    const ownSession = sessions.get(aluno)!
    for (const session of [randomUUID(), sessions.get(professor)!]) {
      sessions.set(aluno, session)
      await assert.rejects(iniciar(publicada), { code: '42501' })
      assert.deepEqual((await queryAs(aluno, 'SELECT * FROM public.tentativas')).rows, [])
    }
    sessions.delete(aluno)
    await assert.rejects(iniciar(publicada), { code: '42501' })
    sessions.set(aluno, ownSession)
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [ownSession])
    await assert.rejects(iniciar(publicada), { code: '42501' })
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [ownSession, aluno])
    await assert.rejects(queryAs(professor, 'SELECT examentech_private.iniciar_tentativa($1)', [publicada]), { code: '42501' })
    for (const schema of ['public', 'examentech_private']) {
      await assert.rejects(db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE anon')
        await tx.query(`SELECT ${schema}.iniciar_tentativa($1)`, [publicada])
      }), { code: '42501' })
    }
  })

  await t.test('consulta só permite próprio aluno, professor autor responsável e ADMIN; histórico permanece', async () => {
    const outroAluno = randomUUID()
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [outroAluno, 'outro@example.test'])
    await db.query("UPDATE public.perfis SET situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [org, outroAluno])
    sessions.set(outroAluno, randomUUID())
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessions.get(outroAluno), outroAluno])
    await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, outroAluno])
    assert.deepEqual((await queryAs(outroAluno, 'SELECT * FROM public.tentativas')).rows, [])
    const outra = await iniciar(publicada, outroAluno)
    assert.deepEqual((await queryAs(outroAluno, 'SELECT id FROM public.tentativas')).rows, [{ id: outra.id }])
    const own = (await queryAs<{ aluno_id: string }>(aluno, 'SELECT aluno_id FROM public.tentativas')).rows
    assert.ok(own.length > 0 && own.every((row) => row.aluno_id === aluno))
    for (const usuario of [professor, admin]) {
      assert.equal((await queryAs(usuario, 'SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [publicada])).rows.length, 2)
    }
    assert.deepEqual((await queryAs(colega, 'SELECT * FROM public.tentativas')).rows, [])
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    assert.equal((await queryAs(aluno, 'SELECT id FROM public.tentativas WHERE id=$1', [primeira.id])).rows.length, 1)
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    await assert.rejects(iniciar(publicada), { code: '55000' })
    await db.query('UPDATE public.turmas SET professor_id=$1 WHERE id=$2', [colega, turmaId])
    for (const usuario of [professor, colega]) assert.deepEqual((await queryAs(usuario, 'SELECT * FROM public.tentativas')).rows, [])
    await db.query('UPDATE public.turmas SET professor_id=$1 WHERE id=$2', [professor, turmaId])
  })

  await t.test('escrita direta e exclusão são bloqueadas; constraints protegem prazo e referências', async () => {
    for (const usuario of [aluno, professor, admin]) {
      for (const sql of [
        "INSERT INTO public.tentativas(avaliacao_id,aluno_id,iniciada_em,limite_em) VALUES ($1,$2,now(),now()+interval '1 hour')",
        'UPDATE public.tentativas SET aluno_id=$2 WHERE avaliacao_id=$1',
        'DELETE FROM public.tentativas WHERE avaliacao_id=$1 AND aluno_id=$2',
      ]) await assert.rejects(queryAs(usuario, sql, [publicada, aluno]), { code: '42501' })
    }
    for (const prazo of ["'infinity'::timestamptz", "'-infinity'::timestamptz", 'now()', "now()-interval '1 minute'"]) {
      await assert.rejects(db.query(`INSERT INTO public.tentativas(avaliacao_id,aluno_id,iniciada_em,limite_em)
        VALUES ($1,$2,now(),${prazo})`, [avaliacaoId, aluno]), { code: '23514' })
    }
    await assert.rejects(db.query("INSERT INTO public.tentativas(avaliacao_id,aluno_id,iniciada_em,limite_em) VALUES ($1,$2,now(),now()+interval '1 hour')", [randomUUID(), aluno]), { code: '23503' })
    await assert.rejects(db.transaction(async (tx) => {
      await tx.query('DELETE FROM public.questoes WHERE avaliacao_id=$1', [publicada])
      await tx.query('DELETE FROM public.avaliacoes WHERE id=$1', [publicada])
    }), { code: '23001', constraint: 'tentativas_avaliacao_id_fkey' })
  })

  await t.test('falha na auditoria desfaz o início e permite tentar novamente', async () => {
    const id = await publicar()
    await db.exec(`CREATE FUNCTION public.falhar_evento_tentativa() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.evento='TENTATIVA_INICIADA' THEN RAISE EXCEPTION 'Falha simulada'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER falhar_evento_tentativa BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_evento_tentativa();`)
    const audit = await eventos()
    await assert.rejects(iniciar(id), /Falha simulada/)
    assert.deepEqual((await db.query('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [id])).rows, [])
    assert.deepEqual(await eventos(), audit)
    await db.exec('DROP TRIGGER falhar_evento_tentativa ON public.eventos_seguranca; DROP FUNCTION public.falhar_evento_tentativa();')
    assert.equal((await iniciar(id)).avaliacao_id, id)
  })

  await t.test('reaplicar a query preserva tentativas e eventos', async () => {
    const rows = (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows
    const audit = await eventos()
    await db.exec(migration)
    assert.deepEqual((await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows, rows)
    assert.deepEqual(await eventos(), audit)
  })
})
