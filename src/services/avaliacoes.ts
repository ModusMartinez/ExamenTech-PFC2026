import { supabase } from '../lib/supabase'
import { lerAvaliacaoRascunho, lerDadosAvaliacao } from './avaliacaoValidation'
import type { DadosAvaliacaoRascunho } from './avaliacaoValidation'

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
