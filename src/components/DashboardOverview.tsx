import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { carregarDashboard } from '../services/dashboard'
import type { DashboardMetrics } from '../services/dashboard'
import '../styles/dashboard-overview.css'

const pieColors = ['#1d5d95', '#168a8a', '#d78716', '#7562aa']

function tempoRestante(alvo: number, agora: number) {
  const segundos = Math.max(0, Math.floor((alvo - agora) / 1000))
  const dias = Math.floor(segundos / 86400)
  const horas = Math.floor((segundos % 86400) / 3600)
  const minutos = Math.floor((segundos % 3600) / 60)
  const restantes = segundos % 60
  const relogio = [horas, minutos, restantes].map(value => String(value).padStart(2, '0')).join(':')
  return dias ? `${dias}d ${relogio}` : relogio
}

export function DashboardOverview() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [inicio, setInicio] = useState('')
  const [fim, setFim] = useState('')
  const [periodoAplicado, setPeriodoAplicado] = useState<{ inicio: string | null; fim: string | null }>({ inicio: null, fim: null })
  const [periodError, setPeriodError] = useState('')
  const [agora, setAgora] = useState(() => Date.now())
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    carregarDashboard(periodoAplicado).then(data => { if (active) setMetrics(data) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Falha ao carregar dashboard.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh, periodoAplicado])
  const proximaProva = metrics?.profile === 'Aluno' ? metrics.nextExam : null
  const alvoProximaProva = proximaProva?.target
  useEffect(() => {
    if (!alvoProximaProva) return
    const timer = window.setInterval(() => setAgora(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [alvoProximaProva])
  useEffect(() => {
    if (!alvoProximaProva || loading || Date.parse(alvoProximaProva) > agora) return
    const timer = window.setTimeout(() => setRefresh(value => value + 1), 1000)
    return () => window.clearTimeout(timer)
  }, [alvoProximaProva, loading, agora])
  const charts = metrics ? [metrics.chart, ...(metrics.additionalCharts ?? [])] : []
  function aplicarPeriodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inicio && fim && fim < inicio) {
      setPeriodError('A data final precisa ser igual ou posterior à data inicial.')
      return
    }
    setPeriodError('')
    setPeriodoAplicado({ inicio: inicio || null, fim: fim || null })
  }
  function limparPeriodo() {
    setInicio(''); setFim(''); setPeriodError('')
    setPeriodoAplicado({ inicio: null, fim: null })
  }
  return <section className="dashboard-overview" aria-label={`Dashboard${metrics ? ` de ${metrics.profile}` : ''}`}>
    <div className="overview-heading"><div><p className="overview-kicker">DASHBOARD{metrics ? ` · ${metrics.profile.toUpperCase()}` : ''}</p><h2>Indicadores acadêmicos</h2></div>
      <button type="button" className="dashboard-refresh" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Atualizar</button></div>
    <form className="overview-period-filter" onSubmit={aplicarPeriodo} aria-label="Filtrar dashboard por período">
      <p>Deixe as datas vazias para consultar todo o histórico. O período inclui os dias selecionados.</p>
      <label>Data inicial<input type="date" value={inicio} onChange={event => setInicio(event.target.value)} /></label>
      <label>Data final<input type="date" value={fim} onChange={event => setFim(event.target.value)} /></label>
      <button type="submit" className="dashboard-refresh" disabled={loading}>Aplicar período</button>
      <button type="button" className="dashboard-refresh" disabled={loading || (!inicio && !fim)} onClick={limparPeriodo}>Limpar</button>
    </form>
    {periodError && <p className="alert error" role="alert">{periodError}</p>}
    {loading && <p role="status" aria-live="polite">Carregando indicadores...</p>}
    {!loading && error && <div className="alert error" role="alert">{error}</div>}
    {!loading && !error && metrics && <>
    <div className="overview-indicators">{metrics.cards.map(card => <article className="overview-indicator-card" key={card.label}>
      <p>{card.label}</p><strong>{card.value === null ? '—' : card.label.startsWith('Nota da última')
        ? `${card.value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / 10`
        : card.value.toLocaleString('pt-BR')}</strong>
      {card.detail && <span>{card.detail}</span>}
    </article>)}</div>
    {metrics.profile === 'Aluno' && <section className="overview-countdown-card" aria-label="Contagem regressiva da prova">
      <div><p className="overview-kicker">{proximaProva?.type === 'ENCERRAMENTO' ? 'TEMPO RESTANTE' : 'PRÓXIMA PROVA'}</p>
        <h2>{proximaProva?.title ?? 'Nenhuma prova próxima no período'}</h2></div>
      {proximaProva && <div className="overview-countdown-value" aria-label={proximaProva.type === 'ENCERRAMENTO' ? 'Tempo até o encerramento' : 'Tempo até o início'}>
        <strong>{Date.parse(proximaProva.target) > agora ? tempoRestante(Date.parse(proximaProva.target), agora) : 'Atualizando agenda…'}</strong>
        <span>{proximaProva.type === 'ENCERRAMENTO' ? 'Até o encerramento previsto' : 'Até o início previsto'} · {new Date(proximaProva.target).toLocaleString('pt-BR')}</span>
      </div>}
    </section>}
    {charts.map(chart => {
      if (chart.kind === 'pie') {
        const total = chart.items.reduce((sum, item) => sum + item.value, 0)
        let start = 0
        const segments = chart.items.filter(item => item.value > 0).map((item, index) => {
          const end = start + item.value / total * 100
          const segment = `${pieColors[index % pieColors.length]} ${start}% ${end}%`
          start = end
          return segment
        })
        const biggest = [...chart.items].sort((a, b) => b.value - a.value)[0]
        return <section className="overview-chart" key={chart.title}>
          <div className="overview-chart-heading"><div><p className="overview-kicker">DISTRIBUIÇÃO</p><h2>{chart.title}</h2></div></div>
          {total === 0 ? <p className="overview-chart-empty">Nenhuma ocorrência registrada neste período.</p> : <>
            <p className="overview-pie-highlight">Maior ocorrência: <strong>{biggest.label}</strong> ({biggest.value})</p>
            <div className="overview-pie-layout">
              <div className="overview-pie" role="img" aria-label={`${chart.title}: ${chart.items.map(item => `${item.label}, ${item.value}`).join('; ')}`}
                style={{ background: `conic-gradient(${segments.join(', ')})` }} />
              <ul className="overview-pie-legend">{chart.items.map((item, index) => <li key={item.label}>
                <span className="overview-pie-swatch" style={{ backgroundColor: pieColors[index % pieColors.length] }} />
                <span>{item.label}</span><strong>{item.value}</strong>
                <small>{(item.value / total * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</small>
              </li>)}</ul>
            </div>
          </>}
        </section>
      }
      const maximum = Math.max(...chart.items.map(item => item.value), 1)
      return <section className="overview-chart" key={chart.title}>
        <div className="overview-chart-heading"><div><p className="overview-kicker">DISTRIBUIÇÃO</p><h2>{chart.title}</h2></div></div>
        {chart.items.length === 0
          ? <p className="overview-chart-empty">Nenhum registro neste período.</p>
          : <div className="overview-bars" role="img" aria-label={`${chart.title}: ${chart.items.map(item => `${item.label}, ${item.value}`).join('; ')}`}>
            {chart.items.map((item, index) => <div className="overview-bar-row" key={item.label}>
              <div className="overview-bar-label"><span>{item.label}</span><strong>{item.value.toLocaleString('pt-BR')}</strong></div>
              <div className="overview-bar-track"><span className={`overview-bar overview-bar-${['blue','teal','amber','purple'][index % 4]}`} style={{ width: `${item.value ? Math.max(2, item.value / maximum * 100) : 0}%` }} /></div>
            </div>)}
          </div>}
      </section>
    })}
    </>}
  </section>
}
