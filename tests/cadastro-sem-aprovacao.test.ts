import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('007 remove aprovação apenas de alunos com convite usado e vínculo válido', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())

  // Banco descartável. Não usa o projeto Supabase nem variáveis de ambiente.
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, supabase_auth_admin;
    CREATE TABLE auth.users (
      id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB DEFAULT '{}'
    );
    CREATE TABLE auth.sessions (
      id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
    );
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

  async function migration(name: string) {
    await db.exec(await readFile(new URL(`../database/${name}`, import.meta.url), 'utf8'))
  }

  for (const name of [
    '001_perfis.sql', '002_eventos_seguranca.sql',
    '003_cadastro_publico_aluno.sql', '004_convites_organizacoes.sql',
  ]) await migration(name)

  const legacyId = randomUUID()
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [legacyId, 'antigo@example.com'])
  await migration('005_ativar_convite_cadastro.sql')
  await migration('006_auditoria_cadastro_login.sql')

  const orgId = randomUUID()
  const otherOrgId = randomUUID()
  const orgCode = 'AbCdEfGhIjKlMnOpQrS_1'
  await db.query(`
    INSERT INTO public.organizacoes (id, nome, token_login, codigo_rotacionado_em)
    VALUES ($1, 'Escola de teste', $2, NOW()), ($3, 'Outra escola', repeat('z', 21), NOW())
  `, [orgId, orgCode, otherOrgId])

  async function invitedUser(role = 'ALUNO', status = 'PENDENTE') {
    const id = randomUUID()
    const email = `${id}@example.com`
    const code = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
    await db.query(`
      INSERT INTO public.convites_aluno (organizacao_id, email, codigo_hash, expira_em)
      VALUES ($1, $2, encode(sha256(convert_to($3, 'UTF8')), 'hex'), NOW() + INTERVAL '1 day')
    `, [orgId, email, code])
    const result = await db.query<{ data: { ticket: string } }>(
      'SELECT public.preparar_cadastro_aluno($1, $2, $3) AS data', [email, orgCode, code],
    )
    await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
      id, email, JSON.stringify({ ticket_cadastro: result.rows[0].data.ticket }),
    ])
    await db.query('UPDATE public.perfis SET perfil = $2, situacao = $3 WHERE id = $1', [id, role, status])
    return id
  }

  const pendingId = await invitedUser()
  const inactiveId = await invitedUser('ALUNO', 'INATIVO')
  const activeId = await invitedUser('ALUNO', 'ATIVO')
  const teacherId = await invitedUser('PROFESSOR')
  const adminId = await invitedUser('ADMIN')
  const activeAdminId = await invitedUser('ADMIN', 'ATIVO')
  const wrongOrgId = await invitedUser()
  const wrongEmailId = await invitedUser()
  const inactiveOrgId = await invitedUser()
  await db.query('UPDATE public.perfis SET organizacao_id = $2 WHERE id = $1', [wrongOrgId, otherOrgId])
  await db.query('UPDATE auth.users SET email = $2 WHERE id = $1', [wrongEmailId, 'email-alterado@example.com'])
  await db.query('UPDATE public.convites_aluno SET organizacao_id = $2 WHERE utilizado_por = $1', [inactiveOrgId, otherOrgId])
  await db.query('UPDATE public.perfis SET organizacao_id = $2 WHERE id = $1', [inactiveOrgId, otherOrgId])
  await db.query("UPDATE public.organizacoes SET situacao = 'INATIVO' WHERE id = $1", [otherOrgId])

  await t.test('recusa implantação se o gatilho de convite estiver desativado', async () => {
    await db.exec('ALTER TABLE auth.users DISABLE TRIGGER examentech_exigir_convite_aluno')
    await assert.rejects(migration('007_cadastro_sem_aprovacao.sql'), /exigência de convite/)
    await db.exec('ROLLBACK')
    await db.exec('ALTER TABLE auth.users ENABLE TRIGGER examentech_exigir_convite_aluno')
    assert.equal((await db.query<{ situacao: string }>(
      'SELECT situacao FROM public.perfis WHERE id = $1', [pendingId],
    )).rows[0].situacao, 'PENDENTE')
  })

  await t.test('recusa implantação se o gatilho de perfil estiver desativado', async () => {
    await db.exec('ALTER TABLE auth.users DISABLE TRIGGER ao_criar_usuario')
    await assert.rejects(migration('007_cadastro_sem_aprovacao.sql'), /gatilho de criação de perfil/)
    await db.exec('ROLLBACK')
    await db.exec('ALTER TABLE auth.users ENABLE TRIGGER ao_criar_usuario')
  })

  const eventsBefore = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
  await migration('007_cadastro_sem_aprovacao.sql')

  async function profiles() {
    return (await db.query<{ id: string; perfil: string; situacao: string }>(
      'SELECT id, perfil, situacao FROM public.perfis ORDER BY id',
    )).rows
  }

  await t.test('ativa o aluno convidado, sem reativar inativos ou liberar perfis privilegiados', async () => {
    const records = await profiles()
    for (const [id, role, status] of [
      [pendingId, 'ALUNO', 'ATIVO'],
      [inactiveId, 'ALUNO', 'INATIVO'],
      [activeId, 'ALUNO', 'ATIVO'],
      [teacherId, 'PROFESSOR', 'PENDENTE'],
      [adminId, 'ADMIN', 'PENDENTE'],
      [activeAdminId, 'ADMIN', 'ATIVO'],
      [legacyId, 'ALUNO', 'PENDENTE'],
      [wrongOrgId, 'ALUNO', 'PENDENTE'],
      [wrongEmailId, 'ALUNO', 'PENDENTE'],
      [inactiveOrgId, 'ALUNO', 'PENDENTE'],
    ]) {
      assert.deepEqual(records.find((record) => record.id === id), { id, perfil: role, situacao: status })
    }
  })

  await t.test('preserva a auditoria e permite reaplicar sem mudanças adicionais', async () => {
    const before = await profiles()
    await migration('007_cadastro_sem_aprovacao.sql')
    assert.deepEqual(await profiles(), before)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, eventsBefore)
  })

  await t.test('situação padrão passa a ATIVO e permissões de escrita continuam restritas', async () => {
    const result = await db.query<{ column_default: string }>(`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'perfis' AND column_name = 'situacao'
    `)
    assert.equal(result.rows[0].column_default, "'ATIVO'::text")
    const privileges = await db.query<{ trigger_publico: boolean }>(`
      SELECT has_function_privilege('anon', 'public.criar_perfil_novo_usuario()', 'EXECUTE')
        OR has_function_privilege('authenticated', 'public.criar_perfil_novo_usuario()', 'EXECUTE')
        AS trigger_publico
    `)
    assert.equal(privileges.rows[0].trigger_publico, false)
  })
})
