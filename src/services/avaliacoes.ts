import { supabase } from '../lib/supabase'
import { lerAvaliacaoRascunho, lerDadosAvaliacao, UUID_PATTERN } from './avaliacaoValidation'
import type { AvaliacaoRascunho, DadosAvaliacaoRascunho } from './avaliacaoValidation'

const CRIACAO_NAO_CONFIRMADA = 'Não foi possível confirmar a criação. Confira os rascunhos da turma antes de reenviar.'

export async function criarAvaliacaoRascunho(dados: DadosAvaliacaoRascunho) {
  const entrada = lerDadosAvaliacao(dados)
  if (!entrada) throw new Error('Confira os campos da avaliação.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  let response: Response
  try {
    response = await fetch('/api/avaliacoes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(entrada),
    })
  } catch {
    // O servidor pode ter gravado antes da queda da conexão. Não repetir o POST.
    throw new Error(CRIACAO_NAO_CONFIRMADA)
  }

  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw new Error(CRIACAO_NAO_CONFIRMADA)
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(CRIACAO_NAO_CONFIRMADA)
  }
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string'
      ? result.message : CRIACAO_NAO_CONFIRMADA)
  }
  const avaliacao = lerAvaliacaoRascunho('avaliacao' in result ? result.avaliacao : null)
  if (response.status !== 201 || !avaliacao || avaliacao.professor_id !== data.session.user.id ||
      avaliacao.turma_id !== entrada.turma_id || avaliacao.titulo !== entrada.titulo ||
      avaliacao.tipo !== entrada.tipo || avaliacao.inicio_em !== entrada.inicio_em ||
      avaliacao.fim_em !== entrada.fim_em || avaliacao.duracao_minutos !== entrada.duracao_minutos) {
    throw new Error(CRIACAO_NAO_CONFIRMADA)
  }
  return avaliacao
}

export async function listarAvaliacoesRascunho(turmaId: string): Promise<AvaliacaoRascunho[]> {
  if (!UUID_PATTERN.test(turmaId)) throw new Error('ID da turma inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  let response: Response
  try {
    response = await fetch(`/api/avaliacoes?${new URLSearchParams({ turma_id: turmaId.toLowerCase() })}`, {
      method: 'GET', headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de avaliações. Confira sua conexão e tente novamente.')
  }
  const invalidResponse = 'Não foi possível conferir a lista de rascunhos.'
  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw new Error(invalidResponse)
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(invalidResponse)
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string' ? result.message : invalidResponse)
  }
  if (response.status !== 200 || !('limite' in result) || result.limite !== 50 ||
      !('avaliacoes' in result) || !Array.isArray(result.avaliacoes) || result.avaliacoes.length > 50) {
    throw new Error(invalidResponse)
  }
  const avaliacoes: AvaliacaoRascunho[] = []
  for (const item of result.avaliacoes) {
    const avaliacao = lerAvaliacaoRascunho(item)
    if (!avaliacao || avaliacao.turma_id !== turmaId.toLowerCase() ||
        avaliacoes.some((other) => other.id === avaliacao.id)) throw new Error(invalidResponse)
    avaliacoes.push(avaliacao)
  }
  return avaliacoes
}
