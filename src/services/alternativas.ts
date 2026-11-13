import { supabase } from '../lib/supabase'
import { UUID_PATTERN } from './avaliacaoValidation'
import { lerAlternativasRascunho, lerDadosAlternativas } from './alternativaValidation'
import type { AlternativaRascunho, DadosAlternativasRascunho } from './alternativaValidation'

export async function listarAlternativasRascunho(questaoId: string) {
  if (!UUID_PATTERN.test(questaoId)) throw new Error('ID da questão inválido.')
  return requestAlternativas(questaoId.toLowerCase())
}

export async function cadastrarAlternativasRascunho(dados: DadosAlternativasRascunho) {
  const entrada = lerDadosAlternativas(dados)
  if (!entrada) throw new Error('Confira as alternativas e selecione a correta.')
  return requestAlternativas(entrada.questao_id, entrada)
}

async function requestAlternativas(questaoId: string, entrada?: DadosAlternativasRascunho): Promise<AlternativaRascunho[]> {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const failure = entrada
    ? 'Não foi possível confirmar o cadastro. Feche e reabra as alternativas antes de reenviar.'
    : 'Não foi possível consultar as alternativas. Tente novamente.'
  let response: Response
  try {
    response = await fetch(`/api/alternativas${entrada ? '' : `?${new URLSearchParams({ questao_id: questaoId })}`}`, {
      method: entrada ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${data.session.access_token}`, ...(entrada ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store', body: entrada ? JSON.stringify(entrada) : undefined,
    })
  } catch {
    // O cadastro pode ter concluído antes da falha de rede; não repetir o POST.
    throw new Error(failure)
  }
  let result: unknown
  try { result = await response.json() } catch { throw new Error(failure) }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(failure)
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string' ? result.message : failure)
  }
  const alternativas = lerAlternativasRascunho('alternativas' in result ? result.alternativas : null, questaoId)
  if (response.status !== (entrada ? 201 : 200) || !alternativas || (entrada && (
    alternativas.length !== entrada.alternativas.length || alternativas.some((item, index) =>
      item.texto !== entrada.alternativas[index] || item.correta !== (item.ordem === entrada.ordem_correta))))) {
    throw new Error(failure)
  }
  return alternativas
}
