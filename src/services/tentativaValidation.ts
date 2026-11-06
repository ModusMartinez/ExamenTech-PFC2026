import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation.ts'
import { lerTextoAlternativa } from './alternativaValidation.ts'
import { enunciadoQuestaoValido, pontuacaoQuestaoValida } from './questaoValidation.ts'

export type TentativaIniciada = {
  id: string
  avaliacao_id: string
  aluno_id: string
  situacao: 'EM_ANDAMENTO'
  iniciada_em: string
  limite_em: string
}

export function lerTentativaIniciada(value: unknown): TentativaIniciada | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('id' in value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      !('avaliacao_id' in value) || typeof value.avaliacao_id !== 'string' || !UUID_PATTERN.test(value.avaliacao_id) ||
      !('aluno_id' in value) || typeof value.aluno_id !== 'string' || !UUID_PATTERN.test(value.aluno_id) ||
      !('situacao' in value) || value.situacao !== 'EM_ANDAMENTO') return null
  const iniciadaEm = lerDataComFuso('iniciada_em' in value ? value.iniciada_em : null)
  const limiteEm = lerDataComFuso('limite_em' in value ? value.limite_em : null)
  if (!iniciadaEm || !limiteEm || Date.parse(limiteEm) <= Date.parse(iniciadaEm)) return null
  return {
    id: value.id.toLowerCase(), avaliacao_id: value.avaliacao_id.toLowerCase(), aluno_id: value.aluno_id.toLowerCase(),
    situacao: 'EM_ANDAMENTO', iniciada_em: iniciadaEm, limite_em: limiteEm,
  }
}

export type AlternativaTentativa = { id: string; texto: string; ordem: number }
export type QuestaoTentativa = {
  id: string
  tipo: 'OBJETIVA' | 'DISSERTATIVA'
  enunciado: string
  pontuacao: number
  ordem: number
  alternativas: AlternativaTentativa[]
}
export type ConteudoTentativa = {
  tentativa_id: string
  avaliacao_id: string
  titulo: string
  tipo: 'PROVA' | 'ATIVIDADE'
  iniciada_em: string
  limite_em: string
  questoes: QuestaoTentativa[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function lerConteudoTentativa(value: unknown): ConteudoTentativa | null {
  if (!isRecord(value) || typeof value.tentativa_id !== 'string' || !UUID_PATTERN.test(value.tentativa_id) ||
      typeof value.avaliacao_id !== 'string' || !UUID_PATTERN.test(value.avaliacao_id) ||
      typeof value.titulo !== 'string' || (value.tipo !== 'PROVA' && value.tipo !== 'ATIVIDADE') ||
      !Array.isArray(value.questoes) || value.questoes.length === 0) return null
  const titulo = value.titulo.trim()
  const iniciadaEm = lerDataComFuso(value.iniciada_em)
  const limiteEm = lerDataComFuso(value.limite_em)
  if ([...titulo].length < 3 || [...titulo].length > 150 || titulo.includes('\u0000') ||
      !iniciadaEm || !limiteEm || Date.parse(limiteEm) <= Date.parse(iniciadaEm)) return null

  const questoes: QuestaoTentativa[] = []
  const idsQuestoes = new Set<string>()
  const idsAlternativas = new Set<string>()
  for (const [index, item] of value.questoes.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || !UUID_PATTERN.test(item.id) ||
        (item.tipo !== 'OBJETIVA' && item.tipo !== 'DISSERTATIVA') || item.ordem !== index + 1 ||
        !enunciadoQuestaoValido(item.enunciado) || !pontuacaoQuestaoValida(item.pontuacao) ||
        !Array.isArray(item.alternativas)) return null
    const id = item.id.toLowerCase()
    if (idsQuestoes.has(id)) return null
    idsQuestoes.add(id)
    if (item.tipo === 'DISSERTATIVA' ? item.alternativas.length !== 0
      : item.alternativas.length < 2 || item.alternativas.length > 5) return null

    const alternativas: AlternativaTentativa[] = []
    for (const [posicao, alternativa] of item.alternativas.entries()) {
      if (!isRecord(alternativa) || typeof alternativa.id !== 'string' || !UUID_PATTERN.test(alternativa.id) ||
          alternativa.ordem !== posicao + 1) return null
      const alternativaId = alternativa.id.toLowerCase()
      const texto = lerTextoAlternativa(alternativa.texto)
      if (!texto || idsAlternativas.has(alternativaId) || alternativas.some(a => a.texto === texto)) return null
      idsAlternativas.add(alternativaId)
      alternativas.push({ id: alternativaId, texto, ordem: posicao + 1 })
    }
    questoes.push({ id, tipo: item.tipo, enunciado: item.enunciado.trim(),
      pontuacao: item.pontuacao, ordem: index + 1, alternativas })
  }

  // Campos permitidos em todos os níveis, mesmo se a RPC passar a devolver colunas internas.
  return {
    tentativa_id: value.tentativa_id.toLowerCase(), avaliacao_id: value.avaliacao_id.toLowerCase(),
    titulo, tipo: value.tipo, iniciada_em: iniciadaEm, limite_em: limiteEm, questoes,
  }
}
