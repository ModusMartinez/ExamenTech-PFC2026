import { timingSafeEqual } from 'node:crypto'
import { PHOTO_BUCKET, PHOTO_PATH, photoJson, storageClients } from '../scripts/lib/photoStorage.ts'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'

export function createLimpezaFotosHandler(env: Record<string, string | undefined> = process.env, transport: typeof fetch = fetch) {
  return { async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET') return photoJson(405, { message: 'Utilize GET.' }, { Allow: 'GET' })
    const expected = env.CRON_SECRET
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!expected || !token || Buffer.byteLength(expected) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(token))) return photoJson(401, { message: 'Agendamento não autorizado.' })
    let removed = 0
    try {
      const { admin } = storageClients(env, '', transport)
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        const { data, error } = await admin.rpc('listar_fotos_para_limpeza').retry(false)
        if (error || !Array.isArray(data) || data.length > 100 || data.some(item => !item || typeof item.id !== 'string' ||
            !UUID_PATTERN.test(item.id) || typeof item.caminho !== 'string' || !PHOTO_PATH.test(item.caminho))) throw new Error('INVALID_BATCH')
        if (data.length === 0) return photoJson(200, { removidas: removed })
        const { error: storageError } = await admin.storage.from(PHOTO_BUCKET).remove(data.map(item => item.caminho))
        if (storageError) throw new Error('DELETE_FAILED')
        const { data: count, error: confirmError } = await admin.rpc('confirmar_limpeza_fotos', { p_ids: data.map(item => item.id) }).retry(false)
        if (confirmError || count !== data.length) throw new Error('CONFIRM_FAILED')
        removed += count
      }
      return photoJson(503, { message: 'Limpeza parcial. Execute novamente para concluir.', removidas: removed })
    } catch {
      return photoJson(503, { message: 'A limpeza precisa ser verificada e repetida.', removidas: removed })
    }
  } }
}

export default createLimpezaFotosHandler()
