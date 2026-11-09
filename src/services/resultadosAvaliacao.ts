import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation'
import { lerCorrecao } from './correcoesTentativa'
import type { QuestaoCorrecao } from './correcoesTentativa'

export type ResultadoPublicado = {
  tentativa_id: string
  avaliacao_id: string
  titulo: string
  turma_nome: string
  publicado_em: string
}

type AlternativaResultado = { id: string; texto: string; correta: boolean; marcada: boolean }
export type ResultadoAluno = ResultadoPublicado & {
  nota: number
  pontos_obtidos: number
  pontos_totais: number
  questoes: (Omit<QuestaoCorrecao, 'pontos'> & { pontos: number; alternativas: AlternativaResultado[] })[]
}

const estados = ['JANELA_ABERTA', 'ENCERRAMENTO_PENDENTE', 'SEM_TENTATIVAS', 'CORRECAO_PENDENTE', 'PRONTO', 'PUBLICADO'] as const
export type EstadoPublicacao = { estado: typeof estados[number]; publicado_em: string | null }

function registro(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function idValido(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function lerResultadoPublicado(value: unknown): ResultadoPublicado | null {
  if (!registro(value) || !idValido(value.tentativa_id) || !idValido(value.avaliacao_id) ||
      typeof value.titulo !== 'string' || !value.titulo.trim() || typeof value.turma_nome !== 'string' || !value.turma_nome.trim()) return null
  const publicadoEm = lerDataComFuso(value.publicado_em)
  return publicadoEm ? { tentativa_id: value.tentativa_id, avaliacao_id: value.avaliacao_id,
    titulo: value.titulo, turma_nome: value.turma_nome, publicado_em: publicadoEm } : null
}

export async function listarMeusResultados() {
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('listar_meus_resultados')
  if (error || !Array.isArray(data) || data.length > 50) throw new Error('Não foi possível consultar seus resultados.')
  return data.map(item => {
    const resultado = lerResultadoPublicado(item)
    if (!resultado) throw new Error('Não foi possível confirmar seus resultados.')
    return resultado
  })
}

export async function consultarMeuResultado(tentativaId: string): Promise<ResultadoAluno> {
  if (!idValido(tentativaId)) throw new Error('Resultado inválido.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('consultar_meu_resultado', { p_tentativa_id: tentativaId })
  if (error) throw new Error(error.code === 'P0002' ? 'Resultado indisponível para seu acesso.' : 'Não foi possível consultar o resultado.')
  const falha = 'Não foi possível confirmar o resultado publicado.'
  const publicado = lerResultadoPublicado(data)
  const correcao = lerCorrecao(data, tentativaId.toLowerCase())
  if (!publicado || correcao.nota === null || !registro(data) || !Array.isArray(data.questoes)) throw new Error(falha)
  const questoesRecebidas: unknown[] = data.questoes
  const questoes = correcao.questoes.map((questao, index) => {
    const item = questoesRecebidas[index]
    if (!registro(item) || !Array.isArray(item.alternativas) || questao.pontos === null) throw new Error(falha)
    const alternativas: AlternativaResultado[] = item.alternativas.map((alternativa: unknown) => {
      if (!registro(alternativa) || !idValido(alternativa.id) || typeof alternativa.texto !== 'string' ||
          typeof alternativa.correta !== 'boolean' || typeof alternativa.marcada !== 'boolean') throw new Error(falha)
      return { id: alternativa.id, texto: alternativa.texto, correta: alternativa.correta, marcada: alternativa.marcada }
    })
    return { ...questao, pontos: questao.pontos, alternativas }
  })
  return { ...publicado, nota: correcao.nota, pontos_obtidos: correcao.pontos_obtidos,
    pontos_totais: correcao.pontos_totais, questoes }
}

function lerEstadoPublicacao(value: unknown, avaliacaoId: string): EstadoPublicacao {
  if (!registro(value) || value.avaliacao_id !== avaliacaoId) throw new Error('Não foi possível confirmar o estado da publicação.')
  const estado = estados.find(item => item === value.estado)
  const publicadoEm = lerDataComFuso(value.publicado_em)
  if (!estado || (estado === 'PUBLICADO' ? !publicadoEm : value.publicado_em !== null)) {
    throw new Error('Não foi possível confirmar o estado da publicação.')
  }
  return { estado, publicado_em: publicadoEm }
}

export async function consultarPublicacaoResultados(avaliacaoId: string) {
  if (!idValido(avaliacaoId)) throw new Error('Avaliação inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('consultar_publicacao_resultados', { p_avaliacao_id: avaliacaoId })
  if (error) throw new Error('Não foi possível consultar a publicação dos resultados.')
  return lerEstadoPublicacao(data, avaliacaoId.toLowerCase())
}

export async function publicarResultadosAvaliacao(avaliacaoId: string) {
  if (!idValido(avaliacaoId)) throw new Error('Avaliação inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('publicar_resultados_avaliacao', { p_avaliacao_id: avaliacaoId }).retry(false)
  if (error?.code === '55000') throw new Error('Os resultados ainda não estão prontos. Atualize para conferir.')
  if (error) throw new Error('Não foi possível confirmar a publicação.')
  const publicacao = lerEstadoPublicacao(data, avaliacaoId.toLowerCase())
  if (publicacao.estado !== 'PUBLICADO') throw new Error('A publicação não foi confirmada.')
  return publicacao
}
