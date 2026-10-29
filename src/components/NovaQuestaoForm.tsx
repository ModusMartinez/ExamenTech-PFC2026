import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { criarQuestaoRascunho } from '../services/questoes'
import { enunciadoQuestaoValido, pontuacaoQuestaoValida } from '../services/questaoValidation'
import type { QuestaoRascunho } from '../services/questaoValidation'
import type { AvaliacaoRascunho } from '../services/avaliacaoValidation'

export function NovaQuestaoForm({ avaliacao, onCriada, onCancelar }: {
  avaliacao: AvaliacaoRascunho; onCriada: (questao: QuestaoRascunho) => void; onCancelar: () => void
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
    const tipo = formRef.current?.elements.namedItem('tipo')
    if (tipo instanceof HTMLElement) tipo.focus()
    return () => { active.current = false }
  }, [])

  useEffect(() => {
    if (erro.mensagem && !erro.campo) notice.current?.focus()
  }, [erro])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    const form = event.currentTarget
    const values = new FormData(form)
    const tipo = String(values.get('tipo') ?? '')
    const enunciado = String(values.get('enunciado') ?? '')
    const pontos = String(values.get('pontuacao') ?? '').trim()
    const pontuacao = Number(pontos.replace(',', '.'))
    function invalid(campo: string, mensagem: string) {
      setErro({ campo, mensagem })
      const input = form.elements.namedItem(campo)
      if (input instanceof HTMLElement) input.focus()
    }
    if (tipo !== 'OBJETIVA' && tipo !== 'DISSERTATIVA') return invalid('tipo', 'Selecione Objetiva ou Dissertativa.')
    if (!enunciadoQuestaoValido(enunciado)) return invalid('enunciado', 'Enunciado deve ter de 3 a 10.000 caracteres válidos.')
    if (!/^\d+(?:[.,]\d+)?$/.test(pontos) || !pontuacaoQuestaoValida(pontuacao)) {
      return invalid('pontuacao', 'Informe pontuação de 0,01 a 9999,99, com até duas casas decimais.')
    }
    submitting.current = true
    setSaving(true)
    setErro({ campo: '', mensagem: '' })
    try {
      const questao = await criarQuestaoRascunho({ avaliacao_id: avaliacao.id, tipo, enunciado, pontuacao })
      if (active.current) onCriada(questao)
    } catch (error) {
      if (active.current) setErro({ campo: '', mensagem: error instanceof Error ? error.message : 'Não foi possível confirmar a criação.' })
    } finally {
      submitting.current = false
      if (active.current) setSaving(false)
    }
  }

  function erroDoCampo(campo: string, ajuda?: string) {
    return {
      'aria-invalid': erro.campo === campo,
      'aria-describedby': [ajuda, erro.campo === campo ? `${prefixo}-erro` : ''].filter(Boolean).join(' ') || undefined,
    }
  }

  return (
    <form ref={formRef} className="turma-form avaliacao-form" onSubmit={handleCreate} noValidate aria-label="Nova questão em rascunho">
      <fieldset disabled={saving}>
        <legend>Nova questão</legend>
        <p className="questao-avaliacao">{avaliacao.titulo}</p>
        <label htmlFor={`${prefixo}-tipo`}>Tipo</label>
        <select id={`${prefixo}-tipo`} name="tipo" defaultValue="OBJETIVA" required {...erroDoCampo('tipo')}>
          <option value="OBJETIVA">Objetiva</option>
          <option value="DISSERTATIVA">Dissertativa</option>
        </select>
        <label htmlFor={`${prefixo}-enunciado`}>Enunciado</label>
        <p id={`${prefixo}-enunciado-ajuda`} className="turmas-note">3 a 10.000 caracteres.</p>
        <textarea id={`${prefixo}-enunciado`} name="enunciado" rows={6} required
          {...erroDoCampo('enunciado', `${prefixo}-enunciado-ajuda`)} />
        <label htmlFor={`${prefixo}-pontuacao`}>Pontuação</label>
        <p id={`${prefixo}-pontuacao-ajuda`} className="turmas-note">0,01 a 9999,99. Até duas casas decimais.</p>
        <input id={`${prefixo}-pontuacao`} name="pontuacao" inputMode="decimal" defaultValue="1" required
          {...erroDoCampo('pontuacao', `${prefixo}-pontuacao-ajuda`)} />
        <div className="avaliacao-form-actions">
          <button type="submit" className="btn-primary" aria-busy={saving}>{saving ? 'Criando...' : 'Criar questão'}</button>
          <button type="button" className="turmas-refresh" onClick={onCancelar}>Cancelar</button>
        </div>
      </fieldset>
      {erro.mensagem && <p ref={notice} tabIndex={-1} id={`${prefixo}-erro`} className="alert error" role="alert">{erro.mensagem}</p>}
    </form>
  )
}
