import { createClient } from '@supabase/supabase-js'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import { EXECUCAO_HEADER, lerChaveExecucao, motivoSaidaValido } from '../src/services/tentativaValidation.ts'

function json(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createEncerrarTentativaHandler(
  env: Record<string, string | undefined> = process.env,
  transport: typeof fetch = fetch,
) {
  return { async fetch(request: Request) {
    if (request.method !== 'POST') return json(405, { message: 'Utilize POST.' }, { Allow: 'POST' })
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) return json(401, { message: 'Sua sessão terminou.' })
    const chaveExecucao = lerChaveExecucao(request.headers.get(EXECUCAO_HEADER))
    const query = new URL(request.url).searchParams
    const tentativaId = query.get('tentativa_id')
    const motivo = query.get('motivo') ?? 'SAIDA'
    if (!chaveExecucao || query.size !== (query.has('motivo') ? 2 : 1) || !tentativaId ||
        !UUID_PATTERN.test(tentativaId) || !motivoSaidaValido(motivo)) {
      return json(400, { message: 'Identificação da tentativa ou da página inválida.' })
    }

    const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
    const key = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
    const failure = 'Não foi possível confirmar o encerramento da tentativa.'
    if (!url || !key) return json(503, { message: failure })
    try {
      const supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${token}` }, fetch: transport },
      })
      // O Supabase verifica o JWT. A RPC exige a sessão e a página iniciais.
      const { data, error, status } = await supabase.rpc('encerrar_tentativa', {
        p_tentativa_id: tentativaId, p_motivo: motivo, p_chave_execucao: chaveExecucao,
      }).retry(false)
      if (!error) return json(200, { encerramento: data })
      if (status === 401) return json(401, { message: 'Sua sessão terminou.' })
      if (error.code === '42501') return json(403, { message: 'A tentativa pertence à sessão e à página em que começou.' })
      if (error.code === '23514') return json(400, { message: 'O motivo do encerramento é inválido para esta avaliação.' })
      if (error.code === '55000') return json(409, { message: 'A tentativa já foi encerrada.' })
      return json(503, { message: failure })
    } catch {
      return json(503, { message: failure })
    }
  } }
}

export default createEncerrarTentativaHandler()
