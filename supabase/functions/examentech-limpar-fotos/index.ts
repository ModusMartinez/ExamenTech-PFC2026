// Arquivo independente para colar no editor de Edge Functions do Supabase.
// A função não aceita caminhos/IDs do chamador: só usa a fila autorizada do banco.
type Environment = Record<string, string | undefined>
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const validId = new RegExp(`^${uuid}$`)
const validPath = new RegExp(`^${uuid}/[1-9][0-9]*/(${uuid})\\.jpg$`)
type Item = { id: string; caminho: string }

function json(status: number, value: object) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function sameToken(received: string, expected: string) {
  const encoder = new TextEncoder()
  const [first, second] = await Promise.all([received, expected].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))))
  const left = new Uint8Array(first), right = new Uint8Array(second)
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i]
  return difference === 0
}

function serviceKey(env: Environment) {
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY
  if (env.SUPABASE_SECRET_KEY) return env.SUPABASE_SECRET_KEY
  try {
    const keys: unknown = JSON.parse(env.SUPABASE_SECRET_KEYS ?? '{}')
    if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
      return Object.values(keys).find((value: unknown) => typeof value === 'string' && value.startsWith('sb_secret_')) as string | undefined
    }
  } catch { /* Uma configuração inválida não deve liberar a execução. */ }
}

export function createEdgePhotoCleanup(env: Environment, transport: typeof fetch = fetch) {
  return { async fetch(request: Request): Promise<Response> {
    if (!['GET', 'POST'].includes(request.method)) return json(405, { message: 'Utilize GET ou POST.' })
    const expected = env.EXAM_PHOTO_CLEANUP_TOKEN
    const received = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!expected || expected.length < 32 || expected.length > 256) return json(503, { message: 'Limpeza não configurada.' })
    if (!received || received.length > 256 || !await sameToken(received, expected)) return json(401, { message: 'Agendamento não autorizado.' })
    let removed = 0
    try {
      const url = new URL(env.SUPABASE_URL ?? '')
      const key = serviceKey(env)
      if (!key || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('INVALID_CONFIGURATION')
      }
      const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' }
      // Chaves modernas usam apikey; o JWT de serviço legado também usa Bearer.
      if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`
      async function call(path: string, body: object, method = 'POST'): Promise<unknown> {
        const response = await transport(new URL(path, url), { method, headers, body: JSON.stringify(body),
          redirect: 'error', signal: AbortSignal.timeout(10000) })
        if (!response.ok) throw new Error('SERVICE_FAILED')
        return response.json()
      }
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        const result = await call('/rest/v1/rpc/listar_fotos_para_limpeza', {})
        if (!Array.isArray(result) || result.length > 100) throw new Error('INVALID_BATCH')
        const batch: Item[] = result.map((value: unknown) => {
          if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !validId.test(value.id) ||
              !('caminho' in value) || typeof value.caminho !== 'string' || validPath.exec(value.caminho)?.[1] !== value.id) {
            throw new Error('INVALID_ITEM')
          }
          return { id: value.id, caminho: value.caminho }
        })
        if (batch.length === 0) return json(200, { removidas: removed })
        const deleted = await call('/storage/v1/object/examentech-evidencias', { prefixes: batch.map(item => item.caminho) }, 'DELETE')
        if (!Array.isArray(deleted)) throw new Error('DELETE_NOT_CONFIRMED')
        const count = await call('/rest/v1/rpc/confirmar_limpeza_fotos', { p_ids: batch.map(item => item.id) })
        if (count !== batch.length) throw new Error('METADATA_NOT_CONFIRMED')
        removed += batch.length
      }
      return json(503, { message: 'Limpeza parcial. Execute novamente para concluir.', removidas: removed })
    } catch {
      return json(503, { message: 'Não foi possível concluir a limpeza. Verifique e repita.', removidas: removed })
    }
  } }
}

// No Node, a importação em testes não inicia um servidor nem acessa serviços.
const runtime = (globalThis as typeof globalThis & { Deno?: {
  env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): unknown;
} }).Deno
if (runtime) {
  const env = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS',
    'EXAM_PHOTO_CLEANUP_TOKEN'].map(name => [name, runtime.env.get(name)]))
  runtime.serve(createEdgePhotoCleanup(env).fetch)
}
