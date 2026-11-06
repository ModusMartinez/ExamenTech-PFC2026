import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation.ts'

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
