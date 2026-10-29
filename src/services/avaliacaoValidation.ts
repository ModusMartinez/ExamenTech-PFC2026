export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CamposAvaliacaoRascunho = {
  titulo: string
  tipo: 'PROVA' | 'ATIVIDADE'
  inicio_em: string
  fim_em: string
  duracao_minutos: number
}

export type DadosAvaliacaoRascunho = CamposAvaliacaoRascunho & { turma_id: string }
export type DadosEdicaoAvaliacaoRascunho = CamposAvaliacaoRascunho & { avaliacao_id: string }

export type AvaliacaoRascunho = DadosAvaliacaoRascunho & {
  id: string
  professor_id: string
  situacao: 'RASCUNHO'
  criado_em: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function lerDataComFuso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/)
  if (!match || value.startsWith('0000-') || !Number.isFinite(Date.parse(value))) return null
  // Date.parse normaliza 30/02; a comparação impede aceitar essa data como março.
  const calendarDate = new Date(`${match[1]}T00:00:00Z`)
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== match[1]) return null
  return new Date(value).toISOString()
}

// Campos compartilhados pela criação, edição e resposta do banco.
function lerCamposAvaliacao(value: unknown): CamposAvaliacaoRascunho | null {
  if (!isRecord(value) || typeof value.titulo !== 'string' || (value.tipo !== 'PROVA' && value.tipo !== 'ATIVIDADE') ||
      typeof value.duracao_minutos !== 'number' || !Number.isInteger(value.duracao_minutos) ||
      value.duracao_minutos < 1 || value.duracao_minutos > 2147483647) return null

  const titulo = value.titulo.trim()
  const tamanho = [...titulo].length // Mesmo critério de caracteres do PostgreSQL, inclusive emojis.
  const inicio = lerDataComFuso(value.inicio_em)
  const fim = lerDataComFuso(value.fim_em)
  if (tamanho < 3 || tamanho > 150 || !inicio || !fim || Date.parse(fim) <= Date.parse(inicio)) return null
  return {
    titulo, tipo: value.tipo,
    inicio_em: inicio, fim_em: fim, duracao_minutos: value.duracao_minutos,
  }
}

export function lerDadosAvaliacao(value: unknown): DadosAvaliacaoRascunho | null {
  if (!isRecord(value) || typeof value.turma_id !== 'string' || !UUID_PATTERN.test(value.turma_id)) return null
  const campos = lerCamposAvaliacao(value)
  return campos ? { turma_id: value.turma_id.toLowerCase(), ...campos } : null
}

export function lerDadosEdicaoAvaliacao(value: unknown): DadosEdicaoAvaliacaoRascunho | null {
  if (!isRecord(value) || typeof value.avaliacao_id !== 'string' || !UUID_PATTERN.test(value.avaliacao_id)) return null
  const campos = lerCamposAvaliacao(value)
  return campos ? { avaliacao_id: value.avaliacao_id.toLowerCase(), ...campos } : null
}

export function lerAvaliacaoRascunho(value: unknown): AvaliacaoRascunho | null {
  const dados = lerDadosAvaliacao(value)
  if (!dados || !isRecord(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      typeof value.professor_id !== 'string' || !UUID_PATTERN.test(value.professor_id) ||
      value.situacao !== 'RASCUNHO') return null
  const criadoEm = lerDataComFuso(value.criado_em)
  if (!criadoEm) return null
  return {
    ...dados, id: value.id.toLowerCase(), professor_id: value.professor_id.toLowerCase(),
    situacao: 'RASCUNHO', criado_em: criadoEm,
  }
}
