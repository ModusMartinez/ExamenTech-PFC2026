import { createClient } from '@supabase/supabase-js'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createMatriculasHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (!['POST', 'PATCH'].includes(request.method)) {
        return jsonResponse(405, { message: 'Utilize POST ou PATCH.' }, { Allow: 'POST, PATCH' })
      }
      const approving = request.method === 'PATCH'
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para acessar as matrículas.' })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
      }

      let params: { p_codigo: string } | { p_matricula_id: string }
      try {
        const body: unknown = await request.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return jsonResponse(400, { message: 'Envie um objeto JSON com os dados da operação.' })
        }
        if (approving) {
          if (Object.keys(body).some((key) => key !== 'matricula_id') ||
              !('matricula_id' in body) || typeof body.matricula_id !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.matricula_id)) {
            return jsonResponse(400, { message: 'Informe somente o ID válido da matrícula.' })
          }
          params = { p_matricula_id: body.matricula_id }
        } else {
          if (Object.keys(body).some((key) => key !== 'codigo') ||
              !('codigo' in body) || typeof body.codigo !== 'string') {
            return jsonResponse(400, { message: 'Informe somente o código da turma.' })
          }
          const codigo = body.codigo.trim().toUpperCase()
          if (!/^[A-F0-9]{12}$/.test(codigo)) {
            return jsonResponse(400, { message: 'Informe o código da turma com 12 caracteres.' })
          }
          params = { p_codigo: codigo }
        }
      } catch {
        return jsonResponse(400, { message: 'JSON inválido.' })
      }

      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
      const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !publicKey) return jsonResponse(503, { message: 'Serviço de matrículas não configurado.' })

      try {
        // Usa a sessão de quem executa a ação, nunca a chave administrativa.
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

        // Identidade, permissões e transições de situação são conferidas também no banco.
        const { data, error } = await supabase.rpc(approving ? 'aprovar_matricula' : 'solicitar_matricula', params)
        if (error) {
          if (approving) {
            if (error.code === '42501') return jsonResponse(403, { message: 'Aprovação exige professor responsável ou administrador ativo, com MFA.' })
            if (error.code === 'P0002') return jsonResponse(404, { message: 'Matrícula não encontrada ou acesso não autorizado.' })
            if (error.code === '55000') return jsonResponse(409, { message: 'A matrícula não está pendente ou não pode ser aprovada.' })
            return jsonResponse(503, { message: 'Não foi possível aprovar a matrícula. Tente novamente.' })
          }
          if (error.code === '42501') return jsonResponse(403, { message: 'Solicitação exige aluno ativo, organização ativa e MFA.' })
          if (error.code === '22023') return jsonResponse(400, { message: 'Código de turma inválido ou indisponível.' })
          if (error.code === '23505') return jsonResponse(409, { message: 'Já existe uma matrícula nesta turma. Consulte o responsável.' })
          return jsonResponse(503, { message: 'Não foi possível registrar a solicitação. Tente novamente.' })
        }
        const matricula: unknown = data
        if (!matricula || typeof matricula !== 'object' ||
            !('id' in matricula) || typeof matricula.id !== 'string' ||
            !('turma_id' in matricula) || typeof matricula.turma_id !== 'string' ||
            !('turma_nome' in matricula) || typeof matricula.turma_nome !== 'string' ||
            !('situacao' in matricula) || matricula.situacao !== (approving ? 'ATIVA' : 'PENDENTE') ||
            !('solicitado_em' in matricula) || typeof matricula.solicitado_em !== 'string') {
          return jsonResponse(503, { message: 'Não foi possível confirmar a operação.' })
        }
        return jsonResponse(approving ? 200 : 201, { matricula })
      } catch {
        return jsonResponse(503, { message: 'Não foi possível conectar ao serviço de matrículas.' })
      }
    },
  }
}

export default createMatriculasHandler()
