import { supabase } from '../lib/supabase'

type MatriculaSolicitada = {
  id: string
  turma_id: string
  turma_nome: string
  situacao: 'PENDENTE'
  solicitado_em: string
}

export async function solicitarMatricula(codigo: string): Promise<MatriculaSolicitada> {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  let response: Response
  try {
    response = await fetch('/api/matriculas', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ codigo: codigo.trim().toUpperCase() }),
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de matrículas. Confira sua conexão e tente novamente.')
  }

  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw new Error('Resposta inválida do serviço de matrículas. Não foi possível confirmar a solicitação.')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Resposta inválida do serviço de matrículas.')
  }
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string'
      ? result.message : 'Não foi possível registrar a solicitação. Tente novamente.')
  }

  const matricula = 'matricula' in result ? result.matricula : null
  if (!matricula || typeof matricula !== 'object' ||
      !('id' in matricula) || typeof matricula.id !== 'string' ||
      !('turma_id' in matricula) || typeof matricula.turma_id !== 'string' ||
      !('turma_nome' in matricula) || typeof matricula.turma_nome !== 'string' ||
      !('situacao' in matricula) || matricula.situacao !== 'PENDENTE' ||
      !('solicitado_em' in matricula) || typeof matricula.solicitado_em !== 'string') {
    throw new Error('Não foi possível confirmar os dados da solicitação.')
  }
  return {
    id: matricula.id, turma_id: matricula.turma_id, turma_nome: matricula.turma_nome,
    situacao: matricula.situacao, solicitado_em: matricula.solicitado_em,
  }
}
