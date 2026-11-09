import { supabase } from '../lib/supabase'
import { UUID_PATTERN } from './avaliacaoValidation'
import { lerDadosRespostaTentativa, lerRespostaTentativa } from './respostaValidation'
import type { DadosRespostaTentativa, RespostaTentativa } from './respostaValidation'

export class ErroSalvamentoResposta extends Error {
  readonly codigo: 'CONFLITO' | 'RECUSADA' | 'NAO_CONFIRMADA'

  constructor(message: string, codigo: ErroSalvamentoResposta['codigo']) {
    super(message)
    this.name = 'ErroSalvamentoResposta'
    this.codigo = codigo
  }
}

export async function consultarRespostasTentativa(tentativaId: string): Promise<RespostaTentativa[]> {
  if (typeof tentativaId !== 'string' || !UUID_PATTERN.test(tentativaId)) throw new Error('Tentativa inválida.')
  const id = tentativaId.toLowerCase()
  let dados: unknown
  try {
    const resultado = await supabase.rpc('consultar_respostas_tentativa', { p_tentativa_id: id })
    if (resultado.error) throw resultado.error
    dados = resultado.data
  } catch {
    throw new Error('Não foi possível recuperar as respostas já salvas.')
  }
  const falha = 'As respostas anteriores não puderam ser confirmadas.'
  if (!Array.isArray(dados)) throw new Error(falha)
  const respostas: RespostaTentativa[] = []
  for (const item of dados) {
    const resposta = lerRespostaTentativa(item)
    if (!resposta || resposta.tentativa_id !== id || respostas.some(anterior =>
      anterior.questao_id === resposta.questao_id || anterior.id === resposta.id)) throw new Error(falha)
    respostas.push(resposta)
  }
  return respostas
}

export async function salvarRespostaTentativa(dados: DadosRespostaTentativa): Promise<RespostaTentativa> {
  // Copiar e validar antes de aguardar a sessão: esta requisição representa uma versão específica.
  const entrada = lerDadosRespostaTentativa(dados)
  if (!entrada) throw new ErroSalvamentoResposta('Confira a questão, a versão e o conteúdo da resposta.', 'RECUSADA')
  const { data, error } = await supabase.auth.getSession().catch(() => {
    throw new ErroSalvamentoResposta('Não foi possível conferir sua sessão. Entre novamente.', 'RECUSADA')
  })
  if (error || !data.session) throw new ErroSalvamentoResposta('Sua sessão terminou. Entre novamente.', 'RECUSADA')

  const naoConfirmada = 'Não foi possível confirmar o salvamento. A resposta pode ter sido salva. Reenvie o mesmo conteúdo e a mesma versão.'
  let response: Response
  try {
    response = await fetch('/api/salvar-resposta-tentativa', {
      method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(entrada),
    })
  } catch {
    throw new ErroSalvamentoResposta(naoConfirmada, 'NAO_CONFIRMADA')
  }

  let resultado: unknown
  try { resultado = await response.json() } catch {
    throw new ErroSalvamentoResposta(naoConfirmada, 'NAO_CONFIRMADA')
  }
  if (!resultado || typeof resultado !== 'object' || Array.isArray(resultado)) {
    throw new ErroSalvamentoResposta(naoConfirmada, 'NAO_CONFIRMADA')
  }
  if (!response.ok) {
    const mensagem = 'message' in resultado && typeof resultado.message === 'string' && resultado.message.trim()
      ? resultado.message : null
    if (response.status === 409) {
      throw new ErroSalvamentoResposta(mensagem ?? 'A tentativa está indisponível ou a versão da resposta está desatualizada.', 'CONFLITO')
    }
    if ([400, 401, 403, 404, 405, 413, 415].includes(response.status)) {
      throw new ErroSalvamentoResposta(mensagem ?? 'O salvamento da resposta foi recusado.', 'RECUSADA')
    }
    throw new ErroSalvamentoResposta(naoConfirmada, 'NAO_CONFIRMADA')
  }
  const resposta = lerRespostaTentativa('resposta' in resultado ? resultado.resposta : null)
  if (response.status !== 200 || !resposta || resposta.tentativa_id !== entrada.tentativa_id ||
      resposta.questao_id !== entrada.questao_id || resposta.versao !== entrada.versao ||
      resposta.alternativa_id !== entrada.alternativa_id || resposta.texto !== (entrada.texto === '' ? null : entrada.texto)) {
    throw new ErroSalvamentoResposta(naoConfirmada, 'NAO_CONFIRMADA')
  }
  return resposta
}
