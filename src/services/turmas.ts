import { supabase } from '../lib/supabase'

export type Turma = {
  id: string
  nome: string
  professor_id: string
  codigo_ingresso: string
  situacao: 'ATIVA' | 'INATIVA'
  criado_em: string
}

function isTurma(value: unknown): value is Turma {
  return typeof value === 'object' && value !== null &&
    'id' in value && typeof value.id === 'string' &&
    'nome' in value && typeof value.nome === 'string' &&
    'professor_id' in value && typeof value.professor_id === 'string' &&
    'codigo_ingresso' in value && typeof value.codigo_ingresso === 'string' &&
    'situacao' in value && ['ATIVA', 'INATIVA'].includes(String(value.situacao)) &&
    'criado_em' in value && typeof value.criado_em === 'string'
}

async function requestTurmas(nome?: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  const response = await fetch('/api/turmas', {
    method: nome === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      ...(nome === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: nome === undefined ? undefined : JSON.stringify({ nome }),
  })
  const result: unknown = await response.json()
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Resposta inválida do serviço de turmas.')
  }
  if (!response.ok) {
    const message = 'message' in result && typeof result.message === 'string'
      ? result.message
      : 'Não foi possível acessar as turmas.'
    throw new Error(message)
  }
  return result as Record<string, unknown>
}

export async function listarTurmas(): Promise<Turma[]> {
  const result = await requestTurmas()
  if (!Array.isArray(result.turmas) || !result.turmas.every(isTurma)) {
    throw new Error('Não foi possível interpretar a lista de turmas.')
  }
  return result.turmas
}

export async function criarTurma(nome: string): Promise<Turma> {
  const result = await requestTurmas(nome)
  if (!isTurma(result.turma)) throw new Error('Não foi possível confirmar a turma criada.')
  return result.turma
}
