import { supabase } from '../lib/supabase'
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
