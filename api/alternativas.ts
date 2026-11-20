import { createClient } from '@supabase/supabase-js'
import { conferirAcessoAvaliacoes } from '../server/acessoAvaliacoes.ts'
import { UUID_PATTERN } from '../src/services/avaliacaoValidation.ts'
import { lerAlternativasRascunho, lerDadosAlternativas } from '../src/services/alternativaValidation.ts'
import type { DadosAlternativasRascunho } from '../src/services/alternativaValidation.ts'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createAlternativasHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(405, { message: 'Utilize GET ou POST.' }, { Allow: 'GET, POST' })
      }
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para acessar as alternativas.' })
      const listing = request.method === 'GET'
      const query = new URL(request.url).searchParams
      const questaoId = query.get('questao_id')?.toLowerCase() ?? ''
      if (!listing ? query.size > 0 : query.size !== 1 || !questaoId || !UUID_PATTERN.test(questaoId)) {
        return jsonResponse(400, { message: listing ? 'Informe somente o ID válido da questão.' : 'Não envie parâmetros na URL de criação.' })
      }
      let dados: DadosAlternativasRascunho | null = null
      if (!listing) {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
        }
        try {
          const body: unknown = await request.json()
          dados = lerDadosAlternativas(body)
          if (!dados || !body || Object.keys(body).some((key) => !['questao_id', 'alternativas', 'ordem_correta'].includes(key))) {
            return jsonResponse(400, { message: 'Informe a questão, de 2 a 5 alternativas distintas de até 2.000 caracteres e a posição correta.' })
          }
        } catch {
          return jsonResponse(400, { message: 'JSON inválido.' })
        }
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de alternativas não configurado.' })
      try {
        const supabase = createClient(url, publicKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetchImplementation },
        })
        const acesso = await conferirAcessoAvaliacoes(supabase, token)
        if (acesso.status) return jsonResponse(acesso.status, { message: acesso.message })
        if (!listing && acesso.perfil !== 'PROFESSOR') {
          return jsonResponse(403, { message: 'Somente o professor autor pode cadastrar alternativas.' })
        }
        if (dados) {
          const { data, error } = await supabase.rpc('criar_alternativas_rascunho', {
            p_questao_id: dados.questao_id, p_alternativas: dados.alternativas, p_ordem_correta: dados.ordem_correta,
          })
          const notConfirmed = 'Não foi possível confirmar o cadastro. Consulte as alternativas antes de tentar novamente.'
          if (error) {
            if (error.code === '42501') return jsonResponse(403, { message: 'Cadastro exige professor autor ativo, organização ativa e MFA.' })
            if (error.code === 'P0002') return jsonResponse(404, { message: 'Questão não encontrada ou acesso não autorizado.' })
            if (error.code === '55000') return jsonResponse(409, { message: 'A questão já possui alternativas, a turma está inativa ou a avaliação não está em rascunho.' })
            if (['23502', '23514', '22P02', '22003', '22021'].includes(error.code)) {
              return jsonResponse(400, { message: 'Confira as alternativas e o gabarito. A questão deve ser objetiva.' })
            }
            return jsonResponse(503, { message: notConfirmed })
          }
          const alternativas = lerAlternativasRascunho(data, dados.questao_id)
          if (!alternativas || alternativas.length !== dados.alternativas.length || alternativas.some((item, index) =>
            item.texto !== dados.alternativas[index] || item.correta !== (item.ordem === dados.ordem_correta))) {
            return jsonResponse(503, { message: notConfirmed })
          }
          return jsonResponse(201, { alternativas })
        }

        // A RLS da questão exige acesso ao rascunho, inclusive quando ainda não há alternativas.
        const questao = await supabase.from('questoes').select('id,tipo').eq('id', questaoId).maybeSingle()
        if (questao.error) return jsonResponse(503, { message: 'Não foi possível conferir a questão.' })
        if (!questao.data) return jsonResponse(404, { message: 'Questão não encontrada ou acesso não autorizado.' })
        if (questao.data.id !== questaoId || !['OBJETIVA', 'DISSERTATIVA'].includes(questao.data.tipo)) {
          return jsonResponse(503, { message: 'Resposta inválida na consulta da questão.' })
        }
        if (questao.data.tipo !== 'OBJETIVA') return jsonResponse(400, { message: 'Somente questões objetivas possuem alternativas.' })
        const { data, error } = await supabase.from('alternativas')
          .select('id,questao_id,texto,ordem,correta,criado_em').eq('questao_id', questaoId)
          .order('ordem', { ascending: true }).limit(5)
        const alternativas = lerAlternativasRascunho(data, questaoId)
        if (error || !alternativas) return jsonResponse(503, { message: 'Não foi possível conferir a lista de alternativas.' })
        return jsonResponse(200, { alternativas })
      } catch {
        return jsonResponse(503, { message: 'Não foi possível conectar ao serviço. Consulte as alternativas antes de repetir um cadastro.' })
      }
    },
  }
}

export default createAlternativasHandler()
