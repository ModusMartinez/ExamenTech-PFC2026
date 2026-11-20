import { createClient } from '@supabase/supabase-js'
import { lerAlunosTurma, lerMatriculasPendentes, lerMinhasMatriculas } from '../src/services/matriculaValidation.ts'

function jsonResponse(status: number, body: object, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export function createMatriculasHandler(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    async fetch(request: Request) {
      if (!['GET', 'POST', 'PATCH'].includes(request.method)) {
        return jsonResponse(405, { message: 'Utilize GET, POST ou PATCH.' }, { Allow: 'GET, POST, PATCH' })
      }
      const listing = request.method === 'GET'
      const updating = request.method === 'PATCH'
      let inactivating = false
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) return jsonResponse(401, { message: 'Entre novamente para acessar as matrículas.' })
      const query = new URL(request.url).searchParams
      const ownEnrollments = query.get('consulta') === 'minhas'
      const turmaId = query.get('turma_id')
      const pagina = query.get('pagina') ?? '0'
      if (listing) {
        const validQuery = query.has('turma_id')
          ? [...query.keys()].every((key) => key === 'turma_id' || key === 'pagina') &&
            query.getAll('turma_id').length === 1 && query.getAll('pagina').length <= 1 &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turmaId ?? '') &&
            /^(0|[1-9][0-9]{0,6})$/.test(pagina) && Number(pagina) <= 1000000
          : [...query.keys()].every((key) => key === 'consulta') &&
            query.getAll('consulta').length <= 1 && (!query.has('consulta') || ownEnrollments)
        if (!validQuery) return jsonResponse(400, { message: 'Consulta inválida.' })
      }
      if (!listing && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return jsonResponse(415, { message: 'Envie os dados no formato JSON.' })
      }

      let params: { p_codigo: string } | { p_matricula_id: string } | undefined
      if (!listing) {
        try {
          const body: unknown = await request.json()
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return jsonResponse(400, { message: 'Envie um objeto JSON com os dados da operação.' })
          }
          if (updating) {
            if (Object.keys(body).some((key) => key !== 'matricula_id' && key !== 'acao') ||
                ('acao' in body && body.acao !== 'aprovar' && body.acao !== 'inativar') ||
                !('matricula_id' in body) || typeof body.matricula_id !== 'string' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.matricula_id)) {
              return jsonResponse(400, { message: 'Informe o ID válido da matrícula e uma ação válida.' })
            }
            inactivating = 'acao' in body && body.acao === 'inativar'
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

        if (listing) {
          if (turmaId) {
            const { data, error } = await supabase.rpc('listar_alunos_turma', {
              p_turma_id: turmaId, p_pagina: Number(pagina),
            })
            if (error?.code === '42501') return jsonResponse(403, { message: 'Consulta exige professor ou administrador ativo, com MFA.' })
            if (error?.code === 'P0002') return jsonResponse(404, { message: 'Turma não encontrada ou acesso não autorizado.' })
            const alunos = error ? null : lerAlunosTurma(data)
            if (!alunos) return jsonResponse(503, { message: 'Não foi possível carregar os alunos.' })
            return jsonResponse(200, { alunos })
          }
          const { data, error } = await supabase.rpc(ownEnrollments ? 'listar_minhas_matriculas' : 'listar_matriculas_pendentes')
          if (error?.code === '42501') {
            return jsonResponse(403, { message: ownEnrollments
              ? 'Consulta exige aluno ativo, organização ativa e MFA.'
              : 'Consulta exige professor ou administrador ativo, com MFA.' })
          }
          const matriculas = error ? null : ownEnrollments ? lerMinhasMatriculas(data) : lerMatriculasPendentes(data)
          if (!matriculas) return jsonResponse(503, { message: ownEnrollments
            ? 'Não foi possível carregar suas matrículas. Tente novamente.'
            : 'Não foi possível carregar as matrículas pendentes. Tente novamente.' })
          return jsonResponse(200, { matriculas })
        }

        // Identidade, permissões e transições de situação são conferidas também no banco.
        const operation = inactivating ? 'inativar_matricula' : updating ? 'aprovar_matricula' : 'solicitar_matricula'
        const expectedStatus = inactivating ? 'INATIVA' : updating ? 'ATIVA' : 'PENDENTE'
        const { data, error } = await supabase.rpc(operation, params)
        if (error) {
          if (inactivating) {
            if (error.code === '42501') return jsonResponse(403, { message: 'Inativação exige professor responsável ou administrador ativo, com MFA.' })
            if (error.code === 'P0002') return jsonResponse(404, { message: 'Matrícula não encontrada ou acesso não autorizado.' })
            if (error.code === '55000') return jsonResponse(409, { message: 'A matrícula não está ativa.' })
            return jsonResponse(503, { message: 'Não foi possível inativar a matrícula. Atualize a lista antes de tentar novamente.' })
          }
          if (updating) {
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
            !('situacao' in matricula) || matricula.situacao !== expectedStatus ||
            !('solicitado_em' in matricula) || typeof matricula.solicitado_em !== 'string') {
          return jsonResponse(503, { message: 'Não foi possível confirmar a operação.' })
        }
        return jsonResponse(updating ? 200 : 201, { matricula })
      } catch {
        return jsonResponse(503, { message: 'Não foi possível conectar ao serviço de matrículas.' })
      }
    },
  }
}

export default createMatriculasHandler()
