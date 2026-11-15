import { supabase } from '../lib/supabase'

export type IngressoAluno = {
  fase: 'SEM_MATRICULA' | 'PENDENTE' | 'LIBERADO'
  acesso_liberado: boolean
  matriculas_pendentes: number
}

export function lerIngressoAluno(value: unknown): IngressoAluno | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (typeof data.fase !== 'string' || !['SEM_MATRICULA', 'PENDENTE', 'LIBERADO'].includes(data.fase) ||
      typeof data.acesso_liberado !== 'boolean' ||
      !Number.isSafeInteger(data.matriculas_pendentes) || Number(data.matriculas_pendentes) < 0 ||
      data.acesso_liberado !== (data.fase === 'LIBERADO') ||
      (data.fase === 'PENDENTE' && Number(data.matriculas_pendentes) === 0) ||
      (data.fase === 'SEM_MATRICULA' && data.matriculas_pendentes !== 0)) return null
  return data as IngressoAluno
}

export async function consultarIngressoAluno(): Promise<IngressoAluno> {
  const { data, error } = await supabase.rpc('consultar_ingresso_aluno')
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw new Error('A verificação de ingresso ainda não está disponível. Peça ao responsável para aplicar a migração 047.')
    }
    if (error.code === '42501') {
      throw new Error('Não foi possível confirmar seu ingresso. Entre novamente com o Authenticator e confira a situação da conta com o responsável.')
    }
    throw new Error('Não foi possível consultar seu ingresso. Tente novamente.')
  }
  const ingresso = lerIngressoAluno(data)
  if (!ingresso) throw new Error('A resposta de ingresso está inválida. Tente novamente ou procure o responsável.')
  return ingresso
}
