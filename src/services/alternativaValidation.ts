import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation.ts'

export type DadosAlternativasRascunho = { questao_id: string; alternativas: string[]; ordem_correta: number }
export type AlternativaRascunho = {
  id: string; questao_id: string; texto: string; ordem: number; correta: boolean; criado_em: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function lerTextoAlternativa(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const texto = value.trim()
  return texto && [...texto].length <= 2000 && !texto.includes('\u0000') ? texto : null
}

export function lerDadosAlternativas(value: unknown): DadosAlternativasRascunho | null {
  if (!isRecord(value) || typeof value.questao_id !== 'string' || !UUID_PATTERN.test(value.questao_id) ||
      !Array.isArray(value.alternativas) || value.alternativas.length < 2 || value.alternativas.length > 5 ||
      typeof value.ordem_correta !== 'number' || !Number.isInteger(value.ordem_correta) ||
      value.ordem_correta < 1 || value.ordem_correta > value.alternativas.length) return null
  const alternativas: string[] = []
  for (const item of value.alternativas) {
    const texto = lerTextoAlternativa(item)
    if (!texto || alternativas.includes(texto)) return null
    alternativas.push(texto)
  }
  return { questao_id: value.questao_id.toLowerCase(), alternativas, ordem_correta: value.ordem_correta }
}

// Lista vazia representa uma questão objetiva ainda sem alternativas.
export function lerAlternativasRascunho(value: unknown, questaoId: string): AlternativaRascunho[] | null {
  if (!Array.isArray(value) || value.length === 1 || value.length > 5) return null
  const alternativas: AlternativaRascunho[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || !UUID_PATTERN.test(item.id) ||
        typeof item.questao_id !== 'string' || item.questao_id.toLowerCase() !== questaoId.toLowerCase() ||
        item.ordem !== index + 1 || typeof item.correta !== 'boolean') return null
    const texto = lerTextoAlternativa(item.texto)
    const criadoEm = lerDataComFuso(item.criado_em)
    const id = item.id.toLowerCase()
    if (!texto || !criadoEm || alternativas.some((other) => other.id === id || other.texto === texto)) return null
    alternativas.push({ id, questao_id: questaoId.toLowerCase(),
      texto, ordem: index + 1, correta: item.correta, criado_em: criadoEm })
  }
  return alternativas.length === 0 || alternativas.filter((item) => item.correta).length === 1 ? alternativas : null
}
