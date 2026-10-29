import { createClient } from '@supabase/supabase-js'
import { conferirAcessoAvaliacoes } from '../server/acessoAvaliacoes.ts'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import { lerDadosQuestao, lerQuestaoRascunho } from '../src/services/questaoValidation.ts'
import type { DadosQuestaoRascunho, QuestaoRascunho } from '../src/services/questaoValidation.ts'

const QUESTAO_FIELDS = 'id,avaliacao_id,tipo,enunciado,pontuacao,ordem,criado_em'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createQuestoesHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(405, { message: 'Utilize GET ou POST.' }, { Allow: 'GET, POST' })
      }
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para acessar as questões.' })
      const listing = request.method === 'GET'
      const query = new URL(request.url).searchParams
      const avaliacaoId = query.get('avaliacao_id')?.toLowerCase()
      if (!listing ? query.size > 0 : query.size !== 1 || !avaliacaoId || !UUID_PATTERN.test(avaliacaoId)) {
        return jsonResponse(400, { message: listing ? 'Informe somente o ID válido da avaliação.' : 'Não envie parâmetros na URL de criação.' })
      }
      let dados: DadosQuestaoRascunho | null = null
      if (!listing) {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
        }
        try {
          const body: unknown = await request.json()
          dados = lerDadosQuestao(body)
          if (!dados || !body || Object.keys(body).some((key) => !['avaliacao_id', 'tipo', 'enunciado', 'pontuacao'].includes(key))) {
            return jsonResponse(400, { message: 'Confira a avaliação, o tipo, o enunciado e a pontuação da questão.' })
          }
        } catch {
          return jsonResponse(400, { message: 'JSON inválido.' })
        }
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de questões não configurado.' })
      try {
        const supabase = createClient(url, publicKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetchImplementation },
        })
        const acesso = await conferirAcessoAvaliacoes(supabase, token)
        if (acesso.status) return jsonResponse(acesso.status, { message: acesso.message })
        if (!listing && acesso.perfil !== 'PROFESSOR') {
          return jsonResponse(403, { message: 'Somente o professor autor pode criar questões.' })
        }
        if (dados) {
          const { data, error } = await supabase.rpc('criar_questao_rascunho', {
            p_avaliacao_id: dados.avaliacao_id, p_tipo: dados.tipo,
            p_enunciado: dados.enunciado, p_pontuacao: dados.pontuacao,
          })
          const notConfirmed = 'Não foi possível confirmar a criação. Consulte as questões antes de tentar novamente.'
          if (error) {
            if (error.code === '42501') return jsonResponse(403, { message: 'Criação exige professor autor ativo, organização ativa e MFA.' })
            if (error.code === 'P0002') return jsonResponse(404, { message: 'Avaliação não encontrada ou acesso não autorizado.' })
            if (error.code === '55000') return jsonResponse(409, { message: 'A turma está inativa ou a avaliação não está em rascunho.' })
            if (['23502', '23514', '22P02', '22003', '22021'].includes(error.code)) {
              return jsonResponse(400, { message: 'Confira os campos da questão.' })
            }
            return jsonResponse(503, { message: notConfirmed })
          }
          const questao = lerQuestaoRascunho(data)
          if (!questao || questao.avaliacao_id !== dados.avaliacao_id || questao.tipo !== dados.tipo ||
              questao.enunciado !== dados.enunciado || questao.pontuacao !== dados.pontuacao) {
            return jsonResponse(503, { message: notConfirmed })
          }
          return jsonResponse(201, { questao })
        }

        // A RLS diferencia avaliação vazia de avaliação fora do acesso, sem revelar a alheia.
        const avaliacao = await supabase.from('avaliacoes').select('id,situacao')
          .eq('id', avaliacaoId).eq('situacao', 'RASCUNHO').maybeSingle()
        if (avaliacao.error) return jsonResponse(503, { message: 'Não foi possível conferir a avaliação.' })
        if (!avaliacao.data) return jsonResponse(404, { message: 'Avaliação não encontrada ou acesso não autorizado.' })
        if (avaliacao.data.id !== avaliacaoId || avaliacao.data.situacao !== 'RASCUNHO') {
          return jsonResponse(503, { message: 'Resposta inválida na consulta da avaliação.' })
        }
        const { data, error } = await supabase.from('questoes').select(QUESTAO_FIELDS)
          .eq('avaliacao_id', avaliacaoId).order('ordem', { ascending: true }).limit(50)
        if (error || !Array.isArray(data) || data.length > 50) {
          return jsonResponse(503, { message: 'Não foi possível consultar as questões.' })
        }
        const questoes: QuestaoRascunho[] = []
        for (const item of data) {
          const questao = lerQuestaoRascunho(item)
          if (!questao || questao.avaliacao_id !== avaliacaoId ||
              questoes.some((other) => other.id === questao.id) || questao.ordem <= (questoes.at(-1)?.ordem ?? 0)) {
            return jsonResponse(503, { message: 'Resposta inválida na consulta das questões.' })
          }
          questoes.push(questao)
        }
        return jsonResponse(200, { questoes, limite: 50 })
      } catch {
        return jsonResponse(503, { message: 'Não foi possível conectar ao serviço. Consulte as questões antes de repetir uma criação.' })
      }
    },
  }
}

export default createQuestoesHandler()
