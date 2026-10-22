import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { criarTurma, listarTurmas } from '../services/turmas'
import type { Turma } from '../services/turmas'
import { validateTurmaName } from '../services/turmaValidation'
import '../styles/turmas.css'

export function TurmasPanel({ profile }: { profile: 'Administrador' | 'Professor' }) {
  const [turmas, setTurmas] = useState<Turma[]>([])
  const [nome, setNome] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [success, setSuccess] = useState('')
  const [refresh, setRefresh] = useState(0)
  const submitting = useRef(false)
  const isTeacher = profile === 'Professor'

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await listarTurmas()
        if (active) setTurmas(result)
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Não foi possível carregar as turmas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [refresh])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (!isTeacher || submitting.current || loading) return
    setFormError('')
    setSuccess('')
    const validationError = validateTurmaName(nome)
    if (validationError) {
      setFormError(validationError)
      return
    }
    submitting.current = true
    setCreating(true)
    try {
      const turma = await criarTurma(nome.trim())
      setTurmas((current) => [turma, ...current])
      setNome('')
      setSuccess(`Turma “${turma.nome}” criada.`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Não foi possível criar a turma.')
    } finally {
      submitting.current = false
      setCreating(false)
    }
  }

  return (
    <section className="turmas-panel" aria-labelledby="turmas-title">
      <header>
        <p className="overline">TURMAS</p>
        <h1 id="turmas-title">{isTeacher ? 'Minhas turmas' : 'Turmas cadastradas'}</h1>
        <p className="subtitle">
          {isTeacher ? 'Crie e consulte as turmas sob sua responsabilidade.'
            : 'Consulta administrativa das turmas cadastradas pelos professores.'}
        </p>
      </header>

      {isTeacher && (
        <form className="turma-form" onSubmit={handleCreate} noValidate>
          <h2>Nova turma</h2>
          <label htmlFor="turma-nome">Nome da turma</label>
          <p id="turma-nome-help">Use de 3 a 100 caracteres. Exemplo: Engenharia de Software — 8º B.</p>
          <div className="turma-form-fields">
            <input id="turma-nome" value={nome} onChange={(event) => setNome(event.target.value)}
              maxLength={100} required disabled={creating}
              aria-invalid={Boolean(formError)}
              aria-describedby={`turma-nome-help${formError ? ' turma-form-error' : ''}`} />
            <button type="submit" className="btn-primary" disabled={creating || loading}
              aria-busy={creating}>{creating ? 'Criando...' : 'Criar turma'}</button>
          </div>
          {formError && <p id="turma-form-error" className="alert error" role="alert">{formError}</p>}
          {success && <p className="alert success" role="status">{success}</p>}
        </form>
      )}

      <div className="turmas-list-heading">
        <h2>{isTeacher ? 'Turmas criadas' : 'Lista de turmas'}</h2>
        <button type="button" className="turmas-refresh" disabled={loading || creating}
          onClick={() => setRefresh((current) => current + 1)}>Atualizar</button>
      </div>
      {loading && <p role="status">Carregando turmas...</p>}
      {loadError && <p className="alert error" role="alert">{loadError}</p>}
      {!loading && !loadError && turmas.length === 0 && <p role="status">Nenhuma turma cadastrada.</p>}
      {!loading && !loadError && turmas.length > 0 && (
        <ul className="turmas-list">
          {turmas.map((turma) => (
            <li key={turma.id}>
              <div className="turma-description">
                <h3>{turma.nome}</h3>
                <p>{turma.situacao === 'ATIVA' ? 'Ativa' : 'Inativa'}</p>
                {!isTeacher && <p>Responsável (ID): <span>{turma.professor_id}</span></p>}
              </div>
              <div className="turma-code">
                <span>Código de ingresso</span>
                <code>{turma.codigo_ingresso}</code>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="turmas-note">
        Alunos podem solicitar matrícula pelo código. Confira as solicitações na seção Matrículas.
        O código da turma não substitui o convite de cadastro.
      </p>
    </section>
  )
}
