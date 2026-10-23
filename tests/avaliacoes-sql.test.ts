import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('avaliações em rascunho: regras, RLS e auditoria no PostgreSQL local', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS; CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, supabase_auth_admin;
    CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB DEFAULT '{}');
    CREATE TABLE auth.sessions (id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id));
    CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}')
    $$;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT NULLIF(auth.jwt() ->> 'sub', '')::UUID
    $$;
    CREATE TABLE public.organizacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nome TEXT NOT NULL,
      token_login TEXT UNIQUE NOT NULL, situacao TEXT NOT NULL DEFAULT 'ATIVO'
    );
  `)
  async function migrate(file: string) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  for (const file of ['001_perfis.sql', '002_eventos_seguranca.sql', '004_convites_organizacoes.sql',
    '006_auditoria_cadastro_login.sql', '011_turmas.sql', '012_matriculas.sql',
    '013_solicitar_matricula.sql', '014_aprovar_matricula.sql', '015_listar_matriculas_pendentes.sql',
    '016_listar_minhas_matriculas.sql', '017_listar_alunos_turma.sql', '018_inativar_matricula.sql',
    '019_avaliacoes_rascunho.sql']) await migrate(file)

  const org = randomUUID()
  const otherOrg = randomUUID()
  await db.query(`INSERT INTO public.organizacoes(id,nome,token_login)
    VALUES ($1,'Escola fictícia','123456789012345678901'), ($2,'Outra escola','123456789012345678902')`, [org, otherOrg])
  const professor = randomUUID()
  const colleague = randomUUID()
  const aluno = randomUUID()
  const admin = randomUUID()
  const sessions = new Map<string, string>()
  for (const [id, perfil] of [[professor, 'PROFESSOR'], [colleague, 'PROFESSOR'], [aluno, 'ALUNO'], [admin, 'ADMIN']]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, `${id}@example.test`])
    await db.query("UPDATE public.perfis SET perfil=$1,situacao='ATIVO',organizacao_id=$2 WHERE id=$3", [perfil, org, id])
    const sessionId = randomUUID()
    sessions.set(id, sessionId)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessionId, id])
  }
  async function queryAs<T = Record<string, unknown>>(id: string, sql: string, params: unknown[] = [], aal = 'aal2') {
    return db.transaction(async (tx) => {
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, aal, session_id: sessions.get(id) })])
      await tx.exec('SET LOCAL ROLE authenticated')
      return tx.query<T>(sql, params)
    })
  }
  const turmaId = (await queryAs<{ id: string }>(professor,
    "INSERT INTO public.turmas(nome) VALUES ('Engenharia 8B') RETURNING id")).rows[0].id
  const otherTurmaId = (await queryAs<{ id: string }>(colleague,
    "INSERT INTO public.turmas(nome) VALUES ('Outra turma') RETURNING id")).rows[0].id
  await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, aluno])
  const createSql = 'SELECT public.criar_avaliacao_rascunho($1,$2,$3,$4,$5,$6) AS avaliacao'
  const valid = [turmaId, '  Primeira prova  ', 'PROVA', '2026-11-09T19:00:00-03:00', '2026-11-09T21:00:00-03:00', 60]
  const listSql = 'SELECT * FROM public.avaliacoes ORDER BY id'
  let avaliacaoId = ''

  await t.test('cria Prova e Atividade para a turma inteira, com autor da sessão e auditoria', async () => {
    const result = await queryAs<{ avaliacao: Record<string, unknown> }>(professor, createSql, valid)
    const avaliacao = result.rows[0].avaliacao
    assert.equal(typeof avaliacao.id, 'string')
    avaliacaoId = String(avaliacao.id)
    assert.equal(avaliacao.turma_id, turmaId)
    assert.equal(avaliacao.professor_id, professor)
    assert.equal(avaliacao.titulo, 'Primeira prova')
    assert.equal(avaliacao.tipo, 'PROVA')
    assert.equal(avaliacao.situacao, 'RASCUNHO')
    assert.equal(avaliacao.duracao_minutos, 60)
    assert.equal(new Date(String(avaliacao.inicio_em)).toISOString(), '2026-11-09T22:00:00.000Z')
    assert.equal(new Date(String(avaliacao.fim_em)).toISOString(), '2026-11-10T00:00:00.000Z')
    assert.ok(avaliacao.criado_em)
    assert.equal('aluno_id' in avaliacao, false)
    const atividade = (await queryAs<{ avaliacao: Record<string, unknown> }>(professor, createSql,
      [turmaId, 'Atividade 1', 'ATIVIDADE', valid[3], valid[4], 30])).rows[0].avaliacao
    assert.equal(atividade.tipo, 'ATIVIDADE')
    assert.equal(atividade.situacao, 'RASCUNHO')
    assert.notEqual(atividade.id, avaliacaoId)
    const events = await db.query<Record<string, unknown>>("SELECT * FROM public.eventos_seguranca WHERE evento='AVALIACAO_CRIADA'")
    assert.equal(events.rows.length, 2)
    for (const event of events.rows) {
      assert.equal(event.usuario_id, professor)
      assert.equal(event.provedor, 'EXAMENTECH')
      assert.equal(event.acao, 'criar_avaliacao_rascunho')
      assert.equal(event.sucesso, true)
      assert.ok([avaliacaoId, atividade.id].includes(event.recurso_id))
      assert.ok(event.criado_em)
      assert.equal(JSON.stringify(event).includes('Primeira prova'), false)
    }
  })

  await t.test('responsável e ADMIN consultam; outro professor e aluno matriculado não leem rascunhos', async () => {
    assert.equal((await queryAs(professor, listSql)).rows.length, 2)
    for (const id of [colleague, aluno]) assert.deepEqual((await queryAs(id, listSql)).rows, [])
    await queryAs(colleague, createSql, [otherTurmaId, ...valid.slice(1)])
    assert.equal((await queryAs(professor, listSql)).rows.length, 2)
    assert.equal((await queryAs(colleague, listSql)).rows.length, 1)
    await db.query('UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', [admin])
    assert.equal((await queryAs(admin, listSql)).rows.length, 3)
    await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
    assert.equal((await queryAs(admin, listSql)).rows.length, 3)
    assert.deepEqual((await queryAs(professor, listSql)).rows, [])
    await assert.rejects(queryAs(professor, createSql, valid), { code: '42501' })
    await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
  })

  await t.test('recusa ADMIN, aluno, ausência de MFA e sessão inexistente ou de outro usuário', async () => {
    for (const schema of ['public', 'examentech_private']) {
      const sql = createSql.replace('public.', `${schema}.`)
      for (const id of [admin, aluno]) await assert.rejects(queryAs(id, sql, valid), { code: '42501' })
      for (const aal of ['aal1', '']) await assert.rejects(queryAs(professor, sql, valid, aal), { code: '42501' })
    }
    assert.deepEqual((await queryAs(professor, listSql, [], 'aal1')).rows, [])
    assert.deepEqual((await queryAs(admin, listSql, [], 'aal1')).rows, [])
    const sessionId = sessions.get(professor)!
    for (const invalidSession of [randomUUID(), sessions.get(colleague)!]) {
      sessions.set(professor, invalidSession)
      await assert.rejects(queryAs(professor, createSql, valid), { code: '42501' })
      assert.deepEqual((await queryAs(professor, listSql)).rows, [])
    }
    sessions.set(professor, sessionId)
  })

  await t.test('recusa perfil inativo, organização ausente/diferente e turma alheia ou inexistente', async () => {
    await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [professor])
    await assert.rejects(queryAs(professor, createSql, valid), { code: '42501' })
    assert.deepEqual((await queryAs(professor, listSql)).rows, [])
    await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [professor])
    for (const orgId of [null, otherOrg]) {
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [orgId, professor])
      await assert.rejects(queryAs(professor, createSql, valid), { code: orgId === null ? '42501' : 'P0002' })
      assert.deepEqual((await queryAs(professor, listSql)).rows, [])
    }
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, professor])
    for (const id of [otherTurmaId, randomUUID(), null]) {
      await assert.rejects(queryAs(professor, createSql, [id, ...valid.slice(1)]), { code: 'P0002' })
    }
  })

  await t.test('turma inativa mantém consulta, mas não recebe novo rascunho; troca de responsável não transfere autoria', async () => {
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    await assert.rejects(queryAs(professor, createSql, valid), { code: '55000' })
    assert.equal((await queryAs(professor, listSql)).rows.length, 2)
    await db.query("UPDATE public.turmas SET situacao='ATIVA',professor_id=$1 WHERE id=$2", [colleague, turmaId])
    await assert.rejects(queryAs(professor, createSql, valid), { code: 'P0002' })
    for (const id of [professor, colleague]) {
      assert.deepEqual((await queryAs(id, 'SELECT * FROM public.avaliacoes WHERE turma_id=$1', [turmaId])).rows, [])
    }
    assert.equal((await queryAs(admin, listSql)).rows.length, 3)
    await db.query('UPDATE public.turmas SET professor_id=$1 WHERE id=$2', [professor, turmaId])
  })

  await t.test('valida campos obrigatórios, título, tipo, datas finitas/ordenadas e minutos inteiros positivos', async () => {
    const invalidCases: [number, unknown, string][] = [
      [1, '', '23514'], [1, '  ', '23514'], [1, '\t\t\t', '23514'], [1, 'AB', '23514'], [1, 'A'.repeat(151), '23514'],
      [2, 'OUTRO', '23514'], [2, 'prova', '23514'], [3, valid[4], '23514'], [4, valid[3], '23514'],
      [3, 'infinity', '23514'], [3, '-infinity', '23514'], [4, 'infinity', '23514'],
      [3, 'não é data', '22007'], [5, 0, '23514'], [5, -1, '23514'], [5, '1.5', '22P02'],
    ]
    for (let index = 1; index < valid.length; index++) invalidCases.push([index, null, '23502'])
    const before = await db.query('SELECT * FROM public.avaliacoes ORDER BY id')
    const events = await db.query('SELECT id FROM public.eventos_seguranca ORDER BY id')
    for (const [index, value, code] of invalidCases) {
      const params: unknown[] = [...valid]
      params[index] = value
      await assert.rejects(queryAs(professor, createSql, params), { code })
    }
    assert.deepEqual((await db.query('SELECT * FROM public.avaliacoes ORDER BY id')).rows, before.rows)
    assert.deepEqual((await db.query('SELECT id FROM public.eventos_seguranca ORDER BY id')).rows, events.rows)
    for (const titulo of ['ABC', 'A'.repeat(150)]) {
      await queryAs(professor, createSql, [turmaId, titulo, 'PROVA', ...valid.slice(3, 5), 1])
    }
  })

  await t.test('bloqueia escrita direta, publicação, exclusão e autor forjado, inclusive para ADMIN', async () => {
    for (const id of [professor, colleague, aluno, admin]) {
      for (const sql of [
        "INSERT INTO public.avaliacoes(turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        "UPDATE public.avaliacoes SET situacao='PUBLICADA'", "UPDATE public.avaliacoes SET titulo='Outro título'",
        'DELETE FROM public.avaliacoes',
      ]) {
        await assert.rejects(queryAs(id, sql, sql.startsWith('INSERT') ? [turmaId, colleague, ...valid.slice(1)] : []), { code: '42501' })
      }
    }
    await assert.rejects(queryAs(professor,
      'SELECT public.criar_avaliacao_rascunho($1,$2,$3,$4,$5,$6,p_professor_id => $7)', [...valid, colleague]), { code: '42883' })
    // Mesmo o dono do banco não publica sem a migração da próxima etapa.
    await assert.rejects(db.query("UPDATE public.avaliacoes SET situacao='PUBLICADA' WHERE id=$1", [avaliacaoId]), { code: '23514' })
    await assert.rejects(db.query('DELETE FROM public.turmas WHERE id=$1', [otherTurmaId]), /avaliacoes_turma_id_fkey/)
    for (const sql of [listSql, createSql, createSql.replace('public.', 'examentech_private.')]) {
      await assert.rejects(db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE anon')
        return tx.query(sql, sql === listSql ? [] : valid)
      }), { code: '42501' })
    }
  })

  await t.test('mantém solicitação, aprovação e inativação com seus eventos anteriores', async () => {
    const codigo = (await db.query<{ codigo_ingresso: string }>(
      'SELECT codigo_ingresso FROM public.turmas WHERE id=$1', [otherTurmaId])).rows[0].codigo_ingresso
    const matricula = (await queryAs<{ matricula: { id: string } }>(aluno,
      'SELECT public.solicitar_matricula($1) AS matricula', [codigo])).rows[0].matricula
    await queryAs(colleague, 'SELECT public.aprovar_matricula($1)', [matricula.id])
    await queryAs(admin, 'SELECT public.inativar_matricula($1)', [matricula.id])
    assert.deepEqual((await db.query<{ evento: string }>(
      'SELECT evento FROM public.eventos_seguranca WHERE recurso_id=$1 ORDER BY evento', [matricula.id])).rows,
    ['MATRICULA_APROVADA', 'MATRICULA_INATIVADA', 'MATRICULA_SOLICITADA'].map((evento) => ({ evento })))
  })

  await t.test('falha na auditoria desfaz o rascunho; reaplicar 019 preserva registros e eventos', async () => {
    const before = (await db.query(listSql)).rows
    const events = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
    await db.exec(`
      CREATE FUNCTION public.falhar_auditoria_avaliacao() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.evento = 'AVALIACAO_CRIADA' THEN RAISE EXCEPTION 'Falha de auditoria simulada'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER falhar_auditoria_avaliacao BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_auditoria_avaliacao();
    `)
    await assert.rejects(queryAs(professor, createSql, valid), /Falha de auditoria simulada/)
    await db.exec('DROP TRIGGER falhar_auditoria_avaliacao ON public.eventos_seguranca; DROP FUNCTION public.falhar_auditoria_avaliacao();')
    await migrate('019_avaliacoes_rascunho.sql')
    assert.deepEqual((await db.query(listSql)).rows, before)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, events)
    assert.equal((await queryAs(professor, listSql)).rows.length, 4)
    assert.deepEqual((await queryAs(aluno, listSql)).rows, [])
  })
})
