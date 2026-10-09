import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createTurnstileHandler } from '../api/validar-turnstile.ts'

const environment = {
  NODE_ENV: 'test',
  TURNSTILE_SECRET_KEY: 'segredo-de-teste',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_chave-de-teste',
}
const rejectedToken = 'token-recusado'

type AuditRow = {
  id: string
  solicitacao_id: string
  evento: string
  provedor: string
  acao: string
  sucesso: boolean
  hostname: string | null
  codigos_erro: string[]
}

async function createIntegration(t: TestContext) {
  const db = new PGlite()
  t.after(() => db.close())

  // Apenas o esquema mínimo do Auth; as tabelas e regras do PFC vêm das migrações.
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, supabase_auth_admin;
    CREATE TABLE auth.users (
      id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB DEFAULT '{}'
    );
    CREATE TABLE auth.sessions (
      id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
    );
    CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}')
    $$;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT NULLIF(auth.jwt() ->> 'sub', '')::UUID
    $$;
  `)
  for (const migration of ['001_perfis.sql', '002_eventos_seguranca.sql', '006_auditoria_cadastro_login.sql']) {
    await db.exec(await readFile(new URL(`../database/${migration}`, import.meta.url), 'utf8'))
  }

  const createRequestId = t.mock.fn(randomUUID)
  const fetchImplementation = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    assert.equal(request.method, 'POST')

    if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const verification: unknown = await request.json()
      assert.ok(verification !== null && typeof verification === 'object')
      assert.ok('response' in verification && typeof verification.response === 'string')
      assert.ok('secret' in verification)
      assert.equal(verification.secret, environment.TURNSTILE_SECRET_KEY)
      const success = verification.response !== rejectedToken
      return Response.json({
        success, hostname: 'localhost', action: 'login',
        'error-codes': success ? [] : ['invalid-input-response'],
      })
    }

    if (request.url === `${environment.SUPABASE_URL}/rest/v1/eventos_seguranca`) {
      assert.equal(request.headers.get('apikey'), environment.SUPABASE_SECRET_KEY)
      assert.equal(request.headers.get('authorization'), null)
      const eventJson = await request.text()

      // Adaptador do transporte REST apenas para o teste. A gravação, os tipos,
      // as permissões e as constraints são executados pelo PostgreSQL real.
      await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role')
        await tx.query(`
          INSERT INTO public.eventos_seguranca (
            solicitacao_id, evento, provedor, acao, sucesso, hostname, codigos_erro
          )
          SELECT solicitacao_id, evento, provedor, acao, sucesso, hostname, codigos_erro
          FROM jsonb_populate_record(NULL::public.eventos_seguranca, $1::JSONB)
        `, [eventJson])
      })
      return new Response(null, { status: 201 })
    }

    throw new Error(`Requisição externa não prevista: ${request.url}`)
  })

  const handler = createTurnstileHandler({ env: environment, fetchImplementation, createRequestId })
  return { db, handler, createRequestId, fetchImplementation }
}

function createRequest(token?: string) {
  return new Request('http://localhost/api/validar-turnstile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token === undefined ? {} : { token }),
  })
}

async function readEvents(db: PGlite) {
  return (await db.query<AuditRow>(`
    SELECT id, solicitacao_id, evento, provedor, acao, sucesso, hostname, codigos_erro
    FROM public.eventos_seguranca
  `)).rows
}

test('POST /api/validar-turnstile com token válido retorna 200 e corpo de sucesso', async (t) => {
  const { handler, createRequestId, fetchImplementation } = await createIntegration(t)

  const response = await handler.fetch(createRequest('token-valido'))
  const payload: unknown = await response.json()

  assert.equal(response.status, 200)
  assert.equal(createRequestId.mock.callCount(), 1)
  assert.deepEqual(payload, {
    success: true,
    requestId: createRequestId.mock.calls[0].result,
    audited: true,
    message: 'Verificação de segurança concluída.',
  })
  assert.equal(fetchImplementation.mock.callCount(), 2)
})

test('POST /api/validar-turnstile com token recusado retorna 403 e persiste a rejeição', async (t) => {
  const { db, handler, createRequestId } = await createIntegration(t)

  const response = await handler.fetch(createRequest(rejectedToken))
  const payload: unknown = await response.json()
  const events = await readEvents(db)

  assert.equal(response.status, 403)
  assert.equal(createRequestId.mock.callCount(), 1)
  assert.deepEqual(payload, {
    success: false,
    requestId: createRequestId.mock.calls[0].result,
    audited: true,
    code: 'VERIFICACAO_RECUSADA',
    message: 'A verificação de segurança foi recusada. Tente novamente.',
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].solicitacao_id, createRequestId.mock.calls[0].result)
  assert.equal(events[0].evento, 'TURNSTILE_REJEITADO')
  assert.equal(events[0].sucesso, false)
  assert.deepEqual(events[0].codigos_erro, ['invalid-input-response'])
})

test('persistência salva e recupera evento de auditoria com ID e data gerados pelo banco', async (t) => {
  const { db } = await createIntegration(t)
  const requestId = randomUUID()

  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role')
    await tx.query(`
      INSERT INTO public.eventos_seguranca (solicitacao_id, evento, sucesso, hostname)
      VALUES ($1, 'TURNSTILE_VALIDADO', TRUE, 'localhost')
    `, [requestId])
  })
  const events = await readEvents(db)
  const timestamps = await db.query<{ registrado: boolean }>(`
    SELECT criado_em IS NOT NULL AS registrado
    FROM public.eventos_seguranca WHERE solicitacao_id = $1
  `, [requestId])

  assert.equal(events.length, 1)
  assert.match(events[0].id, /^[a-f0-9-]{36}$/)
  assert.deepEqual(events[0], {
    id: events[0].id, solicitacao_id: requestId, evento: 'TURNSTILE_VALIDADO',
    provedor: 'CLOUDFLARE_TURNSTILE', acao: 'login', sucesso: true,
    hostname: 'localhost', codigos_erro: [],
  })
  assert.deepEqual(timestamps.rows, [{ registrado: true }])
})

test('fluxo API, validação e banco registra solicitações distintas sem persistir tokens ou segredo', async (t) => {
  const { db, handler, createRequestId } = await createIntegration(t)
  const firstToken = 'token-sensivel-primeira-solicitacao'
  const secondToken = 'token-sensivel-segunda-solicitacao'

  const firstResponse = await handler.fetch(createRequest(firstToken))
  const secondResponse = await handler.fetch(createRequest(secondToken))
  const firstPayload: unknown = await firstResponse.json()
  const secondPayload: unknown = await secondResponse.json()
  const events = await readEvents(db)
  const storedRows = await db.query('SELECT * FROM public.eventos_seguranca')

  assert.equal(firstResponse.status, 200)
  assert.equal(secondResponse.status, 200)
  assert.equal(createRequestId.mock.callCount(), 2)
  const requestIds = createRequestId.mock.calls.map((call) => call.result)
  assert.notEqual(requestIds[0], requestIds[1])
  for (const [index, payload] of [firstPayload, secondPayload].entries()) {
    assert.deepEqual(payload, {
      success: true, requestId: requestIds[index], audited: true,
      message: 'Verificação de segurança concluída.',
    })
  }
  assert.equal(events.length, 2)
  assert.deepEqual(new Set(events.map((event) => event.solicitacao_id)), new Set(requestIds))
  for (const event of events) {
    assert.equal(event.evento, 'TURNSTILE_VALIDADO')
    assert.equal(event.sucesso, true)
    assert.equal(event.provedor, 'CLOUDFLARE_TURNSTILE')
    assert.equal(event.acao, 'login')
    assert.equal(event.hostname, 'localhost')
    assert.deepEqual(event.codigos_erro, [])
  }
  const storedJson = JSON.stringify(storedRows.rows)
  for (const sensitiveValue of [firstToken, secondToken, environment.TURNSTILE_SECRET_KEY]) {
    assert.equal(storedJson.includes(sensitiveValue), false)
  }
})

test('POST /api/validar-turnstile sem token retorna 400 sem consultar provedor ou gravar evento', async (t) => {
  const { db, handler, fetchImplementation } = await createIntegration(t)

  const response = await handler.fetch(createRequest())
  const payload: unknown = await response.json()

  assert.equal(response.status, 400)
  assert.deepEqual(payload, {
    success: false, code: 'TOKEN_INVALIDO',
    message: 'Conclua novamente a verificação de segurança.',
  })
  assert.equal(fetchImplementation.mock.callCount(), 0)
  assert.deepEqual(await readEvents(db), [])
})

test('falha real de unicidade na auditoria retorna 503 sem confirmar a validação', async (t) => {
  const { db, handler, createRequestId, fetchImplementation } = await createIntegration(t)
  const requestId = randomUUID()
  createRequestId.mock.mockImplementation(() => requestId)
  await db.query(`
    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, sucesso)
    VALUES ($1, 'TURNSTILE_REJEITADO', FALSE)
  `, [requestId])
  const eventsBefore = await readEvents(db)

  const response = await handler.fetch(createRequest('token-valido'))
  const payload: unknown = await response.json()

  assert.equal(response.status, 503)
  assert.deepEqual(payload, {
    success: false, requestId, audited: false, code: 'AUDITORIA_INDISPONIVEL',
    message: 'A verificação não pôde ser registrada. Tente novamente em instantes.',
  })
  assert.equal(fetchImplementation.mock.callCount(), 2)
  const auditWrite = fetchImplementation.mock.calls[1].result
  assert.ok(auditWrite)
  await assert.rejects(auditWrite, { code: '23505' })
  assert.deepEqual(await readEvents(db), eventsBefore)
})
