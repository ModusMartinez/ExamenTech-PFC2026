import type { SupabaseClient } from '@supabase/supabase-js'

// Avaliações e questões exigem o mesmo perfil; autoria e MFA também são conferidos pelo banco.
export async function conferirAcessoAvaliacoes(supabase: SupabaseClient, token: string) {
  const { data: identity, error: identityError } = await supabase.auth.getUser(token)
  if (identityError) {
    const invalidSession = [400, 401, 403].includes(identityError.status ?? 0)
    return {
      status: invalidSession ? 401 : 503,
      message: invalidSession ? 'Sessão inválida. Entre novamente.' : 'Não foi possível conferir sua sessão.',
    }
  }
  if (!identity.user) return { status: 401, message: 'Sessão inválida. Entre novamente.' }
  const { data: profileData, error: profileError } = await supabase.from('perfis')
    .select('perfil,situacao').eq('id', identity.user.id).maybeSingle()
  if (profileError) return { status: 503, message: 'Não foi possível conferir seu perfil.' }
  const profile: unknown = profileData
  if (!profile || typeof profile !== 'object' || !('situacao' in profile) || profile.situacao !== 'ATIVO' ||
      !('perfil' in profile) || (profile.perfil !== 'PROFESSOR' && profile.perfil !== 'ADMIN')) {
    return { status: 403, message: 'Seu perfil não permite esta operação. Confira também o MFA.' }
  }
  return { usuarioId: identity.user.id, perfil: profile.perfil }
}
