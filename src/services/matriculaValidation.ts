export type MatriculaPendente = {
  id: string
  turma_id: string
  turma_nome: string
  aluno_id: string
  aluno_nome: string
  aluno_rgm: string | null
  situacao: 'PENDENTE'
  solicitado_em: string
}

// A API e o navegador conferem o mesmo contrato e descartam campos extras.
export function lerMatriculasPendentes(value: unknown): MatriculaPendente[] | null {
  if (!Array.isArray(value) || value.length > 50) return null
  const matriculas: MatriculaPendente[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.id !== 'string' || typeof item.turma_id !== 'string' ||
        typeof item.turma_nome !== 'string' || typeof item.aluno_id !== 'string' ||
        typeof item.aluno_nome !== 'string' ||
        (item.aluno_rgm !== null && typeof item.aluno_rgm !== 'string') ||
        item.situacao !== 'PENDENTE' || typeof item.solicitado_em !== 'string' ||
        !Number.isFinite(Date.parse(item.solicitado_em))) return null

    matriculas.push({
      id: item.id, turma_id: item.turma_id, turma_nome: item.turma_nome,
      aluno_id: item.aluno_id, aluno_nome: item.aluno_nome, aluno_rgm: item.aluno_rgm,
      situacao: 'PENDENTE', solicitado_em: item.solicitado_em,
    })
  }
  return matriculas
}
