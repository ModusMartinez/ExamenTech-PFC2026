import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const adminId = '00000000-0000-4000-8000-000000000001'
const studentId = '00000000-0000-4000-8000-000000000002'

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

  await scenario('preserva registros antigos e permissões após reaplicar 006', async () => {
    assert.equal((await db.query('SELECT * FROM public.eventos_seguranca')).rows.length, 1)
    assert.equal((await events()).length, 0)
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
    await startSession(userId)
    assert.equal((await access())?.situacao, 'ATIVO')
    assert.deepEqual((await events()).map((row) => row.evento).sort(), ['CADASTRO_REALIZADO', 'LOGIN_SUCESSO'])
  })

  await scenario('retirar aprovação não permite reutilizar o ticket de cadastro', async () => {
    const { userId, email, ticket } = await prepareSignup()
    const metadata = JSON.stringify({ ticket_cadastro: ticket })
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
      userId, email, JSON.stringify({ nome: 'Aluno', ticket_cadastro: ticket }),
    ]), /falha_simulada/)
    await db.exec('ROLLBACK TO SAVEPOINT cadastro; RESET ROLE')
    assert.equal((await db.query('SELECT * FROM auth.users WHERE id = $1', [userId])).rows.length, 0)
    assert.equal((await db.query('SELECT * FROM public.perfis WHERE id = $1', [userId])).rows.length, 0)
    const invite = await db.query<{ situacao: string }>('SELECT situacao FROM public.convites_aluno WHERE email = $1', [email])
    assert.equal(invite.rows[0].situacao, 'LIBERADO')
    assert.equal((await events()).length, 0)
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
})
