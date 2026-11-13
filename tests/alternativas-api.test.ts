import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'
import { createAlternativasHandler } from '../api/alternativas.ts'
import { lerAlternativasRascunho, lerDadosAlternativas } from '../src/services/alternativaValidation.ts'

test('API de alternativas integrada às regras do banco local', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, colega, aluno, admin, sessions, queryAs, turmaId, avaliacaoId } = await prepararBancoAvaliacoes(db)
  async function criarQuestao(tipo = 'OBJETIVA') {
    return (await queryAs<{ questao: { id: string } }>(professor,
      "SELECT public.criar_questao_rascunho($1,$2,'Questão para alternativas',1) AS questao", [avaliacaoId, tipo])).rows[0].questao.id
  }
  const questaoId = await criarQuestao()
  const body = { questao_id: questaoId.toUpperCase(), alternativas: ['  Alternativa A  ', 'Alternativa B'], ordem_correta: 2 }
  const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
  const events = async () => (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
  function request(method = 'GET', payload: unknown = body, query = method === 'GET' ? `?questao_id=${questaoId}` : '') {
    return new Request(`http://localhost/api/alternativas${query}`, {
      method, headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(payload) : undefined,
    })
  }
  // HTTP/Auth simulados; RLS, função SQL e auditoria executados no banco local.
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
        if (url.pathname === '/rest/v1/questoes') {
          assert.equal(url.searchParams.get('select'), 'id,tipo')
          return Response.json((await queryAs(id, 'SELECT id,tipo FROM public.questoes WHERE id=$1',
            [url.searchParams.get('id')?.slice(3)], aal)).rows)
        }
        if (url.pathname === '/rest/v1/alternativas') {
          assert.equal(url.searchParams.get('select'), 'id,questao_id,texto,ordem,correta,criado_em')
          assert.equal(url.searchParams.get('order'), 'ordem.asc')
          assert.equal(url.searchParams.get('limit'), '5')
          const result = await queryAs<{ alternativa: unknown }>(id,
            'SELECT to_jsonb(a) AS alternativa FROM public.alternativas a WHERE questao_id=$1 ORDER BY ordem LIMIT 5',
            [url.searchParams.get('questao_id')?.slice(3)], aal)
          return Response.json(result.rows.map((row) => row.alternativa))
        }
        if (url.pathname === '/rest/v1/rpc/criar_alternativas_rascunho') {
          assert.equal(req.method, 'POST')
          const params: Record<string, unknown> = await req.json()
          assert.deepEqual(Object.keys(params).sort(), ['p_alternativas', 'p_ordem_correta', 'p_questao_id'])
          return Response.json((await queryAs<{ alternativas: unknown }>(id,
            'SELECT public.criar_alternativas_rascunho($1,$2,$3) AS alternativas',
            [params.p_questao_id, params.p_alternativas, params.p_ordem_correta], aal)).rows[0].alternativas)
        }
        assert.fail(`Rota inesperada: ${url.pathname}`)
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'Detalhe interno' }, { status: 400 })
      }
    })
    return { transport, handler: createAlternativasHandler(env, transport) }
  }

  await t.test('consulta vazia, cadastro único com gabarito e auditoria; GET não gera evento', async () => {
    const { handler } = apiFor(professor)
    const empty = await handler.fetch(request())
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), { alternativas: [] })
    const response = await handler.fetch(request('POST'))
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const saved = await response.json()
    assert.deepEqual(saved.alternativas.map((item: { texto: string; ordem: number; correta: boolean }) => [item.texto, item.ordem, item.correta]),
      [['Alternativa A', 1, false], ['Alternativa B', 2, true]])
    const logged = (await db.query('SELECT usuario_id,evento,recurso_id FROM public.eventos_seguranca WHERE evento=$1', ['ALTERNATIVAS_CRIADAS'])).rows
    assert.deepEqual(logged, [{ usuario_id: professor, evento: 'ALTERNATIVAS_CRIADAS', recurso_id: questaoId }])
    const before = await events()
    assert.equal(JSON.stringify(before).includes('Alternativa A'), false)
    for (const id of [professor, admin]) {
      const listed = await apiFor(id).handler.fetch(request('GET', null, `?questao_id=${questaoId.toUpperCase()}`))
      assert.equal(listed.status, 200)
      assert.equal(listed.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await listed.json(), saved)
    }
    assert.equal((await handler.fetch(request('POST'))).status, 409)
    assert.deepEqual(await (await handler.fetch(request())).json(), saved)
    assert.deepEqual(await events(), before)
  })

  await t.test('entrada inválida é recusada antes do Auth; não aceita campos extras ou gabarito fora da lista', async () => {
    const { handler, transport } = apiFor(professor)
    const invalid: unknown[] = [null, [], {}, { ...body, questao_id: 'inválido' },
      { ...body, professor_id: professor }, { ...body, correta: true }, { ...body, id: randomUUID() }]
    for (const field of Object.keys(body)) invalid.push({ ...body, [field]: undefined })
    for (const alternativas of [null, 'A', [], ['A'], ['A', 'B', 'C', 'D', 'E', 'F'], ['A', ' A '],
      ['', 'B'], ['\n\t ', 'B'], [null, 'B'], [2, 'B'], [['A'], 'B'], ['A\u0000B', 'C'], ['📝'.repeat(2001), 'B']]) {
      invalid.push({ ...body, alternativas })
    }
    for (const ordem_correta of [0, -1, 3, 1.5, '2', true, null]) invalid.push({ ...body, ordem_correta })
    for (const payload of invalid) assert.equal((await handler.fetch(request('POST', payload))).status, 400)
    for (const query of ['', '?questao_id=inválido', `?questao_id=${questaoId}&questao_id=${questaoId}`, `?questao_id=${questaoId}&aluno_id=${aluno}`]) {
      assert.equal((await handler.fetch(request('GET', null, query))).status, 400)
    }
    assert.equal((await handler.fetch(request('POST', body, '?extra=1'))).status, 400)
    assert.equal((await handler.fetch(new Request('http://localhost/api/alternativas', {
      method: 'POST', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }, body: '{',
    }))).status, 400)
    const badType = request('POST'); badType.headers.set('Content-Type', 'text/plain')
    assert.equal((await handler.fetch(badType)).status, 415)
    const noToken = request(); noToken.headers.delete('Authorization')
    assert.equal((await handler.fetch(noToken)).status, 401)
    const unsupported = await handler.fetch(request('PATCH'))
    assert.equal(unsupported.status, 405)
    assert.equal(unsupported.headers.get('allow'), 'GET, POST')
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('aluno, outro professor, MFA, sessão e perfil/organização impedem acesso indevido ao gabarito', async () => {
    const before = await events()
    assert.equal((await apiFor(admin).handler.fetch(request('POST'))).status, 403)
    for (const [id, aal] of [[aluno, 'aal2'], [professor, 'aal1'], [admin, 'aal1']]) {
      for (const method of ['GET', 'POST']) assert.equal((await apiFor(id, aal).handler.fetch(request(method))).status, 403)
    }
    const other = await apiFor(colega).handler.fetch(request())
    const missing = await apiFor(professor).handler.fetch(request('GET', null, `?questao_id=${randomUUID()}`))
    assert.equal(other.status, 404); assert.equal(missing.status, 404)
    assert.deepEqual(await other.json(), await missing.json())
    assert.equal((await apiFor(colega).handler.fetch(request('POST'))).status, 404)
    const session = sessions.get(professor)!
    for (const invalidSession of [randomUUID(), sessions.get(colega)!]) {
      sessions.set(professor, invalidSession)
      assert.equal((await apiFor(professor).handler.fetch(request())).status, 404)
      assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 403)
    }
    sessions.set(professor, session)
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

  await t.test('aceita cinco alternativas Unicode no limite e recusa dissertativa e avaliação fora de rascunho', async () => {
    const id = await criarQuestao()
    const response = await apiFor(professor).handler.fetch(request('POST', {
      questao_id: id, alternativas: ['📝'.repeat(2000), 'B', 'C', 'D', 'E'], ordem_correta: 5,
    }))
    assert.equal(response.status, 201)
    const saved = (await response.json()).alternativas
    assert.equal(saved.length, 5); assert.equal(saved[4].correta, true)
    assert.equal([...saved[0].texto].length, 2000)
    const dissertativa = await criarQuestao('DISSERTATIVA')
    assert.equal((await apiFor(professor).handler.fetch(request('POST', { ...body, questao_id: dissertativa }))).status, 400)
    assert.equal((await apiFor(professor).handler.fetch(request('GET', null, `?questao_id=${dissertativa}`))).status, 400)
    await db.exec('ALTER TABLE public.avaliacoes DROP CONSTRAINT avaliacoes_situacao_check')
    for (const situacao of ['PUBLICADA', 'CANCELADA']) {
      await db.query('UPDATE public.avaliacoes SET situacao=$1 WHERE id=$2', [situacao, avaliacaoId])
      for (const id of [professor, admin]) assert.equal((await apiFor(id).handler.fetch(request())).status, 404)
      assert.equal((await apiFor(professor).handler.fetch(request('POST'))).status, 409)
    }
    await db.query("UPDATE public.avaliacoes SET situacao='RASCUNHO' WHERE id=$1", [avaliacaoId])
    await db.exec("ALTER TABLE public.avaliacoes ADD CONSTRAINT avaliacoes_situacao_check CHECK (situacao='RASCUNHO')")
  })

  await t.test('falha na auditoria desfaz todo o conjunto e não expõe detalhes internos', async () => {
    const id = await criarQuestao()
    const before = await events()
    await db.exec(`CREATE FUNCTION public.falhar_alternativas_api() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN IF NEW.evento = 'ALTERNATIVAS_CRIADAS' THEN RAISE EXCEPTION 'Detalhe interno'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER falhar_alternativas_api BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_alternativas_api();`)
    const response = await apiFor(professor).handler.fetch(request('POST', { ...body, questao_id: id }))
    assert.equal(response.status, 503)
    assert.equal(JSON.stringify(await response.json()).includes('Detalhe interno'), false)
    assert.deepEqual((await db.query('SELECT * FROM public.alternativas WHERE questao_id=$1', [id])).rows, [])
    assert.deepEqual(await events(), before)
    await db.exec('DROP TRIGGER falhar_alternativas_api ON public.eventos_seguranca; DROP FUNCTION public.falhar_alternativas_api();')
  })

  await t.test('perda da resposta após gravar não repete o POST; consulta recupera o conjunto', async () => {
    const id = await criarQuestao()
    const { transport } = apiFor(professor)
    let chamadasRpc = 0
    const handler = createAlternativasHandler(env, async (input, init) => {
      const response = await transport(input, init)
      if (new URL(new Request(input, init).url).pathname === '/rest/v1/rpc/criar_alternativas_rascunho') {
        chamadasRpc++
        throw new Error('Conexão perdida após a gravação')
      }
      return response
    })
    assert.equal((await handler.fetch(request('POST', { ...body, questao_id: id }))).status, 503)
    assert.equal(chamadasRpc, 1)
    const consulta = await apiFor(professor).handler.fetch(request('GET', null, `?questao_id=${id}`))
    assert.equal(consulta.status, 200)
    assert.equal((await consulta.json()).alternativas.length, 2)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE recurso_id=$1 AND evento='ALTERNATIVAS_CRIADAS'", [id])).rows.length, 1)
  })

  await t.test('falhas de Auth, consulta e resposta inválida não confirmam cadastro nem viram lista vazia', async () => {
    for (const [status, expected] of [[401, 401], [403, 401], [429, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'Detalhe interno' }, { status }))
      assert.equal((await createAlternativasHandler(env, transport).fetch(request())).status, expected)
      assert.equal(transport.mock.callCount(), 1)
    }
    assert.equal((await createAlternativasHandler({}).fetch(request())).status, 503)
    const failed = t.mock.fn(async () => { throw new Error('Sem conexão') })
    assert.equal((await createAlternativasHandler(env, failed).fetch(request('POST'))).status, 503)
    assert.equal(failed.mock.callCount(), 1)
    const saved = (await (await apiFor(professor).handler.fetch(request())).json()).alternativas
    const cases: [string, string, unknown, number, number][] = [
      ['perfis', 'GET', { code: 'XX000' }, 500, 503], ['perfis', 'GET', [], 200, 403],
      ['questoes', 'GET', { code: 'XX000' }, 500, 503], ['questoes', 'GET', [], 200, 404],
      ['questoes', 'GET', [{ id: randomUUID(), tipo: 'OBJETIVA' }], 200, 503],
      ['questoes', 'GET', [{ id: questaoId, tipo: 'DESCONHECIDA' }], 200, 503],
      ['alternativas', 'GET', { code: 'XX000' }, 500, 503],
      ...[null, [saved[0]], [saved[0], saved[0]], [...saved].reverse(), Array(6).fill(saved[0]),
        saved.map((item: object) => ({ ...item, correta: false })), saved.map((item: object) => ({ ...item, correta: true })),
        [{ ...saved[0], questao_id: randomUUID() }, saved[1]], [{ ...saved[0], correta: 'false' }, saved[1]],
        [{ ...saved[0], texto: saved[1].texto }, saved[1]], [{ ...saved[0], criado_em: 'inválido' }, saved[1]]]
        .map((value): [string, string, unknown, number, number] => ['alternativas', 'GET', value, 200, 503]),
      ...[null, [], [saved[0]], [{ ...saved[0], texto: 'Outro texto' }, saved[1]],
        saved.map((item: { correta: boolean }) => ({ ...item, correta: !item.correta }))]
        .map((value): [string, string, unknown, number, number] => ['rpc/criar_alternativas_rascunho', 'POST', value, 200, 503]),
      ...[['42501', 403], ['P0002', 404], ['55000', 409], ['23514', 400], ['XX000', 503]]
        .map(([code, expected]): [string, string, unknown, number, number] =>
          ['rpc/criar_alternativas_rascunho', 'POST', { code, message: 'Detalhe interno' }, 400, Number(expected)]),
    ]
    for (const [path, method, value, status, expected] of cases) {
      const { transport } = apiFor(professor)
      const handler = createAlternativasHandler(env, async (input, init) => {
        if (new URL(new Request(input, init).url).pathname === `/rest/v1/${path}`) return Response.json(value, { status })
        return transport(input, init)
      })
      const response = await handler.fetch(request(method))
      assert.equal(response.status, expected, `${method} ${path}`)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(JSON.stringify(await response.json()).includes('Detalhe interno'), false)
    }
    const sanitized = createAlternativasHandler(env, async (input, init) => {
      if (new URL(new Request(input, init).url).pathname === '/rest/v1/rpc/criar_alternativas_rascunho') {
        return Response.json(saved.map((item: object) => ({ ...item, campo_interno: 'Não devolver' })))
      }
      return apiFor(professor).transport(input, init)
    })
    const response = await sanitized.fetch(request('POST'))
    assert.equal(response.status, 201)
    assert.deepEqual(Object.keys((await response.json()).alternativas[0]).sort(), ['correta', 'criado_em', 'id', 'ordem', 'questao_id', 'texto'])
  })
})

test('contrato de alternativas valida tipos e normaliza textos, IDs e datas', () => {
  const id = randomUUID()
  const body = { questao_id: id.toUpperCase(), alternativas: [' A ', 'B'], ordem_correta: 1 }
  assert.deepEqual(lerDadosAlternativas(body), { questao_id: id, alternativas: ['A', 'B'], ordem_correta: 1 })
  for (const ordem_correta of [NaN, Infinity, -Infinity]) assert.equal(lerDadosAlternativas({ ...body, ordem_correta }), null)
  const saved = ['A', 'B'].map((texto, i) => ({ id: randomUUID(), questao_id: id, texto, ordem: i + 1,
    correta: i === 0, criado_em: '2026-11-04T10:00:00-03:00' }))
  assert.equal(lerAlternativasRascunho(saved, id)?.[0].criado_em, '2026-11-04T13:00:00.000Z')
  assert.equal(lerAlternativasRascunho([{ ...saved[0], id: 'inválido' }, saved[1]], id), null)
  assert.equal(lerAlternativasRascunho([{ ...saved[0], ordem: '1' }, saved[1]], id), null)
})
