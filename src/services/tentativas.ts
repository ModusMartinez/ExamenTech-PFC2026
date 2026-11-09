import { supabase } from '../lib/supabase'
import { UUID_PATTERN } from './avaliacaoValidation'
import { lerDataComFuso } from './avaliacaoValidation'
import { lerConteudoTentativa, lerTentativaIniciada } from './tentativaValidation'
import { EXAM_NOTICE_VERSION } from '../content/legalDocuments'
import { photosEnabled } from './examFeatures'
import { PHOTO_NOTICE_VERSION } from './examPhotos'

async function lerResposta(response: Response, mensagemFalha: string): Promise<object> {
  let result: unknown
  try { result = await response.json() } catch { throw new Error(mensagemFalha) }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(mensagemFalha)
  if (!response.ok) {
    throw new Error('message' in result && typeof result.message === 'string' && result.message.trim()
      ? result.message : mensagemFalha)
  }
  return result
}

export async function iniciarTentativa(avaliacaoId: string) {
  if (typeof avaliacaoId !== 'string' || !UUID_PATTERN.test(avaliacaoId)) throw new Error('ID da avaliação inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const notConfirmed = 'Não foi possível confirmar o início. A tentativa pode ter sido criada. Confira com o professor antes de tentar novamente.'

  let response: Response
  try {
    response = await fetch('/api/iniciar-tentativa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
      cache: 'no-store', body: JSON.stringify({ avaliacao_id: avaliacaoId.toLowerCase(), aviso_versao: EXAM_NOTICE_VERSION,
        ...(photosEnabled() ? { fotos_aviso_versao: PHOTO_NOTICE_VERSION } : {}) }),
    })
  } catch {
    // O banco pode ter criado a tentativa antes da falha de rede. Não repetir o início.
    throw new Error(notConfirmed)
  }
  const result = await lerResposta(response, notConfirmed)
  const tentativa = lerTentativaIniciada('tentativa' in result ? result.tentativa : null)
  if (response.status !== 201 || !tentativa || tentativa.avaliacao_id !== avaliacaoId.toLowerCase() ||
      tentativa.aluno_id !== data.session.user.id.toLowerCase()) throw new Error(notConfirmed)
  return tentativa
}

export async function consultarConteudoTentativa(tentativaId: string) {
  if (typeof tentativaId !== 'string' || !UUID_PATTERN.test(tentativaId)) throw new Error('ID da tentativa inválido.')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const failure = 'Não foi possível carregar o conteúdo da tentativa.'

  let response: Response
  try {
    const query = new URLSearchParams({ tentativa_id: tentativaId.toLowerCase() })
    response = await fetch(`/api/conteudo-tentativa?${query}`, {
      method: 'GET', headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    })
  } catch {
    throw new Error('Não foi possível conectar ao serviço de avaliações. Confira sua conexão.')
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
  if (code === '42501') return new Error('Sua sessão ou perfil não permite esta operação. Entre novamente.')
  if (code === 'P0002') return new Error('Tentativa ou questão não encontrada para seu acesso.')
  if (code === '55000') return new Error('A tentativa foi encerrada ou está fora do prazo.')
  if (code === '23514') return new Error('Confira a resposta ou os dados enviados.')
  return new Error(fallback)
}

export async function registrarFalhaCamera(tentativaId: string, solicitacaoId: string) {
  if (!UUID_PATTERN.test(tentativaId) || !UUID_PATTERN.test(solicitacaoId)) throw new Error('Ocorrência inválida.')
  const failure = 'Não foi possível confirmar o registro da falha da câmera. Tente reenviar a ocorrência.'
  let result
  try {
    result = await supabase.rpc('registrar_falha_camera', {
      p_tentativa_id: tentativaId.toLowerCase(), p_solicitacao_id: solicitacaoId.toLowerCase(),
    }).abortSignal(AbortSignal.timeout(8000)).retry(false)
  } catch {
    throw new Error(failure)
  }
  if (result.error) throw erroTentativa(result.error.code, failure)
  const value: unknown = result.data
  if (!isRecord(value) || value.tentativa_id !== tentativaId.toLowerCase() ||
      value.solicitacao_id !== solicitacaoId.toLowerCase() || !lerDataComFuso(value.registrado_em)) {
    throw new Error(failure)
  }
}

export async function encerrarTentativa(tentativaId: string, motivo: 'ENVIO' | 'PRAZO' | 'SAIDA'): Promise<EncerramentoTentativa> {
  if (!UUID_PATTERN.test(tentativaId)) throw new Error('Tentativa inválida.')
  if (!['ENVIO', 'PRAZO', 'SAIDA'].includes(motivo)) throw new Error('Motivo de encerramento inválido.')
  const { data: session, error: sessionError } = await supabase.auth.getSession()
  if (sessionError || !session.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const { data, error } = await supabase.rpc('encerrar_tentativa', {
    p_tentativa_id: tentativaId, p_motivo: motivo,
  })
  if (error) throw erroTentativa(error.code, 'Não foi possível confirmar o encerramento. Confira a conexão antes de repetir.')
  const encerramento = lerEncerramento(data)
  const esperada = motivo === 'ENVIO' || motivo === 'PRAZO' ? 'FINALIZADA' : 'INTERROMPIDA'
  if (!encerramento || encerramento.id !== tentativaId.toLowerCase() || encerramento.situacao !== esperada) {
    throw new Error('Não foi possível confirmar o encerramento da tentativa.')
  }
  return encerramento
}
