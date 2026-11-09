import { useEffect, useState } from 'react'
import { carregarDashboard } from '../services/dashboard'
import type { DashboardMetrics } from '../services/dashboard'
import '../styles/dashboard-overview.css'

export function DashboardOverview() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    carregarDashboard().then(data => { if (active) setMetrics(data) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Falha ao carregar dashboard.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])
  if (loading) return <section className="dashboard-overview" aria-busy="true"><p role="status">Carregando indicadores...</p></section>
  if (error || !metrics) return <section className="dashboard-overview"><div className="alert error" role="alert">{error || 'Não foi possível carregar o dashboard.'}</div><button type="button" className="dashboard-refresh" onClick={() => setRefresh(value => value + 1)}>Tentar novamente</button></section>
  const charts = [metrics.chart, ...(metrics.additionalCharts ?? [])]
  return <section className="dashboard-overview" aria-label={`Dashboard de ${metrics.profile}`}>
    <div className="overview-heading"><div><p className="overview-kicker">DASHBOARD · {metrics.profile.toUpperCase()}</p><h2>Indicadores acadêmicos</h2></div><button type="button" className="dashboard-refresh" onClick={() => setRefresh(value => value + 1)}>Atualizar</button></div>
    <div className="overview-indicators">{metrics.cards.map(card => <article className="overview-indicator-card" key={card.label}><p>{card.label}</p><strong>{card.value.toLocaleString('pt-BR')}</strong></article>)}</div>
    {charts.map(chart => {
      const maximum = Math.max(...chart.items.map(item => item.value), 1)
      return <section className="overview-chart" key={chart.title}>
        <div className="overview-chart-heading"><div><p className="overview-kicker">DISTRIBUIÇÃO</p><h2>{chart.title}</h2></div></div>
        {chart.items.length === 0
          ? <p className="overview-chart-empty">Nenhuma turma ativa cadastrada.</p>
          : <div className="overview-bars" role="img" aria-label={`${chart.title}: ${chart.items.map(item => `${item.label}, ${item.value}`).join('; ')}`}>
            {chart.items.map((item, index) => <div className="overview-bar-row" key={item.label}>
              <div className="overview-bar-label"><span>{item.label}</span><strong>{item.value.toLocaleString('pt-BR')}</strong></div>
              <div className="overview-bar-track"><span className={`overview-bar overview-bar-${['blue','teal','amber','purple'][index % 4]}`} style={{ width: `${item.value ? Math.max(2, item.value / maximum * 100) : 0}%` }} /></div>
            </div>)}
          </div>}
      </section>
    })}
  </section>
}
