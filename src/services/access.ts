import { supabase } from '../lib/supabase'
import { decideProfileAccess } from './profileAccess'

export type { AccessUser, Profile } from './profileAccess'
import type { AccessUser } from './profileAccess'

export type AccessState =
  | { kind: 'signed-out' }
  | { kind: 'setup-totp' }
  | { kind: 'verify-totp'; factorId: string }
  | { kind: 'denied'; message: string }
  | { kind: 'ready'; user: AccessUser }

export async function resolveAccess(): Promise<AccessState> {
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

  const { data: record, error: profileError } = await supabase
    .from('perfis')
    .select('nome, email, perfil, situacao')
    .eq('id', userData.user.id)
    .single()

  if (profileError || !record) {
    throw new Error('Seu perfil não foi encontrado. Procure o administrador.')
  }

  return decideProfileAccess(record)
}
