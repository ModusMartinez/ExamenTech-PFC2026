import { createClient } from '@supabase/supabase-js'

export const PHOTO_BUCKET = 'examentech-evidencias'
export const PHOTO_MAX_BYTES = 1024 * 1024
export const PHOTO_NOTICE_VERSION = '2026-11-08-fotos-v1'
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
export const PHOTO_PATH = new RegExp(`^${uuid}/[1-9][0-9]*/${uuid}\\.jpg$`)

export function photoJson(status: number, body: object, extra?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', ...extra } })
}

export function storageClients(env: Record<string, string | undefined>, token: string, transport: typeof fetch) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !publicKey || !secret) throw new Error('STORAGE_NOT_CONFIGURED')
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  return {
    user: createClient(url, publicKey, { ...options, global: { headers: { Authorization: `Bearer ${token}` }, fetch: transport } }),
    admin: createClient(url, secret, { ...options, global: { fetch: transport } }),
  }
}

export async function readPhotoBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length')) > PHOTO_MAX_BYTES) throw new Error('TOO_LARGE')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('INVALID_JPEG')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > PHOTO_MAX_BYTES) {
        await reader.cancel()
        throw new Error('TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let position = 0
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length }
  return result
}

// Confere dimensões no arquivo, não em valores enviados pelo navegador.
// APP1/EXIF e comentários são recusados: o canvas da câmera não precisa deles.
export function jpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('INVALID_JPEG')
  let at = 2
  let dimensions: { width: number; height: number } | null = null
  while (at < bytes.length - 2) {
    if (bytes[at++] !== 0xff) throw new Error('INVALID_JPEG')
    while (bytes[at] === 0xff) at++
    const marker = bytes[at++]
    if (marker === 0xe1 || marker === 0xfe) throw new Error('INVALID_JPEG')
    const length = (bytes[at] << 8) | bytes[at + 1]
    if (length < 2 || at + length > bytes.length) throw new Error('INVALID_JPEG')
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || dimensions) throw new Error('INVALID_JPEG')
      const height = (bytes[at + 3] << 8) | bytes[at + 4]
      const width = (bytes[at + 5] << 8) | bytes[at + 6]
      if (width < 1 || width > 960 || height < 1 || height > 720) throw new Error('INVALID_JPEG')
      dimensions = { width, height }
    }
    if (marker === 0xda) {
      if (!dimensions) throw new Error('INVALID_JPEG')
      return dimensions
    }
    at += length
  }
  throw new Error('INVALID_JPEG')
}
