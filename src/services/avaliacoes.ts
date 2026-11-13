import { supabase } from '../lib/supabase'
import { lerAvaliacaoPublicada, lerAvaliacaoRascunho, lerDadosAvaliacao, lerDadosEdicaoAvaliacao, lerDataComFuso, lerMinhasAvaliacoes, lerPublicacaoAvaliacao, UUID_PATTERN } from './avaliacaoValidation'
import type { DadosAvaliacaoRascunho, DadosEdicaoAvaliacaoRascunho } from './avaliacaoValidation'

export async function criarAvaliacaoRascunho(dados: DadosAvaliacaoRascunho) {
  const entrada = lerDadosAvaliacao(dados)
  if (!entrada) throw new Error('Confira os campos da avaliação.')
  return gravarAvaliacaoRascunho(entrada)
}

export async function editarAvaliacaoRascunho(dados: DadosEdicaoAvaliacaoRascunho) {
  const entrada = lerDadosEdicaoAvaliacao(dados)
  if (!entrada) throw new Error('Confira os campos da avaliação.')
  return gravarAvaliacaoRascunho(entrada)
}

async function gravarAvaliacaoRascunho(entrada: DadosAvaliacaoRascunho | DadosEdicaoAvaliacaoRascunho) {
  const editing = 'avaliacao_id' in entrada
  const notConfirmed = `Não foi possível confirmar a ${editing ? 'edição' : 'criação'}. Confira os rascunhos da turma antes de reenviar.`
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  let response: Response
  try {
    response = await fetch('/api/avaliacoes', {
      method: editing ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(entrada),
    })
  } catch {
    // O servidor pode ter gravado antes da queda da conexão. Não repetir a gravação.
    throw new Error(notConfirmed)
  }

  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw new Error(notConfirmed)
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(notConfirmed)
  }
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string'
      ? result.message : notConfirmed)
  }
  const avaliacao = lerAvaliacaoRascunho('avaliacao' in result ? result.avaliacao : null)
  if (response.status !== (editing ? 200 : 201) || !avaliacao || avaliacao.professor_id !== data.session.user.id ||
      (editing ? avaliacao.id !== entrada.avaliacao_id : avaliacao.turma_id !== entrada.turma_id) || avaliacao.titulo !== entrada.titulo ||
      avaliacao.tipo !== entrada.tipo || avaliacao.inicio_em !== entrada.inicio_em ||
      avaliacao.fim_em !== entrada.fim_em || avaliacao.duracao_minutos !== entrada.duracao_minutos) {
    throw new Error(notConfirmed)
  }
  return avaliacao
}

export function listarAvaliacoesRascunho(turmaId: string) {
  return listarAvaliacoes(turmaId, 'RASCUNHO', lerAvaliacaoRascunho)
}

export function listarAvaliacoesPublicadas(turmaId: string) {
  return listarAvaliacoes(turmaId, 'PUBLICADA', lerAvaliacaoPublicada)
}

export async function cancelarAvaliacao(avaliacaoId: string) {
  if (!UUID_PATTERN.test(avaliacaoId)) throw new Error('ID da avaliação inválido.')
  const { data, error } = await supabase.rpc('cancelar_avaliacao', { p_avaliacao_id: avaliacaoId })
  if (error?.code === '42501') throw new Error('O cancelamento exige o professor autor com MFA.')
  if (error?.code === '55000') throw new Error('Só é possível cancelar avaliações publicadas sem resultados divulgados.')
  const canceladaEm = lerDataComFuso(data?.cancelada_em)
  if (error || data?.id !== avaliacaoId || data.situacao !== 'CANCELADA' || !canceladaEm) {
    throw new Error('Não foi possível confirmar o cancelamento. Atualize a lista de avaliações e confira a situação.')
  }
  return canceladaEm
}

export async function listarMinhasAvaliacoes() {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  let response: Response
  try {
    response = await fetch('/api/minhas-avaliacoes', {
      method: 'GET', headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de avaliações. Confira sua conexão e tente novamente.')
  }
  const invalidResponse = 'Não foi possível conferir sua lista de avaliações.'
  let result: unknown
  try { result = await response.json() } catch { throw new Error(invalidResponse) }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(invalidResponse)
  if (!response.ok) throw new Error('message' in result && typeof result.message === 'string' ? result.message : invalidResponse)
  const avaliacoes = lerMinhasAvaliacoes('avaliacoes' in result ? result.avaliacoes : null)
  if (response.status !== 200 || !avaliacoes) throw new Error(invalidResponse)
  return avaliacoes
}

async function listarAvaliacoes<T extends { id: string; turma_id: string }>(
  turmaId: string, situacao: 'RASCUNHO' | 'PUBLICADA', lerAvaliacao: (value: unknown) => T | null,
): Promise<T[]> {
  if (!UUID_PATTERN.test(turmaId)) throw new Error('ID da turma inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  let response: Response
  try {
    const query = new URLSearchParams({ turma_id: turmaId.toLowerCase() })
    if (situacao === 'PUBLICADA') query.set('situacao', situacao)
    response = await fetch(`/api/avaliacoes?${query}`, {
      method: 'GET', headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de avaliações. Confira sua conexão e tente novamente.')
  }
  const invalidResponse = situacao === 'PUBLICADA' ? 'Não foi possível conferir a lista de publicadas.' : 'Não foi possível conferir a lista de rascunhos.'
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
  const avaliacoes: T[] = []
  for (const item of result.avaliacoes) {
    const avaliacao = lerAvaliacao(item)
    if (!avaliacao || avaliacao.turma_id !== turmaId.toLowerCase() ||
        avaliacoes.some((other) => other.id === avaliacao.id)) throw new Error(invalidResponse)
    avaliacoes.push(avaliacao)
  }
  return avaliacoes
}

export async function publicarAvaliacao(avaliacaoId: string) {
  if (!UUID_PATTERN.test(avaliacaoId)) throw new Error('ID da avaliação inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const failure = 'Não foi possível confirmar a publicação. Confira Publicadas e atualize os rascunhos antes de reenviar.'
  let response: Response
  try {
    response = await fetch('/api/publicar-avaliacao', {
      method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
      cache: 'no-store', body: JSON.stringify({ avaliacao_id: avaliacaoId.toLowerCase() }),
    })
  } catch { throw new Error(failure) }
  let result: unknown
  try { result = await response.json() } catch { throw new Error(failure) }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(failure)
  if (!response.ok) throw new Error('message' in result && typeof result.message === 'string' ? result.message : failure)
  const publicacao = lerPublicacaoAvaliacao('avaliacao' in result ? result.avaliacao : null)
  if (response.status !== 200 || !publicacao || publicacao.id !== avaliacaoId.toLowerCase()) throw new Error(failure)
  return publicacao
}
