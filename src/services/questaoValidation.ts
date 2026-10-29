import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation.ts'

export type DadosQuestaoRascunho = {
  avaliacao_id: string
  tipo: 'OBJETIVA' | 'DISSERTATIVA'
  enunciado: string
  pontuacao: number
}

export type QuestaoRascunho = DadosQuestaoRascunho & {
  id: string
  ordem: number
  criado_em: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function enunciadoQuestaoValido(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const tamanho = [...value.trim()].length
  return tamanho >= 3 && tamanho <= 10000 && !value.includes('\u0000')
}

export function pontuacaoQuestaoValida(value: unknown): value is number {
  // Não arredonda o valor recebido nem depende da precisão binária de value * 100.
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 9999.99 &&
    Number(value.toFixed(2)) === value
}

export function lerDadosQuestao(value: unknown): DadosQuestaoRascunho | null {
  if (!isRecord(value) || typeof value.avaliacao_id !== 'string' || !UUID_PATTERN.test(value.avaliacao_id) ||
      (value.tipo !== 'OBJETIVA' && value.tipo !== 'DISSERTATIVA') ||
      !enunciadoQuestaoValido(value.enunciado) || !pontuacaoQuestaoValida(value.pontuacao)) return null
  return {
    avaliacao_id: value.avaliacao_id.toLowerCase(), tipo: value.tipo,
    enunciado: value.enunciado.trim(), pontuacao: value.pontuacao,
  }
}

export function lerQuestaoRascunho(value: unknown): QuestaoRascunho | null {
  const dados = lerDadosQuestao(value)
  if (!dados || !isRecord(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      typeof value.ordem !== 'number' || !Number.isInteger(value.ordem) ||
      value.ordem < 1 || value.ordem > 2147483647) return null
  const criadoEm = lerDataComFuso(value.criado_em)
  return criadoEm ? { ...dados, id: value.id.toLowerCase(), ordem: value.ordem, criado_em: criadoEm } : null
}
