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

export function lerDadosQuestao(value: unknown): DadosQuestaoRascunho | null {
  if (!isRecord(value) || typeof value.avaliacao_id !== 'string' || !UUID_PATTERN.test(value.avaliacao_id) ||
      (value.tipo !== 'OBJETIVA' && value.tipo !== 'DISSERTATIVA') || typeof value.enunciado !== 'string' ||
      typeof value.pontuacao !== 'number' || !Number.isFinite(value.pontuacao) ||
      value.pontuacao <= 0 || value.pontuacao > 9999.99) return null
  const enunciado = value.enunciado.trim()
  const tamanho = [...enunciado].length
  // Compara sem arredondar o valor recebido; evita o erro binário de pontuacao * 100.
  if (tamanho < 3 || tamanho > 10000 || enunciado.includes('\u0000') ||
      Number(value.pontuacao.toFixed(2)) !== value.pontuacao) return null
  return {
    avaliacao_id: value.avaliacao_id.toLowerCase(), tipo: value.tipo,
    enunciado, pontuacao: value.pontuacao,
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
