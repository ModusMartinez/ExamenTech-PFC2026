import { lerDataComFuso, UUID_PATTERN } from './avaliacaoValidation'
import type { PhotoMoment } from './photoEvidence'

export const PHOTO_NOTICE_VERSION = '2026-11-08-fotos-v1'
export const PHOTO_NOTICE = 'Uma foto inicial e três fotos em momentos aleatórios da tentativa serão enviadas ao armazenamento privado. O professor responsável e o ADM da sua organização poderão consultá-las para análise manual. O prazo máximo é de 90 dias por foto, com exclusão automática. Não há gravação de vídeo ou áudio, comparação facial nem identificação automática de fraude. Se você enviar a prova antes dos horários sorteados, as fotos futuras não serão tiradas. Uma retomada autorizada exige novo aviso e novas capturas.'
export type PhotoSlot = { id: string; momento: PhotoMoment; agendada_em: string; recebida_em: string | null }
export type PhotoPlan = { tentativa_id: string; ciclo: number; servidor_em: string; capturas: PhotoSlot[] }
export type ResponsiblePhoto = PhotoSlot & { ciclo: number; expira_em: string | null; situacao: 'PENDENTE' | 'ENVIANDO' | 'DISPONIVEL' | 'EXCLUIDA' }
const moments: PhotoMoment[] = ['INICIAL', 'PROVA_1', 'PROVA_2', 'PROVA_3']

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function slot(value: unknown): PhotoSlot | null {
  if (!record(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) ||
      !moments.includes(value.momento as PhotoMoment)) return null
  const scheduled = lerDataComFuso(value.agendada_em)
  const received = value.recebida_em === null ? null : lerDataComFuso(value.recebida_em)
  if (!scheduled || (value.recebida_em !== null && !received)) return null
  return { id: value.id, momento: value.momento as PhotoMoment, agendada_em: scheduled, recebida_em: received }
}

export async function consultarPlanoFotos(tentativaId: string): Promise<PhotoPlan> {
  if (!UUID_PATTERN.test(tentativaId)) throw new Error('Tentativa inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('consultar_plano_fotos', { p_tentativa_id: tentativaId })
  if (error || !record(data) || data.tentativa_id !== tentativaId || !Number.isSafeInteger(data.ciclo) ||
      (data.ciclo as number) < 1 || data.retencao_dias !== 90 || !Array.isArray(data.capturas) || data.capturas.length !== 4) {
    throw new Error('Não foi possível consultar os horários das fotos. Tente novamente nesta página.')
  }
  const serverTime = lerDataComFuso(data.servidor_em)
  const captures = data.capturas.map(slot)
  if (!serverTime || captures.some((item, i) => !item || item.momento !== moments[i]) ||
      new Set(captures.map(item => item?.id)).size !== 4) throw new Error('O plano das fotos não pôde ser confirmado.')
  return { tentativa_id: tentativaId, ciclo: data.ciclo as number, servidor_em: serverTime, capturas: captures as PhotoSlot[] }
}

async function sessionToken() {
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sua sessão terminou. Entre novamente.')
  return data.session.access_token
}

export async function enviarFoto(captureId: string, uploadId: string, blob: Blob, signal: AbortSignal) {
  if (!UUID_PATTERN.test(captureId) || !UUID_PATTERN.test(uploadId)) throw new Error('Captura inválida.')
  const token = await sessionToken()
  const query = new URLSearchParams({ captura_id: captureId, upload_id: uploadId })
  const response = await fetch(`/api/fotos-tentativa?${query}`, { method: 'POST', cache: 'no-store', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: blob })
  const result: unknown = await response.json()
  if (!response.ok || !record(result) || result.id !== captureId || !lerDataComFuso(result.recebida_em) || !lerDataComFuso(result.expira_em)) {
    throw new Error('Foto ainda não confirmada. Confira a conexão e reenvie a captura pendente.')
  }
}

export async function listarFotosResponsavel(tentativaId: string): Promise<ResponsiblePhoto[]> {
  if (!UUID_PATTERN.test(tentativaId)) throw new Error('Tentativa inválida.')
  const { supabase } = await import('../lib/supabase')
  const { data, error } = await supabase.rpc('listar_fotos_responsavel', { p_tentativa_id: tentativaId })
  if (error || !Array.isArray(data) || data.length > 100) throw new Error('Não foi possível consultar as fotos para seu acesso.')
  return data.map((item: unknown) => {
    const capture = slot(item)
    if (!capture || !record(item) || !Number.isSafeInteger(item.ciclo) || (item.ciclo as number) < 1 ||
        !['PENDENTE', 'ENVIANDO', 'DISPONIVEL', 'EXCLUIDA'].includes(String(item.situacao)) ||
        (item.expira_em !== null && !lerDataComFuso(item.expira_em))) throw new Error('Os registros das fotos não puderam ser confirmados.')
    return { ...capture, ciclo: item.ciclo as number, situacao: item.situacao as ResponsiblePhoto['situacao'],
      expira_em: item.expira_em as string | null }
  })
}

export async function consultarImagemFoto(captureId: string, signal: AbortSignal): Promise<Blob> {
  if (!UUID_PATTERN.test(captureId)) throw new Error('Captura inválida.')
  const token = await sessionToken()
  const response = await fetch(`/api/fotos-tentativa?${new URLSearchParams({ captura_id: captureId })}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal,
  })
  if (!response.ok || response.headers.get('content-type') !== 'image/jpeg') throw new Error('Foto indisponível ou sem acesso.')
  return response.blob()
}
