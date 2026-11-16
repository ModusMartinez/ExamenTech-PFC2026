import { supabase } from '../lib/supabase'
import type { Profile } from './profileAccess'
import { lerDataComFuso } from './avaliacaoValidation'

type DashboardChart = { title: string; items: { label: string; value: number }[]; kind?: 'bar' | 'pie' }

export type DashboardMetrics = {
  profile: Profile
  cards: { label: string; value: number | null; detail?: string }[]
  chart: DashboardChart
  additionalCharts?: DashboardChart[]
  nextExam?: { title: string; target: string; type: 'INICIO' | 'ENCERRAMENTO' } | null
}

export async function carregarDashboard(periodo: { inicio: string | null; fim: string | null }): Promise<DashboardMetrics> {
  const { data, error } = await supabase.rpc('consultar_indicadores_dashboard_periodo', {
    p_inicio: periodo.inicio, p_fim: periodo.fim,
  })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw new Error('A função dos indicadores não foi encontrada. Confirme se as migrações 049 a 051 foram aplicadas no Supabase.')
    }
    if (error.code === '42501') {
      throw new Error(error.message || 'Acesso à dashboard bloqueado pelas regras do perfil.')
    }
    console.error('Falha ao consultar indicadores da dashboard:', error.code)
    throw new Error(`Não foi possível carregar os indicadores (erro ${error.code || 'desconhecido'}).`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Não foi possível carregar os indicadores. Confirme se as migrações 049 a 051 foram aplicadas.')
  }
  const result = data as Record<string, unknown>
  const profiles: Record<string, Profile> = { ADMIN: 'Administrador', PROFESSOR: 'Professor', ALUNO: 'Aluno' }
  const profile = typeof result.perfil === 'string' ? profiles[result.perfil] : undefined
  if (!profile || !Array.isArray(result.indicadores) || !Array.isArray(result.grafico) || typeof result.titulo_grafico !== 'string') {
    throw new Error('A resposta do dashboard está inválida.')
  }
  const parseCount = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Os indicadores recebidos estão inválidos.')
    const item = value as Record<string, unknown>
    if (typeof item.rotulo !== 'string' || !Number.isSafeInteger(item.valor) || Number(item.valor) < 0) {
      throw new Error('Os indicadores recebidos estão inválidos.')
    }
    return { label: item.rotulo, value: item.valor as number }
  }
  const cards = result.indicadores.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Os indicadores recebidos estão inválidos.')
    const item = value as Record<string, unknown>
    if (typeof item.rotulo !== 'string' ||
        (item.valor !== null && (typeof item.valor !== 'number' || !Number.isFinite(item.valor) || item.valor < 0)) ||
        (item.detalhe !== undefined && typeof item.detalhe !== 'string')) throw new Error('Os indicadores recebidos estão inválidos.')
    return { label: item.rotulo, value: item.valor as number | null,
      ...(typeof item.detalhe === 'string' ? { detail: item.detalhe } : {}) }
  })
  const items = result.grafico.map(parseCount)
  if (cards.length !== (profile === 'Professor' ? 6 : 7)) throw new Error('Os indicadores do dashboard estão incompletos. Confirme se a migração 050 foi aplicada.')
  const additionalCharts: NonNullable<DashboardMetrics['additionalCharts']> = []
  if (profile === 'Administrador') {
    if (typeof result.titulo_grafico_turmas !== 'string' || !Array.isArray(result.grafico_turmas)) {
      throw new Error('O gráfico de turmas da administração está inválido.')
    }
    additionalCharts.push({ title: result.titulo_grafico_turmas, items: result.grafico_turmas.map(parseCount) })
  }
  if (profile === 'Professor') {
    if (!Array.isArray(result.grafico_ocorrencias)) throw new Error('A distribuição de ocorrências está inválida. Confirme se a migração 051 foi aplicada.')
    additionalCharts.push({ title: 'Ocorrências registradas por tipo', items: result.grafico_ocorrencias.map(parseCount), kind: 'pie' })
  }
  let nextExam: DashboardMetrics['nextExam']
  if (profile === 'Aluno') {
    const value = result.proxima_avaliacao
    if (value === null || value === undefined) nextExam = null
    else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Os dados da próxima avaliação estão inválidos.')
      const item = value as Record<string, unknown>
      if (typeof item.titulo !== 'string' || !item.titulo.trim() ||
          (item.tipo !== 'INICIO' && item.tipo !== 'ENCERRAMENTO') || !lerDataComFuso(item.alvo_em)) {
        throw new Error('Os dados da próxima avaliação estão inválidos.')
      }
      nextExam = { title: item.titulo, target: item.alvo_em as string, type: item.tipo }
    }
  }
  return { profile, cards, chart: { title: result.titulo_grafico, items }, additionalCharts, nextExam }
}
