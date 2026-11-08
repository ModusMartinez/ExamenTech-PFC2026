import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation'

export type ResponsibleAttempt = {
  id: string; avaliacao_id: string; aluno_id: string; aluno_nome: string;
  situacao: 'EM_ANDAMENTO' | 'FINALIZADA' | 'INTERROMPIDA';
  iniciada_em: string; limite_em: string; encerrada_em: string | null; ciclo: number; retomada_autorizada: boolean;
}

export async function listarTentativasResponsavel(avaliacaoId: string): Promise<ResponsibleAttempt[]> {
  if (!UUID_PATTERN.test(avaliacaoId)) throw new Error('Avaliação inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('listar_tentativas_responsavel', { p_avaliacao_id: avaliacaoId })
  if (error || !Array.isArray(data) || data.length > 50) throw new Error('Não foi possível consultar tentativas para seu acesso.')
  return data.map(item => {
    if (!item || !UUID_PATTERN.test(item.id) || !UUID_PATTERN.test(item.aluno_id) || item.avaliacao_id !== avaliacaoId ||
        typeof item.aluno_nome !== 'string' || !item.aluno_nome.trim() ||
        !['EM_ANDAMENTO', 'FINALIZADA', 'INTERROMPIDA'].includes(item.situacao) || !Number.isSafeInteger(item.ciclo) || item.ciclo < 1 ||
        typeof item.retomada_autorizada !== 'boolean' || !lerDataComFuso(item.iniciada_em) || !lerDataComFuso(item.limite_em) ||
        (item.encerrada_em !== null && !lerDataComFuso(item.encerrada_em))) throw new Error('Os dados das tentativas não puderam ser confirmados.')
    return { id: item.id, avaliacao_id: avaliacaoId, aluno_id: item.aluno_id, aluno_nome: item.aluno_nome,
      situacao: item.situacao, iniciada_em: item.iniciada_em, limite_em: item.limite_em,
      encerrada_em: item.encerrada_em, ciclo: item.ciclo, retomada_autorizada: item.retomada_autorizada }
  })
}

export async function reativarTentativa(tentativaId: string, motivo: string, minutos: number) {
  if (!UUID_PATTERN.test(tentativaId) || [...motivo.trim()].length < 5 || [...motivo.trim()].length > 500 ||
      !Number.isSafeInteger(minutos) || minutos < 1 || minutos > 1440) throw new Error('Informe uma justificativa de 5 a 500 caracteres e o tempo autorizado.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('reativar_tentativa', {
    p_tentativa_id: tentativaId, p_motivo: motivo.trim(), p_minutos: minutos,
  }).retry(false)
  if (error) throw new Error(error.code === '42501' ? 'Somente o professor responsável ou o ADM da organização pode reativar.'
    : error.code === '55000' ? 'A tentativa não está interrompida, já foi liberada ou a janela da avaliação terminou.'
      : 'Não foi possível confirmar a reativação. Atualize a lista antes de tentar novamente.')
  if (!data || data.id !== tentativaId || data.retomada_autorizada !== true || typeof data.liberacao_id !== 'string' ||
      !UUID_PATTERN.test(data.liberacao_id)) throw new Error('A reativação não foi confirmada. Atualize a lista antes de tentar novamente.')
}
