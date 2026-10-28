import type { CamposAvaliacaoRascunho } from './avaliacaoValidation'

export type ErroFormularioAvaliacao = { campo: string; mensagem: string }

export function dataISOParaLocal(value: string) {
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dataLocalParaISO(value: string, original?: string) {
  // Mantém segundos e o instante original em fusos com horário repetido, se o campo não mudou.
  if (original && value === dataISOParaLocal(original)) return original
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || value.startsWith('0000-')) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const partes = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
  if (partes.some((parte, index) => parte !== Number(value.split(/[-T:]/)[index]))) return null
  return date.toISOString()
}

export function lerFormularioAvaliacao(values: FormData, original?: CamposAvaliacaoRascunho):
  { dados: CamposAvaliacaoRascunho; erro: null } | { dados: null; erro: ErroFormularioAvaliacao } {
  const campo = (name: string) => String(values.get(name) ?? '')
  const titulo = campo('titulo').trim()
  const tipo = campo('tipo')
  const inicio = dataLocalParaISO(campo('inicio_em'), original?.inicio_em)
  const fim = dataLocalParaISO(campo('fim_em'), original?.fim_em)
  const duracao = Number(campo('duracao_minutos'))
  const invalid = (campo: string, mensagem: string) => ({ dados: null, erro: { campo, mensagem } })
  if ([...titulo].length < 3 || [...titulo].length > 150) return invalid('titulo', 'Título deve ter de 3 a 150 caracteres.')
  if (tipo !== 'PROVA' && tipo !== 'ATIVIDADE') return invalid('tipo', 'Selecione Prova ou Atividade.')
  if (!inicio) return invalid('inicio_em', 'Informe uma data e um horário de início válidos.')
  if (!fim || Date.parse(fim) <= Date.parse(inicio)) return invalid('fim_em', 'Fim deve ser posterior ao início.')
  if (!Number.isInteger(duracao) || duracao < 1 || duracao > 2147483647) {
    return invalid('duracao_minutos', 'Informe uma duração válida em minutos inteiros, maior que zero.')
  }
  return { dados: { titulo, tipo, inicio_em: inicio, fim_em: fim, duracao_minutos: duracao }, erro: null }
}
