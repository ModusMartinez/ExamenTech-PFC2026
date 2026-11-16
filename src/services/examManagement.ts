import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation'

export type ResponsibleAttempt = {
  id: string; avaliacao_id: string; aluno_id: string; aluno_nome: string;
  situacao: 'EM_ANDAMENTO' | 'FINALIZADA' | 'INTERROMPIDA' | 'CANCELADA';
  iniciada_em: string; limite_em: string; encerrada_em: string | null; ciclo: number;
}

export type AttemptTimelineItem = {
  id: string
  ocorrido_em: string
  tipo: 'EVENTO' | 'FOTO'
  titulo: string
  detalhe: string
  situacao: string | null
  momento: string | null
  expira_em: string | null
}

export async function listarLinhaTempoTentativa(tentativaId: string): Promise<AttemptTimelineItem[]> {
  if (!UUID_PATTERN.test(tentativaId)) throw new Error('Tentativa inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('listar_linha_tempo_tentativa', { p_tentativa_id: tentativaId })
  if (error || !Array.isArray(data) || data.length > 500) {
    throw new Error(error?.code === '42501' ? 'Somente o professor responsável pode consultar esta linha do tempo.'
      : 'Não foi possível consultar a linha do tempo para seu acesso.')
  }
  return data.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Os registros da linha do tempo são inválidos.')
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || !UUID_PATTERN.test(item.id) ||
        (item.tipo !== 'EVENTO' && item.tipo !== 'FOTO') ||
        typeof item.titulo !== 'string' || typeof item.detalhe !== 'string' ||
        !lerDataComFuso(item.ocorrido_em) ||
        (item.situacao !== null && typeof item.situacao !== 'string') ||
        (item.momento !== null && typeof item.momento !== 'string') ||
        (item.expira_em !== null && !lerDataComFuso(item.expira_em))) {
      throw new Error('Os registros da linha do tempo são inválidos.')
    }
    return { id: item.id, ocorrido_em: item.ocorrido_em as string, tipo: item.tipo as AttemptTimelineItem['tipo'],
      titulo: item.titulo, detalhe: item.detalhe, situacao: item.situacao as string | null,
      momento: item.momento as string | null, expira_em: item.expira_em as string | null }
  })
}

export async function listarTentativasResponsavel(avaliacaoId: string): Promise<ResponsibleAttempt[]> {
  if (!UUID_PATTERN.test(avaliacaoId)) throw new Error('Avaliação inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('listar_tentativas_responsavel', { p_avaliacao_id: avaliacaoId })
  if (error || !Array.isArray(data) || data.length > 50) throw new Error('Não foi possível consultar tentativas para seu acesso.')
  return data.map(item => {
    if (!item || !UUID_PATTERN.test(item.id) || !UUID_PATTERN.test(item.aluno_id) || item.avaliacao_id !== avaliacaoId ||
        typeof item.aluno_nome !== 'string' || !item.aluno_nome.trim() ||
        !['EM_ANDAMENTO', 'FINALIZADA', 'INTERROMPIDA', 'CANCELADA'].includes(item.situacao) || !Number.isSafeInteger(item.ciclo) || item.ciclo < 1 ||
        !lerDataComFuso(item.iniciada_em) || !lerDataComFuso(item.limite_em) ||
        (item.encerrada_em !== null && !lerDataComFuso(item.encerrada_em))) throw new Error('Os dados das tentativas não puderam ser confirmados.')
    return { id: item.id, avaliacao_id: avaliacaoId, aluno_id: item.aluno_id, aluno_nome: item.aluno_nome,
      situacao: item.situacao, iniciada_em: item.iniciada_em, limite_em: item.limite_em,
      encerrada_em: item.encerrada_em, ciclo: item.ciclo }
  })
}
