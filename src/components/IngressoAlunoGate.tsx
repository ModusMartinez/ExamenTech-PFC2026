import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { consultarIngressoAluno } from '../services/ingressoAluno'
import type { IngressoAluno } from '../services/ingressoAluno'
import { BrandLogo } from './BrandLogo'
import { SolicitarMatriculaPanel } from './SolicitarMatriculaPanel'
import { MinhasMatriculasPanel } from './MinhasMatriculasPanel'
import '../styles/turmas.css'

type Props = { children: ReactNode; onLogout: () => Promise<void> }

export function IngressoAlunoGate({ children, onLogout }: Props) {
  const [ingresso, setIngresso] = useState<IngressoAluno | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [view, setView] = useState<'solicitar' | 'matriculas'>('solicitar')
  const [leaving, setLeaving] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  useEffect(() => {
    let active = true
    consultarIngressoAluno()
      .then((data) => { if (active) setIngresso(data) })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível consultar seu ingresso.')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])

  if (!loading && ingresso?.acesso_liberado) return children

  function checkAgain() {
    setLoading(true)
    setIngresso(null)
    setError('')
    setRefresh((value) => value + 1)
  }

  async function logout() {
    setLeaving(true)
    setLogoutError('')
    try { await onLogout() }
    catch { setLogoutError('Não foi possível sair. Tente novamente.') }
    finally { setLeaving(false) }
  }

  return <div className="dashboard-container">
    <nav className="dashboard-nav" aria-label="Conta do aluno">
      <BrandLogo />
      <button type="button" className="btn-outline" disabled={leaving} onClick={() => void logout()}>
        {leaving ? 'Saindo...' : 'Sair'}
      </button>
    </nav>
    <main className="dashboard-content" aria-busy={loading}>
      <p className="overline">INGRESSO DO ALUNO</p>
      <h1>Ingresso na primeira turma</h1>
      <p>Para acessar o painel acadêmico e suas provas, solicite matrícula em uma turma e aguarde a aprovação do professor ou administrador.</p>
      {loading && <p role="status">Verificando seu ingresso...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {logoutError && <p className="alert error" role="alert">{logoutError}</p>}
      {!loading && ingresso?.fase === 'PENDENTE' && <p className="alert info" role="status">
        Sua solicitação está pendente de aprovação. Após a aprovação, clique em Verificar liberação.
      </p>}
      <button type="button" className="turmas-refresh" disabled={loading}
        onClick={checkAgain}>Verificar liberação</button>
      {!loading && ingresso && <>
        <nav className="dashboard-section-nav" aria-label="Matrícula inicial">
          <button type="button" aria-pressed={view === 'solicitar'} onClick={() => setView('solicitar')}>Solicitar matrícula</button>
          <button type="button" aria-pressed={view === 'matriculas'} onClick={() => setView('matriculas')}>Minhas matrículas</button>
        </nav>
        {view === 'solicitar' ? <SolicitarMatriculaPanel /> : <MinhasMatriculasPanel key={refresh} />}
      </>}
    </main>
  </div>
}
