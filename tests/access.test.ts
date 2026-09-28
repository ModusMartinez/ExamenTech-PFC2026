import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAccess } from '../src/services/access.ts'

const activeProfile = {
  nome: 'Aluno de teste',
  email: 'aluno@exemplo.com',
  perfil: 'ALUNO',
  situacao: 'ATIVO',
}

function createClient(options: {
  session?: boolean
  validUser?: boolean
  aal?: string
  hasFactor?: boolean
  profile?: typeof activeProfile | null
  auditError?: boolean
} = {}) {
  const calls: unknown[][] = []
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: options.session === false ? null : {} }, error: null,
      }),
      getUser: async () => ({
        data: { user: options.validUser === false ? null : { id: 'usuario' } }, error: null,
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: options.aal ?? 'aal2' }, error: null,
        }),
        listFactors: async () => ({
          data: { totp: options.hasFactor ? [{ id: 'fator' }] : [] }, error: null,
        }),
      },
    },
    rpc: async (...args: unknown[]) => {
      calls.push(args)
      return {
        data: options.profile === undefined ? activeProfile : options.profile,
        error: options.auditError ? { code: 'PGRST202' } : null,
      }
    },
  } as unknown as SupabaseClient

  return { client, calls }
}

test('não registra acesso sem sessão ou antes de confirmar MFA', async () => {
  for (const [options, expected] of [
    [{ session: false }, { kind: 'signed-out' }],
    [{ aal: 'aal1' }, { kind: 'setup-totp' }],
    [{ aal: 'aal1', hasFactor: true }, { kind: 'verify-totp', factorId: 'fator' }],
  ] as const) {
    const { client, calls } = createClient(options)
    assert.deepEqual(await resolveAccess(client), expected)
    assert.equal(calls.length, 0)
  }
})

test('confirma o usuário no Auth antes de pedir o registro de acesso', async () => {
  const { client, calls } = createClient({ validUser: false })
  await assert.rejects(resolveAccess(client), /confirmar sua identidade/)
  assert.equal(calls.length, 0)
})

test('após MFA chama o banco sem enviar identidade ou resultado do evento', async () => {
  const { client, calls } = createClient()
  assert.deepEqual(await resolveAccess(client), {
    kind: 'ready',
    user: { name: activeProfile.nome, email: activeProfile.email, profile: 'Aluno' },
  })
  assert.deepEqual(calls, [['registrar_acesso']])
})

test('perfil bloqueado também passa pela auditoria antes de negar o painel', async () => {
  for (const situacao of ['PENDENTE', 'INATIVO']) {
    const { client, calls } = createClient({ profile: { ...activeProfile, situacao } })
    assert.equal((await resolveAccess(client)).kind, 'denied')
    assert.deepEqual(calls, [['registrar_acesso']])
  }
})

test('perfil ausente não libera acesso e sua negativa já foi registrada pelo banco', async () => {
  const { client, calls } = createClient({ profile: null })
  assert.deepEqual(await resolveAccess(client), {
    kind: 'denied', message: 'Seu perfil não foi encontrado. Procure o administrador.',
  })
  assert.deepEqual(calls, [['registrar_acesso']])
})

test('falha na auditoria ou migration ausente não libera o painel', async () => {
  const { client } = createClient({ auditError: true })
  await assert.rejects(resolveAccess(client), /registrar seu acesso/)
})
