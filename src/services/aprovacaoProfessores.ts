import { supabase } from '../lib/supabase'
import { UUID_PATTERN, lerDataComFuso } from './avaliacaoValidation'

export type ProfessorPendente = { id: string; nome: string; email: string; organizacao: string; criado_em: string }

export async function listarProfessoresPendentes(): Promise<ProfessorPendente[]> {
  const { data, error } = await supabase.rpc('listar_professores_pendentes')
  if (error || !Array.isArray(data) || data.length > 50) throw new Error('Não foi possível carregar os professores pendentes.')
  return data.map((item: unknown) => {
    if (!item || typeof item !== 'object' ||
        !('id' in item) || typeof item.id !== 'string' || !UUID_PATTERN.test(item.id) ||
        !('nome' in item) || typeof item.nome !== 'string' ||
        !('email' in item) || typeof item.email !== 'string' ||
        !('organizacao' in item) || typeof item.organizacao !== 'string') {
      throw new Error('A lista de professores contém dados inválidos.')
    }
    const criadoEm = lerDataComFuso('criado_em' in item ? item.criado_em : null)
    if (!criadoEm) throw new Error('A lista de professores contém uma data inválida.')
    return { id: item.id, nome: item.nome, email: item.email, organizacao: item.organizacao, criado_em: criadoEm }
  })
}

export async function aprovarProfessor(id: string) {
  if (!UUID_PATTERN.test(id)) throw new Error('ID do professor inválido.')
  const { data, error } = await supabase.rpc('aprovar_professor', { p_professor_id: id })
  if (error || typeof data !== 'boolean') throw new Error('Não foi possível confirmar a aprovação. Atualize a lista.')
  return data
}
