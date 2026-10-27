import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { solicitarMatricula } from '../services/matriculas'
import '../styles/turmas.css'

export function SolicitarMatriculaPanel() {
  const [codigo, setCodigo] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const submitting = useRef(false)
  const codigoInput = useRef<HTMLInputElement>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    setError('')
    setSuccess('')
    if (!/^[A-F0-9]{12}$/.test(codigo.trim().toUpperCase())) {
      setError('Informe o código da turma com 12 caracteres, usando números de 0 a 9 e letras de A a F.')
      codigoInput.current?.focus()
      return
    }

    submitting.current = true
    setSending(true)
    try {
      const matricula = await solicitarMatricula(codigo)
      setCodigo('')
      setSuccess(`Solicitação enviada para “${matricula.turma_nome}”. Situação: pendente de aprovação.`)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível solicitar a matrícula.')
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  return (
    <section className="turmas-panel" aria-labelledby="matricula-title">
      <header>
        <p className="overline">MATRÍCULAS</p>
        <h1 id="matricula-title">Solicitar matrícula</h1>
        <p className="subtitle">Informe o código recebido do professor para solicitar ingresso na turma.</p>
      </header>

      <form className="turma-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="matricula-codigo">Código da turma</label>
        <p id="matricula-codigo-help">
          São 12 caracteres. Use o código da turma, não o código da organização nem o convite de cadastro.
        </p>
        <div className="turma-form-fields">
          <input id="matricula-codigo" ref={codigoInput} value={codigo} required disabled={sending}
            autoComplete="off" autoCapitalize="characters" spellCheck={false}
            onChange={(event) => { setCodigo(event.target.value); setError('') }}
            aria-invalid={Boolean(error)}
            aria-describedby={`matricula-codigo-help${error ? ' matricula-error' : ''}`} />
          <button type="submit" className="btn-primary" disabled={sending} aria-busy={sending}>
            {sending ? 'Enviando...' : 'Enviar solicitação'}
          </button>
        </div>
        {error && <p id="matricula-error" className="alert error" role="alert">{error}</p>}
        {success && <p className="alert success" role="status">{success}</p>}
      </form>

      <p className="turmas-note">
        A solicitação fica pendente até a aprovação pelo professor responsável ou administrador.
        Acompanhe a situação em Minhas matrículas.
        O acesso às avaliações ainda não está disponível.
      </p>
    </section>
  )
}
