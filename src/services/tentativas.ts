import { supabase } from '../lib/supabase'
import { UUID_PATTERN } from './avaliacaoValidation'
import { lerDataComFuso } from './avaliacaoValidation'
import { ErroAcessoTentativa, ErroConexaoTentativa, EXECUCAO_HEADER, lerChaveExecucao,
  lerConteudoTentativa, lerTentativaIniciada, motivoSaidaValido, OPERACOES_CLIPBOARD } from './tentativaValidation'
import type { MotivoSaidaTentativa, OperacaoClipboard } from './tentativaValidation'
import { EXAM_NOTICE_VERSION, PROVA_NOTICE_VERSION } from '../content/legalDocuments'
import { PHOTO_NOTICE_VERSION } from './examPhotos'

async function lerResposta(response: Response, mensagemFalha: string): Promise<object> {
  let result: unknown
  try { result = await response.json() } catch (cause) {
    if (cause instanceof TypeError || cause instanceof DOMException) throw new ErroConexaoTentativa(mensagemFalha)
  }
  if (!response.ok) {
    const mensagem = isRecord(result) && typeof result.message === 'string' && result.message.trim()
      ? result.message : mensagemFalha
    if ([401, 403, 410].includes(response.status)) throw new ErroAcessoTentativa(mensagem)
    throw new Error(mensagem)
  }
  if (!isRecord(result)) throw new Error(mensagemFalha)
  return result
}

async function sessaoAluno() {
  const { data, error } = await supabase.auth.getSession().catch(() => {
    throw new ErroAcessoTentativa('Não foi possível conferir sua sessão.')
  })
  if (error || !data.session) throw new ErroAcessoTentativa('Sua sessão terminou. Entre novamente.')
  return data.session
}

export async function iniciarTentativa(avaliacaoId: string, chaveExecucao: string, comFotos = false) {
  if (typeof avaliacaoId !== 'string' || !UUID_PATTERN.test(avaliacaoId)) throw new Error('ID da avaliação inválido.')
  if (!lerChaveExecucao(chaveExecucao)) throw new Error('Identificação da página da prova inválida.')
  const session = await sessaoAluno()
  const notConfirmed = 'Não foi possível confirmar o início. A tentativa pode ter sido criada. Confira com o professor antes de tentar novamente.'

  let response: Response
  try {
    response = await fetch('/api/iniciar-tentativa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json',
        [EXECUCAO_HEADER]: chaveExecucao }, signal: AbortSignal.timeout(12000),
      cache: 'no-store', body: JSON.stringify({ avaliacao_id: avaliacaoId.toLowerCase(),
        aviso_versao: comFotos ? PROVA_NOTICE_VERSION : EXAM_NOTICE_VERSION,
        ...(comFotos ? { fotos_aviso_versao: PHOTO_NOTICE_VERSION } : {}) }),
    })
  } catch {
    // O banco pode ter criado a tentativa antes da falha de rede. Não repetir o início.
    throw new ErroConexaoTentativa(notConfirmed)
  }
  const result = await lerResposta(response, notConfirmed)
  const tentativa = lerTentativaIniciada('tentativa' in result ? result.tentativa : null)
  if (response.status !== 201 || !tentativa || tentativa.avaliacao_id !== avaliacaoId.toLowerCase() ||
      tentativa.aluno_id !== session.user.id.toLowerCase()) throw new Error(notConfirmed)
  return tentativa
}

export async function consultarConteudoTentativa(tentativaId: string, chaveExecucao: string) {
  if (typeof tentativaId !== 'string' || !UUID_PATTERN.test(tentativaId)) throw new Error('ID da tentativa inválido.')
  if (!lerChaveExecucao(chaveExecucao)) throw new Error('Identificação da página da prova inválida.')
  const session = await sessaoAluno()
  const failure = 'Não foi possível carregar o conteúdo da tentativa.'

  let response: Response
  try {
    const query = new URLSearchParams({ tentativa_id: tentativaId.toLowerCase() })
    response = await fetch(`/api/conteudo-tentativa?${query}`, {
      method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${session.access_token}`, [EXECUCAO_HEADER]: chaveExecucao },
    })
  } catch {
    throw new ErroConexaoTentativa('Não foi possível conectar ao serviço de avaliações. Confira sua conexão.')
  }
  const result = await lerResposta(response, failure)
  const conteudo = lerConteudoTentativa('conteudo' in result ? result.conteudo : null)
  if (response.status !== 200 || !conteudo || conteudo.tentativa_id !== tentativaId.toLowerCase()) throw new Error(failure)
  return conteudo
}

export type EncerramentoTentativa = {
  id: string
  situacao: 'FINALIZADA' | 'INTERROMPIDA'
  encerrada_em: string
  falhas_camera: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function lerEncerramento(value: unknown): EncerramentoTentativa | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      (value.situacao !== 'FINALIZADA' && value.situacao !== 'INTERROMPIDA') ||
      !Number.isInteger(value.falhas_camera) || (value.falhas_camera !== 0 && value.falhas_camera !== 1)) return null
  const encerradaEm = lerDataComFuso(value.encerrada_em)
  if (!encerradaEm) return null
  return { id: value.id.toLowerCase(), situacao: value.situacao,
    encerrada_em: encerradaEm, falhas_camera: value.falhas_camera }
}

function erroTentativa(code: string | undefined, fallback: string): Error {
  if (code === '42501') return new ErroAcessoTentativa('A tentativa só pode ser acessada na sessão e na página em que começou.')
  if (code === 'P0002') return new Error('Tentativa ou questão não encontrada para seu acesso.')
  if (code === '55000') return new Error('A tentativa foi encerrada ou está fora do prazo.')
  if (code === '23514') return new Error('Confira a resposta ou os dados enviados.')
  return new Error(fallback)
}

export async function registrarFalhaCamera(tentativaId: string, solicitacaoId: string, chaveExecucao: string) {
  if (!UUID_PATTERN.test(tentativaId) || !UUID_PATTERN.test(solicitacaoId) || !lerChaveExecucao(chaveExecucao)) {
    throw new Error('Ocorrência inválida.')
  }
  const failure = 'Não foi possível confirmar o registro da falha da câmera. Tente reenviar a ocorrência.'
  const connectionFailure = 'A conexão foi perdida durante o registro da ocorrência.'
  let result
  try {
    result = await supabase.rpc('registrar_falha_camera', {
      p_tentativa_id: tentativaId.toLowerCase(), p_solicitacao_id: solicitacaoId.toLowerCase(), p_chave_execucao: chaveExecucao,
    }).abortSignal(AbortSignal.timeout(8000)).retry(false)
  } catch {
    throw new ErroConexaoTentativa(connectionFailure)
  }
  if (result.status === 0) throw new ErroConexaoTentativa(connectionFailure)
  if (result.status === 401) throw new ErroAcessoTentativa('Sua sessão terminou. Entre novamente.')
  if (result.error) throw erroTentativa(result.error.code, failure)
  const value: unknown = result.data
  if (!isRecord(value) || value.tentativa_id !== tentativaId.toLowerCase() ||
      value.solicitacao_id !== solicitacaoId.toLowerCase() || !lerDataComFuso(value.registrado_em)) {
    throw new Error(failure)
  }
}

export async function registrarBloqueioClipboard(tentativaId: string, solicitacaoId: string, chaveExecucao: string,
  operacao: OperacaoClipboard) {
  if (!UUID_PATTERN.test(tentativaId) || !UUID_PATTERN.test(solicitacaoId) || !lerChaveExecucao(chaveExecucao) ||
      !OPERACOES_CLIPBOARD.includes(operacao)) throw new Error('Ocorrência inválida.')
  const failure = 'Não foi possível confirmar o registro do bloqueio da área de transferência.'
  const { data, error, status } = await supabase.rpc('registrar_bloqueio_clipboard', {
    p_tentativa_id: tentativaId, p_solicitacao_id: solicitacaoId, p_chave_execucao: chaveExecucao, p_operacao: operacao,
  }).abortSignal(AbortSignal.timeout(8000)).retry(false)
  if (status === 0) throw new ErroConexaoTentativa('A conexão foi perdida durante o registro da ocorrência.')
  if (status === 401) throw new ErroAcessoTentativa('Sua sessão terminou. Entre novamente.')
  if (error) throw erroTentativa(error.code, failure)
  const confirmacao: unknown = data
  if (!isRecord(confirmacao) || confirmacao.tentativa_id !== tentativaId ||
      confirmacao.solicitacao_id !== solicitacaoId || !lerDataComFuso(confirmacao.registrado_em)) throw new Error(failure)
}

export async function encerrarTentativa(tentativaId: string, motivo: 'ENVIO' | 'PRAZO' | MotivoSaidaTentativa,
  chaveExecucao: string): Promise<EncerramentoTentativa> {
  if (!UUID_PATTERN.test(tentativaId)) throw new Error('Tentativa inválida.')
  const saida = motivoSaidaValido(motivo)
  if (!saida && motivo !== 'ENVIO' && motivo !== 'PRAZO') throw new Error('Motivo de encerramento inválido.')
  if (!lerChaveExecucao(chaveExecucao)) throw new Error('Identificação da página da prova inválida.')
  const failure = 'Não foi possível confirmar o encerramento da tentativa.'
  let encerramento: EncerramentoTentativa | null
  if (saida) {
    const session = await sessaoAluno()
    const query = new URLSearchParams({ tentativa_id: tentativaId })
    if (motivo !== 'SAIDA') query.set('motivo', motivo)
    const response = await fetch(`/api/encerrar-tentativa?${query}`, {
      method: 'POST', cache: 'no-store', keepalive: true, signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${session.access_token}`, [EXECUCAO_HEADER]: chaveExecucao },
    }).catch(() => { throw new ErroConexaoTentativa(failure) })
    const result = await lerResposta(response, failure)
    encerramento = lerEncerramento('encerramento' in result ? result.encerramento : null)
  } else {
    const { data, error, status } = await supabase.rpc('encerrar_tentativa', {
      p_tentativa_id: tentativaId, p_motivo: motivo, p_chave_execucao: chaveExecucao,
    }).abortSignal(AbortSignal.timeout(12000)).retry(false)
    if (status === 0) throw new ErroConexaoTentativa(failure)
    if (status === 401) throw new ErroAcessoTentativa('Sua sessão terminou. Entre novamente.')
    if (error) throw erroTentativa(error.code, failure)
    encerramento = lerEncerramento(data)
  }
  if (!encerramento || encerramento.id !== tentativaId.toLowerCase() ||
      (!saida && encerramento.situacao !== 'FINALIZADA')) {
    throw new Error(failure)
  }
  return encerramento
}
