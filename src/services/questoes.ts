import { supabase } from '../lib/supabase'
import { UUID_PATTERN } from './avaliacaoValidation'
import { lerDadosQuestao, lerQuestaoRascunho } from './questaoValidation'
import type { DadosQuestaoRascunho, QuestaoRascunho } from './questaoValidation'

export async function criarQuestaoRascunho(dados: DadosQuestaoRascunho): Promise<QuestaoRascunho> {
  const entrada = lerDadosQuestao(dados)
  if (!entrada) throw new Error('Confira os campos da questão.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const notConfirmed = 'Não foi possível confirmar a criação. Verifique se a questão foi salva antes de reenviar.'

  let response: Response
  try {
    response = await fetch('/api/questoes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(entrada),
    })
  } catch {
    // A gravação pode ter concluído antes da falha de rede; não repete o POST.
    throw new Error(notConfirmed)
  }
  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw new Error(notConfirmed)
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(notConfirmed)
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string' ? result.message : notConfirmed)
  }
  const questao = lerQuestaoRascunho('questao' in result ? result.questao : null)
  if (response.status !== 201 || !questao || questao.avaliacao_id !== entrada.avaliacao_id ||
      questao.tipo !== entrada.tipo || questao.enunciado !== entrada.enunciado || questao.pontuacao !== entrada.pontuacao) {
    throw new Error(notConfirmed)
  }
  return questao
}

export async function listarQuestoesRascunho(avaliacaoId: string): Promise<QuestaoRascunho[]> {
  if (!UUID_PATTERN.test(avaliacaoId)) throw new Error('ID da avaliação inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  let response: Response
  try {
    response = await fetch(`/api/questoes?${new URLSearchParams({ avaliacao_id: avaliacaoId.toLowerCase() })}`, {
      method: 'GET', headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de questões. Confira sua conexão e tente novamente.')
  }
  const invalidResponse = 'Não foi possível conferir a lista de questões.'
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
      !('questoes' in result) || !Array.isArray(result.questoes) || result.questoes.length > 50) {
    throw new Error(invalidResponse)
  }
  const questoes: QuestaoRascunho[] = []
  for (const item of result.questoes) {
    const questao = lerQuestaoRascunho(item)
    if (!questao || questao.avaliacao_id !== avaliacaoId.toLowerCase() ||
        questoes.some((other) => other.id === questao.id) || questao.ordem <= (questoes.at(-1)?.ordem ?? 0)) {
      throw new Error(invalidResponse)
    }
    questoes.push(questao)
  }
  return questoes
}
