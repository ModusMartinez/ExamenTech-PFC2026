import { createClient } from '@supabase/supabase-js'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import { EXECUCAO_HEADER, lerChaveExecucao, lerTentativaIniciada } from '../src/services/tentativaValidation.ts'
import { EXAM_NOTICE_VERSION, PROVA_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { PHOTO_NOTICE_VERSION } from '../scripts/lib/photoStorage.ts'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createIniciarTentativaHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (request.method !== 'POST') return jsonResponse(405, { message: 'Utilize POST.' }, { Allow: 'POST' })
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para iniciar a tentativa.' })
      const chaveExecucao = lerChaveExecucao(request.headers.get(EXECUCAO_HEADER))
      if (!chaveExecucao) return jsonResponse(400, { message: 'Identificação da página da prova inválida.' })
      if (new URL(request.url).searchParams.size) return jsonResponse(400, { message: 'Não envie parâmetros na URL de início.' })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
      }
      let avaliacaoId: string
      let comFotos: boolean
      try {
        const body: unknown = await request.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse(400, { message: 'Dados da tentativa inválidos.' })
        comFotos = 'fotos_aviso_versao' in body
        if (Object.keys(body).length !== (comFotos ? 3 : 2) ||
            !('avaliacao_id' in body) || typeof body.avaliacao_id !== 'string' || !UUID_PATTERN.test(body.avaliacao_id) ||
            !('aviso_versao' in body) || body.aviso_versao !== (comFotos ? PROVA_NOTICE_VERSION : EXAM_NOTICE_VERSION) ||
            ('fotos_aviso_versao' in body && body.fotos_aviso_versao !== PHOTO_NOTICE_VERSION)) {
          return jsonResponse(400, { message: 'Confirme o aviso atual e informe o ID válido da avaliação.' })
        }
        avaliacaoId = body.avaliacao_id.toLowerCase()
      } catch {
        return jsonResponse(400, { message: 'JSON inválido.' })
      }
      if (comFotos && env.EXAM_PHOTOS_ENABLED !== 'true') {
        return jsonResponse(503, { message: 'O serviço de fotografias está indisponível para iniciar a prova.' })
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de avaliações não configurado.' })
      const notConfirmed = 'Não foi possível confirmar o início. A tentativa pode ter sido criada. Confira com o professor antes de tentar novamente.'
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

        // O banco usa o JWT do aluno para vincular a tentativa à sessão inicial.
        const { data, error } = await supabase.rpc(comFotos ? 'iniciar_tentativa_com_fotos' : 'iniciar_tentativa', {
          p_avaliacao_id: avaliacaoId, p_aviso_versao: comFotos ? PROVA_NOTICE_VERSION : EXAM_NOTICE_VERSION, p_chave_execucao: chaveExecucao,
          ...(comFotos ? { p_fotos_aviso_versao: PHOTO_NOTICE_VERSION } : {}),
        }).retry(false)
        if (error) {
          if (error.code === '42501') return jsonResponse(403, { message: 'Início exige aluno ativo, organização ativa, sessão e MFA.' })
          if (error.code === 'P0002') return jsonResponse(404, { message: 'Avaliação não encontrada ou acesso não autorizado.' })
          if (error.code === '55000') return jsonResponse(409, { message: 'A avaliação não está disponível para início ou já possui uma tentativa.' })
          if (error.code === '23514') return jsonResponse(400, { message: 'O aviso da prova precisa ser confirmado novamente.' })
          return jsonResponse(503, { message: notConfirmed })
        }
        const tentativa = lerTentativaIniciada(data)
        if (!tentativa || tentativa.avaliacao_id !== avaliacaoId || tentativa.aluno_id !== identity.user.id.toLowerCase()) {
          return jsonResponse(503, { message: notConfirmed })
        }
        return jsonResponse(201, { tentativa })
      } catch {
        // A transação pode ter concluído antes da perda da resposta. Não repetir o POST.
        return jsonResponse(503, { message: notConfirmed })
      }
    },
  }
}

export default createIniciarTentativaHandler()
