import { useEffect, useState } from 'react'
import { listarMinhasMatriculas } from '../services/matriculas'
import type { MatriculaDoAluno } from '../services/matriculaValidation'
import '../styles/turmas.css'

const situacoes = { PENDENTE: 'Pendente', ATIVA: 'Ativa', INATIVA: 'Inativa' }

export function MinhasMatriculasPanel() {
  const [matriculas, setMatriculas] = useState<MatriculaDoAluno[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const result = await listarMinhasMatriculas()
        if (active) setMatriculas(result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Não foi possível carregar suas matrículas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [refresh])

  return (
    <section className="turmas-panel matriculas-panel" aria-labelledby="minhas-matriculas-title">
      <header>
        <p className="overline">MATRÍCULAS</p>
        <h1 id="minhas-matriculas-title">Minhas matrículas</h1>
        <p className="subtitle">Acompanhe suas solicitações de ingresso e a situação de cada matrícula.</p>
      </header>
      <div className="turmas-list-heading">
        <h2>Turmas solicitadas</h2>
        <button type="button" className="turmas-refresh" disabled={loading}
          onClick={() => setRefresh((current) => current + 1)}>Atualizar</button>
      </div>
      <p className="turmas-note">Até 50 matrículas, da solicitação mais recente para a mais antiga. Use Atualizar para conferir mudanças de situação.</p>
      {loading && <p role="status">Carregando suas matrículas...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && matriculas.length === 0 && (
        <p role="status">Nenhuma matrícula encontrada na sua organização. Para entrar em uma turma, use Solicitar matrícula.</p>
      )}
      {!loading && !error && matriculas.length > 0 && (
        <ul className="turmas-list">
          {matriculas.map((matricula) => (
            <li key={matricula.id}>
              <div className="turma-description">
                <h3>{matricula.turma_nome}</h3>
                <p>Solicitada em: <time dateTime={matricula.solicitado_em}>
                  {new Date(matricula.solicitado_em).toLocaleString('pt-BR')}
                </time></p>
              </div>
              <span className="matricula-situacao">Situação: {situacoes[matricula.situacao]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="turmas-note">
        Pendente: aguardando aprovação. Ativa: matrícula aprovada. Inativa: vínculo inativo, com histórico preservado.
        O acesso às avaliações ainda não está disponível.
      </p>
    </section>
  )
}
