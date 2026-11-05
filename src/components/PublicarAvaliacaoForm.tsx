import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { publicarAvaliacao } from '../services/avaliacoes'
import type { AvaliacaoRascunho } from '../services/avaliacaoValidation'

export function PublicarAvaliacaoForm({ avaliacao, onPublicada, onCancelar }: {
  avaliacao: AvaliacaoRascunho; onPublicada: () => void; onCancelar: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const cancel = useRef<HTMLButtonElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  const active = useRef(false)
  const submitting = useRef(false)
  useEffect(() => {
    active.current = true
    cancel.current?.focus()
    return () => { active.current = false }
  }, [])
  useEffect(() => { if (error) notice.current?.focus() }, [error])

  async function handlePublish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setSaving(true)
    setError('')
    try {
      await publicarAvaliacao(avaliacao.id)
      if (active.current) onPublicada()
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : 'Não foi possível confirmar a publicação.')
    } finally {
      submitting.current = false
      if (active.current) setSaving(false)
    }
  }

  return (
    <form className="turma-form avaliacao-form" aria-label="Publicar avaliação" onSubmit={handlePublish}>
      <fieldset disabled={saving}>
        <legend>Publicar avaliação</legend>
        <p className="questao-avaliacao">{avaliacao.titulo}</p>
        <p className="turmas-note">Após publicar, não será possível alterar a avaliação, as questões ou o gabarito.</p>
        <div className="avaliacao-form-actions">
          <button type="submit" className="btn-primary" aria-busy={saving}>{saving ? 'Publicando...' : 'Confirmar publicação'}</button>
          <button ref={cancel} type="button" className="turmas-refresh" onClick={onCancelar}>Cancelar</button>
        </div>
      </fieldset>
      {error && <p ref={notice} tabIndex={-1} className="alert error" role="alert">{error}</p>}
    </form>
  )
}
