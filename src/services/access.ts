import type { SupabaseClient } from '@supabase/supabase-js'
import { decideProfileAccess } from './profileAccess.ts'

export type { AccessUser, Profile } from './profileAccess.ts'
import type { AccessUser } from './profileAccess.ts'

export type AccessState =
  | { kind: 'signed-out' }
  | { kind: 'setup-totp' }
  | { kind: 'verify-totp'; factorId: string }
  | { kind: 'denied'; message: string }
  | { kind: 'ready'; user: AccessUser }

export async function resolveAccess(supabase: SupabaseClient): Promise<AccessState> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()

  if (sessionError) {
    throw new Error('Não foi possível verificar a sessão. Tente novamente.')
  }

  if (!sessionData.session) {
    return { kind: 'signed-out' }
  }

  const { data: userData, error: userError } = await supabase.auth.getUser()

  if (userError || !userData.user) {
    throw new Error('Não foi possível confirmar sua identidade. Entre novamente.')
  }

  const { data: assurance, error: assuranceError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

  if (assuranceError || !assurance) {
    throw new Error('Não foi possível verificar a autenticação em duas etapas.')
  }

  if (assurance.currentLevel !== 'aal2') {
    const { data: factors, error: factorsError } =
      await supabase.auth.mfa.listFactors()

    if (factorsError || !factors) {
      throw new Error('Não foi possível consultar o segundo fator de acesso.')
    }

    const totp = factors.totp[0]

    return totp
      ? { kind: 'verify-totp', factorId: totp.id }
      : { kind: 'setup-totp' }
  }

  // O banco consulta o próprio perfil e registra o resultado após o MFA.
  // A função não recebe usuário nem resultado informados pelo navegador.
  const { data: record, error: auditError } = await supabase.rpc('registrar_acesso')

  if (auditError) {
    throw new Error('Não foi possível registrar seu acesso. Tente novamente.')
  }

  if (!record) {
    return { kind: 'denied', message: 'Seu perfil não foi encontrado. Procure o administrador.' }
  }

  return decideProfileAccess(record)
}
