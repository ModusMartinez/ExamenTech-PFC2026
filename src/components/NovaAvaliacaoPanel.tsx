import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listarTurmas } from '../services/turmas'
import type { Turma } from '../services/turmas'
import { criarAvaliacaoRascunho } from '../services/avaliacoes'
import { lerDadosAvaliacao } from '../services/avaliacaoValidation'
import '../styles/turmas.css'

function dataLocalParaISO(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || value.startsWith('0000-')) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  // Recusa datas normalizadas pelo navegador, inclusive horários inexistentes no fuso local.
  const partes = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
  if (partes.some((parte, index) => parte !== Number(value.split(/[-T:]/)[index]))) return null
  return date.toISOString()
}

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
    const titulo = campo('titulo').trim()
    const inicio = dataLocalParaISO(campo('inicio_em'))
    const fim = dataLocalParaISO(campo('fim_em'))
    const duracao = Number(campo('duracao_minutos'))
    if (!turmas.some((turma) => turma.id === campo('turma_id'))) return invalid('turma_id', 'Selecione uma turma ativa.')
    if ([...titulo].length < 3 || [...titulo].length > 150) return invalid('titulo', 'Título deve ter de 3 a 150 caracteres.')
    if (!['PROVA', 'ATIVIDADE'].includes(campo('tipo'))) return invalid('tipo', 'Selecione Prova ou Atividade.')
    if (!inicio) return invalid('inicio_em', 'Informe uma data e um horário de início válidos.')
    if (!fim || Date.parse(fim) <= Date.parse(inicio)) return invalid('fim_em', 'Fim deve ser posterior ao início.')
    if (!Number.isInteger(duracao) || duracao < 1 || duracao > 2147483647) {
      return invalid('duracao_minutos', 'Informe uma duração válida em minutos inteiros, maior que zero.')
    }
    const dados = lerDadosAvaliacao({
      turma_id: campo('turma_id'), titulo, tipo: campo('tipo'),
      inicio_em: inicio, fim_em: fim, duracao_minutos: duracao,
    })
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
          <label htmlFor="avaliacao-titulo">Título</label>
          <input id="avaliacao-titulo" name="titulo" required {...erroDoCampo('titulo')} />
          <label htmlFor="avaliacao-tipo">Tipo</label>
          <select id="avaliacao-tipo" name="tipo" defaultValue="PROVA" required {...erroDoCampo('tipo')}>
            <option value="PROVA">Prova</option>
            <option value="ATIVIDADE">Atividade</option>
          </select>
          <p className="turmas-note" id="avaliacao-fuso">Horários no fuso do navegador: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
          <label htmlFor="avaliacao-inicio">Início</label>
          <input id="avaliacao-inicio" name="inicio_em" type="datetime-local" required {...erroDoCampo('inicio_em')}
            aria-describedby={`avaliacao-fuso${formError.campo === 'inicio_em' ? ' avaliacao-form-error' : ''}`} />
          <label htmlFor="avaliacao-fim">Fim</label>
          <input id="avaliacao-fim" name="fim_em" type="datetime-local" required {...erroDoCampo('fim_em')}
            aria-describedby={`avaliacao-fuso${formError.campo === 'fim_em' ? ' avaliacao-form-error' : ''}`} />
          <label htmlFor="avaliacao-duracao">Duração (minutos)</label>
          <input id="avaliacao-duracao" name="duracao_minutos" type="number" min={1} max={2147483647} step={1}
            required {...erroDoCampo('duracao_minutos')} />
          <button type="submit" className="btn-primary" aria-busy={creating}>{creating ? 'Criando...' : 'Criar rascunho'}</button>
        </fieldset>
        {formError.mensagem && <p ref={notice} tabIndex={-1} id="avaliacao-form-error" className="alert error" role="alert">{formError.mensagem}</p>}
        {success && <p ref={notice} tabIndex={-1} className="alert success" role="status">{success}</p>}
      </form>
    </section>
  )
}
