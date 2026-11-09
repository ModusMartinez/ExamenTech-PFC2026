import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createQuestoesHandler } from '../api/questoes.ts'
import { lerDadosQuestao, lerQuestaoRascunho } from '../src/services/questaoValidation.ts'

test('API de questões integrada às regras do banco local', async (t) => {
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
  for (const file of ['001_perfis.sql', '002_eventos_seguranca.sql', '004_convites_organizacoes.sql',
    '006_auditoria_cadastro_login.sql', '011_turmas.sql', '012_matriculas.sql',
    '019_avaliacoes_rascunho.sql', '020_editar_avaliacao_rascunho.sql',
    '021_questoes_rascunho.sql', '022_alternativas_rascunho.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  const org = randomUUID()
  const professor = randomUUID(), colega = randomUUID(), aluno = randomUUID(), admin = randomUUID()
  const sessions = new Map<string, string>()
  await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Escola fictícia','123456789012345678901')", [org])
  for (const [id, perfil] of [[professor, 'PROFESSOR'], [colega, 'PROFESSOR'], [aluno, 'ALUNO'], [admin, 'ADMIN']]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, `${id}@example.test`])
    await db.query("UPDATE public.perfis SET perfil=$1,situacao='ATIVO',organizacao_id=$2 WHERE id=$3", [perfil, org, id])
    const session = randomUUID()
    sessions.set(id, session)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [session, id])
  }
  async function queryAs<T = Record<string, unknown>>(id: string, sql: string, params: unknown[] = [], aal = 'aal2') {
    return db.transaction(async (tx) => {
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, aal, session_id: sessions.get(id) })])
      await tx.exec('SET LOCAL ROLE authenticated')
      return tx.query<T>(sql, params)
    })
  }
  const turmaId = (await queryAs<{ id: string }>(professor, "INSERT INTO public.turmas(nome) VALUES ('Turma de teste') RETURNING id")).rows[0].id
  await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, aluno])
  async function createAssessment() {
    return (await queryAs<{ avaliacao: { id: string } }>(professor,
      "SELECT public.criar_avaliacao_rascunho($1,'Prova de teste','PROVA','2026-11-09T19:00:00Z','2026-11-09T21:00:00Z',60) AS avaliacao", [turmaId])).rows[0].avaliacao.id
  }
  const avaliacaoId = await createAssessment()
  const body = { avaliacao_id: avaliacaoId.toUpperCase(), tipo: 'OBJETIVA', enunciado: '  Questão criada pela API  ', pontuacao: 0.29 }
  const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
  const events = async () => (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
  function request(method = 'GET', payload: unknown = body, query = method === 'GET' ? `?avaliacao_id=${avaliacaoId}` : '') {
    return new Request(`http://localhost/api/questoes${query}`, {
      method, headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(payload) : undefined,
    })
  }
  // Auth e HTTP simulados; funções SQL, RLS, constraints e transações executadas no PGlite.
  function apiFor(id: string, aal = 'aal2') {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      assert.equal(req.headers.get('apikey'), 'public-test-key')
      assert.equal(req.headers.get('authorization'), 'Bearer test-session')
      if (url.pathname === '/auth/v1/user') return Response.json({ id, app_metadata: {}, user_metadata: {} })
      try {
        if (url.pathname === '/rest/v1/perfis') {
          assert.equal(url.searchParams.get('id'), `eq.${id}`)
          return Response.json((await queryAs(id, 'SELECT perfil,situacao FROM public.perfis WHERE id=$1', [id], aal)).rows)
        }
        if (url.pathname === '/rest/v1/avaliacoes') {
          assert.equal(url.searchParams.get('select'), 'id,situacao')
          assert.equal(url.searchParams.get('situacao'), 'eq.RASCUNHO')
          return Response.json((await queryAs(id, "SELECT id,situacao FROM public.avaliacoes WHERE id=$1 AND situacao='RASCUNHO'",
            [url.searchParams.get('id')?.slice(3)], aal)).rows)
        }
        if (url.pathname === '/rest/v1/questoes') {
          assert.equal(url.searchParams.get('select'), 'id,avaliacao_id,tipo,enunciado,pontuacao,ordem,criado_em')
          assert.equal(url.searchParams.get('order'), 'ordem.asc')
          assert.equal(url.searchParams.get('limit'), '50')
          const result = await queryAs<{ questao: unknown }>(id,
            'SELECT to_jsonb(q) AS questao FROM public.questoes q WHERE avaliacao_id=$1 ORDER BY ordem LIMIT 50',
            [url.searchParams.get('avaliacao_id')?.slice(3)], aal)
          return Response.json(result.rows.map((row) => row.questao))
        }
        if (url.pathname === '/rest/v1/rpc/criar_questao_rascunho') {
          assert.equal(req.method, 'POST')
          const params: Record<string, unknown> = await req.json()
          assert.deepEqual(Object.keys(params).sort(), ['p_avaliacao_id', 'p_enunciado', 'p_pontuacao', 'p_tipo'])
          return Response.json((await queryAs<{ questao: unknown }>(id,
            'SELECT public.criar_questao_rascunho($1,$2,$3,$4) AS questao',
            [params.p_avaliacao_id, params.p_tipo, params.p_enunciado, params.p_pontuacao], aal)).rows[0].questao)
        }
        assert.fail(`Rota inesperada: ${url.pathname}`)
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'Detalhe interno' }, { status: 400 })
      }
    })
    return { transport, handler: createQuestoesHandler(env, transport) }
  }

  await t.test('cria ambos os tipos, mantém ordem e auditoria e consulta sem gabarito nem novo evento', async () => {
    const { handler } = apiFor(professor)
    for (const [index, tipo] of ['OBJETIVA', 'DISSERTATIVA'].entries()) {
      const response = await handler.fetch(request('POST', { ...body, tipo }))
      assert.equal(response.status, 201)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const { questao } = await response.json()
      assert.equal(questao.avaliacao_id, avaliacaoId)
      assert.equal(questao.tipo, tipo)
      assert.equal(questao.enunciado, body.enunciado.trim())
      assert.equal(questao.pontuacao, 0.29)
      assert.equal(questao.ordem, index + 1)
      assert.ok(questao.id)
      assert.ok(questao.criado_em)
      const logged = (await db.query<{ usuario_id: string; evento: string }>(
        'SELECT usuario_id,evento FROM public.eventos_seguranca WHERE recurso_id=$1', [questao.id])).rows
      assert.deepEqual(logged, [{ usuario_id: professor, evento: 'QUESTAO_CRIADA' }])
      if (tipo === 'OBJETIVA') await queryAs(professor,
        "SELECT public.criar_alternativas_rascunho($1,ARRAY['Alternativa A','Alternativa B'],2)", [questao.id])
      const before = await events()
      const listed = await handler.fetch(request())
      assert.equal(listed.status, 200)
      assert.equal(listed.headers.get('cache-control'), 'no-store')
      const { questoes, limite } = await listed.json()
      assert.equal(limite, 50)
      assert.deepEqual(questoes[index], questao)
      assert.equal(JSON.stringify(questoes).includes('correta'), false)
      assert.equal(JSON.stringify(questoes).includes('Alternativa A'), false)
      assert.deepEqual(await events(), before)
    }
    const emptyId = await createAssessment()
    const empty = await handler.fetch(request('GET', null, `?avaliacao_id=${emptyId}`))
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), { questoes: [], limite: 50 })
  })

  await t.test('valida entrada antes de chamar Auth, sem aceitar campos extras ou números em texto', async () => {
    const { handler, transport } = apiFor(professor)
    const invalid: unknown[] = [null, [], {}, { ...body, alternativas: [] }, { ...body, professor_id: professor },
      { ...body, id: randomUUID() }, { ...body, ordem: 1 }, { ...body, criado_em: '2026-10-29' }]
    for (const field of Object.keys(body)) invalid.push({ ...body, [field]: undefined })
    for (const pontuacao of ['2.5', null, 0, -1, 0.001, 2.555, 10000]) invalid.push({ ...body, pontuacao })
    for (const enunciado of ['', 'AB', '\t\n ', 'A'.repeat(10001), 'A\u0000B']) invalid.push({ ...body, enunciado })
    invalid.push({ ...body, tipo: 'PROVA' }, { ...body, avaliacao_id: 'inválido' })
    for (const payload of invalid) assert.equal((await handler.fetch(request('POST', payload))).status, 400)
    for (const query of ['', '?avaliacao_id=inválido', `?avaliacao_id=${avaliacaoId}&avaliacao_id=${avaliacaoId}`, `?avaliacao_id=${avaliacaoId}&aluno_id=${aluno}`]) {
      assert.equal((await handler.fetch(request('GET', null, query))).status, 400)
    }
    assert.equal((await handler.fetch(request('POST', body, '?extra=1'))).status, 400)
    const badJson = new Request('http://localhost/api/questoes', { method: 'POST', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }, body: '{' })
    assert.equal((await handler.fetch(badJson)).status, 400)
    const badType = request('POST'); badType.headers.set('Content-Type', 'text/plain')
    assert.equal((await handler.fetch(badType)).status, 415)
    const noToken = request(); noToken.headers.delete('Authorization')
    assert.equal((await handler.fetch(noToken)).status, 401)
    const unsupported = await handler.fetch(request('PATCH'))
    assert.equal(unsupported.status, 405)
    assert.equal(unsupported.headers.get('allow'), 'GET, POST')
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('mantém autorização por perfil, MFA, sessão, organização, autoria e situação da turma', async () => {
    const before = await events()
    assert.equal((await apiFor(admin).handler.fetch(request())).status, 200)
    assert.equal((await apiFor(admin).handler.fetch(request('POST'))).status, 403)
    for (const [id, aal] of [[aluno, 'aal2'], [professor, 'aal1'], [admin, 'aal1']]) {
      for (const method of ['GET', 'POST']) assert.equal((await apiFor(id, aal).handler.fetch(request(method))).status, 403)
    }
    const other = await apiFor(colega).handler.fetch(request())
    const missing = await apiFor(professor).handler.fetch(request('GET', null, `?avaliacao_id=${randomUUID()}`))
    assert.equal(other.status, 404); assert.equal(missing.status, 404)
    assert.deepEqual(await other.json(), await missing.json())
    assert.equal((await apiFor(colega).handler.fetch(request('POST'))).status, 404)
    const sessionId = sessions.get(professor)!
    for (const session of [randomUUID(), sessions.get(colega)!]) {
      sessions.set(professor, session)
      assert.equal((await apiFor(professor).handler.fetch(request())).status, 404)
      assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 403)
    }
    sessions.set(professor, sessionId)
    await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [professor])
    for (const method of ['GET', 'POST']) assert.equal((await apiFor(professor).handler.fetch(request(method))).status, 403)
    await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [professor])
    await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [org])
    assert.equal((await apiFor(professor).handler.fetch(request())).status, 404)
    assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 403)
    await db.query("UPDATE public.organizacoes SET situacao='ATIVO' WHERE id=$1", [org])
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    assert.equal((await apiFor(professor).handler.fetch(request())).status, 200)
    assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 409)
    await db.query("UPDATE public.turmas SET situacao='ATIVA',professor_id=$1 WHERE id=$2", [colega, turmaId])
    for (const id of [professor, colega]) for (const method of ['GET', 'POST']) {
      assert.equal((await apiFor(id).handler.fetch(request(method))).status, 404)
    }
    await db.query('UPDATE public.turmas SET professor_id=$1 WHERE id=$2', [professor, turmaId])
    assert.deepEqual(await events(), before)
  })

  await t.test('limita a 50 questões em ordem e aceita limites de texto Unicode e pontuação', async () => {
    const id = await createAssessment()
    const { handler } = apiFor(professor)
    const response = await handler.fetch(request('POST', { ...body, avaliacao_id: id, enunciado: '📝'.repeat(10000), pontuacao: 9999.99 }))
    assert.equal(response.status, 201)
    await db.query(`INSERT INTO public.questoes(avaliacao_id,tipo,enunciado,pontuacao,ordem)
      SELECT $1,'OBJETIVA','Questão ' || n,0.01,n FROM generate_series(2,55) n`, [id])
    const listed = await handler.fetch(request('GET', null, `?avaliacao_id=${id.toUpperCase()}`))
    assert.equal(listed.status, 200)
    const { questoes } = await listed.json()
    assert.equal(questoes.length, 50)
    assert.deepEqual(questoes.map((q: { ordem: number }) => q.ordem), Array.from({ length: 50 }, (_, i) => i + 1))
    assert.equal(questoes[0].pontuacao, 9999.99)
    assert.equal(questoes[1].pontuacao, 0.01)
  })

  await t.test('recusa avaliações fora de rascunho e desfaz a criação se a auditoria falhar', async () => {
    const before = (await db.query('SELECT * FROM public.questoes ORDER BY id')).rows
    const beforeEvents = await events()
    await db.exec('ALTER TABLE public.avaliacoes DROP CONSTRAINT avaliacoes_situacao_check')
    for (const situacao of ['PUBLICADA', 'CANCELADA']) {
      await db.query('UPDATE public.avaliacoes SET situacao=$1 WHERE id=$2', [situacao, avaliacaoId])
      assert.equal((await apiFor(professor).handler.fetch(request())).status, 404)
      assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 409)
    }
    await db.query("UPDATE public.avaliacoes SET situacao='RASCUNHO' WHERE id=$1", [avaliacaoId])
    await db.exec(`ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_situacao_check CHECK (situacao='RASCUNHO');
      CREATE FUNCTION public.falhar_questao_api() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.evento = 'QUESTAO_CRIADA' THEN RAISE EXCEPTION 'Detalhe interno'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER falhar_questao_api BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_questao_api();`)
    const response = await apiFor(professor).handler.fetch(request('POST'))
    assert.equal(response.status, 503)
    assert.equal(JSON.stringify(await response.json()).includes('Detalhe interno'), false)
    await db.exec('DROP TRIGGER falhar_questao_api ON public.eventos_seguranca; DROP FUNCTION public.falhar_questao_api();')
    assert.deepEqual((await db.query('SELECT * FROM public.questoes ORDER BY id')).rows, before)
    assert.deepEqual(await events(), beforeEvents)
  })

  await t.test('falhas de Auth, transporte e respostas inválidas não confirmam gravação nem viram lista vazia', async () => {
    for (const [status, expected] of [[401, 401], [403, 401], [429, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'Detalhe interno' }, { status }))
      assert.equal((await createQuestoesHandler(env, transport).fetch(request())).status, expected)
      assert.equal(transport.mock.callCount(), 1)
    }
    assert.equal((await createQuestoesHandler({}).fetch(request())).status, 503)
    assert.equal((await createQuestoesHandler(env, async () => { throw new Error('Rede indisponível') }).fetch(request())).status, 503)
    const sample = (await (await apiFor(professor).handler.fetch(request('POST'))).json()).questao
    const cases: [string, string, unknown, number, number][] = [
      ['perfis', 'GET', { code: 'XX000' }, 500, 503], ['perfis', 'GET', [], 200, 403],
      ['avaliacoes', 'GET', { code: 'XX000' }, 500, 503], ['avaliacoes', 'GET', [], 200, 404],
      ['avaliacoes', 'GET', [{ id: randomUUID(), situacao: 'RASCUNHO' }], 200, 503],
      ['avaliacoes', 'GET', [{ id: avaliacaoId, situacao: 'PUBLICADA' }], 200, 503],
      ['questoes', 'GET', { code: 'XX000' }, 500, 503], ['questoes', 'GET', null, 200, 503],
      ['questoes', 'GET', [sample, sample], 200, 503], ['questoes', 'GET', Array(51).fill(sample), 200, 503],
      ['questoes', 'GET', [{ ...sample, avaliacao_id: randomUUID() }], 200, 503],
      ['questoes', 'GET', [{ ...sample, pontuacao: '0.29' }], 200, 503],
      ['questoes', 'GET', [sample, { ...sample, id: randomUUID(), ordem: 1 }], 200, 503],
      ['rpc/criar_questao_rascunho', 'POST', null, 200, 503],
      ...['avaliacao_id', 'tipo', 'enunciado', 'pontuacao'].map((field): [string, string, unknown, number, number] =>
        ['rpc/criar_questao_rascunho', 'POST', { ...sample, [field]: field === 'avaliacao_id' ? randomUUID() : field === 'pontuacao' ? 2 : 'Outro' }, 200, 503]),
      ...[['42501', 403], ['P0002', 404], ['55000', 409], ['23514', 400], ['XX000', 503]].map(([code, expected]): [string, string, unknown, number, number] =>
        ['rpc/criar_questao_rascunho', 'POST', { code, message: 'Detalhe interno' }, 400, Number(expected)]),
    ]
    for (const [path, method, responseBody, status, expected] of cases) {
      const { transport } = apiFor(professor)
      const handler = createQuestoesHandler(env, async (input, init) => {
        if (new URL(new Request(input, init).url).pathname === `/rest/v1/${path}`) return Response.json(responseBody, { status })
        return transport(input, init)
      })
      const response = await handler.fetch(request(method))
      assert.equal(response.status, expected, `${method} ${path}`)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(JSON.stringify(await response.json()).includes('Detalhe interno'), false)
    }
    const extra = createQuestoesHandler(env, async (input, init) => {
      if (new URL(new Request(input, init).url).pathname === '/rest/v1/rpc/criar_questao_rascunho') {
        return Response.json({ ...sample, correta: true, alternativas: ['Não devolver'] })
      }
      return apiFor(professor).transport(input, init)
    })
    const sanitized = await extra.fetch(request('POST'))
    assert.equal(sanitized.status, 201)
    assert.deepEqual(Object.keys((await sanitized.json()).questao).sort(),
      ['avaliacao_id', 'criado_em', 'enunciado', 'id', 'ordem', 'pontuacao', 'tipo'])
  })
})

test('contrato de questões valida decimais sem arredondar e datas da resposta', () => {
  const body = { avaliacao_id: randomUUID(), tipo: 'OBJETIVA', enunciado: 'Enunciado válido', pontuacao: 0.29 }
  for (const pontuacao of [0.01, 0.07, 0.29, 1, 1.23, 2.5, 9999.99]) assert.ok(lerDadosQuestao({ ...body, pontuacao }))
  for (const pontuacao of [NaN, Infinity, -Infinity, 1.005, 0.001, '1', true]) assert.equal(lerDadosQuestao({ ...body, pontuacao }), null)
  const saved = { ...body, id: randomUUID(), ordem: 1, criado_em: '2026-10-29T10:00:00-03:00' }
  assert.equal(lerQuestaoRascunho(saved)?.criado_em, '2026-10-29T13:00:00.000Z')
  for (const ordem of [0, -1, 1.5, 2147483648, '1']) assert.equal(lerQuestaoRascunho({ ...saved, ordem }), null)
  for (const criado_em of ['2026-02-30T10:00:00Z', '2026-10-29', 'inválido']) assert.equal(lerQuestaoRascunho({ ...saved, criado_em }), null)
})
