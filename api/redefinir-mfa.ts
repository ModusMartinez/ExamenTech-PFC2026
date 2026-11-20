import { createClient } from '@supabase/supabase-js'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'

function json(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createRedefinirMfaHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return { async fetch(request: Request) {
    if (!['GET', 'POST'].includes(request.method)) return json(405, { message: 'Utilize GET ou POST.' }, { Allow: 'GET, POST' })
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) return json(401, { message: 'Entre novamente para administrar o segundo fator.' })
    const query = new URL(request.url).searchParams
    let usuarioId = ''
    const busca = query.get('busca')?.trim() ?? ''
    if (request.method === 'GET') {
      if ([...query.keys()].some((key) => key !== 'busca') || query.getAll('busca').length !== 1 || busca.length < 3 || busca.length > 120) {
        return json(400, { message: 'Informe entre 3 e 120 caracteres do nome ou e-mail.' })
      }
    } else {
      if ([...query.keys()].length) return json(400, { message: 'Consulta inválida.' })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(415, { message: 'Envie os dados no formato JSON.' })
      }
      try {
        const body: unknown = await request.json()
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['usuario_id', 'confirmado'].includes(key)) ||
            !('usuario_id' in body) || typeof body.usuario_id !== 'string' || !UUID_PATTERN.test(body.usuario_id) ||
            !('confirmado' in body) || body.confirmado !== true) return json(400, { message: 'Confirme a redefinição para um usuário válido.' })
        usuarioId = body.usuario_id.toLowerCase()
      } catch { return json(400, { message: 'JSON inválido.' }) }
    }
    const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
    const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
    const secretKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !publicKey || !secretKey) return json(503, { message: 'Serviço de redefinição do segundo fator não configurado.' })
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    const client = createClient(url, publicKey, {
      ...options, global: { fetch: fetchImplementation, headers: { Authorization: `Bearer ${token}` } },
    })
    try {
      const { data, error } = await client.auth.getUser(token)
      if (error || !data.user) return json(error && ![400, 401, 403].includes(error.status ?? 0) ? 503 : 401,
        { message: 'Não foi possível confirmar sua sessão. Entre novamente.' })
      if (usuarioId === data.user.id.toLowerCase()) return json(403, { message: 'Não é permitido redefinir seu próprio segundo fator por esta função.' })
      if (request.method === 'GET') {
        const result = await client.rpc('listar_usuarios_redefinicao_mfa', { p_busca: busca })
        if (result.error) return json(result.error.code === '42501' ? 403 : 503,
          { message: 'A consulta exige administrador da organização ativa, com MFA.' })
        if (!Array.isArray(result.data)) return json(503, { message: 'Não foi possível carregar os usuários.' })
        return json(200, { usuarios: result.data })
      }
      const authorization = await client.rpc('autorizar_redefinicao_mfa', { p_usuario_id: usuarioId })
      if (authorization.error) return json(authorization.error.code === '42501' ? 403 : authorization.error.code === '23505' ? 409 : 503,
        { message: authorization.error.code === '23505' ? 'Já existe uma redefinição em andamento. Aguarde antes de conferir novamente.'
          : 'Redefinição não autorizada. Confira seu vínculo com a organização e o MFA.' })
      if (typeof authorization.data !== 'string' || !UUID_PATTERN.test(authorization.data)) {
        return json(503, { message: 'Não foi possível confirmar a autorização da redefinição.' })
      }
      const admin = createClient(url, secretKey, { ...options, global: { fetch: fetchImplementation } })
      // A autorização expira em cinco minutos; as chamadas do Auth compartilham um limite menor.
      const authSignal = AbortSignal.timeout(60_000)
      const adminAuth = createClient(url, secretKey, { ...options, global: {
        fetch: (input, init) => fetchImplementation(input, { ...init, signal: authSignal }),
      } })
      let completed = false
      try {
        const factors = await adminAuth.auth.admin.mfa.listFactors({ userId: usuarioId })
        if (factors.error || !factors.data || !Array.isArray(factors.data.factors)) throw new Error('MFA_LIST_FAILED')
        // A aplicação usa TOTP; remover todos os fatores evita conservar outro autenticador antigo.
        for (const factor of factors.data.factors) {
          const removed = await adminAuth.auth.admin.mfa.deleteFactor({ userId: usuarioId, id: factor.id })
          if (removed.error) throw new Error('MFA_DELETE_FAILED')
        }
        const remaining = await adminAuth.auth.admin.mfa.listFactors({ userId: usuarioId })
        completed = !remaining.error && Array.isArray(remaining.data?.factors) && remaining.data.factors.length === 0
      } catch { completed = false }
      const finalized = await admin.rpc('concluir_redefinicao_mfa', {
        p_redefinicao_id: authorization.data, p_sucesso: completed,
      })
      if (finalized.error || finalized.data !== true) return json(503, {
        message: 'O segundo fator pode ter sido alterado, mas não foi possível confirmar a auditoria e o encerramento das sessões. Confira com o responsável antes de repetir.',
      })
      if (!completed) return json(503, { message: 'A redefinição não foi concluída. As sessões anteriores foram encerradas. Confira a auditoria antes de tentar novamente.' })
      return json(200, { redefinido: true, message: 'Segundo fator redefinido. No próximo acesso, o usuário deverá configurar o Authenticator novamente.' })
    } catch {
      return json(503, { message: 'Não foi possível confirmar a redefinição. Confira a auditoria antes de repetir a operação.' })
    }
  } }
}

export default createRedefinirMfaHandler()
