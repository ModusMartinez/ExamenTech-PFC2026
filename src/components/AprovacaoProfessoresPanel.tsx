import { useEffect, useRef, useState } from 'react'
import { aprovarProfessor, listarProfessoresPendentes } from '../services/aprovacaoProfessores'
import type { ProfessorPendente } from '../services/aprovacaoProfessores'
import '../styles/turmas.css'

export function AprovacaoProfessoresPanel() {
  const [professores, setProfessores] = useState<ProfessorPendente[]>([])
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [aprovando, setAprovando] = useState('')
  const [erroLista, setErroLista] = useState('')
  const [erroAcao, setErroAcao] = useState('')
  const [aviso, setAviso] = useState('')
  const feedback = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    async function carregar() {
      setLoading(true)
      setErroLista('')
      try {
        const pendentes = await listarProfessoresPendentes()
        if (active) setProfessores(pendentes)
      } catch (error) {
        if (active) setErroLista(error instanceof Error ? error.message : 'Não foi possível carregar as solicitações.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void carregar()
    return () => { active = false }
  }, [refresh])

  async function aprovar(professor: ProfessorPendente) {
    if (aprovando || loading) return
    setAprovando(professor.id)
    setErroAcao('')
    setAviso('')
    try {
      const aprovado = await aprovarProfessor(professor.id)
      setProfessores(atuais => atuais.filter(item => item.id !== professor.id))
      setAviso(aprovado ? `Cadastro de ${professor.nome} aprovado.` : 'Este cadastro já saiu da lista de pendentes.')
      setRefresh(valor => valor + 1)
    } catch (error) {
      setErroAcao(error instanceof Error ? error.message : 'Não foi possível aprovar o cadastro.')
    } finally {
      setAprovando('')
      feedback.current?.focus()
    }
  }

  return <section className="turmas-panel matriculas-panel" aria-labelledby="professores-title">
    <header className="turmas-list-heading">
      <h1 id="professores-title">Aprovar professores</h1>
      <button type="button" className="turmas-refresh" disabled={loading || Boolean(aprovando)}
        onClick={() => { setAviso(''); setErroAcao(''); setRefresh(valor => valor + 1) }}>Atualizar</button>
    </header>
    <div className="matriculas-notice" ref={feedback} tabIndex={-1}>
      {aviso && <p className="alert success" role="status">{aviso}</p>}
      {erroAcao && <p className="alert error" role="alert">{erroAcao}</p>}
    </div>
    {loading && <p role="status">Carregando professores...</p>}
    {erroLista && <p className="alert error" role="alert">{erroLista}</p>}
    {!loading && !erroLista && (professores.length === 0
      ? <p role="status">Nenhum cadastro de professor pendente.</p>
      : <ul className="turmas-list matriculas-list">
        {professores.map(professor => <li key={professor.id}>
          <div className="turma-description">
            <h2>{professor.nome}</h2>
            <p>{professor.email}</p>
            <p>{professor.organizacao}</p>
            <p>Cadastrado em <time dateTime={professor.criado_em}>
              {new Date(professor.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
            </time></p>
          </div>
          <button type="button" className="btn-primary" disabled={Boolean(aprovando)}
            aria-label={`Aprovar cadastro de ${professor.nome}`} onClick={() => void aprovar(professor)}>
            {aprovando === professor.id ? 'Aprovando...' : 'Aprovar'}
          </button>
        </li>)}
      </ul>)}
  </section>
}
