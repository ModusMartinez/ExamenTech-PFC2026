import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { cadastrarAlternativasRascunho } from '../services/alternativas'
import { lerTextoAlternativa } from '../services/alternativaValidation'
import type { AlternativaRascunho } from '../services/alternativaValidation'

export function AlternativasForm({ questaoId, onSalvo, onCancelar }: {
  questaoId: string; onSalvo: (alternativas: AlternativaRascunho[]) => void; onCancelar: () => void
}) {
  const [textos, setTextos] = useState(['', ''])
  const [correta, setCorreta] = useState(0)
  const [saving, setSaving] = useState(false)
  const [erro, setErro] = useState({ campo: '', mensagem: '' })
  const formRef = useRef<HTMLFormElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  const focoAlternativa = useRef(0)
  const active = useRef(false)
  const submitting = useRef(false)
  const prefixo = useId()

  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    const input = formRef.current?.elements.namedItem(`alternativa-${focoAlternativa.current}`)
    if (input instanceof HTMLElement) input.focus()
  }, [textos.length])
  useEffect(() => { if (erro.mensagem && !erro.campo) notice.current?.focus() }, [erro])

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    function invalid(campo: string, mensagem: string) {
      setErro({ campo, mensagem })
      const input = formRef.current?.elements.namedItem(campo)
      if (input instanceof HTMLElement) input.focus()
    }
    const alternativas: string[] = []
    for (const [index, value] of textos.entries()) {
      const texto = lerTextoAlternativa(value)
      if (!texto) return invalid(`alternativa-${index}`, 'Informe de 1 a 2.000 caracteres válidos na alternativa.')
      if (alternativas.includes(texto)) return invalid(`alternativa-${index}`, 'As alternativas devem ter textos diferentes.')
      alternativas.push(texto)
    }
    if (!Number.isInteger(correta) || correta < 1 || correta > textos.length) return invalid('ordem_correta', 'Selecione a alternativa correta.')
    submitting.current = true
    setSaving(true)
    setErro({ campo: '', mensagem: '' })
    try {
      const result = await cadastrarAlternativasRascunho({ questao_id: questaoId, alternativas, ordem_correta: correta })
      if (active.current) onSalvo(result)
    } catch (error) {
      if (active.current) setErro({ campo: '', mensagem: error instanceof Error ? error.message : 'Não foi possível confirmar o cadastro.' })
    } finally {
      submitting.current = false
      if (active.current) setSaving(false)
    }
  }

  function erroDoCampo(campo: string) {
    return { 'aria-invalid': erro.campo === campo, 'aria-describedby': erro.campo === campo ? `${prefixo}-erro` : `${prefixo}-ajuda` }
  }

  return (
    <form ref={formRef} className="turma-form avaliacao-form" aria-label="Cadastrar alternativas" onSubmit={handleSave} noValidate>
      <fieldset disabled={saving}>
        <legend>Cadastrar alternativas</legend>
        <p id={`${prefixo}-ajuda`} className="turmas-note">De 2 a 5 alternativas, até 2.000 caracteres cada. Uma correta.</p>
        {textos.map((texto, index) => (
          <div key={index}>
            <label htmlFor={`${prefixo}-${index}`}>Alternativa {index + 1}</label>
            <textarea id={`${prefixo}-${index}`} name={`alternativa-${index}`} rows={3} required value={texto}
              onChange={(event) => setTextos((current) => current.map((item, i) => i === index ? event.target.value : item))}
              {...erroDoCampo(`alternativa-${index}`)} />
          </div>
        ))}
        <div className="avaliacao-form-actions">
          <button type="button" className="turmas-refresh" disabled={textos.length === 5} onClick={() => {
            focoAlternativa.current = textos.length
            setTextos((current) => current.length < 5 ? [...current, ''] : current)
          }}>Adicionar alternativa</button>
          <button type="button" className="turmas-refresh" disabled={textos.length === 2} onClick={() => {
            focoAlternativa.current = textos.length - 2
            if (correta === textos.length) setCorreta(0)
            setErro({ campo: '', mensagem: '' })
            setTextos((current) => current.length > 2 ? current.slice(0, -1) : current)
          }}>Remover última</button>
        </div>
        <label htmlFor={`${prefixo}-correta`}>Alternativa correta</label>
        <select id={`${prefixo}-correta`} name="ordem_correta" value={correta} required
          onChange={(event) => setCorreta(Number(event.target.value))} {...erroDoCampo('ordem_correta')}>
          <option value={0}>Selecione</option>
          {textos.map((_, index) => <option key={index} value={index + 1}>Alternativa {index + 1}</option>)}
        </select>
        <div className="avaliacao-form-actions">
          <button type="submit" className="btn-primary" aria-busy={saving}>{saving ? 'Salvando...' : 'Salvar alternativas'}</button>
          <button type="button" className="turmas-refresh" onClick={onCancelar}>Cancelar</button>
        </div>
      </fieldset>
      {erro.mensagem && <p ref={notice} tabIndex={-1} id={`${prefixo}-erro`} className="alert error" role="alert">{erro.mensagem}</p>}
    </form>
  )
}
