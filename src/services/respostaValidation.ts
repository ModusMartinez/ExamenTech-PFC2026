import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation.ts'

export type DadosRespostaTentativa = {
  tentativa_id: string
  questao_id: string
  versao: number
  alternativa_id: string | null
  texto: string | null
}
export type RespostaTentativa = DadosRespostaTentativa & { id: string; criado_em: string; atualizado_em: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function lerDadosRespostaTentativa(value: unknown): DadosRespostaTentativa | null {
  if (!isRecord(value) || typeof value.tentativa_id !== 'string' || !UUID_PATTERN.test(value.tentativa_id) ||
      typeof value.questao_id !== 'string' || !UUID_PATTERN.test(value.questao_id) ||
      typeof value.versao !== 'number' || !Number.isInteger(value.versao) || value.versao < 1 || value.versao > 2147483647 ||
      !('alternativa_id' in value || 'texto' in value)) return null
  const alternativa = value.alternativa_id ?? null
  const texto = value.texto ?? null
  if (alternativa !== null && (typeof alternativa !== 'string' || !UUID_PATTERN.test(alternativa))) return null
  if (texto !== null && (typeof texto !== 'string' || [...texto].length > 10000 ||
      texto.includes('\u0000') || /[\uD800-\uDFFF]/u.test(texto))) return null
  if (alternativa !== null && texto !== null) return null

  // Preservar espaços e texto vazio; a 028 valida o tipo da questão e converte vazio em NULL.
  return { tentativa_id: value.tentativa_id.toLowerCase(), questao_id: value.questao_id.toLowerCase(),
    versao: value.versao, alternativa_id: alternativa?.toLowerCase() ?? null, texto }
}

export function lerRespostaTentativa(value: unknown): RespostaTentativa | null {
  const dados = lerDadosRespostaTentativa(value)
  if (!dados || !isRecord(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      !('alternativa_id' in value) || !('texto' in value) || dados.texto === '') return null
  const criadoEm = lerDataComFuso(value.criado_em)
  const atualizadoEm = lerDataComFuso(value.atualizado_em)
  if (!criadoEm || !atualizadoEm || Date.parse(atualizadoEm) < Date.parse(criadoEm)) return null
  return { ...dados, id: value.id.toLowerCase(), criado_em: criadoEm, atualizado_em: atualizadoEm }
}
