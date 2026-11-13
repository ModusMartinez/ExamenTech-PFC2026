import { createClient } from '@supabase/supabase-js'
import { lerMinhasAvaliacoes } from '../src/services/avaliacaoValidation.ts'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createMinhasAvaliacoesHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (request.method !== 'GET') return jsonResponse(405, { message: 'Utilize GET.' }, { Allow: 'GET' })
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para consultar suas avaliações.' })
      if (new URL(request.url).searchParams.size > 0) return jsonResponse(400, { message: 'Consulta inválida.' })

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de avaliações não configurado.' })

      try {
        const supabase = createClient(url, publicKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetchImplementation },
        })
        const { data: identity, error: identityError } = await supabase.auth.getUser(token)
        if (identityError) {
          const invalidSession = [400, 401, 403].includes(identityError.status ?? 0)
          return jsonResponse(invalidSession ? 401 : 503, {
            message: invalidSession ? 'Sessão inválida. Entre novamente.' : 'Não foi possível conferir sua sessão.',
          })
        }
        if (!identity.user) return jsonResponse(401, { message: 'Sessão inválida. Entre novamente.' })

        // O banco identifica o aluno pela sessão e confere o vínculo ativo com cada turma.
        const { data, error } = await supabase.rpc('listar_minhas_avaliacoes')
        if (error?.code === '42501') {
          return jsonResponse(403, { message: 'Consulta exige aluno ativo, organização ativa, sessão e MFA.' })
        }
        const avaliacoes = error ? null : lerMinhasAvaliacoes(data)
        if (!avaliacoes) return jsonResponse(503, { message: 'Não foi possível carregar suas avaliações.' })
        return jsonResponse(200, { avaliacoes })
      } catch {
        return jsonResponse(503, { message: 'Não foi possível conectar ao serviço de avaliações.' })
      }
    },
  }
}

export default createMinhasAvaliacoesHandler()
