import { createHash } from 'node:crypto'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import { PHOTO_BUCKET, PHOTO_PATH, jpegDimensions, photoJson, readPhotoBody, storageClients } from '../scripts/lib/photoStorage.ts'

export function createFotosTentativaHandler(env: Record<string, string | undefined> = process.env, transport: typeof fetch = fetch) {
  return { async fetch(request: Request): Promise<Response> {
    if (!['GET', 'POST'].includes(request.method)) return photoJson(405, { message: 'Utilize GET ou POST.' }, { Allow: 'GET, POST' })
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) return photoJson(401, { message: 'Entre novamente para acessar fotografias.' })
    if (env.EXAM_PHOTOS_ENABLED !== 'true') return photoJson(503, { message: 'O envio e a consulta de fotos ainda não estão habilitados.' })
    const query = new URL(request.url).searchParams
    const id = query.get('captura_id')
    const uploadId = query.get('upload_id')
    if (!id || !UUID_PATTERN.test(id) || (request.method === 'GET' ? query.size !== 1
      : query.size !== 2 || !uploadId || !UUID_PATTERN.test(uploadId))) {
      return photoJson(400, { message: 'Identificação da captura inválida.' })
    }
    try {
      // Toda autorização usa o JWT do usuário. A chave privada só transfere o
      // arquivo já autorizado e confirma sua existência no Storage.
      const { user, admin } = storageClients(env, token, transport)
      const { data: identity, error: authError } = await user.auth.getUser(token)
      if (authError || !identity.user) return photoJson(authError && ![400, 401, 403].includes(authError.status ?? 0) ? 503 : 401,
        { message: 'Não foi possível conferir sua sessão.' })
      const { data: bucket, error: bucketError } = await admin.storage.getBucket(PHOTO_BUCKET)
      if (bucketError || !bucket || bucket.public !== false || Number(bucket.file_size_limit) !== 1024 * 1024 ||
          bucket.allowed_mime_types?.length !== 1 || bucket.allowed_mime_types[0] !== 'image/jpeg') {
        return photoJson(503, { message: 'O armazenamento privado das fotos precisa ser conferido pelo responsável.' })
      }
      if (request.method === 'GET') {
        const { data, error } = await user.rpc('autorizar_leitura_foto', { p_captura_id: id }).retry(false)
        if (error || !data || data.id !== id || typeof data.caminho !== 'string' || !PHOTO_PATH.test(data.caminho) ||
            !Number.isFinite(Date.parse(data.expira_em)) || Date.parse(data.expira_em) <= Date.now()) {
          return photoJson(error?.code === '42501' ? 403 : 503, { message: 'Foto indisponível ou sem acesso.' })
        }
        const { data: blob, error: storageError } = await admin.storage.from(PHOTO_BUCKET).download(data.caminho)
        if (storageError || !blob) return photoJson(503, { message: 'Não foi possível consultar a foto.' })
        return new Response(blob, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="evidencia.jpg"' } })
      }
      if (request.headers.get('content-type')?.toLowerCase() !== 'image/jpeg') return photoJson(415, { message: 'Envie uma foto JPEG.' })
      const bytes = await readPhotoBody(request)
      const { width, height } = jpegDimensions(bytes)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const { data: reserve, error } = await user.rpc('reservar_envio_foto', {
        p_captura_id: id, p_upload_id: uploadId, p_sha256: hash,
        p_tamanho: bytes.length, p_largura: width, p_altura: height,
      }).retry(false)
      if (error) return photoJson(error.code === '42501' ? 403 : error.code === '55000' ? 409 : 503,
        { message: 'Não foi possível autorizar o envio desta captura.' })
      if (!reserve || reserve.id !== id || typeof reserve.caminho !== 'string' || !PHOTO_PATH.test(reserve.caminho)) {
        return photoJson(503, { message: 'Não foi possível confirmar a reserva da foto.' })
      }
      if (!reserve.ja_recebida) {
        const { error: storageError } = await admin.storage.from(PHOTO_BUCKET).upload(reserve.caminho, bytes, {
          contentType: 'image/jpeg', upsert: false, cacheControl: '0',
        })
        // O mesmo envio pode já ter chegado antes de uma resposta se perder.
        if (storageError) {
          const status = 'statusCode' in storageError ? String(storageError.statusCode) : ''
          const duplicate = status === '409' || (status === '400' && /already exists|duplicate/i.test(storageError.message))
          if (!duplicate) return photoJson(503, { message: 'A foto não foi confirmada. Tente reenviar a captura pendente.' })
          const { data: existing, error: readError } = await admin.storage.from(PHOTO_BUCKET).download(reserve.caminho)
          if (readError || !existing || existing.size > 1024 * 1024 ||
              createHash('sha256').update(new Uint8Array(await existing.arrayBuffer())).digest('hex') !== hash) {
            return photoJson(409, { message: 'O arquivo existente não corresponde a esta captura. Informe o responsável.' })
          }
        }
      }
      const { data, error: confirmError } = await admin.rpc('confirmar_envio_foto', {
        p_captura_id: id, p_upload_id: uploadId,
      }).retry(false)
      if (confirmError || !data || data.id !== id || !Number.isFinite(Date.parse(data.recebida_em)) ||
          !Number.isFinite(Date.parse(data.expira_em))) return photoJson(503, { message: 'O recebimento da foto ainda não foi confirmado.' })
      return photoJson(200, { id, recebida_em: data.recebida_em, expira_em: data.expira_em })
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : ''
      return photoJson(code === 'TOO_LARGE' ? 413 : code === 'INVALID_JPEG' ? 400 : 503, {
        message: code === 'TOO_LARGE' ? 'A foto ultrapassa 1 MiB.' : code === 'INVALID_JPEG'
          ? 'Foto inválida. Utilize a captura da câmera do sistema.' : 'Serviço de fotografias indisponível.',
      })
    }
  } }
}

export default createFotosTentativaHandler()
