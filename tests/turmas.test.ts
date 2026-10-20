import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createTurmasHandler } from '../api/turmas.ts'
import { validateTurmaName } from '../src/services/turmaValidation.ts'

test('nome da turma aceita limites e rejeita valores inválidos', () => {
  for (const nome of ['ABC', 'A'.repeat(100), '  Turma B  ']) {
    assert.equal(validateTurmaName(nome), null)
  }
  for (const nome of ['', '  ', 'AB', 'A'.repeat(101), null, 10, {}]) {
    assert.equal(typeof validateTurmaName(nome), 'string')
  }
})

test('turmas: API, permissões e auditoria no PostgreSQL local', async (t) => {
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
  for (const file of ['001_perfis.sql', '002_eventos_seguranca.sql',
    '004_convites_organizacoes.sql', '006_auditoria_cadastro_login.sql', '011_turmas.sql']) {
    await migrate(file)
  }

  const org = randomUUID()
  const otherOrg = randomUUID()
  await db.query(`INSERT INTO public.organizacoes(id,nome,token_login)
    VALUES ($1,'Escola demonstrativa','123456789012345678901'),
           ($2,'Outra escola','123456789012345678902')`, [org, otherOrg])
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

  async function queryAs(id: string, sql: string, params: unknown[] = [], aal = 'aal2') {
    return db.transaction(async (tx) => {
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: id, aal, session_id: sessions.get(id) }),
      ])
      await tx.exec('SET LOCAL ROLE authenticated')
      return tx.query(sql, params)
    })
  }

  function apiFor(id: string, aal = 'aal2') {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.headers.get('apikey'), 'public-test-key')
      assert.equal(request.headers.get('authorization'), 'Bearer test-session')
      const path = new URL(request.url).pathname
      if (path === '/auth/v1/user') {
        return Response.json({ id, email: `${id}@example.test`, app_metadata: {}, user_metadata: {} })
      }
      try {
        if (path === '/rest/v1/perfis') {
          const result = await queryAs(id, 'SELECT perfil,situacao FROM public.perfis WHERE id=$1', [id], aal)
          return Response.json(result.rows)
        }
        if (path === '/rest/v1/turmas') {
          if (request.method === 'POST') {
            const body = await request.json() as { nome: string }
            assert.deepEqual(Object.keys(body), ['nome'])
            const result = await queryAs(id, 'INSERT INTO public.turmas(nome) VALUES ($1) RETURNING *', [body.nome], aal)
            return Response.json(result.rows[0], { status: 201 })
          }
          const result = await queryAs(id, 'SELECT * FROM public.turmas ORDER BY criado_em DESC,id DESC', [], aal)
          return Response.json(result.rows)
        }
        throw new Error(`Rota inesperada no teste: ${path}`)
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : 'XX000'
        return Response.json({ code, message: 'Falha simulada do banco' }, { status: 400 })
      }
    })
    return {
      handler: createTurmasHandler({
        SUPABASE_URL: 'https://exemplo.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
      }, transport),
      transport,
    }
  }
  function request(method = 'GET', body?: unknown) {
    return new Request('http://localhost/api/turmas', {
      method, headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  let turmaId = ''

  await t.test('professor cria com identidade do banco e evento rastreável', async () => {
    const { handler } = apiFor(professor)
    const response = await handler.fetch(request('POST', { nome: '  Engenharia 8B  ' }))
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { turma } = await response.json()
    turmaId = turma.id
    assert.equal(turma.nome, 'Engenharia 8B')
    assert.equal(turma.professor_id, professor)
    assert.equal(turma.organizacao_id, org)
    assert.match(turma.codigo_ingresso, /^[A-F0-9]{12}$/)
    assert.equal(turma.situacao, 'ATIVA')
    const event = (await db.query<{ usuario_id: string; recurso_id: string; sucesso: boolean }>(
      "SELECT * FROM public.eventos_seguranca WHERE evento='TURMA_CRIADA'",
    )).rows[0]
    assert.equal(event.usuario_id, professor)
    assert.equal(event.recurso_id, turma.id)
    assert.equal(event.sucesso, true)
    assert.ok(!JSON.stringify(event).includes(turma.codigo_ingresso))
  })

  await t.test('mesmo professor cria várias turmas na mesma sessão', async () => {
    const response = await apiFor(professor).handler.fetch(request('POST', { nome: 'Segunda turma' }))
    assert.equal(response.status, 201)
    assert.notEqual((await response.json()).turma.id, turmaId)
    const result = await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='TURMA_CRIADA'")
    assert.equal(result.rows.length, 2)
  })

  await t.test('consulta persiste e professor não vê a turma de outro responsável', async () => {
    const own = await apiFor(professor).handler.fetch(request())
    assert.equal(own.status, 200)
    assert.equal((await own.json()).turmas.length, 2)
    const other = await apiFor(colleague).handler.fetch(request())
    assert.deepEqual((await other.json()).turmas, [])
    assert.equal((await queryAs(colleague, 'SELECT * FROM public.turmas WHERE id=$1', [turmaId])).rows.length, 0)
  })

  await t.test('administrador consulta mas não cria turma no lugar do professor', async () => {
    const { handler } = apiFor(admin)
    assert.equal((await (await handler.fetch(request())).json()).turmas.length, 2)
    assert.equal((await handler.fetch(request('POST', { nome: 'Turma admin' }))).status, 403)
    await assert.rejects(queryAs(admin, "INSERT INTO public.turmas(nome) VALUES ('Turma admin')"), /professor ativo/)
  })

  await t.test('aluno e sessão sem MFA não acessam a API nem linhas da tabela', async () => {
    for (const [id, aal] of [[aluno, 'aal2'], [professor, 'aal1']]) {
      const { handler } = apiFor(id, aal)
      assert.equal((await handler.fetch(request())).status, 403)
      assert.equal((await handler.fetch(request('POST', { nome: 'Não permitida' }))).status, 403)
      assert.equal((await queryAs(id, 'SELECT * FROM public.turmas', [], aal)).rows.length, 0)
      await assert.rejects(queryAs(id, "INSERT INTO public.turmas(nome) VALUES ('Não permitida')", [], aal))
    }
  })

  await t.test('banco bloqueia perfil inativo, organização inativa, vínculo ausente e sessão encerrada', async () => {
    const changes = [
      ["UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", professor, "UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1"],
      ["UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", org, "UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1"],
    ]
    for (const [change, id, restore] of changes) {
      await db.query(change, [id])
      assert.equal((await queryAs(professor, 'SELECT * FROM public.turmas')).rows.length, 0)
      await assert.rejects(queryAs(professor, "INSERT INTO public.turmas(nome) VALUES ('Bloqueada')"))
      await db.query(restore, [id])
    }
    await db.query('UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', [professor])
    await assert.rejects(queryAs(professor, "INSERT INTO public.turmas(nome) VALUES ('Sem vínculo')"))
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [otherOrg, professor])
    assert.equal((await queryAs(professor, 'SELECT * FROM public.turmas')).rows.length, 0)
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, professor])
    const currentSession = sessions.get(professor)!
    sessions.set(professor, randomUUID())
    assert.equal((await queryAs(professor, 'SELECT * FROM public.turmas')).rows.length, 0)
    await assert.rejects(queryAs(professor, "INSERT INTO public.turmas(nome) VALUES ('Sessão encerrada')"))
    sessions.set(professor, currentSession)
  })

  await t.test('não permite forjar responsável, código ou organização nem alterar/excluir turmas', async () => {
    for (const column of ['professor_id', 'organizacao_id', 'codigo_ingresso']) {
      const value = column === 'codigo_ingresso' ? 'ABCDEF123456' : colleague
      await assert.rejects(queryAs(professor, `INSERT INTO public.turmas(nome,${column}) VALUES ('Forjada',$1)`, [value]), /permission denied/)
    }
    for (const id of [professor, admin]) {
      await assert.rejects(queryAs(id, "UPDATE public.turmas SET nome='Alterada'"), /permission denied/)
      await assert.rejects(queryAs(id, 'DELETE FROM public.turmas'), /permission denied/)
    }
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE anon')
      await tx.query('SELECT * FROM public.turmas')
    }), /permission denied/)
  })

  await t.test('nome inválido falha também no banco sem gerar turma ou auditoria', async () => {
    for (const nome of ['', 'AB', 'A'.repeat(101)]) {
      await assert.rejects(queryAs(professor, 'INSERT INTO public.turmas(nome) VALUES ($1)', [nome]), /turmas_nome_valido/)
    }
    assert.equal((await db.query('SELECT id FROM public.turmas')).rows.length, 2)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='TURMA_CRIADA'")).rows.length, 2)
  })

  await t.test('falha na auditoria desfaz a criação da turma', async () => {
    await db.exec("ALTER TABLE public.eventos_seguranca ADD CONSTRAINT teste_falha CHECK (acao <> 'criar_turma') NOT VALID")
    const response = await apiFor(professor).handler.fetch(request('POST', { nome: 'Não persistir' }))
    assert.notEqual(response.status, 201)
    assert.equal((await db.query('SELECT id FROM public.turmas')).rows.length, 2)
    await db.exec('ALTER TABLE public.eventos_seguranca DROP CONSTRAINT teste_falha')
  })

  await t.test('API rejeita campos adicionais, nome inválido, JSON inválido e falta de sessão', async () => {
    const { handler, transport } = apiFor(professor)
    for (const body of [{ nome: 'AB' }, { nome: 'Turma', professor_id: colleague }, null, []]) {
      assert.equal((await handler.fetch(request('POST', body))).status, 400)
    }
    const invalidJson = new Request('http://localhost/api/turmas', {
      method: 'POST', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }, body: '{',
    })
    assert.equal((await handler.fetch(invalidJson)).status, 400)
    assert.equal((await handler.fetch(new Request('http://localhost/api/turmas'))).status, 401)
    assert.equal((await handler.fetch(request('DELETE'))).status, 405)
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('API não confia em token recusado pelo Auth nem esconde indisponibilidade', async () => {
    const invalid = createTurmasHandler({
      SUPABASE_URL: 'https://exemplo.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
    }, async () => Response.json({ message: 'Token inválido' }, { status: 401 }))
    assert.equal((await invalid.fetch(request())).status, 401)
    assert.equal((await createTurmasHandler({}).fetch(request())).status, 503)
  })

  await t.test('reaplicar migração preserva turmas, códigos e eventos', async () => {
    const before = await db.query('SELECT * FROM public.turmas ORDER BY id')
    const eventCount = (await db.query('SELECT id FROM public.eventos_seguranca')).rows.length
    await migrate('011_turmas.sql')
    assert.deepEqual((await db.query('SELECT * FROM public.turmas ORDER BY id')).rows, before.rows)
    assert.equal((await db.query('SELECT id FROM public.eventos_seguranca')).rows.length, eventCount)
  })

  await t.test('012: base das matrículas, sem liberar escrita para a aplicação', async (m) => {
    const turmasAntes = (await db.query('SELECT * FROM public.turmas ORDER BY id')).rows
    const eventosAntes = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
    await migrate('012_matriculas.sql')
    assert.deepEqual((await db.query('SELECT * FROM public.turmas ORDER BY id')).rows, turmasAntes)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, eventosAntes)

    const outroAluno = randomUUID()
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [outroAluno, 'outro-aluno@example.test'])
    await db.query("UPDATE public.perfis SET situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [org, outroAluno])
    sessions.set(outroAluno, randomUUID())
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessions.get(outroAluno), outroAluno])
    const turmaColega = (await queryAs(colleague, "INSERT INTO public.turmas(nome) VALUES ('Turma do colega') RETURNING id"))
      .rows[0] as { id: string }
    // Massa inserida pelo dono do banco de testes, não por um usuário da aplicação.
    await db.query(`INSERT INTO public.turma_alunos(turma_id,aluno_id)
      VALUES ($1,$2),($3,$2),($1,$4)`, [turmaId, aluno, turmaColega.id, outroAluno])
    const consultar = 'SELECT turma_id,aluno_id,situacao FROM public.turma_alunos ORDER BY turma_id,aluno_id'
    const matriculas = (await db.query<{ turma_id: string; aluno_id: string; situacao: string }>(consultar)).rows

    await m.test('começa pendente, permite várias turmas e impede vínculo duplicado ou inválido', async () => {
      assert.ok(matriculas.every((matricula) => matricula.situacao === 'PENDENTE'))
      assert.equal(matriculas.filter((matricula) => matricula.aluno_id === aluno).length, 2)
      await assert.rejects(db.query('INSERT INTO public.turma_alunos(turma_id,aluno_id) VALUES ($1,$2)',
        [turmaId, aluno]), { code: '23505' })
      await assert.rejects(db.exec("UPDATE public.turma_alunos SET situacao='APROVADA'"), { code: '23514' })
      for (const vinculo of [[randomUUID(), aluno], [turmaId, randomUUID()]]) {
        await assert.rejects(db.query('INSERT INTO public.turma_alunos(turma_id,aluno_id) VALUES ($1,$2)',
          vinculo), { code: '23503' })
      }
    })

    await m.test('aluno lê só seus vínculos, professor só suas turmas e ADMIN lê todos', async () => {
      for (const id of [aluno, outroAluno]) {
        assert.deepEqual((await queryAs(id, consultar)).rows, matriculas.filter((matricula) => matricula.aluno_id === id))
      }
      assert.deepEqual((await queryAs(professor, consultar)).rows, matriculas.filter((matricula) => matricula.turma_id === turmaId))
      assert.deepEqual((await queryAs(colleague, consultar)).rows, matriculas.filter((matricula) => matricula.turma_id === turmaColega.id))
      assert.deepEqual((await queryAs(admin, consultar)).rows, matriculas)
      assert.equal((await queryAs(aluno, 'SELECT * FROM public.turmas')).rows.length, 0)
    })

    await m.test('consulta exige MFA, perfil ativo e sessão válida para todos os perfis', async () => {
      for (const id of [aluno, professor, admin]) {
        assert.deepEqual((await queryAs(id, consultar, [], 'aal1')).rows, [])
        await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [id])
        assert.deepEqual((await queryAs(id, consultar)).rows, [])
        await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [id])
        const sessionId = sessions.get(id)!
        for (const invalidSession of [randomUUID(), sessions.get(outroAluno)!]) {
          sessions.set(id, invalidSession)
          assert.deepEqual((await queryAs(id, consultar)).rows, [])
        }
        sessions.set(id, sessionId)
      }
    })

    await m.test('aluno e professor não consultam vínculo fora de sua organização ou com organização inativa', async () => {
      for (const id of [aluno, professor]) {
        await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [otherOrg, id])
        assert.deepEqual((await queryAs(id, consultar)).rows, [])
        await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, id])
      }
      await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
      for (const id of [aluno, professor]) assert.deepEqual((await queryAs(id, consultar)).rows, [])
      assert.deepEqual((await queryAs(admin, consultar)).rows, matriculas)
      await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
    })

    await m.test('não permite escrita direta nem autoaprovação, inclusive para ADMIN', async () => {
      for (const id of [aluno, professor, admin]) {
        await assert.rejects(queryAs(id, 'INSERT INTO public.turma_alunos(turma_id,aluno_id) VALUES ($1,$2)',
          [turmaColega.id, outroAluno]), /permission denied/)
        await assert.rejects(queryAs(id, "UPDATE public.turma_alunos SET situacao='ATIVA'"), /permission denied/)
        await assert.rejects(queryAs(id, 'DELETE FROM public.turma_alunos'), /permission denied/)
      }
      for (const sql of ['SELECT * FROM public.turma_alunos',
        `SELECT examentech_private.pode_consultar_matricula('${turmaId}','${aluno}')`]) {
        await assert.rejects(db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE anon')
          return tx.query(sql)
        }), /permission denied/)
      }
    })

    await m.test('matrícula inativa mantém identidade, data e consulta do histórico; exclusão não faz cascata', async () => {
      const antes = (await db.query('SELECT id,solicitado_em FROM public.turma_alunos ORDER BY id')).rows
      // Mudanças administrativas abaixo exercitam o modelo; não há rota de aprovação ainda.
      await db.exec("UPDATE public.turma_alunos SET situacao='ATIVA'")
      await db.exec("UPDATE public.turma_alunos SET situacao='INATIVA'")
      assert.deepEqual((await db.query('SELECT id,solicitado_em FROM public.turma_alunos ORDER BY id')).rows, antes)
      assert.equal((await queryAs(aluno, consultar)).rows.length, 2)
      await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
      assert.equal((await queryAs(aluno, consultar)).rows.length, 2)
      await assert.rejects(db.query('DELETE FROM public.turmas WHERE id=$1', [turmaId]), { code: '23001' })
      await assert.rejects(db.query('DELETE FROM public.perfis WHERE id=$1', [aluno]), { code: '23001' })
      await assert.rejects(db.query('INSERT INTO public.turma_alunos(turma_id,aluno_id) VALUES ($1,$2)',
        [turmaId, aluno]), { code: '23505' })
    })

    await m.test('reaplicar 012 preserva matrículas e permissões', async () => {
      const antes = (await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows
      await migrate('012_matriculas.sql')
      assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows, antes)
      assert.equal((await queryAs(aluno, consultar)).rows.length, 2)
      assert.equal((await queryAs(colleague, consultar)).rows.length, 1)
      await assert.rejects(queryAs(admin, 'DELETE FROM public.turma_alunos'), /permission denied/)
    })
  })
})
