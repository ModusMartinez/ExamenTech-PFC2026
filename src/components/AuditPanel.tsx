import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import '../styles/audit.css'

type SecurityEvent = {
  id: string
  criado_em: string
  evento: string
  provedor: string
  acao: string
  sucesso: boolean
  usuario_id: string | null
  codigos_erro: string[]
}

const eventNames: Record<string, string> = {
  CADASTRO_REALIZADO: 'Cadastro realizado',
  LOGIN_SUCESSO: 'Login autorizado',
  LOGIN_NEGADO: 'Login negado',
  TURNSTILE_VALIDADO: 'Turnstile validado',
  TURNSTILE_REJEITADO: 'Turnstile rejeitado',
  TURNSTILE_INDISPONIVEL: 'Turnstile indisponível',
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR') : 'Data indisponível'
}

export function AuditPanel() {
  const [events, setEvents] = useState<SecurityEvent[]>([])
  const [eventFilter, setEventFilter] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    async function loadEvents() {
      setLoading(true)
      setError('')
      setEvents([])

      try {
        // A RLS permite leitura somente para ADMIN ativo com MFA.
        // Nenhuma chave secreta ou função de escrita é usada nesta tela.
        let query = supabase.from('eventos_seguranca')
          .select('id,criado_em,evento,provedor,acao,sucesso,usuario_id,codigos_erro')
          .order('criado_em', { ascending: false })
          .order('id', { ascending: false })
          .limit(50)

        if (eventFilter) query = query.eq('evento', eventFilter)

        const { data, error: queryError } = await query
        if (!active) return
        if (queryError || !Array.isArray(data)) throw new Error('Falha na consulta.')
        setEvents(data as SecurityEvent[])
      } catch {
        if (active) setError('Não foi possível carregar os eventos. Confira seu acesso e tente atualizar.')
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadEvents()
    return () => { active = false }
  }, [eventFilter, refresh])

  return (
    <section className="audit-panel" aria-labelledby="audit-title">
      <header>
        <p className="overline">SEGURANÇA</p>
        <h1 id="audit-title">Auditoria</h1>
        <p className="subtitle">Últimos eventos registrados pelo ExamenTech. </p>
      </header>

      <div className="audit-toolbar">
        <div>
          <label htmlFor="audit-event-filter">Tipo de evento</label>
          <select
            id="audit-event-filter"
            value={eventFilter}
            disabled={loading}
            onChange={(event) => setEventFilter(event.target.value)}
          >
            <option value="">Todos os eventos</option>
            {Object.entries(eventNames).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <button type="button" className="btn-outline" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? 'Carregando...' : 'Atualizar'}
        </button>
      </div>

      {loading && <p role="status">Carregando eventos...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && events.length === 0 && <p role="status">Nenhum evento encontrado para este filtro.</p>}

      {!loading && !error && events.length > 0 && (
        <>
          <p className="audit-note" role="status"> {events.length} registro(s) max. 50 por consulta.</p>
          <p className="audit-note audit-scroll-hint">Deslize a tabela para ver todas as colunas.</p>
          <div className="audit-table-scroll" role="region" aria-label="Eventos de segurança" tabIndex={0}>
            <table className="audit-table">
              <caption>Eventos de segurança</caption>
              <thead>
                <tr>
                  <th scope="col">Data e hora</th>
                  <th scope="col">Evento</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">Usuário (ID)</th>
                  <th scope="col">Origem / ação</th>
                  <th scope="col">Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDate(event.criado_em)}</td>
                    <td>{eventNames[event.evento] ?? event.evento}<small>{event.evento}</small></td>
                    <td><span className={`audit-result ${event.sucesso ? 'audit-success' : 'audit-failure'}`}>
                      {event.sucesso ? 'Sucesso' : 'Falha / negado'}
                    </span></td>
                    <td>{event.usuario_id ? <code>{event.usuario_id}</code> : 'Sem usuário associado'}</td>
                    <td>{event.provedor}<small>{event.acao}</small></td>
                    <td>{event.codigos_erro.length ? event.codigos_erro.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="audit-note">
          Examentech
      </p>
    </section>
  )
}
