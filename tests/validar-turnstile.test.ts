import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnstileHandler } from '../api/validar-turnstile.ts'

const requestId = '9fa12460-8567-4e30-b82d-79c91cf18029'

const environment = {
  TURNSTILE_SECRET_KEY: 'segredo-de-teste',
  SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste',
  NODE_ENV: 'test',
}

function createRequest(token?: string) {
  return new Request('http://localhost/api/validar-turnstile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token === undefined ? {} : { token }),
  })
}

test('aceita token válido e grava auditoria sem armazenar o token', async () => {
  const token = 'token-sensivel-nao-deve-ser-gravado'
  let auditBody = ''

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = input.toString()

    if (url.includes('siteverify')) {
      return Response.json({
        success: true,
        hostname: 'localhost',
        action: 'login',
        'error-codes': [],
      })
    }

    auditBody = String(init?.body ?? '')
    return new Response(null, { status: 201 })
  }

  const handler = createTurnstileHandler({
    env: environment,
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest(token))
  const payload = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 200)
  assert.equal(payload.success, true)
  assert.equal(payload.audited, true)
  assert.equal(payload.requestId, requestId)
  assert.equal(auditBody.includes(token), false)
  assert.match(auditBody, /TURNSTILE_VALIDADO/)
})

test('usa a chave secreta atual do Supabase somente no cabeçalho apikey', async () => {
  let auditHeaders = new Headers()

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = input.toString()

    if (url.includes('siteverify')) {
      return Response.json({
        success: true,
        hostname: 'localhost',
        action: 'login',
      })
    }

    auditHeaders = new Headers(init?.headers)
    return new Response(null, { status: 201 })
  }

  const handler = createTurnstileHandler({
    env: {
      ...environment,
      SUPABASE_SECRET_KEY: 'sb_secret_chave-de-teste',
    },
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-valido'))

  assert.equal(response.status, 200)
  assert.equal(auditHeaders.get('apikey'), 'sb_secret_chave-de-teste')
  assert.equal(auditHeaders.get('authorization'), null)
})

test('aceita a resposta simplificada da chave oficial de teste local', async () => {
  const fetchImplementation: typeof fetch = async (input) => {
    const url = input.toString()

    if (url.includes('siteverify')) {
      return Response.json({
        success: true,
        hostname: 'example.com',
      })
    }

    return new Response(null, { status: 201 })
  }

  const handler = createTurnstileHandler({
    env: {
      SUPABASE_URL: environment.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: environment.SUPABASE_SERVICE_ROLE_KEY,
      NODE_ENV: 'development',
    },
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-oficial-de-teste'))

  assert.equal(response.status, 200)
})

test('não usa chave de teste em ambientes de preview', async () => {
  let externalCalls = 0

  const handler = createTurnstileHandler({
    env: {
      VERCEL_ENV: 'preview',
      SUPABASE_URL: environment.SUPABASE_URL,
      SUPABASE_SECRET_KEY: 'sb_secret_chave-de-teste',
    },
    fetchImplementation: async () => {
      externalCalls += 1
      return Response.json({ success: true })
    },
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-de-teste'))
  const payload = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 500)
  assert.equal(payload.code, 'SERVICO_NAO_CONFIGURADO')
  assert.equal(externalCalls, 0)
})

test('não presume ambiente local quando NODE_ENV não está definido', async () => {
  let externalCalls = 0

  const handler = createTurnstileHandler({
    env: {
      SUPABASE_URL: environment.SUPABASE_URL,
      SUPABASE_SECRET_KEY: 'sb_secret_chave-de-teste',
    },
    fetchImplementation: async () => {
      externalCalls += 1
      return Response.json({ success: true })
    },
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-de-teste'))

  assert.equal(response.status, 500)
  assert.equal(externalCalls, 0)
})

test('bloqueia token recusado e registra a rejeição', async () => {
  let auditBody = ''

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = input.toString()

    if (url.includes('siteverify')) {
      return Response.json({
        success: false,
        'error-codes': ['invalid-input-response'],
      })
    }

    auditBody = String(init?.body ?? '')
    return new Response(null, { status: 201 })
  }

  const handler = createTurnstileHandler({
    env: environment,
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-invalido'))
  const payload = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 403)
  assert.equal(payload.success, false)
  assert.equal(payload.audited, true)
  assert.match(auditBody, /TURNSTILE_REJEITADO/)
  assert.match(auditBody, /invalid-input-response/)
})

test('rejeita token válido emitido para outra ação', async () => {
  let auditBody = ''

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = input.toString()

    if (url.includes('siteverify')) {
      return Response.json({
        success: true,
        hostname: 'localhost',
        action: 'cadastro',
      })
    }

    auditBody = String(init?.body ?? '')
    return new Response(null, { status: 201 })
  }

  const handler = createTurnstileHandler({
    env: environment,
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-outra-acao'))

  assert.equal(response.status, 403)
  assert.match(auditBody, /action-mismatch/)
})

test('rejeita token emitido para hostname fora da lista permitida', async () => {
  let auditBody = ''

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = input.toString()

    if (url.includes('siteverify')) {
      return Response.json({
        success: true,
        hostname: 'dominio-indevido.example',
        action: 'login',
      })
    }

    auditBody = String(init?.body ?? '')
    return new Response(null, { status: 201 })
  }

  const handler = createTurnstileHandler({
    env: {
      ...environment,
      TURNSTILE_EXPECTED_HOSTNAMES: 'app.exemplo.com,www.exemplo.com',
    },
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-outro-hostname'))

  assert.equal(response.status, 403)
  assert.match(auditBody, /hostname-mismatch/)
})

test('falha de forma segura quando a auditoria não pode ser gravada', async () => {
  const fetchImplementation: typeof fetch = async (input) => {
    const url = input.toString()

    if (url.includes('siteverify')) {
      return Response.json({ success: true, action: 'login' })
    }

    return new Response(null, { status: 500 })
  }

  const handler = createTurnstileHandler({
    env: environment,
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest('token-valido'))
  const payload = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 503)
  assert.equal(payload.success, false)
  assert.equal(payload.code, 'AUDITORIA_INDISPONIVEL')
})

test('rejeita requisição sem token antes de chamar serviços externos', async () => {
  let calls = 0

  const fetchImplementation: typeof fetch = async () => {
    calls += 1
    return new Response(null, { status: 500 })
  }

  const handler = createTurnstileHandler({
    env: environment,
    fetchImplementation,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(createRequest())

  assert.equal(response.status, 400)
  assert.equal(calls, 0)
})

test('aceita somente o método POST', async () => {
  const handler = createTurnstileHandler({
    env: environment,
    createRequestId: () => requestId,
  })

  const response = await handler.fetch(
    new Request('http://localhost/api/validar-turnstile'),
  )

  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
})
