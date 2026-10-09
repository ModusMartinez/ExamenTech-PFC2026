import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { AuthError, createClient, type Session, type User } from '@supabase/supabase-js'
import { resolveAccess } from '../src/services/access.ts'

const activeProfile = {
  nome: 'Aluno de teste',
  email: 'aluno@exemplo.com',
  perfil: 'ALUNO',
  situacao: 'ATIVO',
}

const authUser: User = {
  id: '00000000-0000-4000-8000-000000000001',
  email: activeProfile.email,
  aud: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-10-09T12:00:00Z',
}

const authSession: Session = {
  user: authUser,
  access_token: 'token-de-teste',
  refresh_token: 'refresh-de-teste',
  token_type: 'bearer',
  expires_in: 3600,
}

function createAccessClient(t: TestContext, options: {
  session?: boolean
  validUser?: boolean
  aal?: 'aal1' | 'aal2'
  hasFactor?: boolean
  profile?: typeof activeProfile | null
  auditError?: boolean
} = {}) {
  // Cliente isolado, com Auth e RPC substituídos. O fetch bloqueia rede acidental.
  const client = createClient('https://exemplo.supabase.co', 'chave-publica-de-teste', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => { throw new Error('Rede não permitida neste teste.') } },
  })

  t.mock.method(client.auth, 'getSession', async () => ({
    data: { session: options.session === false ? null : authSession }, error: null,
  }))
  const getUser = t.mock.method(client.auth, 'getUser', async () => (
    options.validUser === false
      ? { data: { user: null }, error: new AuthError('Usuário não encontrado.') }
      : { data: { user: authUser }, error: null }
  ))
  const assurance = t.mock.method(client.auth.mfa, 'getAuthenticatorAssuranceLevel', async () => ({
    data: { currentLevel: options.aal ?? 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
    error: null,
  }))
  const factors = t.mock.method(client.auth.mfa, 'listFactors', async () => ({
    data: { totp: options.hasFactor ? [{ id: 'fator' }] : [] }, error: null,
  }))
  const registerAccess = t.mock.method(client, 'rpc', async () => ({
    data: options.profile === undefined ? activeProfile : options.profile,
    error: options.auditError ? { code: 'PGRST202' } : null,
  }))

  return { client, getUser, assurance, factors, registerAccess }
}

test('sem sessão retorna signed-out sem consultar identidade, MFA ou auditoria', async (t) => {
  const { client, getUser, assurance, registerAccess } = createAccessClient(t, { session: false })

  const result = await resolveAccess(client)

  assert.deepEqual(result, { kind: 'signed-out' })
  assert.equal(getUser.mock.callCount(), 0)
  assert.equal(assurance.mock.callCount(), 0)
  assert.equal(registerAccess.mock.callCount(), 0)
})

test('sessão sem MFA e sem fator TOTP pede configuração sem registrar acesso', async (t) => {
  const { client, factors, registerAccess } = createAccessClient(t, { aal: 'aal1' })

  const result = await resolveAccess(client)

  assert.deepEqual(result, { kind: 'setup-totp' })
  assert.equal(factors.mock.callCount(), 1)
  assert.equal(registerAccess.mock.callCount(), 0)
})

test('sessão sem MFA com fator TOTP pede verificação sem registrar acesso', async (t) => {
  const { client, registerAccess } = createAccessClient(t, { aal: 'aal1', hasFactor: true })

  const result = await resolveAccess(client)

  assert.deepEqual(result, { kind: 'verify-totp', factorId: 'fator' })
  assert.equal(registerAccess.mock.callCount(), 0)
})

test('identidade não confirmada lança Error com mensagem e não registra acesso', async (t) => {
  const { client, getUser, assurance, registerAccess } = createAccessClient(t, { validUser: false })

  await assert.rejects(resolveAccess(client), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.constructor, Error)
    assert.equal(error.message, 'Não foi possível confirmar sua identidade. Entre novamente.')
    return true
  })
  assert.equal(getUser.mock.callCount(), 1)
  assert.equal(assurance.mock.callCount(), 0)
  assert.equal(registerAccess.mock.callCount(), 0)
})

test('MFA confirmado registra acesso uma vez sem enviar identidade e libera perfil ativo', async (t) => {
  const { client, getUser, factors, registerAccess } = createAccessClient(t)

  const result = await resolveAccess(client)

  assert.deepEqual(result, {
    kind: 'ready',
    user: { name: activeProfile.nome, email: activeProfile.email, profile: 'Aluno' },
  })
  assert.equal(getUser.mock.callCount(), 1)
  assert.equal(factors.mock.callCount(), 0)
  assert.equal(registerAccess.mock.callCount(), 1)
  assert.deepEqual(registerAccess.mock.calls[0].arguments, ['registrar_acesso'])
})

for (const status of ['PENDENTE', 'INATIVO']) {
  test(`perfil ${status} após MFA passa pela auditoria e tem acesso negado`, async (t) => {
    const profile = { ...activeProfile, situacao: status }
    const { client, registerAccess } = createAccessClient(t, { profile })

    const result = await resolveAccess(client)

    assert.deepEqual(result, {
      kind: 'denied', message: 'Sua conta não está ativa. Procure o administrador.',
    })
    assert.equal(registerAccess.mock.callCount(), 1)
    assert.deepEqual(registerAccess.mock.calls[0].arguments, ['registrar_acesso'])
  })
}

test('perfil ausente após MFA não libera acesso e mantém a chamada de auditoria', async (t) => {
  const { client, registerAccess } = createAccessClient(t, { profile: null })

  const result = await resolveAccess(client)

  assert.deepEqual(result, {
    kind: 'denied', message: 'Seu perfil não foi encontrado. Procure o administrador.',
  })
  assert.equal(registerAccess.mock.callCount(), 1)
  assert.deepEqual(registerAccess.mock.calls[0].arguments, ['registrar_acesso'])
})

test('falha na auditoria lança Error com mensagem em vez de liberar o painel', async (t) => {
  const { client, registerAccess } = createAccessClient(t, { auditError: true })

  await assert.rejects(resolveAccess(client), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.constructor, Error)
    assert.equal(error.message, 'Não foi possível registrar seu acesso. Tente novamente.')
    return true
  })
  assert.equal(registerAccess.mock.callCount(), 1)
  assert.deepEqual(registerAccess.mock.calls[0].arguments, ['registrar_acesso'])
})
