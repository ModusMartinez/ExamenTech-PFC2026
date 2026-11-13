import { supabase } from '../lib/supabase'
import type { Profile } from './profileAccess'

export type DashboardMetrics = {
  profile: Profile
  cards: { label: string; value: number }[]
  chart: { title: string; items: { label: string; value: number }[] }
  additionalCharts?: { title: string; items: { label: string; value: number }[] }[]
}

export async function carregarDashboard(): Promise<DashboardMetrics> {
  const { data, error } = await supabase.rpc('consultar_indicadores_dashboard')
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw new Error('A função dos indicadores não foi encontrada. Confirme se a migração 033 foi aplicada no Supabase.')
    }
    if (error.code === '42501') {
      throw new Error(error.message || 'Acesso à dashboard bloqueado pelas regras do perfil.')
    }
    console.error('Falha ao consultar indicadores da dashboard:', error.code)
    throw new Error(`Não foi possível carregar os indicadores (erro ${error.code || 'desconhecido'}).`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Não foi possível carregar os indicadores. Confirme se a migração 033 foi aplicada.')
  }
  const result = data as Record<string, unknown>
  const profiles: Record<string, Profile> = { ADMIN: 'Administrador', PROFESSOR: 'Professor', ALUNO: 'Aluno' }
  const profile = typeof result.perfil === 'string' ? profiles[result.perfil] : undefined
  if (!profile || !Array.isArray(result.indicadores) || !Array.isArray(result.grafico) || typeof result.titulo_grafico !== 'string') {
    throw new Error('A resposta do dashboard está inválida.')
  }
  const parse = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Os indicadores recebidos estão inválidos.')
    const item = value as Record<string, unknown>
    if (typeof item.rotulo !== 'string' || !Number.isSafeInteger(item.valor) || Number(item.valor) < 0) {
      throw new Error('Os indicadores recebidos estão inválidos.')
    }
    return { label: item.rotulo, value: item.valor as number }
  }
  const cards = result.indicadores.map(parse)
  const items = result.grafico.map(parse)
  if (cards.length !== 4 || items.length === 0) throw new Error('Os indicadores do dashboard estão incompletos.')
  const additionalCharts: NonNullable<DashboardMetrics['additionalCharts']> = []
  if (profile === 'Administrador') {
    if (typeof result.titulo_grafico_turmas !== 'string' || !Array.isArray(result.grafico_turmas)) {
      throw new Error('O gráfico de turmas da administração está inválido.')
    }
    additionalCharts.push({ title: result.titulo_grafico_turmas, items: result.grafico_turmas.map(parse) })
  }
  return { profile, cards, chart: { title: result.titulo_grafico, items }, additionalCharts }
}
