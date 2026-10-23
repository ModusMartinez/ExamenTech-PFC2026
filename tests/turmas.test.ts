import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createTurmasHandler } from '../api/turmas.ts'
import { createMatriculasHandler } from '../api/matriculas.ts'
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
        if (path === '/rest/v1/rpc/solicitar_matricula') {
          const body = await request.json() as { p_codigo: string }
          assert.deepEqual(Object.keys(body), ['p_codigo'])
          const result = await queryAs(id, 'SELECT public.solicitar_matricula($1) AS matricula', [body.p_codigo], aal)
          return Response.json((result.rows[0] as { matricula: unknown }).matricula)
        }
        if (path === '/rest/v1/rpc/aprovar_matricula') {
          const body = await request.json() as { p_matricula_id: string }
          assert.deepEqual(Object.keys(body), ['p_matricula_id'])
          const result = await queryAs(id, 'SELECT public.aprovar_matricula($1) AS matricula', [body.p_matricula_id], aal)
          return Response.json((result.rows[0] as { matricula: unknown }).matricula)
        }
        if (path === '/rest/v1/rpc/listar_matriculas_pendentes') {
          assert.deepEqual(await request.json(), {})
          const result = await queryAs(id, 'SELECT public.listar_matriculas_pendentes() AS matriculas', [], aal)
          return Response.json((result.rows[0] as { matriculas: unknown }).matriculas)
        }
        if (path === '/rest/v1/rpc/listar_minhas_matriculas') {
          assert.deepEqual(await request.json(), {})
          const result = await queryAs(id, 'SELECT public.listar_minhas_matriculas() AS matriculas', [], aal)
          return Response.json((result.rows[0] as { matriculas: unknown }).matriculas)
        }
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
    const env = { SUPABASE_URL: 'https://exemplo.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
    return {
      handler: createTurmasHandler(env, transport),
      matriculas: createMatriculasHandler(env, transport),
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

  await t.test('013: solicitação por código via API e banco', async (m) => {
    const anteriores = (await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows
    await migrate('013_solicitar_matricula.sql')
    assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows, anteriores)
    const turma = (await queryAs(professor, "INSERT INTO public.turmas(nome) VALUES ('Turma de ingresso') RETURNING *"))
      .rows[0] as { id: string; nome: string; codigo_ingresso: string }
    function matriculaRequest(body: unknown = { codigo: turma.codigo_ingresso }) {
      return new Request('http://localhost/api/matriculas', {
        method: 'POST', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    const solicitar = (id = aluno, aal = 'aal2') => apiFor(id, aal).matriculas.fetch(matriculaRequest())
    const rpc = 'SELECT public.solicitar_matricula($1)'

    await m.test('aluno solicita com código normalizado; banco define identidade, pendência e auditoria', async () => {
      const response = await apiFor(aluno).matriculas.fetch(matriculaRequest({ codigo: `  ${turma.codigo_ingresso.toLowerCase()}  ` }))
      assert.equal(response.status, 201)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const { matricula } = await response.json()
      assert.equal(matricula.turma_id, turma.id)
      assert.equal(matricula.turma_nome, turma.nome)
      assert.equal(matricula.situacao, 'PENDENTE')
      assert.ok(matricula.solicitado_em)
      const registro = (await db.query('SELECT aluno_id FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows
      assert.deepEqual(registro, [{ aluno_id: aluno }])
      const evento = (await db.query<{ usuario_id: string; recurso_id: string; sucesso: boolean }>(
        "SELECT * FROM public.eventos_seguranca WHERE evento='MATRICULA_SOLICITADA'",
      )).rows[0]
      assert.equal(evento.usuario_id, aluno)
      assert.equal(evento.recurso_id, matricula.id)
      assert.equal(evento.sucesso, true)
      assert.ok(!JSON.stringify(evento).includes(turma.codigo_ingresso))
      assert.equal((await queryAs(aluno, 'SELECT * FROM public.turmas')).rows.length, 0)
    })

    await m.test('repetição não duplica, aprova nem reativa vínculo; preserva ID, data e auditoria', async () => {
      const antes = (await db.query('SELECT id,solicitado_em FROM public.turma_alunos WHERE turma_id=$1', [turma.id])).rows
      for (const situacao of ['PENDENTE', 'ATIVA', 'INATIVA']) {
        await db.query('UPDATE public.turma_alunos SET situacao=$1 WHERE turma_id=$2', [situacao, turma.id])
        assert.equal((await solicitar()).status, 409)
        assert.deepEqual((await db.query('SELECT situacao FROM public.turma_alunos WHERE turma_id=$1', [turma.id])).rows, [{ situacao }])
      }
      assert.deepEqual((await db.query('SELECT id,solicitado_em FROM public.turma_alunos WHERE turma_id=$1', [turma.id])).rows, antes)
      assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='MATRICULA_SOLICITADA'")).rows.length, 1)
    })

    await m.test('recusa outros perfis, falta de MFA, conta inativa e sessão de outra pessoa ou encerrada', async () => {
      for (const id of [professor, admin]) assert.equal((await solicitar(id)).status, 403)
      assert.equal((await solicitar(aluno, 'aal1')).status, 403)
      await assert.rejects(queryAs(aluno, 'SELECT examentech_private.solicitar_matricula($1)',
        [turma.codigo_ingresso], 'aal1'), { code: '42501' })
      await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [aluno])
      assert.equal((await solicitar()).status, 403)
      await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [aluno])
      const sessionId = sessions.get(aluno)!
      for (const invalidSession of [randomUUID(), sessions.get(professor)!]) {
        sessions.set(aluno, invalidSession)
        assert.equal((await solicitar()).status, 403)
      }
      sessions.set(aluno, sessionId)
      await assert.rejects(db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE anon')
        return tx.query(rpc, [turma.codigo_ingresso])
      }), /permission denied/)
    })

    await m.test('código inválido, turma inativa e outra organização não revelam dados da turma', async () => {
      const mensagem = { message: 'Código de turma inválido ou indisponível.' }
      for (const codigo of [null, '', 'ABC', 'Z'.repeat(12), 'A'.repeat(13)]) {
        await assert.rejects(queryAs(aluno, rpc, [codigo]), { code: '22023' })
      }
      const inexistente = randomUUID().replaceAll('-', '').slice(0, 12)
      const response = await apiFor(aluno).matriculas.fetch(matriculaRequest({ codigo: inexistente }))
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), mensagem)
      await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turma.id])
      assert.deepEqual(await (await solicitar()).json(), mensagem)
      await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [turma.id])
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [otherOrg, aluno])
      assert.deepEqual(await (await solicitar()).json(), mensagem)
      await db.query('UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', [aluno])
      assert.equal((await solicitar()).status, 403)
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, aluno])
      await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
      assert.equal((await solicitar()).status, 403)
      await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
    })

    await m.test('API recusa corpo adulterado, JSON inválido, método e conteúdo incorretos antes de chamar o Auth', async () => {
      const { matriculas, transport } = apiFor(aluno)
      for (const body of [null, [], {}, { codigo: 123 }, { codigo: 'ABC' },
        { codigo: turma.codigo_ingresso, aluno_id: professor }, { codigo: turma.codigo_ingresso, situacao: 'ATIVA' }]) {
        assert.equal((await matriculas.fetch(matriculaRequest(body))).status, 400)
      }
      const headers = { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'POST', headers, body: '{' }))).status, 400)
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'POST' }))).status, 401)
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'POST', headers: { Authorization: 'Bearer test-session' } }))).status, 415)
      const invalidMethod = await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'DELETE' }))
      assert.equal(invalidMethod.status, 405)
      assert.equal(invalidMethod.headers.get('allow'), 'GET, POST, PATCH')
      assert.equal(transport.mock.callCount(), 0)
    })

    await m.test('token recusado não chama RPC; falha de serviço ou resposta inválida não confirma matrícula', async () => {
      const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
      for (const status of [401, 500]) {
        const transport = t.mock.fn(async () => Response.json({ message: 'Falha de teste' }, { status }))
        const result = await createMatriculasHandler(env, transport).fetch(matriculaRequest())
        assert.equal(result.status, status === 401 ? 401 : 503)
        assert.equal(transport.mock.callCount(), 1)
      }
      assert.equal((await createMatriculasHandler({}).fetch(matriculaRequest())).status, 503)
      const invalid = createMatriculasHandler(env, async (input) => new URL(String(input)).pathname === '/auth/v1/user'
        ? Response.json({ id: aluno }) : Response.json({}))
      assert.equal((await invalid.fetch(matriculaRequest())).status, 503)
    })

    await m.test('falha na auditoria desfaz solicitação; outra turma pode ser solicitada na mesma sessão', async () => {
      const nova = (await queryAs(professor, "INSERT INTO public.turmas(nome) VALUES ('Outra solicitação') RETURNING *"))
        .rows[0] as { id: string; codigo_ingresso: string }
      await db.exec("ALTER TABLE public.eventos_seguranca ADD CONSTRAINT teste_matricula CHECK (acao <> 'solicitar_matricula') NOT VALID")
      const body = { codigo: nova.codigo_ingresso }
      assert.equal((await apiFor(aluno).matriculas.fetch(matriculaRequest(body))).status, 503)
      assert.equal((await db.query('SELECT id FROM public.turma_alunos WHERE turma_id=$1', [nova.id])).rows.length, 0)
      await db.exec('ALTER TABLE public.eventos_seguranca DROP CONSTRAINT teste_matricula')
      assert.equal((await apiFor(aluno).matriculas.fetch(matriculaRequest(body))).status, 201)
      assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='MATRICULA_SOLICITADA'")).rows.length, 2)
    })

    await m.test('013 preserva bloqueio de escrita direta e pode ser reaplicada sem alterar registros', async () => {
      const antes = (await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows
      const eventos = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
      await migrate('013_solicitar_matricula.sql')
      assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows, antes)
      assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, eventos)
      await assert.rejects(queryAs(aluno, 'INSERT INTO public.turma_alunos(turma_id,aluno_id) VALUES ($1,$2)',
        [turma.id, aluno]), /permission denied/)
      await assert.rejects(queryAs(aluno, "UPDATE public.turma_alunos SET situacao='ATIVA'"), /permission denied/)
      await assert.rejects(queryAs(admin, 'DELETE FROM public.turma_alunos'), /permission denied/)
    })
  })

  await t.test('014: aprovação de matrícula pelo responsável ou ADMIN', async (m) => {
    const anteriores = (await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows
    const eventosAnteriores = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
    await migrate('014_aprovar_matricula.sql')
    assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows, anteriores)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, eventosAnteriores)

    type Matricula = { id: string; turma_id: string; turma_nome: string; situacao: string; solicitado_em: string }
    async function novaMatricula(responsavel = professor): Promise<Matricula> {
      const turma = (await queryAs(responsavel, "INSERT INTO public.turmas(nome) VALUES ('Turma para aprovação') RETURNING codigo_ingresso"))
        .rows[0] as { codigo_ingresso: string }
      const result = await queryAs(aluno, 'SELECT public.solicitar_matricula($1) AS matricula', [turma.codigo_ingresso])
      return (result.rows[0] as { matricula: Matricula }).matricula
    }
    function approvalRequest(body: unknown) {
      return new Request('http://localhost/api/matriculas', {
        method: 'PATCH', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    const aprovar = (id: string, ator = professor, aal = 'aal2') =>
      apiFor(ator, aal).matriculas.fetch(approvalRequest({ matricula_id: id }))
    const eventos = (id: string) => db.query<{ usuario_id: string; recurso_id: string; sessao_id: string | null; sucesso: boolean }>(
      "SELECT * FROM public.eventos_seguranca WHERE evento='MATRICULA_APROVADA' AND recurso_id=$1", [id])

    await m.test('professor aprova sua turma, preserva o vínculo e registra o aprovador sem mudar contas', async () => {
      const matricula = await novaMatricula()
      const perfis = (await db.query('SELECT * FROM public.perfis ORDER BY id')).rows
      const response = await aprovar(matricula.id)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await response.json(), { matricula: { ...matricula, situacao: 'ATIVA' } })
      assert.deepEqual((await queryAs(aluno, 'SELECT situacao FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows,
        [{ situacao: 'ATIVA' }])
      assert.deepEqual((await db.query('SELECT * FROM public.perfis ORDER BY id')).rows, perfis)
      const audit = (await eventos(matricula.id)).rows
      assert.equal(audit.length, 1)
      assert.equal(audit[0].usuario_id, professor)
      assert.equal(audit[0].recurso_id, matricula.id)
      assert.equal(audit[0].sucesso, true)
      assert.equal(audit[0].sessao_id, null)
      assert.ok(!JSON.stringify(audit).includes(matricula.turma_nome))
      const antes = (await db.query('SELECT * FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows
      assert.equal((await aprovar(matricula.id)).status, 409)
      assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows, antes)
      assert.deepEqual((await eventos(matricula.id)).rows, audit)
    })

    await m.test('ADMIN aprova turma de outro responsável sem depender de vínculo próprio com a organização', async () => {
      const matricula = await novaMatricula(colleague)
      await db.query('UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', [admin])
      const response = await aprovar(matricula.id, admin)
      assert.equal(response.status, 200)
      assert.equal((await response.json()).matricula.situacao, 'ATIVA')
      assert.equal((await eventos(matricula.id)).rows[0].usuario_id, admin)
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, admin])
    })

    await m.test('outro professor e ID inexistente recebem a mesma resposta, sem expor matrícula', async () => {
      const matricula = await novaMatricula()
      for (const id of [matricula.id, randomUUID()]) {
        const response = await aprovar(id, colleague)
        assert.equal(response.status, 404)
        assert.deepEqual(await response.json(), { message: 'Matrícula não encontrada ou acesso não autorizado.' })
      }
      for (const organizacao of [otherOrg, null]) {
        await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [organizacao, professor])
        assert.equal((await aprovar(matricula.id)).status, 404)
      }
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, professor])
      await assert.rejects(queryAs(colleague, 'SELECT examentech_private.aprovar_matricula($1)', [matricula.id]), { code: 'P0002' })
      assert.equal((await eventos(matricula.id)).rows.length, 0)
    })

    await m.test('aluno, visitante, falta de MFA, conta inativa ou sessão inválida não aprovam', async () => {
      const matricula = await novaMatricula()
      assert.equal((await aprovar(matricula.id, aluno)).status, 403)
      for (const ator of [professor, admin]) {
        assert.equal((await aprovar(matricula.id, ator, 'aal1')).status, 403)
        await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [ator])
        assert.equal((await aprovar(matricula.id, ator)).status, 403)
        await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [ator])
        const sessionId = sessions.get(ator)!
        for (const invalidSession of [randomUUID(), sessions.get(aluno)!]) {
          sessions.set(ator, invalidSession)
          assert.equal((await aprovar(matricula.id, ator)).status, 403)
        }
        sessions.set(ator, sessionId)
      }
      for (const fn of ['public.aprovar_matricula', 'examentech_private.aprovar_matricula']) {
        await assert.rejects(queryAs(aluno, `SELECT ${fn}($1)`, [matricula.id]), { code: '42501' })
        await assert.rejects(queryAs(professor, `SELECT ${fn}($1)`, [matricula.id], 'aal1'), { code: '42501' })
        await assert.rejects(db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE anon')
          return tx.query(`SELECT ${fn}($1)`, [matricula.id])
        }), /permission denied/)
      }
      assert.equal((await eventos(matricula.id)).rows.length, 0)
    })

    await m.test('nem ADMIN aprova turma inativa ou aluno sem perfil/vínculo ativo na organização da turma', async () => {
      const matricula = await novaMatricula()
      const changes = [
        ["UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", matricula.turma_id, "UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1"],
        ["UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", aluno, "UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1"],
        ["UPDATE public.perfis SET perfil='PROFESSOR' WHERE id=$1", aluno, "UPDATE public.perfis SET perfil='ALUNO' WHERE id=$1"],
        ['UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', aluno, `UPDATE public.perfis SET organizacao_id='${org}' WHERE id=$1`],
        [`UPDATE public.perfis SET organizacao_id='${otherOrg}' WHERE id=$1`, aluno, `UPDATE public.perfis SET organizacao_id='${org}' WHERE id=$1`],
      ]
      for (const [change, id, restore] of changes) {
        await db.query(change, [id])
        for (const ator of [professor, admin]) assert.equal((await aprovar(matricula.id, ator)).status, 409)
        await db.query(restore, [id])
      }
      await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
      assert.equal((await aprovar(matricula.id)).status, 404)
      assert.equal((await aprovar(matricula.id, admin)).status, 409)
      await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
      assert.deepEqual((await db.query('SELECT situacao FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows,
        [{ situacao: 'PENDENTE' }])
      assert.equal((await eventos(matricula.id)).rows.length, 0)
    })

    await m.test('aprovação não reativa matrículas inativas nem reaprova ativas', async () => {
      const matricula = await novaMatricula()
      for (const situacao of ['ATIVA', 'INATIVA']) {
        await db.query('UPDATE public.turma_alunos SET situacao=$1 WHERE id=$2', [situacao, matricula.id])
        const antes = (await db.query('SELECT * FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows
        for (const ator of [professor, admin]) assert.equal((await aprovar(matricula.id, ator)).status, 409)
        assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows, antes)
      }
      assert.equal((await eventos(matricula.id)).rows.length, 0)
    })

    await m.test('PATCH aceita só ID UUID da matrícula, sem situação, aprovador ou aluno fornecido pelo cliente', async () => {
      const { matriculas, transport } = apiFor(professor)
      const id = randomUUID()
      for (const body of [null, [], {}, { matricula_id: 12 }, { matricula_id: 'não-uuid' },
        { matricula_id: id, situacao: 'ATIVA' }, { matricula_id: id, usuario_id: admin },
        { matricula_id: id, aluno_id: aluno }, { codigo: 'ABCDEF123456' }]) {
        assert.equal((await matriculas.fetch(approvalRequest(body))).status, 400)
      }
      const headers = { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'PATCH', headers, body: '{' }))).status, 400)
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'PATCH' }))).status, 401)
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'PATCH', headers: { Authorization: 'Bearer test-session' } }))).status, 415)
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas', { method: 'DELETE' }))).status, 405)
      assert.equal(transport.mock.callCount(), 0)
    })

    await m.test('Auth recusado ou indisponível não chama RPC; resposta incompleta nunca confirma aprovação', async () => {
      const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
      const body = { matricula_id: randomUUID() }
      for (const status of [401, 500]) {
        const transport = t.mock.fn(async () => Response.json({ message: 'Falha de teste' }, { status }))
        assert.equal((await createMatriculasHandler(env, transport).fetch(approvalRequest(body))).status, status === 401 ? 401 : 503)
        assert.equal(transport.mock.callCount(), 1)
      }
      assert.equal((await createMatriculasHandler({}).fetch(approvalRequest(body))).status, 503)
      const pendente = await novaMatricula()
      for (const reply of [{}, pendente]) {
        const handler = createMatriculasHandler(env, async (input) => new URL(String(input)).pathname === '/auth/v1/user'
          ? Response.json({ id: professor }) : Response.json(reply))
        assert.equal((await handler.fetch(approvalRequest(body))).status, 503)
      }
    })

    await m.test('falha de auditoria desfaz aprovação e permite nova tentativa sem duplicar evento', async () => {
      const matricula = await novaMatricula()
      const antes = (await db.query('SELECT * FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows
      await db.exec("ALTER TABLE public.eventos_seguranca ADD CONSTRAINT teste_aprovacao CHECK (acao <> 'aprovar_matricula') NOT VALID")
      assert.equal((await aprovar(matricula.id)).status, 503)
      assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos WHERE id=$1', [matricula.id])).rows, antes)
      assert.equal((await eventos(matricula.id)).rows.length, 0)
      await db.exec('ALTER TABLE public.eventos_seguranca DROP CONSTRAINT teste_aprovacao')
      assert.equal((await aprovar(matricula.id)).status, 200)
      assert.equal((await eventos(matricula.id)).rows.length, 1)
    })

    await m.test('014 preserva registros, leitura do histórico e bloqueio de escrita direta ao reaplicar', async () => {
      const antes = (await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows
      const audit = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
      await migrate('014_aprovar_matricula.sql')
      assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows, antes)
      assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, audit)
      assert.ok((await queryAs(aluno, "SELECT id FROM public.turma_alunos WHERE situacao='INATIVA'")).rows.length > 0)
      for (const ator of [aluno, professor, admin]) {
        await assert.rejects(queryAs(ator, "UPDATE public.turma_alunos SET situacao='ATIVA'"), /permission denied/)
        await assert.rejects(queryAs(ator, 'DELETE FROM public.turma_alunos'), /permission denied/)
        await assert.rejects(queryAs(ator, 'INSERT INTO public.turma_alunos(turma_id,aluno_id) VALUES ($1,$2)',
          [turmaId, aluno]), /permission denied/)
      }
      assert.equal((await novaMatricula()).situacao, 'PENDENTE')
    })
  })

  await t.test('015: pendências identificadas sem ampliar acesso aos perfis', async (m) => {
    await migrate('015_listar_matriculas_pendentes.sql')
    const rpc = 'SELECT public.listar_matriculas_pendentes() AS matriculas'
    const listRequest = () => new Request('http://localhost/api/matriculas', {
      headers: { Authorization: 'Bearer test-session' },
    })
    const listar = (id = professor, aal = 'aal2') => apiFor(id, aal).matriculas.fetch(listRequest())
    type Pendencia = { id: string; turma_id: string; aluno_id: string; aluno_nome: string; aluno_rgm: string | null; situacao: string }
    await db.query("UPDATE public.perfis SET nome='Aluno demonstrativo',rgm='12345678900' WHERE id=$1", [aluno])

    await m.test('GET mostra só pendentes das próprias turmas com identificação mínima, sem leitura geral de perfis', async () => {
      const response = await listar()
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const { matriculas } = await response.json() as { matriculas: Pendencia[] }
      const expected = (await db.query<{ id: string }>(`SELECT m.id FROM public.turma_alunos m
        JOIN public.turmas t ON t.id=m.turma_id WHERE t.professor_id=$1 AND m.situacao='PENDENTE'
        ORDER BY m.solicitado_em,m.id LIMIT 50`, [professor])).rows
      assert.ok(matriculas.length > 0)
      assert.deepEqual(matriculas.map(({ id }) => ({ id })), expected)
      assert.ok(matriculas.every((item) => item.situacao === 'PENDENTE' && item.aluno_nome === 'Aluno demonstrativo'))
      assert.equal(matriculas[0].aluno_rgm, '12345678900')
      assert.deepEqual(Object.keys(matriculas[0]).sort(), [
        'id', 'turma_id', 'turma_nome', 'aluno_id', 'aluno_nome', 'aluno_rgm', 'situacao', 'solicitado_em',
      ].sort())
      assert.deepEqual((await queryAs(professor, 'SELECT * FROM public.perfis WHERE id=$1', [aluno])).rows, [])
      const other = await (await listar(colleague)).json() as { matriculas: Pendencia[] }
      assert.ok(other.matriculas.every((item) => !matriculas.some((own) => own.id === item.id)))
    })

    await m.test('ADMIN vê pendentes de todos os responsáveis mesmo sem organização; aceita RGM ausente', async () => {
      await db.query('UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', [admin])
      await db.query('UPDATE public.perfis SET rgm=NULL WHERE id=$1', [aluno])
      const response = await listar(admin)
      assert.equal(response.status, 200)
      const { matriculas } = await response.json() as { matriculas: Pendencia[] }
      const expected = (await db.query<{ id: string }>("SELECT id FROM public.turma_alunos WHERE situacao='PENDENTE' ORDER BY solicitado_em,id LIMIT 50")).rows
      assert.deepEqual(matriculas.map(({ id }) => ({ id })), expected)
      assert.ok(matriculas.every((item) => item.aluno_rgm === null))
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, admin])
    })

    await m.test('nega aluno, visitante, falta de MFA, perfil inativo e sessão encerrada também na RPC privada', async () => {
      assert.equal((await listar(aluno)).status, 403)
      await assert.rejects(queryAs(aluno, 'SELECT examentech_private.listar_matriculas_pendentes()'), { code: '42501' })
      for (const id of [professor, admin]) {
        assert.equal((await listar(id, 'aal1')).status, 403)
        await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [id])
        assert.equal((await listar(id)).status, 403)
        await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [id])
        const sessionId = sessions.get(id)!
        for (const invalid of [randomUUID(), sessions.get(aluno)!]) {
          sessions.set(id, invalid)
          assert.equal((await listar(id)).status, 403)
        }
        sessions.set(id, sessionId)
      }
      for (const schema of ['public', 'examentech_private']) {
        await assert.rejects(db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE anon')
          return tx.query(`SELECT ${schema}.listar_matriculas_pendentes()`)
        }), /permission denied/)
      }
      assert.equal((await apiFor(professor).matriculas.fetch(new Request('http://localhost/api/matriculas'))).status, 401)
    })

    await m.test('professor fora da organização ou organização inativa não recebe nomes nem vínculos', async () => {
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [otherOrg, professor])
      assert.deepEqual(await (await listar()).json(), { matriculas: [] })
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, professor])
      await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
      assert.deepEqual(await (await listar()).json(), { matriculas: [] })
      await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
    })

    await m.test('aprovação remove a solicitação da próxima consulta, sem apagar o vínculo', async () => {
      const { matriculas } = await (await listar()).json() as { matriculas: Pendencia[] }
      const pendente = matriculas[0]
      await queryAs(professor, 'SELECT public.aprovar_matricula($1)', [pendente.id])
      const result = await (await listar()).json() as { matriculas: Pendencia[] }
      assert.ok(!result.matriculas.some((item) => item.id === pendente.id))
      assert.deepEqual((await db.query('SELECT situacao FROM public.turma_alunos WHERE id=$1', [pendente.id])).rows, [{ situacao: 'ATIVA' }])
    })

    await m.test('consulta limita às 50 mais antigas e reaplicar 015 não modifica registros nem permissões de escrita', async () => {
      // Massa criada apenas no banco local de testes para ultrapassar o limite da tela.
      const turmas = await queryAs(professor, "INSERT INTO public.turmas(nome) SELECT 'Fila '||n FROM generate_series(1,51) n RETURNING id")
      for (const turma of turmas.rows as { id: string }[]) {
        await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,solicitado_em) VALUES ($1,$2,'2026-01-01')", [turma.id, aluno])
      }
      const before = (await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows
      const events = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
      await migrate('015_listar_matriculas_pendentes.sql')
      const { matriculas } = await (await listar()).json() as { matriculas: Pendencia[] }
      assert.equal(matriculas.length, 50)
      const expected = (await db.query<{ id: string }>(`SELECT m.id FROM public.turma_alunos m JOIN public.turmas t ON t.id=m.turma_id
        WHERE t.professor_id=$1 AND m.situacao='PENDENTE' ORDER BY m.solicitado_em,m.id LIMIT 50`, [professor])).rows
      assert.deepEqual(matriculas.map(({ id }) => ({ id })), expected)
      assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows, before)
      assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, events)
      await assert.rejects(queryAs(admin, "UPDATE public.turma_alunos SET situacao='ATIVA'"), /permission denied/)
      assert.equal((await queryAs(professor, rpc)).rows.length, 1)
    })

    await m.test('falha de Auth não consulta RPC e resposta inválida do banco não vira lista vazia', async () => {
      const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
      for (const status of [401, 500]) {
        const transport = t.mock.fn(async () => Response.json({ message: 'Falha de teste' }, { status }))
        assert.equal((await createMatriculasHandler(env, transport).fetch(listRequest())).status, status === 401 ? 401 : 503)
        assert.equal(transport.mock.callCount(), 1)
      }
      assert.equal((await createMatriculasHandler({}).fetch(listRequest())).status, 503)
      for (const reply of [null, {}, [{ id: randomUUID() }]]) {
        const handler = createMatriculasHandler(env, async (input) => new URL(String(input)).pathname === '/auth/v1/user'
          ? Response.json({ id: professor }) : Response.json(reply))
        assert.equal((await handler.fetch(listRequest())).status, 503)
      }
    })
  })

  await t.test('016: aluno consulta somente suas matrículas em todas as situações', async (m) => {
    await migrate('016_listar_minhas_matriculas.sql')
    const titular = randomUUID()
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [titular, 'consulta-aluno@example.test'])
    await db.query("UPDATE public.perfis SET situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [org, titular])
    sessions.set(titular, randomUUID())
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessions.get(titular), titular])
    const listRequest = (query = 'consulta=minhas') => new Request(`http://localhost/api/matriculas?${query}`, {
      headers: { Authorization: 'Bearer test-session' },
    })
    const listar = (id = titular, aal = 'aal2') => apiFor(id, aal).matriculas.fetch(listRequest())
    const rpc = 'SELECT public.listar_minhas_matriculas() AS matriculas'

    await m.test('aluno sem matrículas recebe lista vazia, não erro de acesso', async () => {
      const response = await listar()
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { matriculas: [] })
    })

    const vinculos: { id: string; turma_id: string; situacao: string }[] = []
    for (const situacao of ['PENDENTE', 'ATIVA', 'INATIVA']) {
      const turma = (await queryAs(professor, 'INSERT INTO public.turmas(nome) VALUES ($1) RETURNING id',
        [`Turma ${situacao}`])).rows[0] as { id: string }
      // Massa local para conferir estados já previstos, sem criar rota de inativação.
      const result = await db.query<{ id: string; turma_id: string; situacao: string }>(
        'INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,$3) RETURNING id,turma_id,situacao',
        [turma.id, titular, situacao])
      vinculos.push(result.rows[0])
    }
    await db.query('INSERT INTO public.turma_alunos(turma_id,aluno_id) VALUES ($1,$2)', [vinculos[0].turma_id, aluno])
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [vinculos[2].turma_id])

    await m.test('mostra pendente, ativa e inativa sem códigos ou matrículas de colegas, inclusive em turma inativa', async () => {
      const response = await listar()
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const { matriculas } = await response.json() as { matriculas: { id: string; situacao: string }[] }
      assert.equal(matriculas.length, 3)
      assert.deepEqual(matriculas.map((item) => item.situacao).sort(), ['ATIVA', 'INATIVA', 'PENDENTE'])
      assert.deepEqual(matriculas.map((item) => item.id).sort(), vinculos.map((item) => item.id).sort())
      for (const item of matriculas) {
        assert.deepEqual(Object.keys(item).sort(), ['id', 'turma_id', 'turma_nome', 'situacao', 'solicitado_em'].sort())
      }
      assert.deepEqual((await queryAs(titular, 'SELECT * FROM public.turmas')).rows, [])
      assert.deepEqual((await queryAs(titular, 'SELECT * FROM public.perfis WHERE id=$1', [aluno])).rows, [])
      const direct = await queryAs(titular, 'SELECT examentech_private.listar_minhas_matriculas() AS matriculas')
      assert.deepEqual((direct.rows[0] as { matriculas: unknown }).matriculas, matriculas)
    })

    await m.test('exige ALUNO ativo, organização ativa, sessão própria e MFA; anônimo não executa nenhuma função', async () => {
      for (const id of [professor, admin]) assert.equal((await listar(id)).status, 403)
      await assert.rejects(queryAs(professor, rpc), { code: '42501' })
      assert.equal((await listar(titular, 'aal1')).status, 403)
      await assert.rejects(queryAs(titular, 'SELECT examentech_private.listar_minhas_matriculas()', [], 'aal1'), { code: '42501' })
      for (const [sql, id, restore] of [
        ["UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", titular, "UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1"],
        ["UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", org, "UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1"],
        ['UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', titular, `UPDATE public.perfis SET organizacao_id='${org}' WHERE id=$1`],
      ]) {
        await db.query(sql, [id])
        assert.equal((await listar()).status, 403)
        await db.query(restore, [id])
      }
      const sessionId = sessions.get(titular)!
      for (const invalid of [randomUUID(), sessions.get(aluno)!]) {
        sessions.set(titular, invalid)
        assert.equal((await listar()).status, 403)
      }
      sessions.set(titular, sessionId)
      for (const schema of ['public', 'examentech_private']) {
        await assert.rejects(db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE anon')
          return tx.query(`SELECT ${schema}.listar_minhas_matriculas()`)
        }), /permission denied/)
      }
    })

    await m.test('mudança de organização não libera as matrículas da organização anterior', async () => {
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [otherOrg, titular])
      assert.deepEqual(await (await listar()).json(), { matriculas: [] })
      await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, titular])
    })

    await m.test('reaplicação e consulta preservam dados, eventos e bloqueio de escrita; limite é de 50 mais recentes', async () => {
      const before = (await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows
      const events = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
      await migrate('016_listar_minhas_matriculas.sql')
      const { matriculas } = await (await listar(aluno)).json() as { matriculas: { id: string }[] }
      const expected = (await db.query<{ id: string }>(
        'SELECT id FROM public.turma_alunos WHERE aluno_id=$1 ORDER BY solicitado_em DESC,id DESC LIMIT 50', [aluno])).rows
      assert.equal(matriculas.length, 50)
      assert.deepEqual(matriculas.map(({ id }) => ({ id })), expected)
      assert.deepEqual((await db.query('SELECT * FROM public.turma_alunos ORDER BY id')).rows, before)
      assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, events)
      await assert.rejects(queryAs(titular, "UPDATE public.turma_alunos SET situacao='ATIVA'"), /permission denied/)
      await assert.rejects(queryAs(titular, 'DELETE FROM public.turma_alunos'), /permission denied/)
    })

    await m.test('API recusa identificação de outro aluno, filtros desconhecidos e sessão ausente', async () => {
      const { matriculas, transport } = apiFor(titular)
      for (const query of [`consulta=minhas&aluno_id=${aluno}`, 'consulta=todas', 'consulta=minhas&consulta=minhas']) {
        assert.equal((await matriculas.fetch(listRequest(query))).status, 400)
      }
      assert.equal((await matriculas.fetch(new Request('http://localhost/api/matriculas?consulta=minhas'))).status, 401)
      assert.equal(transport.mock.callCount(), 0)
    })

    await m.test('falha de Auth ou da RPC e dados inválidos não viram lista vazia', async () => {
      const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
      for (const status of [401, 500]) {
        const transport = t.mock.fn(async () => Response.json({ message: 'Falha de teste' }, { status }))
        assert.equal((await createMatriculasHandler(env, transport).fetch(listRequest())).status, status === 401 ? 401 : 503)
        assert.equal(transport.mock.callCount(), 1)
      }
      for (const reply of [null, {}, [{}], { code: 'XX000', message: 'Falha interna de teste' }]) {
        const handler = createMatriculasHandler(env, async (input) => new URL(String(input)).pathname === '/auth/v1/user'
          ? Response.json({ id: titular }) : Response.json(reply, { status: Array.isArray(reply) ? 200 : 400 }))
        assert.equal((await handler.fetch(listRequest())).status, 503)
      }
    })
  })
})
