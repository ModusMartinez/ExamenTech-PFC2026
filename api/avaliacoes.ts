import { createClient } from '@supabase/supabase-js'
import { lerAvaliacaoRascunho, lerDadosAvaliacao, UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import type { AvaliacaoRascunho, DadosAvaliacaoRascunho } from '../src/services/avaliacaoValidation.ts'

const INPUT_FIELDS = ['turma_id', 'titulo', 'tipo', 'inicio_em', 'fim_em', 'duracao_minutos']
const AVALIACAO_FIELDS = 'id,turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos,situacao,criado_em'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createAvaliacoesHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(405, { message: 'Utilize GET ou POST.' }, { Allow: 'GET, POST' })
      }
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para acessar as avaliações.' })
      const creating = request.method === 'POST'
      const query = new URL(request.url).searchParams
      const turmaId = query.get('turma_id')?.toLowerCase()
      if (creating ? query.size > 0 :
        query.size !== 1 || !turmaId || !UUID_PATTERN.test(turmaId)) {
        return jsonResponse(400, { message: creating ? 'Não envie parâmetros na URL de criação.' : 'Informe somente o ID válido da turma.' })
      }
      let dados: DadosAvaliacaoRascunho | null = null
      if (creating) {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
        }
        try {
          const body: unknown = await request.json()
          dados = lerDadosAvaliacao(body)
          if (!dados || !body || Object.keys(body).some((key) => !INPUT_FIELDS.includes(key))) {
            return jsonResponse(400, { message: 'Dados da avaliação inválidos. Confira turma, título, tipo, datas e duração.' })
          }
        } catch {
          return jsonResponse(400, { message: 'JSON inválido.' })
        }
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de avaliações não configurado.' })
      try {
        // A chave pública e o JWT do usuário mantêm a RLS; não usa service_role.
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
        const { data: profileData, error: profileError } = await supabase.from('perfis')
          .select('perfil,situacao').eq('id', identity.user.id).maybeSingle()
        if (profileError) return jsonResponse(503, { message: 'Não foi possível conferir seu perfil.' })
        const profile: unknown = profileData
        if (!profile || typeof profile !== 'object' || !('situacao' in profile) || profile.situacao !== 'ATIVO' ||
            !('perfil' in profile) || (profile.perfil !== 'PROFESSOR' && profile.perfil !== 'ADMIN') ||
            (creating && profile.perfil !== 'PROFESSOR')) {
          return jsonResponse(403, { message: 'Seu perfil não permite esta operação. Confira também o MFA.' })
        }

        if (dados) {
          const { data, error } = await supabase.rpc('criar_avaliacao_rascunho', {
            p_turma_id: dados.turma_id, p_titulo: dados.titulo, p_tipo: dados.tipo,
            p_inicio_em: dados.inicio_em, p_fim_em: dados.fim_em, p_duracao_minutos: dados.duracao_minutos,
          })
          if (error) {
            if (error.code === '42501') return jsonResponse(403, { message: 'Criação exige professor responsável ativo, organização ativa e MFA.' })
            if (error.code === 'P0002') return jsonResponse(404, { message: 'Turma não encontrada ou acesso não autorizado.' })
            if (error.code === '55000') return jsonResponse(409, { message: 'A turma está inativa.' })
            if (['23502', '23514', '22P02', '22007', '22008', '22003'].includes(error.code)) {
              return jsonResponse(400, { message: 'Confira os campos da avaliação.' })
            }
            return jsonResponse(503, { message: 'Não foi possível confirmar a criação. Consulte a lista antes de tentar novamente.' })
          }
          const avaliacao = lerAvaliacaoRascunho(data)
          if (!avaliacao || avaliacao.professor_id !== identity.user.id || avaliacao.turma_id !== dados.turma_id ||
              avaliacao.titulo !== dados.titulo || avaliacao.tipo !== dados.tipo ||
              avaliacao.inicio_em !== dados.inicio_em || avaliacao.fim_em !== dados.fim_em ||
              avaliacao.duracao_minutos !== dados.duracao_minutos) {
            return jsonResponse(503, { message: 'Não foi possível confirmar a criação. Consulte a lista antes de tentar novamente.' })
          }
          return jsonResponse(201, { avaliacao })
        }

        // Distingue turma vazia de turma inexistente/fora do acesso, sem revelar a alheia.
        const turma = await supabase.from('turmas').select('id').eq('id', turmaId).maybeSingle()
        if (turma.error) return jsonResponse(503, { message: 'Não foi possível conferir a turma.' })
        if (!turma.data) return jsonResponse(404, { message: 'Turma não encontrada ou acesso não autorizado.' })
        if (turma.data.id !== turmaId) return jsonResponse(503, { message: 'Não foi possível conferir a turma.' })
        const { data, error } = await supabase.from('avaliacoes').select(AVALIACAO_FIELDS)
          .eq('turma_id', turmaId).eq('situacao', 'RASCUNHO')
          .order('criado_em', { ascending: false }).order('id', { ascending: false }).limit(50)
        if (error || !Array.isArray(data) || data.length > 50) {
          return jsonResponse(503, { message: 'Não foi possível consultar os rascunhos.' })
        }
        const avaliacoes: AvaliacaoRascunho[] = []
        for (const item of data) {
          const avaliacao = lerAvaliacaoRascunho(item)
          if (!avaliacao || avaliacao.turma_id !== turmaId || avaliacoes.some((other) => other.id === avaliacao.id)) {
            return jsonResponse(503, { message: 'Resposta inválida na consulta de rascunhos.' })
          }
          avaliacoes.push(avaliacao)
        }
        return jsonResponse(200, { avaliacoes, limite: 50 })
      } catch {
        return jsonResponse(503, { message: 'Não foi possível conectar ao serviço. Consulte a lista antes de repetir uma criação.' })
      }
    },
  }
}

export default createAvaliacoesHandler()
