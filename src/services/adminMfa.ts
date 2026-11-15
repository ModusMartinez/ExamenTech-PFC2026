import { supabase } from '../lib/supabase'
import { UUID_PATTERN } from './avaliacaoValidation'

export type UsuarioMfa = { id: string; nome: string; email: string; perfil: 'ALUNO' | 'PROFESSOR' }

async function token() {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  return data.session.access_token
}

async function resposta(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Resposta de redefinição inválida.')
  const result = body as Record<string, unknown>
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : 'Não foi possível confirmar a operação.')
  return result
}

export async function buscarUsuariosMfa(busca: string): Promise<UsuarioMfa[]> {
  const query = busca.trim()
  if (query.length < 3 || query.length > 120) throw new Error('Informe entre 3 e 120 caracteres do nome ou e-mail.')
  const bearer = await token()
  const response = await fetch(`/api/redefinir-mfa?${new URLSearchParams({ busca: query })}`, {
    method: 'GET', headers: { Authorization: `Bearer ${bearer}` }, cache: 'no-store',
  })
  const result = await resposta(response)
  if (!Array.isArray(result.usuarios) || !result.usuarios.every((u: unknown) => {
    if (!u || typeof u !== 'object') return false
    const item = u as Record<string, unknown>
    return typeof item.id === 'string' && UUID_PATTERN.test(item.id) && typeof item.nome === 'string' &&
      typeof item.email === 'string' && (item.perfil === 'ALUNO' || item.perfil === 'PROFESSOR')
  })) throw new Error('Não foi possível carregar os usuários.')
  return result.usuarios as UsuarioMfa[]
}

export async function redefinirMfa(usuarioId: string): Promise<void> {
  if (!UUID_PATTERN.test(usuarioId)) throw new Error('Usuário inválido.')
  const bearer = await token()
  try {
    const response = await fetch('/api/redefinir-mfa', {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      cache: 'no-store', body: JSON.stringify({ usuario_id: usuarioId, confirmado: true }),
    })
    const result = await resposta(response)
    if (result.redefinido !== true) throw new Error('Não foi possível confirmar a redefinição. Confira a auditoria antes de repetir.')
  } catch (error) {
    if (error instanceof Error && error.name !== 'TypeError' && error.name !== 'SyntaxError') throw error
    throw new Error('Não foi possível confirmar a redefinição. Confira a auditoria antes de repetir a operação.', { cause: error })
  }
}
