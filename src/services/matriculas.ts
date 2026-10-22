import { supabase } from '../lib/supabase'
import { lerMatriculasPendentes } from './matriculaValidation'

type Matricula = {
  id: string
  turma_id: string
  turma_nome: string
  situacao: 'PENDENTE' | 'ATIVA'
  solicitado_em: string
}

async function requisicaoMatriculas(method: 'GET' | 'POST' | 'PATCH', body?: object) {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')

  let response: Response
  try {
    response = await fetch('/api/matriculas', {
      method,
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de matrículas. Confira sua conexão e tente novamente.')
  }

  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw new Error('Resposta inválida do serviço de matrículas. Não foi possível confirmar a operação.')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Resposta inválida do serviço de matrículas.')
  }
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string'
      ? result.message : 'Não foi possível concluir a operação. Tente novamente.')
  }
  return result
}

function lerMatricula(result: object, situacao: Matricula['situacao']): Matricula {
  const matricula = 'matricula' in result ? result.matricula : null
  if (!matricula || typeof matricula !== 'object' ||
      !('id' in matricula) || typeof matricula.id !== 'string' ||
      !('turma_id' in matricula) || typeof matricula.turma_id !== 'string' ||
      !('turma_nome' in matricula) || typeof matricula.turma_nome !== 'string' ||
      !('situacao' in matricula) || matricula.situacao !== situacao ||
      !('solicitado_em' in matricula) || typeof matricula.solicitado_em !== 'string') {
    throw new Error('Não foi possível confirmar os dados da matrícula.')
  }
  return {
    id: matricula.id, turma_id: matricula.turma_id, turma_nome: matricula.turma_nome,
    situacao, solicitado_em: matricula.solicitado_em,
  }
}

export async function solicitarMatricula(codigo: string) {
  const result = await requisicaoMatriculas('POST', { codigo: codigo.trim().toUpperCase() })
  return lerMatricula(result, 'PENDENTE')
}

export async function listarMatriculasPendentes() {
  const result = await requisicaoMatriculas('GET')
  const matriculas = lerMatriculasPendentes('matriculas' in result ? result.matriculas : null)
  if (!matriculas) throw new Error('Não foi possível conferir a lista de matrículas pendentes.')
  return matriculas
}

export async function aprovarMatricula(id: string) {
  const result = await requisicaoMatriculas('PATCH', { matricula_id: id })
  const matricula = lerMatricula(result, 'ATIVA')
  if (matricula.id !== id) throw new Error('Não foi possível confirmar a matrícula aprovada.')
  return matricula
}
