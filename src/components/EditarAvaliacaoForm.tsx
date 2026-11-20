import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { editarAvaliacaoRascunho } from '../services/avaliacoes'
import type { AvaliacaoRascunho } from '../services/avaliacaoValidation'
import { lerFormularioAvaliacao } from '../services/avaliacaoForm'
import { CamposAvaliacao } from './CamposAvaliacao'

export function EditarAvaliacaoForm({ avaliacao, onSalvo, onCancelar }: {
  avaliacao: AvaliacaoRascunho; onSalvo: (avaliacao: AvaliacaoRascunho) => void; onCancelar: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [erro, setErro] = useState({ campo: '', mensagem: '' })
  const formRef = useRef<HTMLFormElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  const submitting = useRef(false)
  const active = useRef(false)
  const prefixo = useId()

  useEffect(() => {
    active.current = true
    const titulo = formRef.current?.elements.namedItem('titulo')
    if (titulo instanceof HTMLElement) titulo.focus()
    return () => { active.current = false }
  }, [])

  useEffect(() => {
    if (erro.mensagem && !erro.campo) notice.current?.focus()
  }, [erro])

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    const form = event.currentTarget
    const campos = lerFormularioAvaliacao(new FormData(form), avaliacao)
    if (campos.erro) {
      setErro(campos.erro)
      const input = form.elements.namedItem(campos.erro.campo)
      if (input instanceof HTMLElement) input.focus()
      return
    }
    submitting.current = true
    setSaving(true)
    setErro({ campo: '', mensagem: '' })
    try {
      const atualizada = await editarAvaliacaoRascunho({ avaliacao_id: avaliacao.id, ...campos.dados })
      if (atualizada.turma_id !== avaliacao.turma_id || atualizada.criado_em !== avaliacao.criado_em) {
        throw new Error('Não foi possível confirmar a edição. Confira os rascunhos da turma antes de reenviar.')
      }
      if (active.current) onSalvo(atualizada)
    } catch (error) {
      if (active.current) setErro({ campo: '', mensagem: error instanceof Error ? error.message : 'Não foi possível confirmar a edição.' })
    } finally {
      submitting.current = false
      if (active.current) setSaving(false)
    }
  }

  return (
    <form ref={formRef} className="turma-form avaliacao-form" onSubmit={handleSave} noValidate aria-label="Editar avaliação em rascunho">
      <fieldset disabled={saving}>
        <legend>Editar rascunho</legend>
        <CamposAvaliacao prefixo={prefixo} erro={erro} valores={avaliacao} />
        <div className="avaliacao-form-actions">
          <button type="submit" className="btn-primary" aria-busy={saving}>{saving ? 'Salvando...' : 'Salvar alterações'}</button>
          <button type="button" className="turmas-refresh" onClick={onCancelar}>Cancelar</button>
        </div>
      </fieldset>
      {erro.mensagem && <p ref={notice} tabIndex={-1} id={`${prefixo}-form-error`} className="alert error" role="alert">{erro.mensagem}</p>}
    </form>
  )
}
