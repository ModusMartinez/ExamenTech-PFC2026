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

export type PublicacaoAvaliacao = { id: string; situacao: 'PUBLICADA'; publicada_em: string }
export type AvaliacaoPublicada = Omit<AvaliacaoRascunho, 'situacao'> & PublicacaoAvaliacao
export type AvaliacaoAluno = DadosAvaliacaoRascunho & PublicacaoAvaliacao & { turma_nome: string }

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

function lerRegistroAvaliacao(value: unknown) {
  const dados = lerDadosAvaliacao(value)
  if (!dados || !isRecord(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      typeof value.professor_id !== 'string' || !UUID_PATTERN.test(value.professor_id)) return null
  const criadoEm = lerDataComFuso(value.criado_em)
  if (!criadoEm) return null
  return {
    ...dados, id: value.id.toLowerCase(), professor_id: value.professor_id.toLowerCase(),
    criado_em: criadoEm,
  }
}

export function lerAvaliacaoRascunho(value: unknown): AvaliacaoRascunho | null {
  if (!isRecord(value) || value.situacao !== 'RASCUNHO') return null
  const registro = lerRegistroAvaliacao(value)
  return registro ? { ...registro, situacao: 'RASCUNHO' } : null
}

export function lerPublicacaoAvaliacao(value: unknown): PublicacaoAvaliacao | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) || value.situacao !== 'PUBLICADA') return null
  const publicadaEm = lerDataComFuso(value.publicada_em)
  return publicadaEm ? { id: value.id.toLowerCase(), situacao: 'PUBLICADA', publicada_em: publicadaEm } : null
}

export function lerAvaliacaoPublicada(value: unknown): AvaliacaoPublicada | null {
  const registro = lerRegistroAvaliacao(value)
  const publicacao = lerPublicacaoAvaliacao(value)
  return registro && publicacao ? { ...registro, ...publicacao } : null
}

export function lerMinhasAvaliacoes(value: unknown): AvaliacaoAluno[] | null {
  if (!Array.isArray(value) || value.length > 50) return null
  const avaliacoes: AvaliacaoAluno[] = []
  const ids = new Set<string>()
  for (const item of value) {
    const dados = lerDadosAvaliacao(item)
    const publicacao = lerPublicacaoAvaliacao(item)
    if (!dados || !publicacao || !isRecord(item) || typeof item.turma_nome !== 'string' ||
        item.turma_nome.trim().length === 0 || [...item.turma_nome].length > 100 || ids.has(publicacao.id)) return null
    ids.add(publicacao.id)
    avaliacoes.push({ ...dados, ...publicacao, turma_nome: item.turma_nome })
  }
  return avaliacoes
}
