import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'
import { createRedefinirMfaHandler } from '../api/redefinir-mfa.ts'

test('redefinição administrativa de MFA: autorização, Admin API, revogação e auditoria', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const base = await prepararBancoAvaliacoes(db)
  const { admin, aluno, professor, org, sessions, queryAs } = base
  await db.exec(`CREATE TABLE auth.refresh_tokens(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES auth.sessions(id) ON DELETE CASCADE)`)
  await db.exec(`ALTER TABLE public.convites_aluno ADD COLUMN perfil_destino TEXT NOT NULL DEFAULT 'ALUNO'`)
  await db.exec(await readFile(new URL('../database/046_redefinicao_mfa.sql', import.meta.url), 'utf8'))
  await db.exec(`CREATE OR REPLACE FUNCTION examentech_private.emitir_convite_aluno(p_email TEXT,p_organizacao_id UUID)
    RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
      SELECT examentech_private.emitir_convite(p_email,p_organizacao_id,'ALUNO') $$;`)
  const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key', SUPABASE_SECRET_KEY: 'private-server-key' }
  let factors: string[] = [randomUUID(), randomUUID()]
  let targetId: string = aluno
  let failDelete = false, failFinalize = false
  let adminCalls = 0
  const originalFactors = () => [randomUUID(), randomUUID()]
  function request(method = 'GET', body: unknown = { usuario_id: targetId, confirmado: true }, query = method === 'GET' ? '?busca=example' : '') {
    return new Request(`http://localhost/api/redefinir-mfa${query}`, { method,
      headers: { Authorization: 'Bearer user-session', 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined })
  }
  function apiFor(id: string = admin, aal: string = 'aal2') {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init), url = new URL(req.url)
      if (url.pathname === '/auth/v1/user') {
        assert.equal(req.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
        return Response.json({ id, app_metadata: {}, user_metadata: {} })
      }
      try {
        if (url.pathname.startsWith('/auth/v1/admin/')) {
          adminCalls++
          assert.equal(req.headers.get('apikey'), env.SUPABASE_SECRET_KEY)
          assert.equal(req.headers.get('authorization'), `Bearer ${env.SUPABASE_SECRET_KEY}`)
          assert.ok(url.pathname.startsWith(`/auth/v1/admin/users/${targetId}/factors`))
          if (req.method === 'GET') return Response.json(factors.map((factor) => ({ id: factor, factor_type: 'totp', status: 'verified' })))
          const factor = url.pathname.split('/').at(-1)!
          if (failDelete && factors.length === 1) return Response.json({ message: 'Detalhe privado do Auth' }, { status: 500 })
          factors = factors.filter((item) => item !== factor)
          return Response.json({ id: factor })
        }
        const params = req.method === 'POST' ? await req.json() : {}
        if (url.pathname.endsWith('/listar_usuarios_redefinicao_mfa')) {
          assert.equal(req.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
          return Response.json((await queryAs<{ result: unknown }>(id,
            'SELECT public.listar_usuarios_redefinicao_mfa($1) AS result', [params.p_busca], aal)).rows[0].result)
        }
        if (url.pathname.endsWith('/autorizar_redefinicao_mfa')) {
          assert.equal(req.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
          return Response.json((await queryAs<{ result: unknown }>(id,
            'SELECT public.autorizar_redefinicao_mfa($1) AS result', [params.p_usuario_id], aal)).rows[0].result)
        }
        if (url.pathname.endsWith('/concluir_redefinicao_mfa')) {
          assert.equal(req.headers.get('apikey'), env.SUPABASE_SECRET_KEY)
          if (failFinalize) return Response.json({ code: 'XX000', message: 'Detalhe interno' }, { status: 500 })
          const result = await db.transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE service_role')
            return tx.query<{ result: unknown }>('SELECT public.concluir_redefinicao_mfa($1,$2) AS result', [params.p_redefinicao_id, params.p_sucesso])
          })
          return Response.json(result.rows[0].result)
        }
        assert.fail(`Rota inesperada: ${url.pathname}`)
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'Detalhe interno' }, { status: 400 })
      }
    })
    return { transport, handler: createRedefinirMfaHandler(env, transport) }
  }
  async function restoreSession() {
    const session = randomUUID(); sessions.set(aluno, session)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [session, aluno])
    await db.query('INSERT INTO auth.refresh_tokens(session_id) VALUES($1)', [session])
  }

  await t.test('entrada inválida não alcança Auth nem aceita dados de auditoria enviados pelo navegador', async () => {
    const { handler, transport } = apiFor()
    for (const payload of [null, [], {}, { usuario_id: aluno, confirmado: false }, { usuario_id: 'x', confirmado: true },
      { usuario_id: aluno, confirmado: true, administrador_id: admin }]) {
      assert.equal((await handler.fetch(request('POST', payload))).status, 400)
    }
    for (const query of ['', '?busca=ab', '?busca=abc&busca=def', '?busca=abc&usuario_id=outro']) {
      assert.equal((await handler.fetch(request('GET', undefined, query))).status, 400)
    }
    const noToken = request(); noToken.headers.delete('Authorization')
    assert.equal((await handler.fetch(noToken)).status, 401)
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('professor/aluno, AAL1, sessão ausente, outra organização e ADMIN sem vínculo são negados antes de usar segredo', async () => {
    for (const [id, aal] of [[aluno, 'aal2'], [professor, 'aal2'], [admin, 'aal1']]) {
      assert.equal((await apiFor(id, aal).handler.fetch(request())).status, 403)
      assert.equal((await apiFor(id, aal).handler.fetch(request('POST'))).status, 403)
    }
    const savedSession = sessions.get(admin)!
    sessions.set(admin, randomUUID())
    assert.equal((await apiFor().handler.fetch(request('POST'))).status, 403)
    sessions.set(admin, savedSession)
    await db.query('UPDATE public.perfis SET organizacao_id=NULL WHERE id=$1', [admin])
    assert.equal((await apiFor().handler.fetch(request('POST'))).status, 403)
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, admin])
    const outraOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES($1,'Outra instituição','OUTRA1234567890123456')", [outraOrg])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [outraOrg, aluno])
    assert.equal((await apiFor().handler.fetch(request('POST'))).status, 403)
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, aluno])
    assert.equal(adminCalls, 0)
    assert.equal((await apiFor().handler.fetch(request('POST', { usuario_id: admin, confirmado: true }))).status, 403)
  })

  await t.test('listagem mínima, reset remove fatores, preserva perfil/senha e revoga sessões e refresh tokens', async () => {
    await db.query('INSERT INTO auth.refresh_tokens(session_id) VALUES($1)', [sessions.get(aluno)])
    const listed = await apiFor().handler.fetch(request())
    assert.equal(listed.status, 200)
    const users = (await listed.json()).usuarios as Record<string, unknown>[]
    assert.equal(users.some((u) => u.id === admin), false)
    assert.ok(users.some((u) => u.id === aluno))
    assert.deepEqual(Object.keys(users[0]).sort(), ['email', 'id', 'nome', 'perfil'])
    const profile = (await db.query('SELECT * FROM public.perfis WHERE id=$1', [aluno])).rows
    const response = await apiFor().handler.fetch(request('POST'))
    assert.equal(response.status, 200); assert.equal((await response.json()).redefinido, true)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(factors, [])
    assert.equal((await db.query('SELECT id FROM auth.sessions WHERE user_id=$1', [aluno])).rows.length, 0)
    assert.equal((await db.query('SELECT id FROM auth.refresh_tokens')).rows.length, 0)
    assert.deepEqual((await db.query('SELECT * FROM public.perfis WHERE id=$1', [aluno])).rows, profile)
    await assert.rejects(queryAs(aluno, "SELECT public.listar_usuarios_redefinicao_mfa('example')"), /Administrador/)
    const logs = (await db.query<{ evento: string; sucesso: boolean; usuario_id: string; recurso_id: string }>("SELECT evento,sucesso,usuario_id,recurso_id FROM public.eventos_seguranca WHERE evento LIKE 'MFA_%' ORDER BY criado_em,id")).rows
    assert.ok(logs.some((row) => row.evento === 'MFA_REDEFINIDO' && row.sucesso === true && row.usuario_id === admin && row.recurso_id === aluno))
    assert.equal(JSON.stringify(logs).includes(env.SUPABASE_SECRET_KEY), false)
    await assert.rejects(queryAs(admin, 'SELECT public.concluir_redefinicao_mfa($1,true)', [randomUUID()]), /permission denied/)
  })

  await t.test('falha parcial não retorna sucesso, é auditada e encerra sessões antigas', async () => {
    await restoreSession(); factors = originalFactors(); failDelete = true
    const response = await apiFor().handler.fetch(request('POST'))
    assert.equal(response.status, 503)
    assert.equal(factors.length, 1)
    assert.ok((await response.json()).message.includes('não foi concluída'))
    assert.equal((await db.query('SELECT id FROM auth.sessions WHERE user_id=$1', [aluno])).rows.length, 0)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='MFA_REDEFINICAO_FALHOU' AND sucesso=FALSE")).rows.length, 1)
    failDelete = false
  })

  await t.test('JWT antigo do professor não pode emitir convites depois da redefinição', async () => {
    await db.query('UPDATE public.organizacoes SET codigo_rotacionado_em=now() WHERE id=$1', [org])
    assert.ok((await queryAs<{ convite: { codigo: string } }>(professor,
      "SELECT public.emitir_convite_aluno('antes@example.test',$1) AS convite", [org])).rows[0].convite.codigo)
    targetId = professor; factors = originalFactors()
    assert.equal((await apiFor().handler.fetch(request('POST'))).status, 200)
    await assert.rejects(queryAs(professor, "SELECT public.emitir_convite_aluno('depois@example.test',$1)", [org]), /Acesso não autorizado/)
    targetId = aluno
  })

  await t.test('falha na confirmação da auditoria é reportada como resultado incerto; repetição pendente não deleta novamente', async () => {
    factors = originalFactors(); failFinalize = true
    const response = await apiFor().handler.fetch(request('POST'))
    assert.equal(response.status, 503)
    assert.ok((await response.json()).message.includes('pode ter sido alterado'))
    const before = adminCalls
    assert.equal((await apiFor().handler.fetch(request('POST'))).status, 409)
    assert.equal(adminCalls, before)
  })
})
