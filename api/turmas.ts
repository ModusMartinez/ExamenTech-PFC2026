import { createClient } from '@supabase/supabase-js'
import { validateTurmaName } from '../src/services/turmaValidation.ts'

const TURMA_FIELDS = 'id,nome,professor_id,codigo_ingresso,situacao,criado_em'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  })
}

export function createTurmasHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(405, { message: 'Utilize GET ou POST.' }, { Allow: 'GET, POST' })
      }

      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para acessar as turmas.' })

      let nome: string | undefined
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.includes('application/json')) {
          return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
        }
        try {
          const body: unknown = await request.json()
          if (!body || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).some((key) => key !== 'nome') || !('nome' in body)) {
            return jsonResponse(400, { message: 'Informe somente o nome da turma.' })
          }
          const validationError = validateTurmaName(body.nome)
          if (validationError || typeof body.nome !== 'string') {
            return jsonResponse(400, { message: validationError })
          }
          nome = body.nome.trim()
        } catch {
          return jsonResponse(400, { message: 'JSON inválido.' })
        }
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) {
        return jsonResponse(503, { message: 'Serviço de turmas não configurado.' })
      }

      try {
        // A sessão do usuário preserva a RLS. Esta rota não usa service_role.
        const supabase = createClient(url, publicKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetchImplementation },
        })
        const { data: identity, error: identityError } = await supabase.auth.getUser(token)
        if (identityError || !identity.user) {
          return jsonResponse(401, { message: 'Sessão inválida. Entre novamente.' })
        }

        const { data: profile, error: profileError } = await supabase.from('perfis')
          .select('perfil,situacao')
          .eq('id', identity.user.id)
          .maybeSingle()
        if (profileError) {
          return jsonResponse(503, { message: 'Não foi possível conferir seu perfil.' })
        }
        if (!profile || profile.situacao !== 'ATIVO' ||
            !['PROFESSOR', 'ADMIN'].includes(profile.perfil) ||
            (request.method === 'POST' && profile.perfil !== 'PROFESSOR')) {
          return jsonResponse(403, { message: 'Seu perfil não permite esta operação. Confira também o MFA.' })
        }

        const result = request.method === 'POST'
          ? await supabase.from('turmas').insert({ nome }).select(TURMA_FIELDS).single()
          : await supabase.from('turmas').select(TURMA_FIELDS)
            .order('criado_em', { ascending: false }).order('id', { ascending: false })

        if (result.error) {
          if (result.error.code === '42501') {
            return jsonResponse(403, { message: 'Acesso não autorizado. Confira seu perfil, organização e MFA.' })
          }
          if (result.error.code === '23514') {
            return jsonResponse(400, { message: 'Confira o nome da turma.' })
          }
          return jsonResponse(503, { message: 'Não foi possível acessar as turmas. Confira se a migração 011 foi aplicada.' })
        }

        return request.method === 'POST'
          ? jsonResponse(201, { turma: result.data })
          : jsonResponse(200, { turmas: result.data })
      } catch {
        return jsonResponse(503, { message: 'Não foi possível conectar ao serviço de turmas.' })
      }
    },
  }
}

export default createTurmasHandler()
