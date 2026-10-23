import { useEffect, useState } from 'react'
import { listarAlunosTurma } from '../services/matriculas'
import type { AlunoMatriculado } from '../services/matriculaValidation'

export function AlunosTurmaPanel({ turmaId, turmaNome }: { turmaId: string; turmaNome: string }) {
  const [alunos, setAlunos] = useState<AlunoMatriculado[]>([])
  const [pagina, setPagina] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const result = await listarAlunosTurma(turmaId, pagina)
        if (active) setAlunos(result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Não foi possível carregar os alunos.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [turmaId, pagina, refresh])

  return (
    <section id={`alunos-${turmaId}`} className="alunos-turma" aria-label={`Alunos de ${turmaNome}`}>
      <div className="turmas-list-heading">
        <h4>Alunos matriculados</h4>
        <button type="button" className="turmas-refresh" disabled={loading}
          onClick={() => { setPagina(0); setRefresh((current) => current + 1) }}>Atualizar alunos</button>
      </div>
      <p className="turmas-note">Matrículas ativas.</p>
      {loading && <p role="status">Carregando alunos...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && alunos.length === 0 && <p role="status">Nenhum aluno nesta página.</p>}
      {!loading && !error && alunos.length > 0 && (
        <table aria-label={`Matrículas ativas de ${turmaNome}`}>
          <thead><tr><th scope="col">Nome</th><th scope="col">RGM</th></tr></thead>
          <tbody>
            {alunos.slice(0, 50).map((aluno) => (
              <tr key={aluno.id}><td>{aluno.aluno_nome}</td><td>{aluno.aluno_rgm || 'Não informado'}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="alunos-paginacao" aria-label="Paginação dos alunos">
        <button type="button" className="turmas-refresh" disabled={loading || pagina === 0}
          onClick={() => setPagina((current) => current - 1)}>Anterior</button>
        <span aria-live="polite">Página {pagina + 1}</span>
        <button type="button" className="turmas-refresh" disabled={loading || Boolean(error) || alunos.length <= 50}
          onClick={() => setPagina((current) => current + 1)}>Próxima</button>
      </div>
    </section>
  )
}
