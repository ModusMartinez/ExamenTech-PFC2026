import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation'
import { enunciadoQuestaoValido, pontuacaoQuestaoValida } from './questaoValidation'

export type QuestaoCorrecao = {
  id: string
  tipo: 'OBJETIVA' | 'DISSERTATIVA'
  ordem: number
  enunciado: string
  maximo: number
  resposta: string | null
  gabarito: string | null
  pontos: number | null
  comentario: string | null
  versao: number
}

export type CorrecaoTentativa = {
  tentativa_id: string
  pontos_obtidos: number
  pontos_totais: number
  pendentes: number
  nota: number | null
  publicado_em?: string
  questoes: QuestaoCorrecao[]
}

export const LIMITE_COMENTARIO_CORRECAO = 2000

function registro(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function pontosCorrecaoValidos(value: unknown, maximo: number): value is number {
  return value === 0 || (pontuacaoQuestaoValida(value) && value <= maximo)
}

function lerQuestao(value: unknown): QuestaoCorrecao | null {
  if (!registro(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      (value.tipo !== 'OBJETIVA' && value.tipo !== 'DISSERTATIVA') ||
      typeof value.ordem !== 'number' || !Number.isSafeInteger(value.ordem) || value.ordem < 1 ||
      !enunciadoQuestaoValido(value.enunciado) || !pontuacaoQuestaoValida(value.maximo) ||
      (value.resposta !== null && typeof value.resposta !== 'string') ||
      (value.gabarito !== null && typeof value.gabarito !== 'string') ||
      (value.pontos !== null && !pontosCorrecaoValidos(value.pontos, value.maximo)) ||
      (value.comentario !== null && typeof value.comentario !== 'string') ||
      typeof value.versao !== 'number' || !Number.isSafeInteger(value.versao) || value.versao < 0) return null
  return { id: value.id, tipo: value.tipo, ordem: value.ordem, enunciado: value.enunciado, maximo: value.maximo,
    resposta: value.resposta, gabarito: value.gabarito, pontos: value.pontos, comentario: value.comentario, versao: value.versao }
}

export function lerCorrecao(value: unknown, tentativaId: string): CorrecaoTentativa {
  const falha = 'Não foi possível confirmar os dados da correção.'
  if (!registro(value) || value.tentativa_id !== tentativaId || !Array.isArray(value.questoes) || !value.questoes.length ||
      typeof value.pontos_obtidos !== 'number' || !Number.isFinite(value.pontos_obtidos) || value.pontos_obtidos < 0 ||
      typeof value.pontos_totais !== 'number' || !Number.isFinite(value.pontos_totais) || value.pontos_totais <= 0 ||
      value.pontos_obtidos > value.pontos_totais || typeof value.pendentes !== 'number' ||
      (value.nota !== null && !pontosCorrecaoValidos(value.nota, 10))) throw new Error(falha)
  const questoes: QuestaoCorrecao[] = []
  for (const item of value.questoes) {
    const questao = lerQuestao(item)
    if (!questao) throw new Error(falha)
    questoes.push(questao)
  }
  if (questoes.filter(questao => questao.pontos === null).length !== value.pendentes ||
      (value.nota === null) !== (value.pendentes > 0)) throw new Error(falha)
  const publicadoEm = lerDataComFuso(value.publicado_em)
  if (value.publicado_em != null && !publicadoEm) throw new Error(falha)
  return { tentativa_id: tentativaId, pontos_obtidos: value.pontos_obtidos, pontos_totais: value.pontos_totais,
    pendentes: value.pendentes, nota: value.nota, questoes, ...(publicadoEm ? { publicado_em: publicadoEm } : {}) }
}

export async function consultarCorrecaoTentativa(tentativaId: string) {
  if (!UUID_PATTERN.test(tentativaId)) throw new Error('Tentativa inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('consultar_correcao_tentativa', { p_tentativa_id: tentativaId })
  if (error) throw new Error(error.code === '42501' ? 'Somente o professor autor pode acessar a correção.'
    : error.code === '55000' ? 'A correção exige uma tentativa finalizada.' : 'Não foi possível consultar a correção.')
  return lerCorrecao(data, tentativaId.toLowerCase())
}

export async function salvarCorrecaoDissertativa(tentativaId: string, questao: QuestaoCorrecao, pontos: number, comentario: string) {
  if (!UUID_PATTERN.test(tentativaId) || !UUID_PATTERN.test(questao.id) || questao.tipo !== 'DISSERTATIVA' ||
      !questao.resposta || !pontosCorrecaoValidos(pontos, questao.maximo) || comentario.includes('\u0000') ||
      [...comentario].length > LIMITE_COMENTARIO_CORRECAO) throw new Error('Confira a pontuação e o comentário da correção.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('corrigir_dissertativa', {
    p_tentativa_id: tentativaId, p_questao_id: questao.id, p_pontos: pontos, p_comentario: comentario.trim() || null,
    p_versao: questao.versao,
  }).retry(false)
  if (error) {
    if (error.code === '40001') throw new Error('A correção mudou. Atualize antes de salvar.')
    if (error.code === '42501') throw new Error('Somente o professor autor pode salvar a correção.')
    if (error.code === '23514') throw new Error('Confira a pontuação e o comentário da correção.')
    if (error.code === '55000') throw new Error('A correção já foi publicada ou está indisponível. Atualize para conferir.')
    throw new Error('Não foi possível confirmar o salvamento da correção.')
  }
  return lerCorrecao(data, tentativaId.toLowerCase())
}
