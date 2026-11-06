import { supabase } from '../lib/supabase'
import { UUID_PATTERN } from './avaliacaoValidation'
import { lerConteudoTentativa, lerTentativaIniciada } from './tentativaValidation'

async function lerResposta(response: Response, mensagemFalha: string): Promise<object> {
  let result: unknown
  try { result = await response.json() } catch { throw new Error(mensagemFalha) }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(mensagemFalha)
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string' && result.message.trim()
      ? result.message : mensagemFalha)
  }
  return result
}

export async function iniciarTentativa(avaliacaoId: string) {
  if (typeof avaliacaoId !== 'string' || !UUID_PATTERN.test(avaliacaoId)) throw new Error('ID da avaliação inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const notConfirmed = 'Não foi possível confirmar o início. A tentativa pode ter sido criada. Confira com o professor antes de tentar novamente.'

  let response: Response
  try {
    response = await fetch('/api/iniciar-tentativa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
      cache: 'no-store', body: JSON.stringify({ avaliacao_id: avaliacaoId.toLowerCase() }),
    })
  } catch {
    // O banco pode ter criado a tentativa antes da falha de rede. Não repetir o início.
    throw new Error(notConfirmed)
  }
  const result = await lerResposta(response, notConfirmed)
  const tentativa = lerTentativaIniciada('tentativa' in result ? result.tentativa : null)
  if (response.status !== 201 || !tentativa || tentativa.avaliacao_id !== avaliacaoId.toLowerCase() ||
      tentativa.aluno_id !== data.session.user.id.toLowerCase()) throw new Error(notConfirmed)
  return tentativa
}

export async function consultarConteudoTentativa(tentativaId: string) {
  if (typeof tentativaId !== 'string' || !UUID_PATTERN.test(tentativaId)) throw new Error('ID da tentativa inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const failure = 'Não foi possível carregar o conteúdo da tentativa.'

  let response: Response
  try {
    const query = new URLSearchParams({ tentativa_id: tentativaId.toLowerCase() })
    response = await fetch(`/api/conteudo-tentativa?${query}`, {
      method: 'GET', headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de avaliações. Confira sua conexão.')
  }
  const result = await lerResposta(response, failure)
  const conteudo = lerConteudoTentativa('conteudo' in result ? result.conteudo : null)
  if (response.status !== 200 || !conteudo || conteudo.tentativa_id !== tentativaId.toLowerCase()) throw new Error(failure)
  return conteudo
}
