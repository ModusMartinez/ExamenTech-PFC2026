import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listarTurmas } from '../services/turmas'
import type { Turma } from '../services/turmas'
import { criarAvaliacaoRascunho } from '../services/avaliacoes'
import { lerDadosAvaliacao } from '../services/avaliacaoValidation'
import { lerFormularioAvaliacao } from '../services/avaliacaoForm'
import { CamposAvaliacao } from './CamposAvaliacao'
import '../styles/turmas.css'

export function NovaAvaliacaoPanel() {
  const [turmas, setTurmas] = useState<Turma[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState({ campo: '', mensagem: '' })
  const [success, setSuccess] = useState('')
  const submitting = useRef(false)
  const notice = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await listarTurmas()
        if (active) setTurmas(result.filter((turma) => turma.situacao === 'ATIVA'))
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Não foi possível carregar as turmas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [refresh])

  useEffect(() => {
    if (success || (formError.mensagem && !formError.campo)) notice.current?.focus()
  }, [success, formError])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || loading || loadError || turmas.length === 0) return
    const form = event.currentTarget
    const values = new FormData(form)
    const campo = (name: string) => String(values.get(name) ?? '')
    function invalid(name: string, mensagem: string) {
      setFormError({ campo: name, mensagem })
      const input = form.elements.namedItem(name)
      if (input instanceof HTMLElement) input.focus()
    }
    setFormError({ campo: '', mensagem: '' })
    setSuccess('')
    if (!turmas.some((turma) => turma.id === campo('turma_id'))) return invalid('turma_id', 'Selecione uma turma ativa.')
    const campos = lerFormularioAvaliacao(values)
    if (campos.erro) return invalid(campos.erro.campo, campos.erro.mensagem)
    const dados = lerDadosAvaliacao({ turma_id: campo('turma_id'), ...campos.dados })
    if (!dados) return invalid('turma_id', 'Não foi possível validar os dados. Atualize as turmas e confira os campos.')
    submitting.current = true
    setCreating(true)
    try {
      const avaliacao = await criarAvaliacaoRascunho(dados)
      form.reset()
      setSuccess(`Avaliação “${avaliacao.titulo}” criada em rascunho.`)
    } catch (error) {
      setFormError({ campo: '', mensagem: error instanceof Error ? error.message : 'Não foi possível confirmar a criação.' })
    } finally {
      submitting.current = false
      setCreating(false)
    }
  }

  function erroDoCampo(name: string) {
    return {
      'aria-invalid': formError.campo === name,
      'aria-describedby': formError.campo === name ? 'avaliacao-form-error' : undefined,
    }
  }

  return (
    <section className="turmas-panel" aria-labelledby="avaliacao-title">
      <header>
        <p className="overline">AVALIAÇÕES</p>
        <h1 id="avaliacao-title">Nova avaliação</h1>
      </header>
      <button type="button" className="turmas-refresh" disabled={loading || creating}
        onClick={() => setRefresh((current) => current + 1)}>Atualizar turmas</button>
      {loading && <p role="status">Carregando turmas...</p>}
      {loadError && <p className="alert error" role="alert">{loadError}</p>}
      {!loading && !loadError && turmas.length === 0 && <p role="status">Nenhuma turma ativa disponível.</p>}
      <form className="turma-form avaliacao-form" onSubmit={handleCreate} noValidate aria-label="Nova avaliação em rascunho">
        <fieldset disabled={loading || creating || Boolean(loadError) || turmas.length === 0}>
          <legend>Rascunho</legend>
          <label htmlFor="avaliacao-turma">Turma</label>
          <select id="avaliacao-turma" name="turma_id" defaultValue="" required {...erroDoCampo('turma_id')}>
            <option value="">Selecione a turma</option>
            {turmas.map((turma) => <option key={turma.id} value={turma.id}>{turma.nome}</option>)}
          </select>
          <CamposAvaliacao prefixo="avaliacao" erro={formError} />
          <button type="submit" className="btn-primary" aria-busy={creating}>{creating ? 'Criando...' : 'Criar rascunho'}</button>
        </fieldset>
        {formError.mensagem && <p ref={notice} tabIndex={-1} id="avaliacao-form-error" className="alert error" role="alert">{formError.mensagem}</p>}
        {success && <p ref={notice} tabIndex={-1} className="alert success" role="status">{success}</p>}
      </form>
    </section>
  )
}
