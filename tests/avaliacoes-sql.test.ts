import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createAvaliacoesHandler } from '../api/avaliacoes.ts'
import { lerDadosAvaliacao } from '../src/services/avaliacaoValidation.ts'

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

  await t.test('020: edição controlada de avaliações em rascunho', async (t) => {
    const beforeMigration = (await db.query(listSql)).rows
    const oldEvents = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
    await migrate('020_editar_avaliacao_rascunho.sql')
    assert.deepEqual((await db.query(listSql)).rows, beforeMigration)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, oldEvents)
    const original = (await queryAs<{ avaliacao: Record<string, unknown> }>(professor, createSql, valid)).rows[0].avaliacao
    const editSql = 'SELECT public.editar_avaliacao_rascunho($1,$2,$3,$4,$5,$6) AS avaliacao'
    const edited = [original.id, '  Atividade revisada  ', 'ATIVIDADE', '2026-11-10T18:00:00-03:00', '2026-11-10T20:00:00-03:00', 45]
    const readEdited = async () => (await db.query<Record<string, unknown>>('SELECT * FROM public.avaliacoes WHERE id=$1', [original.id])).rows
    const readEvents = async () => (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows

    await t.test('altera somente os cinco campos permitidos e registra autor, recurso e horário', async () => {
      const otherRows = (await db.query('SELECT * FROM public.avaliacoes WHERE id<>$1 ORDER BY id', [original.id])).rows
      const result = (await queryAs<{ avaliacao: Record<string, unknown> }>(professor, editSql, edited)).rows[0].avaliacao
      assert.equal(result.titulo, 'Atividade revisada')
      assert.equal(result.tipo, 'ATIVIDADE')
      assert.equal(result.duracao_minutos, 45)
      assert.equal(new Date(String(result.inicio_em)).toISOString(), '2026-11-10T21:00:00.000Z')
      assert.equal(new Date(String(result.fim_em)).toISOString(), '2026-11-10T23:00:00.000Z')
      for (const field of ['id', 'turma_id', 'professor_id', 'situacao', 'criado_em']) assert.equal(result[field], original[field])
      assert.deepEqual((await db.query('SELECT * FROM public.avaliacoes WHERE id<>$1 ORDER BY id', [original.id])).rows, otherRows)
      const events = (await db.query<Record<string, unknown>>("SELECT * FROM public.eventos_seguranca WHERE evento='AVALIACAO_EDITADA'")).rows
      assert.equal(events.length, 1)
      assert.equal(events[0].usuario_id, professor)
      assert.equal(events[0].recurso_id, original.id)
      assert.equal(events[0].acao, 'editar_avaliacao_rascunho')
      assert.equal(events[0].provedor, 'EXAMENTECH')
      assert.equal(events[0].sucesso, true)
      assert.ok(events[0].criado_em)
      assert.equal(JSON.stringify(events[0]).includes('Atividade revisada'), false)
      assert.equal((await queryAs(admin, 'SELECT titulo FROM public.avaliacoes WHERE id=$1', [original.id])).rows[0].titulo, result.titulo)
      const before = await readEdited()
      const beforeEvents = await readEvents()
      await queryAs(professor, editSql, edited)
      assert.deepEqual(await readEdited(), before)
      assert.deepEqual(await readEvents(), beforeEvents)
    })

    await t.test('nega ADMIN, aluno, outro professor, falta de MFA e sessão ausente/inexistente/alheia', async () => {
      const before = await readEdited()
      const events = await readEvents()
      for (const schema of ['public', 'examentech_private']) {
        const sql = editSql.replace('public.', `${schema}.`)
        for (const id of [admin, aluno]) await assert.rejects(queryAs(id, sql, edited), { code: '42501' })
        await assert.rejects(queryAs(colleague, sql, edited), { code: 'P0002' })
        for (const aal of ['aal1', '']) await assert.rejects(queryAs(professor, sql, edited, aal), { code: '42501' })
        await assert.rejects(db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE anon')
          return tx.query(sql, edited)
        }), { code: '42501' })
      }
      const sessionId = sessions.get(professor)!
      sessions.delete(professor)
      await assert.rejects(queryAs(professor, editSql, edited), { code: '42501' })
      for (const invalidSession of [randomUUID(), sessions.get(colleague)!]) {
        sessions.set(professor, invalidSession)
        await assert.rejects(queryAs(professor, editSql, edited), { code: '42501' })
      }
      sessions.set(professor, sessionId)
      assert.deepEqual(await readEdited(), before)
      assert.deepEqual(await readEvents(), events)
    })

    await t.test('exige perfil/organização/turma ativos e mantém autoria após troca de responsável', async () => {
      const before = await readEdited()
      const events = await readEvents()
      await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [professor])
      await assert.rejects(queryAs(professor, editSql, edited), { code: '42501' })
      await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [professor])
      await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
      await assert.rejects(queryAs(professor, editSql, edited), { code: '42501' })
      await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
      for (const orgId of [null, otherOrg]) {
        await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [orgId, professor])
        await assert.rejects(queryAs(professor, editSql, edited), { code: orgId === null ? '42501' : 'P0002' })
      }
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, professor])
      await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
      await assert.rejects(queryAs(professor, editSql, edited), { code: '55000' })
      assert.equal((await queryAs(professor, 'SELECT id FROM public.avaliacoes WHERE id=$1', [original.id])).rows.length, 1)
      await db.query("UPDATE public.turmas SET situacao='ATIVA',professor_id=$1 WHERE id=$2", [colleague, turmaId])
      for (const id of [professor, colleague]) await assert.rejects(queryAs(id, editSql, edited), { code: 'P0002' })
      await db.query('UPDATE public.turmas SET professor_id=$1 WHERE id=$2', [professor, turmaId])
      for (const id of [randomUUID(), null]) {
        await assert.rejects(queryAs(professor, editSql, [id, ...edited.slice(1)]), { code: 'P0002' })
      }
      assert.deepEqual(await readEdited(), before)
      assert.deepEqual(await readEvents(), events)
    })

    await t.test('constraints recusam campos inválidos sem alteração parcial ou evento', async () => {
      const before = await readEdited()
      const events = await readEvents()
      const invalidCases: [number, unknown, string][] = [
        [1, '', '23514'], [1, '\t\t\t', '23514'], [1, 'AB', '23514'], [1, 'A'.repeat(151), '23514'],
        [2, 'OUTRO', '23514'], [3, edited[4], '23514'], [4, edited[3], '23514'],
        [3, 'infinity', '23514'], [4, 'infinity', '23514'], [3, '2026-02-30', '22008'],
        [5, 0, '23514'], [5, -1, '23514'], [5, '1.5', '22P02'], [5, '2147483648', '22003'],
      ]
      for (let index = 1; index < edited.length; index++) invalidCases.push([index, null, '23502'])
      for (const [index, value, code] of invalidCases) {
        const params: unknown[] = [...edited]
        params[index] = value
        await assert.rejects(queryAs(professor, editSql, params), { code })
      }
      assert.deepEqual(await readEdited(), before)
      assert.deepEqual(await readEvents(), events)
    })

    await t.test('recusa situação diferente de RASCUNHO mesmo quando os campos não mudam', async () => {
      // Só no banco local: simula estados futuros e o rollback restaura a constraint da 019.
      for (const situacao of ['PUBLICADA', 'CANCELADA']) {
        await assert.rejects(db.transaction(async (tx) => {
          await tx.exec('ALTER TABLE public.avaliacoes DROP CONSTRAINT avaliacoes_situacao_check')
          await tx.query('UPDATE public.avaliacoes SET situacao=$1 WHERE id=$2', [situacao, original.id])
          await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: professor, aal: 'aal2', session_id: sessions.get(professor) })])
          await tx.exec('SET LOCAL ROLE authenticated')
          return tx.query(editSql, edited)
        }), { code: '55000' })
      }
      assert.equal((await readEdited())[0].situacao, 'RASCUNHO')
      await assert.rejects(db.query("UPDATE public.avaliacoes SET situacao='PUBLICADA' WHERE id=$1", [original.id]), { code: '23514' })
    })

    await t.test('falha de auditoria desfaz a edição; reaplicar 020 preserva dados e permissões', async () => {
      const before = await readEdited()
      const events = await readEvents()
      await db.exec(`
        CREATE FUNCTION public.falhar_edicao_avaliacao() RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.evento = 'AVALIACAO_EDITADA' THEN RAISE EXCEPTION 'Falha de edição simulada'; END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER falhar_edicao_avaliacao BEFORE INSERT ON public.eventos_seguranca
        FOR EACH ROW EXECUTE FUNCTION public.falhar_edicao_avaliacao();
      `)
      await assert.rejects(queryAs(professor, editSql, [original.id, 'Título alterado', ...edited.slice(2)]), /Falha de edição simulada/)
      await db.exec('DROP TRIGGER falhar_edicao_avaliacao ON public.eventos_seguranca; DROP FUNCTION public.falhar_edicao_avaliacao();')
      await migrate('020_editar_avaliacao_rascunho.sql')
      assert.deepEqual(await readEdited(), before)
      assert.deepEqual(await readEvents(), events)
      for (const id of [professor, colleague, aluno, admin]) {
        for (const sql of ["UPDATE public.avaliacoes SET titulo='Alteração direta'", 'DELETE FROM public.avaliacoes']) {
          await assert.rejects(queryAs(id, sql), { code: '42501' })
        }
      }
      for (const field of ['p_turma_id', 'p_professor_id', 'p_situacao', 'p_criado_em']) {
        await assert.rejects(queryAs(professor,
          `SELECT public.editar_avaliacao_rascunho($1,$2,$3,$4,$5,$6,${field} => $7)`, [...edited, randomUUID()]), { code: '42883' })
      }
      assert.deepEqual((await queryAs(aluno, listSql)).rows, [])
      assert.equal((await queryAs(admin, 'SELECT * FROM public.avaliacoes WHERE id=$1', [original.id])).rows.length, 1)
      await queryAs(professor, editSql, [original.id, 'Prova revisada', 'PROVA', ...edited.slice(3)])
      assert.equal((await readEdited())[0].tipo, 'PROVA')
    })
  })

  // O transporte simula Auth/PostgREST; funções, RLS e persistência são reais no PGlite.
  const env = { SUPABASE_URL: 'https://exemplo.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
  const body = {
    turma_id: turmaId, titulo: '  Rascunho pela API  ', tipo: 'PROVA',
    inicio_em: String(valid[3]), fim_em: String(valid[4]), duracao_minutos: 60,
  }
  const editBody = {
    avaliacao_id: avaliacaoId.toUpperCase(), titulo: '  Atividade editada pela API  ', tipo: 'ATIVIDADE',
    inicio_em: '2026-11-10T19:00:00-03:00', fim_em: '2026-11-10T21:00:00-03:00', duracao_minutos: 45,
  }
  function request(method = 'GET', payload: unknown = method === 'PATCH' ? editBody : body, query = `?turma_id=${turmaId}`) {
    const writing = method === 'POST' || method === 'PATCH'
    return new Request(`http://localhost/api/avaliacoes${writing ? '' : query}`, {
      method, headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
      body: writing ? JSON.stringify(payload) : undefined,
    })
  }
  function apiFor(id: string, aal = 'aal2') {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      assert.equal(req.headers.get('apikey'), 'public-test-key')
      assert.equal(req.headers.get('authorization'), 'Bearer test-session')
      if (url.pathname === '/auth/v1/user') {
        return Response.json({ id, email: `${id}@example.test`, app_metadata: {}, user_metadata: {} })
      }
      try {
        if (url.pathname === '/rest/v1/perfis') {
          assert.equal(url.searchParams.get('id'), `eq.${id}`)
          return Response.json((await queryAs(id, 'SELECT perfil,situacao FROM public.perfis WHERE id=$1', [id], aal)).rows)
        }
        if (url.pathname === '/rest/v1/turmas') {
          assert.equal(url.searchParams.get('select'), 'id')
          return Response.json((await queryAs(id, 'SELECT id FROM public.turmas WHERE id=$1',
            [url.searchParams.get('id')?.slice(3)], aal)).rows)
        }
        if (url.pathname === '/rest/v1/avaliacoes') {
          assert.equal(url.searchParams.get('select'), 'id,turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos,situacao,criado_em')
          assert.equal(url.searchParams.get('situacao'), 'eq.RASCUNHO')
          assert.equal(url.searchParams.get('order'), 'criado_em.desc,id.desc')
          assert.equal(url.searchParams.get('limit'), '50')
          return Response.json((await queryAs(id, `SELECT * FROM public.avaliacoes
            WHERE turma_id=$1 AND situacao='RASCUNHO' ORDER BY criado_em DESC,id DESC LIMIT 50`,
          [url.searchParams.get('turma_id')?.slice(3)], aal)).rows)
        }
        if (url.pathname === '/rest/v1/rpc/criar_avaliacao_rascunho') {
          const params = await req.json()
          assert.deepEqual(Object.keys(params).sort(), ['p_duracao_minutos', 'p_fim_em', 'p_inicio_em', 'p_tipo', 'p_titulo', 'p_turma_id'])
          const result = await queryAs<{ avaliacao: unknown }>(id, createSql,
            [params.p_turma_id, params.p_titulo, params.p_tipo, params.p_inicio_em, params.p_fim_em, params.p_duracao_minutos], aal)
          return Response.json(result.rows[0].avaliacao)
        }
        if (url.pathname === '/rest/v1/rpc/editar_avaliacao_rascunho') {
          assert.equal(req.method, 'POST')
          const params = await req.json()
          assert.deepEqual(Object.keys(params).sort(), ['p_avaliacao_id', 'p_duracao_minutos', 'p_fim_em', 'p_inicio_em', 'p_tipo', 'p_titulo'])
          const result = await queryAs<{ avaliacao: unknown }>(id,
            'SELECT public.editar_avaliacao_rascunho($1,$2,$3,$4,$5,$6) AS avaliacao',
            [params.p_avaliacao_id, params.p_titulo, params.p_tipo, params.p_inicio_em, params.p_fim_em, params.p_duracao_minutos], aal)
          return Response.json(result.rows[0].avaliacao)
        }
        assert.fail(`Rota inesperada: ${url.pathname}`)
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error
        const code = error instanceof Error && 'code' in error ? error.code : 'XX000'
        return Response.json({ code, message: 'Detalhe interno não deve sair na API' }, { status: 400 })
      }
    })
    return { transport, handler: createAvaliacoesHandler(env, transport) }
  }

  await t.test('API cria ambos os tipos, persiste, consulta e não duplica auditoria na leitura', async () => {
    const { handler } = apiFor(professor)
    for (const tipo of ['PROVA', 'ATIVIDADE']) {
      const response = await handler.fetch(request('POST', { ...body, tipo }))
      assert.equal(response.status, 201)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const { avaliacao } = await response.json()
      assert.equal(avaliacao.turma_id, turmaId)
      assert.equal(avaliacao.professor_id, professor)
      assert.equal(avaliacao.situacao, 'RASCUNHO')
      assert.equal(avaliacao.tipo, tipo)
      assert.equal(avaliacao.titulo, body.titulo.trim())
      assert.equal(avaliacao.inicio_em, '2026-11-09T22:00:00.000Z')
      const before = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
      const listed = await handler.fetch(request())
      assert.equal(listed.status, 200)
      assert.equal(listed.headers.get('cache-control'), 'no-store')
      const { avaliacoes, limite } = await listed.json()
      assert.equal(limite, 50)
      assert.deepEqual(avaliacoes.find((item: { id: string }) => item.id === avaliacao.id), avaliacao)
      assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, before)
    }
    const emptyTurma = (await queryAs<{ id: string }>(professor,
      "INSERT INTO public.turmas(nome) VALUES ('Sem rascunhos') RETURNING id")).rows[0].id
    const empty = await handler.fetch(request('GET', null, `?turma_id=${emptyTurma}`))
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), { avaliacoes: [], limite: 50 })
  })

  await t.test('API respeita perfis, MFA, sessão, organização e turma sem revelar dados alheios', async () => {
    const adminApi = apiFor(admin).handler
    assert.equal((await adminApi.fetch(request())).status, 200)
    assert.equal((await adminApi.fetch(request('GET', null, `?turma_id=${otherTurmaId}`))).status, 200)
    for (const method of ['POST', 'PATCH']) assert.equal((await adminApi.fetch(request(method))).status, 403)
    for (const [id, aal] of [[aluno, 'aal2'], [professor, 'aal1'], [admin, 'aal1']]) {
      const { handler } = apiFor(id, aal)
      for (const method of ['GET', 'POST', 'PATCH']) assert.equal((await handler.fetch(request(method))).status, 403)
    }
    const other = await apiFor(colleague).handler.fetch(request())
    const missing = await apiFor(professor).handler.fetch(request('GET', null, `?turma_id=${randomUUID()}`))
    assert.equal(other.status, 404)
    assert.equal(missing.status, 404)
    assert.deepEqual(await other.json(), await missing.json())
    assert.equal((await apiFor(colleague).handler.fetch(request('POST'))).status, 404)
    const sessionId = sessions.get(professor)!
    sessions.set(professor, randomUUID())
    assert.equal((await apiFor(professor).handler.fetch(request())).status, 404)
    assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 403)
    assert.equal((await apiFor(professor).handler.fetch(request('PATCH'))).status, 403)
    sessions.set(professor, sessionId)
    await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [professor])
    for (const method of ['GET', 'POST', 'PATCH']) assert.equal((await apiFor(professor).handler.fetch(request(method))).status, 403)
    await db.query("UPDATE public.perfis SET situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [otherOrg, professor])
    for (const method of ['GET', 'POST', 'PATCH']) assert.equal((await apiFor(professor).handler.fetch(request(method))).status, 404)
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, professor])
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    assert.equal((await apiFor(professor).handler.fetch(request())).status, 200)
    assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 409)
    assert.equal((await apiFor(professor).handler.fetch(request('PATCH'))).status, 409)
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [turmaId])
  })

  await t.test('API rejeita campos/consultas adulterados, datas inválidas e falta de sessão antes de chamar serviços', async () => {
    const { handler, transport } = apiFor(professor)
    for (const payload of [null, [], 'texto', {}, { ...body, professor_id: colleague },
      { ...body, situacao: 'PUBLICADA' }, { ...body, organizacao_id: org }, { ...body, id: randomUUID() },
      { ...body, tipo: 'OUTRO' }, { ...body, turma_id: 'inválido' }, { ...body, duracao_minutos: '60' },
      { ...body, duracao_minutos: 1.5 }, { ...body, duracao_minutos: 0 }, { ...body, duracao_minutos: 2147483648 },
      { ...body, titulo: '\t\t\t' }, { ...body, titulo: 'A'.repeat(151) }, { ...body, fim_em: body.inicio_em },
      { ...body, inicio_em: '2026-02-30T19:00:00-03:00' }, { ...body, inicio_em: '2026-11-09T19:00:00' }]) {
      assert.equal((await handler.fetch(request('POST', payload))).status, 400)
    }
    for (const query of ['', '?turma_id=', '?turma_id=123', `?turma_id=${turmaId}&turma_id=${turmaId}`,
      `?turma_id=${turmaId}&professor_id=${colleague}`, `?turma_id=${turmaId}&situacao=PUBLICADA`]) {
      assert.equal((await handler.fetch(request('GET', null, query))).status, 400)
    }
    const noToken = new Request(`http://localhost/api/avaliacoes?turma_id=${turmaId}`)
    assert.equal((await handler.fetch(noToken)).status, 401)
    const invalidJson = new Request('http://localhost/api/avaliacoes', {
      method: 'POST', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }, body: '{',
    })
    assert.equal((await handler.fetch(invalidJson)).status, 400)
    const wrongType = request('POST')
    wrongType.headers.set('Content-Type', 'text/plain')
    assert.equal((await handler.fetch(wrongType)).status, 415)
    const withQuery = new Request(`http://localhost/api/avaliacoes?turma_id=${turmaId}`, {
      method: 'POST', headers: request('POST').headers, body: JSON.stringify(body),
    })
    assert.equal((await handler.fetch(withQuery)).status, 400)
    const forbidden = await handler.fetch(request('DELETE'))
    assert.equal(forbidden.status, 405)
    assert.equal(forbidden.headers.get('allow'), 'GET, POST, PATCH')
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('API limita aos 50 rascunhos recentes da turma, com desempate por ID', async () => {
    await db.query(`INSERT INTO public.avaliacoes(turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos,criado_em)
      SELECT $1,$2,'Rascunho ' || n,'PROVA',$3,$4,60,'2026-10-26T12:00:00Z'::timestamptz
      FROM generate_series(1,55) AS n`, [turmaId, professor, body.inicio_em, body.fim_em])
    const response = await apiFor(professor).handler.fetch(request())
    const expected = await queryAs(professor,
      'SELECT id FROM public.avaliacoes WHERE turma_id=$1 ORDER BY criado_em DESC,id DESC LIMIT 50', [turmaId])
    assert.equal(response.status, 200)
    const { avaliacoes } = await response.json()
    assert.equal(avaliacoes.length, 50)
    assert.deepEqual(avaliacoes.map((item: { id: string }) => ({ id: item.id })), expected.rows)
  })

  await t.test('API não confirma criação nem retorna lista vazia quando Auth, banco ou contrato falham', async () => {
    for (const [status, expected] of [[401, 401], [403, 401], [429, 503]]) {
      const fetchAuth = t.mock.fn(async () => Response.json({ message: 'Auth indisponível' }, { status }))
      const response = await createAvaliacoesHandler(env, fetchAuth).fetch(request('POST'))
      assert.equal(response.status, expected)
      assert.equal(fetchAuth.mock.callCount(), 1)
    }
    const unconfigured = createAvaliacoesHandler({}, async () => { throw new Error('Não deveria conectar') })
    assert.equal((await unconfigured.fetch(request('POST'))).status, 503)
    const sample = (await apiFor(professor).handler.fetch(request('POST')).then((res) => res.json())).avaliacao
    for (const [path, method, responseBody, status, expected] of [
      ['/rest/v1/perfis', 'GET', { code: 'XX000' }, 500, 503],
      ['/rest/v1/turmas', 'GET', { code: 'XX000' }, 500, 503],
      ['/rest/v1/avaliacoes', 'GET', { code: 'XX000' }, 500, 503],
      ['/rest/v1/avaliacoes', 'GET', null, 200, 503],
      ['/rest/v1/avaliacoes', 'GET', [sample, sample], 200, 503],
      ['/rest/v1/avaliacoes', 'GET', [{ ...sample, turma_id: otherTurmaId }], 200, 503],
      ['/rest/v1/avaliacoes', 'GET', [{ ...sample, situacao: 'PUBLICADA' }], 200, 503],
      ['/rest/v1/rpc/criar_avaliacao_rascunho', 'POST', null, 200, 503],
      ['/rest/v1/rpc/criar_avaliacao_rascunho', 'POST', { ...sample, professor_id: colleague }, 200, 503],
      ['/rest/v1/rpc/criar_avaliacao_rascunho', 'POST', { ...sample, titulo: 'Outro rascunho' }, 200, 503],
      ['/rest/v1/rpc/criar_avaliacao_rascunho', 'POST', { code: '23514', message: 'Detalhe interno' }, 400, 400],
      ['/rest/v1/rpc/criar_avaliacao_rascunho', 'POST', { code: 'P0001', message: 'Detalhe interno' }, 400, 503],
    ] as const) {
      const { transport } = apiFor(professor)
      const handler = createAvaliacoesHandler(env, async (input, init) => {
        if (new URL(new Request(input, init).url).pathname === path) return Response.json(responseBody, { status })
        return transport(input, init)
      })
      const response = await handler.fetch(request(method))
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(JSON.stringify(await response.json()).includes('Detalhe interno'), false)
    }
    const disconnected = createAvaliacoesHandler(env, async () => { throw new Error('Rede indisponível') })
    assert.equal((await disconnected.fetch(request())).status, 503)
    const withExtra = createAvaliacoesHandler(env, async (input, init) => {
      if (new URL(new Request(input, init).url).pathname === '/rest/v1/rpc/criar_avaliacao_rascunho') {
        return Response.json({ ...sample, segredo: 'não retornar' })
      }
      return apiFor(professor).transport(input, init)
    })
    const sanitized = await withExtra.fetch(request('POST'))
    assert.equal(sanitized.status, 201)
    assert.equal('segredo' in (await sanitized.json()).avaliacao, false)
  })

  await t.test('PATCH edita, preserva dados fixos e registra uma auditoria por alteração efetiva', async () => {
    const { handler } = apiFor(professor)
    const original = (await db.query<Record<string, unknown>>('SELECT * FROM public.avaliacoes WHERE id=$1', [avaliacaoId])).rows[0]
    const oldEvents = (await db.query('SELECT * FROM public.eventos_seguranca WHERE recurso_id=$1 ORDER BY id', [avaliacaoId])).rows
    const response = await handler.fetch(request('PATCH'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { avaliacao } = await response.json()
    for (const field of ['id', 'turma_id', 'professor_id', 'situacao']) assert.equal(avaliacao[field], original[field])
    assert.ok(original.criado_em instanceof Date)
    assert.equal(avaliacao.criado_em, original.criado_em.toISOString())
    assert.equal(avaliacao.titulo, editBody.titulo.trim())
    assert.equal(avaliacao.tipo, 'ATIVIDADE')
    assert.equal(avaliacao.inicio_em, '2026-11-10T22:00:00.000Z')
    assert.equal(avaliacao.fim_em, '2026-11-11T00:00:00.000Z')
    assert.equal(avaliacao.duracao_minutos, 45)
    const saved = (await db.query<Record<string, unknown>>('SELECT * FROM public.avaliacoes WHERE id=$1', [avaliacaoId])).rows[0]
    assert.equal(saved.titulo, avaliacao.titulo)
    const events = (await db.query<Record<string, unknown>>('SELECT * FROM public.eventos_seguranca WHERE recurso_id=$1 ORDER BY id', [avaliacaoId])).rows
    assert.equal(events.length, oldEvents.length + 1)
    assert.deepEqual(events.filter((event) => event.evento !== 'AVALIACAO_EDITADA'), oldEvents)
    const event = events.find((event) => event.evento === 'AVALIACAO_EDITADA')!
    assert.equal(event.usuario_id, professor)
    assert.equal(event.acao, 'editar_avaliacao_rascunho')
    assert.equal(event.sucesso, true)
    assert.ok(event.criado_em)
    assert.deepEqual(await (await handler.fetch(request('PATCH'))).json(), { avaliacao })
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca WHERE recurso_id=$1 ORDER BY id', [avaliacaoId])).rows, events)
    const listed = await (await handler.fetch(request())).json()
    assert.deepEqual(listed.avaliacoes.find((item: { id: string }) => item.id === avaliacaoId), avaliacao)
    const missing = await handler.fetch(request('PATCH', { ...editBody, avaliacao_id: randomUUID() }))
    const other = await apiFor(colleague).handler.fetch(request('PATCH'))
    assert.equal(missing.status, 404)
    assert.equal(other.status, 404)
    assert.deepEqual(await other.json(), await missing.json())
    await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
    assert.equal((await handler.fetch(request('PATCH'))).status, 403)
    await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
    assert.equal((await handler.fetch(request('PATCH', { ...editBody, tipo: 'PROVA' }))).status, 200)
  })

  await t.test('PATCH recusa identidade forjada, campos incompletos e entradas inválidas antes de acessar serviços', async () => {
    const { handler, transport } = apiFor(professor)
    for (const payload of [null, [], 'texto', {}, ...Object.keys(editBody).map((field) => ({ ...editBody, [field]: undefined })),
      ...['id', 'turma_id', 'professor_id', 'organizacao_id', 'situacao', 'criado_em', 'aluno_id'].map((field) => ({ ...editBody, [field]: randomUUID() })),
      { ...editBody, avaliacao_id: 'inválido' }, { ...editBody, titulo: 'AB' }, { ...editBody, titulo: '\t\t\t' },
      { ...editBody, titulo: '📝'.repeat(151) }, { ...editBody, tipo: 'OUTRO' }, { ...editBody, duracao_minutos: '45' },
      { ...editBody, duracao_minutos: 0 }, { ...editBody, duracao_minutos: 1.5 }, { ...editBody, duracao_minutos: 2147483648 },
      { ...editBody, inicio_em: '2026-02-30T19:00:00-03:00' }, { ...editBody, inicio_em: '2026-11-10T19:00:00' },
      { ...editBody, fim_em: editBody.inicio_em }]) {
      assert.equal((await handler.fetch(request('PATCH', payload))).status, 400)
    }
    for (const [query, payload, contentType, expected] of [
      ['?avaliacao_id=' + avaliacaoId, JSON.stringify(editBody), 'application/json', 400],
      ['', '{', 'application/json', 400], ['', JSON.stringify(editBody), 'text/plain', 415],
    ] as const) {
      assert.equal((await handler.fetch(new Request(`http://localhost/api/avaliacoes${query}`, {
        method: 'PATCH', headers: { Authorization: 'Bearer test-session', 'Content-Type': contentType }, body: payload,
      }))).status, expected)
    }
    const noToken = request('PATCH')
    noToken.headers.delete('Authorization')
    assert.equal((await handler.fetch(noToken)).status, 401)
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('PATCH trata falhas de Auth, RPC e resposta sem confirmar edição nem vazar detalhes', async () => {
    for (const [status, expected] of [[401, 401], [429, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'Detalhe interno' }, { status }))
      assert.equal((await createAvaliacoesHandler(env, transport).fetch(request('PATCH'))).status, expected)
      assert.equal(transport.mock.callCount(), 1)
    }
    assert.equal((await createAvaliacoesHandler({}, async () => { throw new Error('Sem configuração') }).fetch(request('PATCH'))).status, 503)
    const sample = (await (await apiFor(professor).handler.fetch(request('PATCH'))).json()).avaliacao
    const invalidResponses = [null, [], { ...sample, id: randomUUID() }, { ...sample, professor_id: colleague },
      { ...sample, titulo: 'Outro título' }, { ...sample, tipo: 'PROVA' }, { ...sample, duracao_minutos: 60 },
      { ...sample, inicio_em: body.inicio_em }, { ...sample, fim_em: body.fim_em },
      { ...sample, situacao: 'PUBLICADA' }, { ...sample, criado_em: null }]
    for (const [responseBody, status, expected] of [
      ...invalidResponses.map((value) => [value, 200, 503] as const),
      ...[['42501', 403], ['P0002', 404], ['55000', 409], ['23514', 400], ['P0001', 503], ['PGRST202', 503]]
        .map(([code, expected]) => [{ code, message: 'Detalhe interno' }, 400, expected] as const),
      [{ ...sample, segredo: 'não retornar' }, 200, 200],
    ] as const) {
      const { transport } = apiFor(professor)
      let rpcCalls = 0
      const handler = createAvaliacoesHandler(env, async (input, init) => {
        if (new URL(new Request(input, init).url).pathname === '/rest/v1/rpc/editar_avaliacao_rascunho') {
          rpcCalls++
          return Response.json(responseBody, { status })
        }
        return transport(input, init)
      })
      const response = await handler.fetch(request('PATCH'))
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const result = await response.json()
      if (expected === 200) assert.deepEqual(result, { avaliacao: sample })
      else assert.equal('avaliacao' in result, false)
      assert.equal(JSON.stringify(result).includes('Detalhe interno'), false)
      assert.equal(rpcCalls, 1)
    }
    const { transport } = apiFor(professor)
    let failedCalls = 0
    const disconnected = createAvaliacoesHandler(env, async (input, init) => {
      if (new URL(new Request(input, init).url).pathname.includes('/rpc/')) {
        failedCalls++
        throw new Error('Rede indisponível')
      }
      return transport(input, init)
    })
    assert.equal((await disconnected.fetch(request('PATCH'))).status, 503)
    assert.equal(failedCalls, 1)
  })

  await t.test('PATCH retorna 503 quando a auditoria falha e preserva a avaliação e os eventos', async () => {
    const before = (await db.query(listSql)).rows
    const events = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
    await db.exec(`
      CREATE FUNCTION public.falhar_edicao_api() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.evento = 'AVALIACAO_EDITADA' THEN RAISE EXCEPTION 'Detalhe interno'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER falhar_edicao_api BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_edicao_api();
    `)
    const response = await apiFor(professor).handler.fetch(request('PATCH', { ...editBody, titulo: 'Alteração que deve falhar' }))
    assert.equal(response.status, 503)
    assert.equal(JSON.stringify(await response.json()).includes('Detalhe interno'), false)
    assert.deepEqual((await db.query(listSql)).rows, before)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, events)
    await db.exec('DROP TRIGGER falhar_edicao_api ON public.eventos_seguranca; DROP FUNCTION public.falhar_edicao_api();')
  })
})

test('contrato de rascunho valida calendário, fuso, Unicode e limites sem coerção numérica', () => {
  const valid = {
    turma_id: randomUUID(), titulo: ' Prova 1 ', tipo: 'PROVA',
    inicio_em: '2028-02-29T19:00:00-03:00', fim_em: '2028-03-01T00:00:00Z', duracao_minutos: 1,
  }
  assert.equal(lerDadosAvaliacao(valid)?.inicio_em, '2028-02-29T22:00:00.000Z')
  for (const titulo of ['ABC', 'A'.repeat(150), '📝'.repeat(150)]) assert.ok(lerDadosAvaliacao({ ...valid, titulo }))
  for (const inicio_em of ['2026-02-29T19:00:00Z', '2028-04-31T19:00:00Z', '2028-02-29T24:00:00Z',
    '2028-02-29', 'infinity', '2028-02-29T19:00:00+99:00', '0000-01-01T00:00:00Z']) {
    assert.equal(lerDadosAvaliacao({ ...valid, inicio_em }), null)
  }
  for (const duracao_minutos of [null, '60', 0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.equal(lerDadosAvaliacao({ ...valid, duracao_minutos }), null)
  }
  for (const field of Object.keys(valid)) {
    assert.equal(lerDadosAvaliacao({ ...valid, [field]: undefined }), null)
  }
})
