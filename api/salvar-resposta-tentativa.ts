import { createClient } from '@supabase/supabase-js'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import { lerDadosRespostaTentativa, lerRespostaTentativa } from '../src/services/respostaValidation.ts'
import type { DadosRespostaTentativa } from '../src/services/respostaValidation.ts'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createSalvarRespostaTentativaHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (request.method !== 'POST') return jsonResponse(405, { message: 'Utilize POST.' }, { Allow: 'POST' })
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para salvar a resposta.' })
      if (new URL(request.url).searchParams.size) return jsonResponse(400, { message: 'Não envie parâmetros na URL de salvamento.' })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
      }
      let dados: DadosRespostaTentativa | null
      try {
        const body: unknown = await request.json()
        dados = lerDadosRespostaTentativa(body)
        if (!dados || !body || Object.keys(body).some(key => !['tentativa_id', 'questao_id', 'versao', 'alternativa_id', 'texto'].includes(key))) {
          return jsonResponse(400, { message: 'Confira a tentativa, a questão, a versão e o conteúdo da resposta.' })
        }
      } catch {
        return jsonResponse(400, { message: 'JSON inválido.' })
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de avaliações não configurado.' })
      const notConfirmed = 'Não foi possível confirmar o salvamento. A resposta pode ter sido salva. Reenvie o mesmo conteúdo e a mesma versão.'
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

        // A 034 confere dono, MFA, vínculo, prazo, tipo da questão e sequência da versão.
        const { data, error } = await supabase.rpc('salvar_resposta_tentativa', {
          p_tentativa_id: dados.tentativa_id, p_questao_id: dados.questao_id, p_versao: dados.versao,
          p_alternativa_id: dados.alternativa_id, p_texto: dados.texto,
        }).retry(false)
        if (error) {
          if (error.code === '42501') return jsonResponse(403, { message: 'Salvamento exige aluno ativo, organização ativa, sessão e MFA.' })
          if (error.code === 'P0002') return jsonResponse(404, { message: 'Tentativa ou questão não encontrada, ou acesso não autorizado.' })
          if (error.code === '55000') return jsonResponse(409, { message: 'A tentativa está indisponível ou a versão da resposta está fora de sequência.' })
          if (['23502', '23514', '22P02', '22003', '22021', '22P05'].includes(error.code)) {
            return jsonResponse(400, { message: 'Confira o tipo, a alternativa e o tamanho da resposta.' })
          }
          return jsonResponse(503, { message: notConfirmed })
        }
        const resposta = lerRespostaTentativa(data)
        if (!resposta || resposta.tentativa_id !== dados.tentativa_id || resposta.questao_id !== dados.questao_id ||
            resposta.versao !== dados.versao || resposta.alternativa_id !== dados.alternativa_id ||
            resposta.texto !== (dados.texto === '' ? null : dados.texto)) {
          return jsonResponse(503, { message: notConfirmed })
        }
        return jsonResponse(200, { resposta })
      } catch {
        // A gravação pode ter concluído antes da perda da confirmação; não repetir a RPC automaticamente.
        return jsonResponse(503, { message: notConfirmed })
      }
    },
  }
}

export default createSalvarRespostaTentativaHandler()
