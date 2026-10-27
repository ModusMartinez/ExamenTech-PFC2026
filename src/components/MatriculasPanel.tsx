import { useEffect, useRef, useState } from 'react'
import { aprovarMatricula, listarMatriculasPendentes } from '../services/matriculas'
import type { MatriculaPendente } from '../services/matriculaValidation'
import '../styles/turmas.css'

export function MatriculasPanel({ profile }: { profile: 'Administrador' | 'Professor' }) {
  const [matriculas, setMatriculas] = useState<MatriculaPendente[]>([])
  const [loading, setLoading] = useState(true)
  const [approvingId, setApprovingId] = useState('')
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [success, setSuccess] = useState('')
  const [refresh, setRefresh] = useState(0)
  const submitting = useRef(false)
  const notice = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await listarMatriculasPendentes()
        if (active) setMatriculas(result)
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Não foi possível carregar as matrículas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [refresh])

  async function handleApprove(matricula: MatriculaPendente) {
    if (submitting.current || loading) return
    submitting.current = true
    setApprovingId(matricula.id)
    setActionError('')
    setSuccess('')
    try {
      await aprovarMatricula(matricula.id)
      setMatriculas((current) => current.filter((item) => item.id !== matricula.id))
      setSuccess(`Matrícula de ${matricula.aluno_nome} em “${matricula.turma_nome}” aprovada.`)
      setRefresh((current) => current + 1)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Não foi possível aprovar a matrícula.')
    } finally {
      submitting.current = false
      setApprovingId('')
      // O botão sai da lista após o sucesso; mantém o foco no resultado da ação.
      notice.current?.focus()
    }
  }

  return (
    <section className="turmas-panel matriculas-panel" aria-labelledby="matriculas-title">
      <header>
        <p className="overline">MATRÍCULAS</p>
        <h1 id="matriculas-title">Aprovar matrículas</h1>
        <p className="subtitle">{profile === 'Professor'
          ? 'Confira as solicitações de ingresso nas turmas sob sua responsabilidade.'
          : 'Confira as solicitações de ingresso nas turmas cadastradas.'}</p>
      </header>

      <div className="matriculas-notice" ref={notice} tabIndex={-1}>
        {success && <p className="alert success" role="status">{success}</p>}
        {actionError && <p className="alert error" role="alert">{actionError} Atualize a lista antes de tentar novamente.</p>}
      </div>
      <div className="turmas-list-heading">
        <h2>Solicitações pendentes</h2>
        <button type="button" className="turmas-refresh" disabled={loading || Boolean(approvingId)}
          onClick={() => { setActionError(''); setSuccess(''); setRefresh((current) => current + 1) }}>
          Atualizar
        </button>
      </div>
      <p className="turmas-note">Até 50 solicitações, da mais antiga para a mais recente. A lista é atualizada após cada aprovação.</p>
      {loading && <p role="status">Carregando solicitações...</p>}
      {loadError && <p className="alert error" role="alert">{loadError}</p>}
      {!loading && !loadError && matriculas.length === 0 && <p role="status">Nenhuma solicitação pendente.</p>}
      {!loading && !loadError && matriculas.length > 0 && (
        <ul className="turmas-list matriculas-list">
          {matriculas.map((matricula) => (
            <li key={matricula.id}>
              <div className="turma-description">
                <h3>{matricula.aluno_nome}</h3>
                <p>{matricula.aluno_rgm ? `RGM: ${matricula.aluno_rgm}` : `Aluno (ID): ${matricula.aluno_id}`}</p>
                <p>Turma: {matricula.turma_nome}</p>
                <p>Solicitada em: <time dateTime={matricula.solicitado_em}>
                  {new Date(matricula.solicitado_em).toLocaleString('pt-BR')}
                </time></p>
              </div>
              <button type="button" className="btn-primary" disabled={Boolean(approvingId)}
                aria-label={`Aprovar matrícula de ${matricula.aluno_nome} na turma ${matricula.turma_nome}`}
                aria-busy={approvingId === matricula.id} onClick={() => void handleApprove(matricula)}>
                {approvingId === matricula.id ? 'Aprovando...' : 'Aprovar'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
