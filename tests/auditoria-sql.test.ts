import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Esta suíte cobre o estágio 001–008. A versão atual com 009 tem testes próprios.
const TERMS_VERSION = '2026-09-27'
const PRIVACY_VERSION = '2026-09-27'

const adminId = '00000000-0000-4000-8000-000000000001'
const studentId = '00000000-0000-4000-8000-000000000002'
const legalData = {
  termos_aceitos: true,
  termos_versao: TERMS_VERSION,
  privacidade_versao: PRIVACY_VERSION,
}

test('auditoria em PostgreSQL local, sem conexão com Supabase', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())

  // Estrutura mínima do Auth para testar nossas migrations em um banco vazio.
  // Não simula o serviço HTTP do Supabase nem a entrega de e-mail/MFA real.
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, supabase_auth_admin;
    CREATE TABLE auth.users (
      id UUID PRIMARY KEY, email TEXT,
      raw_user_meta_data JSONB DEFAULT '{}'
    );
    CREATE TABLE auth.sessions (
      id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
    );
    GRANT INSERT, SELECT ON auth.users TO supabase_auth_admin;
    CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}')
    $$;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT NULLIF(auth.jwt() ->> 'sub', '')::UUID
    $$;
    CREATE TABLE public.organizacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nome TEXT NOT NULL,
      token_login TEXT NOT NULL UNIQUE CHECK (token_login ~ '^[A-Za-z0-9_-]{21}$'),
      situacao TEXT NOT NULL DEFAULT 'ATIVO'
    );
  `)

  async function applyMigration(name: string) {
    await db.exec(await readFile(new URL(`../database/${name}`, import.meta.url), 'utf8'))
  }

  for (const migration of [
    '001_perfis.sql', '002_eventos_seguranca.sql',
    '003_cadastro_publico_aluno.sql', '004_convites_organizacoes.sql',
  ]) await applyMigration(migration)

  // Contas já existentes antes de ativar a exigência de convite.
  for (const [id, perfil] of [[adminId, 'ADMIN'], [studentId, 'ALUNO']]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${perfil}@exemplo.com`])
    await db.query("UPDATE public.perfis SET perfil = $2, situacao = 'ATIVO' WHERE id = $1", [id, perfil])
  }
  await db.exec(`
    INSERT INTO public.eventos_seguranca (solicitacao_id, evento, sucesso)
    VALUES (gen_random_uuid(), 'TURNSTILE_VALIDADO', TRUE);
  `)
  await applyMigration('005_ativar_convite_cadastro.sql')
  await applyMigration('006_auditoria_cadastro_login.sql')
  // Reaplicar 006 deve preservar dados e não duplicar gatilhos.
  await applyMigration('006_auditoria_cadastro_login.sql')
  await applyMigration('007_cadastro_sem_aprovacao.sql')
  await applyMigration('007_cadastro_sem_aprovacao.sql')
  await applyMigration('008_aceite_termos.sql')
  await applyMigration('008_aceite_termos.sql')

  async function scenario(name: string, run: () => Promise<void>) {
    await t.test(name, async () => {
      await db.exec('BEGIN')
      try { await run() } finally { await db.exec('ROLLBACK') }
    })
  }

  async function setClaims(userId: string, sessionId: string | null, aal = 'aal2') {
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, session_id: sessionId, aal, role: 'authenticated' }),
    ])
    await db.exec('SET LOCAL ROLE authenticated')
  }

  async function startSession(userId = studentId, aal = 'aal2') {
    const sessionId = randomUUID()
    await db.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [sessionId, userId])
    await setClaims(userId, sessionId, aal)
    return sessionId
  }

  async function access() {
    return (await db.query<{ perfil: { perfil: string; situacao: string } | null }>(
      'SELECT public.registrar_acesso() AS perfil',
    )).rows[0].perfil
  }

  async function events() {
    await db.exec('RESET ROLE')
    return (await db.query<{
      evento: string; usuario_id: string | null; sessao_id: string | null;
      sucesso: boolean; provedor: string; codigos_erro: string[]
    }>("SELECT * FROM public.eventos_seguranca WHERE provedor = 'SUPABASE_AUTH'")).rows
  }

  async function prepareSignup() {
    const userId = randomUUID()
    const email = 'novo@exemplo.com'
    const code = 'AbCdEfGhIjKlMnOpQrS_1'
    const ticket = 'b'.repeat(64)
    const orgId = randomUUID()
    const inviteId = randomUUID()
    await db.query(`
      INSERT INTO public.organizacoes (id, nome, token_login, codigo_rotacionado_em)
      VALUES ($1, 'Escola de teste', $2, NOW())
    `, [orgId, code])
    await db.query(`
      INSERT INTO public.convites_aluno (id, organizacao_id, email, codigo_hash, expira_em)
      VALUES ($1, $2, $3, repeat('a', 64), NOW() + INTERVAL '7 days')
    `, [inviteId, orgId, email])
    await db.query(`
      INSERT INTO public.tickets_cadastro_aluno (
        convite_id, codigo_hash, organizacao_codigo_hash, expira_em
      ) VALUES (
        $1, encode(sha256(convert_to($2, 'UTF8')), 'hex'),
        encode(sha256(convert_to($3, 'UTF8')), 'hex'), NOW() + INTERVAL '5 minutes'
      )
    `, [inviteId, ticket, code])
    return { userId, email, ticket, orgId }
  }

  async function signupWithTerms() {
    const signup = await prepareSignup()
    await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
      signup.userId, signup.email, JSON.stringify({ ...legalData, ticket_cadastro: signup.ticket }),
    ])
    return signup
  }

  await scenario('preserva registros antigos e permissões após reaplicar 006', async () => {
    assert.equal((await db.query('SELECT * FROM public.eventos_seguranca')).rows.length, 1)
    assert.equal((await events()).length, 0)
    assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 0)
    const result = await db.query<{ permitido: boolean }>(`
      SELECT has_function_privilege('anon', 'public.preparar_cadastro_aluno(text,text,text)', 'EXECUTE')
        AND has_schema_privilege('anon', 'examentech_private', 'USAGE') AS permitido
    `)
    assert.equal(result.rows[0].permitido, true)
  })

  await scenario('cadastro com convite cria ALUNO/ATIVO e acessa após MFA sem aprovação', async () => {
    const { userId, email, ticket, orgId } = await prepareSignup()
    await db.exec('SET LOCAL ROLE supabase_auth_admin')
    await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
      userId, email, JSON.stringify({
        ...legalData, usuario_id: adminId, aceito_em: '2000-01-01T00:00:00Z',
        nome: 'Aluno', perfil: 'ADMIN', situacao: 'PENDENTE', rgm: '123456', ticket_cadastro: ticket,
      }),
    ])
    await db.exec('RESET ROLE; SET CONSTRAINTS ALL IMMEDIATE')
    const profile = (await db.query('SELECT perfil, situacao, organizacao_id FROM public.perfis WHERE id = $1', [userId])).rows[0]
    assert.deepEqual(profile, { perfil: 'ALUNO', situacao: 'ATIVO', organizacao_id: orgId })
    assert.equal((await db.query<{ rgm: string | null }>(
      'SELECT rgm FROM public.perfis WHERE id = $1', [userId],
    )).rows[0].rgm, null)
    const rows = await events()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].evento, 'CADASTRO_REALIZADO')
    assert.equal(rows[0].usuario_id, userId)
    assert.equal(rows[0].sessao_id, null)
    assert.equal(rows[0].sucesso, true)
    assert.equal(JSON.stringify(rows).includes(ticket), false)
    assert.equal(JSON.stringify(rows).includes(email), false)
    const metadata = (await db.query<{ raw_user_meta_data: object }>('SELECT raw_user_meta_data FROM auth.users WHERE id = $1', [userId])).rows[0]
    assert.equal('ticket_cadastro' in metadata.raw_user_meta_data, false)
    const acceptance = await db.query(`
      SELECT usuario_id, termos_versao, privacidade_versao, aceito_em = NOW() AS horario_servidor
      FROM public.aceites_termos WHERE usuario_id = $1
    `, [userId])
    assert.deepEqual(acceptance.rows, [{
      usuario_id: userId, termos_versao: TERMS_VERSION,
      privacidade_versao: PRIVACY_VERSION, horario_servidor: true,
    }])
    await startSession(userId)
    assert.equal((await access())?.situacao, 'ATIVO')
    assert.deepEqual((await events()).map((row) => row.evento).sort(), ['CADASTRO_REALIZADO', 'LOGIN_SUCESSO'])
  })

  await scenario('retirar aprovação não permite reutilizar o ticket de cadastro', async () => {
    const { userId, email, ticket } = await prepareSignup()
    const metadata = JSON.stringify({ ...legalData, ticket_cadastro: ticket })
    await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [userId, email, metadata])
    await db.exec('SAVEPOINT repeticao')
    await assert.rejects(db.query(
      'INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)',
      [randomUUID(), 'outro@example.com', metadata],
    ), /convite válido/)
    await db.exec('ROLLBACK TO SAVEPOINT repeticao')
    assert.equal((await events()).length, 1)
  })

  await scenario('cadastro recusado não cria conta nem evento de sucesso', async () => {
    await db.exec('SAVEPOINT tentativa')
    await assert.rejects(db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [randomUUID(), 'semconvite@exemplo.com']), /convite válido/)
    await db.exec('ROLLBACK TO SAVEPOINT tentativa')
    assert.equal((await events()).length, 0)
    assert.equal((await db.query("SELECT * FROM auth.users WHERE email = 'semconvite@exemplo.com'")).rows.length, 0)
  })

  await scenario('falha no registro desfaz cadastro, perfil e consumo do convite', async () => {
    const { userId, email, ticket } = await prepareSignup()
    await db.exec(`
      ALTER TABLE public.eventos_seguranca ADD CONSTRAINT falha_simulada
      CHECK (evento <> 'CADASTRO_REALIZADO');
      SAVEPOINT cadastro;
      SET LOCAL ROLE supabase_auth_admin;
    `)
    await assert.rejects(db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
      userId, email, JSON.stringify({ ...legalData, nome: 'Aluno', ticket_cadastro: ticket }),
    ]), /falha_simulada/)
    await db.exec('ROLLBACK TO SAVEPOINT cadastro; RESET ROLE')
    assert.equal((await db.query('SELECT * FROM auth.users WHERE id = $1', [userId])).rows.length, 0)
    assert.equal((await db.query('SELECT * FROM public.perfis WHERE id = $1', [userId])).rows.length, 0)
    assert.equal((await db.query('SELECT * FROM public.aceites_termos WHERE usuario_id = $1', [userId])).rows.length, 0)
    const invite = await db.query<{ situacao: string }>('SELECT situacao FROM public.convites_aluno WHERE email = $1', [email])
    assert.equal(invite.rows[0].situacao, 'LIBERADO')
    assert.equal((await events()).length, 0)
  })

  for (const [label, metadata] of [
    ['sem aceite', {}],
    ['aceite falso', { ...legalData, termos_aceitos: false }],
    ['string em vez de booleano', { ...legalData, termos_aceitos: 'true' }],
    ['aceite nulo', { ...legalData, termos_aceitos: null }],
    ['sem versões', { termos_aceitos: true }],
    ['termos desatualizados', { ...legalData, termos_versao: '2000-01-01' }],
    ['política desatualizada', { ...legalData, privacidade_versao: '2000-01-01' }],
  ] as const) {
    await scenario(`cadastro ${label} é recusado no banco sem consumir o convite`, async () => {
      const { userId, email, ticket } = await prepareSignup()
      await db.exec('SAVEPOINT sem_aceite; SET LOCAL ROLE supabase_auth_admin')
      await assert.rejects(db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
        userId, email, JSON.stringify({ ...metadata, ticket_cadastro: ticket }),
      ]), /aceite da versão atual/)
      await db.exec('ROLLBACK TO SAVEPOINT sem_aceite; RESET ROLE')

      assert.equal((await db.query('SELECT * FROM auth.users WHERE id = $1', [userId])).rows.length, 0)
      assert.equal((await db.query('SELECT * FROM public.perfis WHERE id = $1', [userId])).rows.length, 0)
      assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 0)
      assert.equal((await events()).length, 0)
      assert.deepEqual((await db.query(`
        SELECT situacao, utilizado_em, utilizado_por FROM public.convites_aluno WHERE email = $1
      `, [email])).rows, [{ situacao: 'LIBERADO', utilizado_em: null, utilizado_por: null }])
      assert.deepEqual((await db.query(`
        SELECT utilizado_em, utilizado_por FROM public.tickets_cadastro_aluno
      `)).rows, [{ utilizado_em: null, utilizado_por: null }])
    })
  }

  await scenario('alterar metadados depois não muda o aceite nem inventa aceite de conta antiga', async () => {
    const { userId } = await signupWithTerms()
    const before = (await db.query('SELECT * FROM public.aceites_termos')).rows
    await db.query('UPDATE auth.users SET raw_user_meta_data = $1 WHERE id IN ($2, $3)', [
      JSON.stringify({ termos_aceitos: true, termos_versao: 'versao-forjada' }), userId, studentId,
    ])
    assert.deepEqual((await db.query('SELECT * FROM public.aceites_termos')).rows, before)
  })

  await scenario('aceite só pode ser consultado pelo titular ou ADMIN, ambos com MFA', async () => {
    const { userId } = await signupWithTerms()
    await startSession(userId, 'aal1')
    assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 0)
    await db.exec('RESET ROLE')
    await startSession(userId)
    assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 1)
    await db.exec('RESET ROLE')
    await startSession(studentId)
    assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 0)
    await db.exec('RESET ROLE')
    await startSession(adminId, 'aal1')
    assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 0)
    await db.exec('RESET ROLE')
    await startSession(adminId)
    assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 1)
  })

  await scenario('anônimo não consulta aceites', async () => {
    await db.exec('SET LOCAL ROLE anon')
    await assert.rejects(db.query('SELECT * FROM public.aceites_termos'), /permission denied/)
  })

  for (const operation of [
    `INSERT INTO public.aceites_termos (usuario_id, termos_versao, privacidade_versao)
     VALUES ('${studentId}', 'forjado', 'forjado')`,
    "UPDATE public.aceites_termos SET termos_versao = 'forjado'",
    'DELETE FROM public.aceites_termos',
  ]) {
    await scenario(`nem ADMIN pelo navegador pode fazer ${operation.split(' ')[0]} nos aceites`, async () => {
      await signupWithTerms()
      await startSession(adminId)
      await assert.rejects(db.exec(operation), /permission denied/)
    })
  }

  await scenario('gatilho não fica executável pelo navegador', async () => {
    for (const role of ['anon', 'authenticated']) {
      const result = await db.query<{ permitido: boolean }>(`
        SELECT has_function_privilege($1, 'examentech_private.registrar_aceite_termos()', 'EXECUTE') AS permitido
      `, [role])
      assert.equal(result.rows[0].permitido, false)
    }
  })

  await scenario('excluir conta remove seu aceite, sem apagar o evento histórico de cadastro', async () => {
    const { userId } = await signupWithTerms()
    await db.query('DELETE FROM auth.users WHERE id = $1', [userId])
    assert.equal((await db.query('SELECT * FROM public.aceites_termos')).rows.length, 0)
    const rows = await events()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].evento, 'CADASTRO_REALIZADO')
    assert.equal(rows[0].usuario_id, null)
  })

  await scenario('login ativo grava usuário da sessão e não duplica no F5', async () => {
    const sessionId = await startSession()
    assert.equal((await access())?.situacao, 'ATIVO')
    await access()
    const rows = await events()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].evento, 'LOGIN_SUCESSO')
    assert.equal(rows[0].usuario_id, studentId)
    assert.equal(rows[0].sessao_id, sessionId)
    assert.equal(rows[0].sucesso, true)
    assert.deepEqual(rows[0].codigos_erro, [])
  })

  await scenario('novo login com outra sessão gera outro evento', async () => {
    await startSession()
    await access()
    await db.exec('RESET ROLE')
    await startSession()
    await access()
    assert.equal((await events()).length, 2)
  })

  for (const situacao of ['PENDENTE', 'INATIVO']) {
    await scenario(`perfil ${situacao} registra negativa sem sucesso`, async () => {
      await db.query('UPDATE public.perfis SET situacao = $2 WHERE id = $1', [studentId, situacao])
      await startSession()
      assert.equal((await access())?.situacao, situacao)
      await access()
      const rows = await events()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].evento, 'LOGIN_NEGADO')
      assert.equal(rows[0].sucesso, false)
      assert.deepEqual(rows[0].codigos_erro, [`PERFIL_${situacao}`])
    })
  }

  await scenario('perfil ausente registra negativa sem desfazer o evento', async () => {
    await db.query('DELETE FROM public.perfis WHERE id = $1', [studentId])
    await startSession()
    assert.equal(await access(), null)
    assert.deepEqual((await events())[0].codigos_erro, ['PERFIL_NAO_ENCONTRADO'])
  })

  await scenario('perfil inesperado nunca é registrado como login bem-sucedido', async () => {
    await db.exec('ALTER TABLE public.perfis DROP CONSTRAINT perfis_perfil_valido')
    await db.query("UPDATE public.perfis SET perfil = 'SUPERADMIN' WHERE id = $1", [studentId])
    await startSession()
    await access()
    const rows = await events()
    assert.equal(rows[0].evento, 'LOGIN_NEGADO')
    assert.deepEqual(rows[0].codigos_erro, ['PERFIL_INVALIDO'])
  })

  await scenario('sessão sem MFA não pode registrar login', async () => {
    await startSession(studentId, 'aal1')
    await assert.rejects(access(), /MFA obrigatório/)
  })

  await scenario('token sem identificador de sessão é recusado', async () => {
    await setClaims(studentId, null)
    await assert.rejects(access(), /MFA obrigatório/)
  })

  await scenario('sessão de outro usuário é recusada', async () => {
    const sessionId = await startSession(adminId)
    await setClaims(studentId, sessionId)
    await assert.rejects(access(), /Sessão encerrada ou inválida/)
  })

  await scenario('sessão encerrada é recusada e histórico não depende dela', async () => {
    const sessionId = await startSession()
    await access()
    await db.exec('RESET ROLE')
    await db.query('DELETE FROM auth.sessions WHERE id = $1', [sessionId])
    assert.equal((await events()).length, 1)
    await setClaims(studentId, sessionId)
    await assert.rejects(access(), /Sessão encerrada ou inválida/)
  })

  await scenario('anônimo não executa a função de auditoria', async () => {
    await db.exec('SET LOCAL ROLE anon')
    await assert.rejects(access(), /permission denied/)
  })

  await scenario('usuário não pode inserir eventos diretamente', async () => {
    await startSession()
    await assert.rejects(db.exec(`
      INSERT INTO public.eventos_seguranca (solicitacao_id, evento, sucesso)
      VALUES (gen_random_uuid(), 'TURNSTILE_VALIDADO', TRUE)
    `), /permission denied/)
  })

  await scenario('API antiga mantém permissão para gravar eventos Turnstile', async () => {
    await db.exec(`
      SET LOCAL ROLE service_role;
      INSERT INTO public.eventos_seguranca (solicitacao_id, evento, sucesso)
      VALUES (gen_random_uuid(), 'TURNSTILE_REJEITADO', FALSE);
    `)
    assert.equal((await db.query("SELECT * FROM public.eventos_seguranca WHERE evento = 'TURNSTILE_REJEITADO'")).rows.length, 1)
  })

  await scenario('exclusão de conta mantém histórico sem referência ao usuário removido', async () => {
    await startSession()
    await access()
    await db.exec('RESET ROLE')
    await db.query('DELETE FROM auth.users WHERE id = $1', [studentId])
    const rows = await events()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].usuario_id, null)
    assert.equal(rows[0].evento, 'LOGIN_SUCESSO')
  })

  await scenario('auditoria continua visível somente para ADMIN com MFA', async () => {
    await startSession()
    await access()
    assert.equal((await db.query('SELECT * FROM public.eventos_seguranca')).rows.length, 0)
    await db.exec('RESET ROLE')
    await startSession(adminId, 'aal1')
    assert.equal((await db.query('SELECT * FROM public.eventos_seguranca')).rows.length, 0)
    await db.exec('RESET ROLE')
    await startSession(adminId)
    assert.equal((await db.query('SELECT * FROM public.eventos_seguranca')).rows.length, 2)
  })

  await t.test('reaplicar 008 preserva aceite registrado e não duplica o gatilho', async () => {
    await signupWithTerms()
    const before = (await db.query('SELECT * FROM public.aceites_termos')).rows
    await applyMigration('008_aceite_termos.sql')
    assert.deepEqual((await db.query('SELECT * FROM public.aceites_termos')).rows, before)
    const triggers = await db.query(`
      SELECT tgname FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'auth.users'::regclass AND tgname = 'examentech_registrar_aceite_termos'
    `)
    assert.equal(triggers.rows.length, 1)
  })
})
