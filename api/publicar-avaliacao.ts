import { createClient } from '@supabase/supabase-js'
import { conferirAcessoAvaliacoes } from '../server/acessoAvaliacoes.ts'
import { lerDataComFuso, UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createPublicarAvaliacaoHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (request.method !== 'POST') return jsonResponse(405, { message: 'Utilize POST.' }, { Allow: 'POST' })
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para publicar a avaliação.' })
      if (new URL(request.url).searchParams.size) return jsonResponse(400, { message: 'Não envie parâmetros na URL de publicação.' })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
      }
      let avaliacaoId: string
      try {
        const body: unknown = await request.json()
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
            !('avaliacao_id' in body) || typeof body.avaliacao_id !== 'string' || !UUID_PATTERN.test(body.avaliacao_id)) {
          return jsonResponse(400, { message: 'Informe somente o ID válido da avaliação.' })
        }
        avaliacaoId = body.avaliacao_id.toLowerCase()
      } catch {
        return jsonResponse(400, { message: 'JSON inválido.' })
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de avaliações não configurado.' })
      const notConfirmed = 'Não foi possível confirmar a publicação. Consulte a situação da avaliação antes de tentar novamente.'
      try {
        const supabase = createClient(url, publicKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetchImplementation },
        })
        const acesso = await conferirAcessoAvaliacoes(supabase, token)
        if (acesso.status) return jsonResponse(acesso.status, { message: acesso.message })
        if (acesso.perfil !== 'PROFESSOR') return jsonResponse(403, { message: 'Somente o professor autor pode publicar avaliações.' })

        const { data, error } = await supabase.rpc('publicar_avaliacao', { p_avaliacao_id: avaliacaoId })
        if (error) {
          if (error.code === '42501') return jsonResponse(403, { message: 'Publicação exige professor autor ativo, organização ativa, sessão e MFA.' })
          if (error.code === 'P0002') return jsonResponse(404, { message: 'Avaliação não encontrada ou acesso não autorizado.' })
          if (error.code === '55000') return jsonResponse(409, { message: 'A turma está inativa ou a avaliação não está em rascunho.' })
          if (error.code === '23514') return jsonResponse(400, { message: 'Confira a janela, a duração e as questões. Cada questão objetiva precisa de 2 a 5 alternativas distintas e uma correta.' })
          return jsonResponse(503, { message: notConfirmed })
        }
        const result: unknown = data
        if (!result || typeof result !== 'object' || Array.isArray(result) ||
            !('id' in result) || result.id !== avaliacaoId || !('situacao' in result) || result.situacao !== 'PUBLICADA') {
          return jsonResponse(503, { message: notConfirmed })
        }
        const publicadaEm = lerDataComFuso('publicada_em' in result ? result.publicada_em : null)
        if (!publicadaEm) return jsonResponse(503, { message: notConfirmed })
        return jsonResponse(200, { avaliacao: { id: avaliacaoId, situacao: 'PUBLICADA', publicada_em: publicadaEm } })
      } catch {
        // A transação pode ter concluído antes da falha de conexão; não repetir o POST.
        return jsonResponse(503, { message: notConfirmed })
      }
    },
  }
}

export default createPublicarAvaliacaoHandler()
