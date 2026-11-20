import { createClient } from '@supabase/supabase-js'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import { EXECUCAO_HEADER, lerChaveExecucao, lerConteudoTentativa } from '../src/services/tentativaValidation.ts'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createConteudoTentativaHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (request.method !== 'GET') return jsonResponse(405, { message: 'Utilize GET.' }, { Allow: 'GET' })
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para consultar a tentativa.' })
      const chaveExecucao = lerChaveExecucao(request.headers.get(EXECUCAO_HEADER))
      if (!chaveExecucao) return jsonResponse(400, { message: 'Identificação da página da prova inválida.' })
      const query = new URL(request.url).searchParams
      const tentativaId = query.get('tentativa_id')?.toLowerCase()
      if (query.size !== 1 || !tentativaId || !UUID_PATTERN.test(tentativaId)) {
        return jsonResponse(400, { message: 'Informe somente o ID válido da tentativa.' })
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de avaliações não configurado.' })
      const failure = 'Não foi possível carregar o conteúdo da tentativa.'
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
        if (typeof identity.user.id !== 'string' || !UUID_PATTERN.test(identity.user.id)) {
          return jsonResponse(503, { message: 'Não foi possível conferir sua sessão.' })
        }

        const { data, error } = await supabase.rpc('consultar_conteudo_tentativa', {
          p_tentativa_id: tentativaId, p_chave_execucao: chaveExecucao,
        }).retry(false)
        if (error) {
          if (error.code === '42501') return jsonResponse(403, { message: 'A tentativa só pode ser acessada na sessão e na página em que começou.' })
          if (error.code === 'P0002') return jsonResponse(404, { message: 'Tentativa não encontrada ou acesso não autorizado.' })
          if (error.code === '55000') return jsonResponse(409, { message: 'A tentativa não está disponível para realização.' })
          return jsonResponse(503, { message: failure })
        }
        const conteudo = lerConteudoTentativa(data)
        if (!conteudo || conteudo.tentativa_id !== tentativaId) return jsonResponse(503, { message: failure })
        return jsonResponse(200, { conteudo })
      } catch {
        return jsonResponse(503, { message: failure })
      }
    },
  }
}

export default createConteudoTentativaHandler()
