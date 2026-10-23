import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/content/legalDocuments.ts'

const adminId = '00000000-0000-4000-8000-000000000001'
const teacherId = '00000000-0000-4000-8000-000000000002'
const studentId = '00000000-0000-4000-8000-000000000003'
const orgId = '00000000-0000-4000-8000-000000000010'
const otherOrgId = '00000000-0000-4000-8000-000000000020'
const orgCode = 'A'.repeat(21)
const legalData = { termos_aceitos: true, termos_versao: TERMS_VERSION, privacidade_versao: PRIVACY_VERSION }

type Invitation = { id: string; email: string; codigo: string; organizacao_id: string; perfil_destino: string }

test('009/010: professor por convite, documentos e auditoria em PostgreSQL local', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  // Auth mínimo apenas para testar o SQL. Nenhuma conta real é criada.
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS; CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, supabase_auth_admin;
    CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB DEFAULT '{}');
    CREATE TABLE auth.sessions (id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE);
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

  async function migrate(name: string) {
    await db.exec(await readFile(new URL(`../database/${name}`, import.meta.url), 'utf8'))
  }

  for (const file of ['001_perfis.sql', '002_eventos_seguranca.sql', '003_cadastro_publico_aluno.sql', '004_convites_organizacoes.sql']) await migrate(file)
  await db.query(`INSERT INTO public.organizacoes (id, nome, token_login, codigo_rotacionado_em)
    VALUES ($1, 'Escola A', $2, NOW()), ($3, 'Escola B', $4, NOW())`, [orgId, orgCode, otherOrgId, 'B'.repeat(21)])
  for (const [id, role] of [[adminId, 'ADMIN'], [teacherId, 'PROFESSOR'], [studentId, 'ALUNO']]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${role}@exemplo.com`])
    await db.query("UPDATE public.perfis SET perfil = $2, situacao = 'ATIVO', organizacao_id = $3 WHERE id = $1", [id, role, orgId])
  }
  for (const file of ['005_ativar_convite_cadastro.sql', '006_auditoria_cadastro_login.sql', '007_cadastro_sem_aprovacao.sql', '008_aceite_termos.sql']) await migrate(file)

  async function asUser(id: string | null, aal = 'aal2', sessionId: string | null = null) {
    await db.exec('RESET ROLE')
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, aal, session_id: sessionId, role: 'authenticated' })])
    await db.exec('SET LOCAL ROLE authenticated')
  }

  async function issue(profile = 'PROFESSOR', email = 'novo@exemplo.com', organizationId = orgId) {
    const name = profile === 'PROFESSOR' ? 'emitir_convite_professor' : 'emitir_convite_aluno'
    return (await db.query<{ convite: Invitation }>(`SELECT public.${name}($1, $2) AS convite`, [email, organizationId])).rows[0].convite
  }

  async function prepare(invitation: Invitation, functionName = 'preparar_cadastro') {
    await db.exec('SET LOCAL ROLE anon')
    const ticket = (await db.query<{ result: { ticket: string } }>(
      `SELECT public.${functionName}($1, $2, $3) AS result`, [invitation.email, orgCode, invitation.codigo],
    )).rows[0].result.ticket
    await db.exec('RESET ROLE')
    return ticket
  }

  async function signup(ticket: string, email: string, extra = {}, userId = randomUUID()) {
    await db.exec('SET LOCAL ROLE supabase_auth_admin')
    await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
      userId, email, JSON.stringify({ ...legalData, nome: 'Conta de teste', ticket_cadastro: ticket, ...extra }),
    ])
    // Confere as FKs e restaura o modo inicial para simular outra transação
    // de Auth quando o mesmo cenário cadastra professor e aluno.
    await db.exec('RESET ROLE; SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED')
    return userId
  }

  async function scenario(name: string, run: () => Promise<void>) {
    await t.test(name, async () => {
      await db.exec('BEGIN')
      try { await run() } finally { await db.exec('ROLLBACK') }
    })
  }

  // Um cadastro e um convite ainda não usado da versão anterior.
  await db.exec('BEGIN')
  await asUser(adminId)
  const oldInvite = await issue('ALUNO', 'anterior@exemplo.com')
  const oldUserId = await signup(await prepare(oldInvite, 'preparar_cadastro_aluno'), oldInvite.email, { termos_versao: '2026-09-27', privacidade_versao: '2026-09-27' })
  await asUser(adminId)
  const pendingInvite = await issue('ALUNO', 'convite-antigo@exemplo.com')
  await db.exec('COMMIT')

  await migrate('009_convites_professor.sql')
  await migrate('009_convites_professor.sql')

  // Preserva também um aceite real da versão imediatamente anterior à 010.
  await db.exec('BEGIN')
  await asUser(adminId)
  const previousInvite = await issue('PROFESSOR', 'versao009@exemplo.com')
  const previousUserId = await signup(await prepare(previousInvite), previousInvite.email, { termos_versao: '2026-09-27-v2', privacidade_versao: '2026-09-27' })
  const previousAcceptance = (await db.query('SELECT * FROM public.aceites_termos WHERE usuario_id = $1', [previousUserId])).rows
  await db.exec('COMMIT')
  await migrate('010_documentos_lgpd.sql')
  await migrate('010_documentos_lgpd.sql')

  await scenario('reaplicar 010 mantém aceite anterior, horário e conta sem aceite retroativo', async () => {
    assert.deepEqual((await db.query('SELECT * FROM public.aceites_termos WHERE usuario_id = $1', [previousUserId])).rows, previousAcceptance)
    assert.deepEqual((await db.query('SELECT perfil, situacao FROM public.perfis WHERE id = $1', [previousUserId])).rows[0], { perfil: 'PROFESSOR', situacao: 'ATIVO' })
    assert.equal((await db.query('SELECT * FROM public.aceites_termos WHERE usuario_id = $1', [adminId])).rows.length, 0)
    assert.equal((await db.query("SELECT * FROM pg_trigger WHERE tgname = 'examentech_registrar_aceite_termos'")).rows.length, 1)
  })

  await scenario('reaplicar 009 preserva conta, aceite anterior e convites antigos como ALUNO', async () => {
    const profile = (await db.query('SELECT perfil, situacao FROM public.perfis WHERE id = $1', [oldUserId])).rows[0]
    assert.deepEqual(profile, { perfil: 'ALUNO', situacao: 'ATIVO' })
    const acceptance = (await db.query<{ termos_versao: string }>('SELECT termos_versao FROM public.aceites_termos WHERE usuario_id = $1', [oldUserId])).rows[0]
    assert.equal(acceptance.termos_versao, '2026-09-27')
    assert.equal((await db.query<{ perfil_destino: string }>('SELECT perfil_destino FROM public.convites_aluno WHERE id = $1', [pendingInvite.id])).rows[0].perfil_destino, 'ALUNO')
    const newId = await signup(await prepare(pendingInvite), pendingInvite.email)
    assert.equal((await db.query<{ perfil: string }>('SELECT perfil FROM public.perfis WHERE id = $1', [newId])).rows[0].perfil, 'ALUNO')
  })

  await scenario('ADMIN emite professor: e-mail normalizado, sete dias e somente hash no banco', async () => {
    await asUser(adminId)
    const invitation = await issue('PROFESSOR', '  Professor.Novo@exemplo.com  ')
    assert.equal(invitation.perfil_destino, 'PROFESSOR')
    assert.equal(invitation.email, 'professor.novo@exemplo.com')
    assert.match(invitation.codigo, /^[a-f0-9]{64}$/)
    await db.exec('RESET ROLE')
    const row = (await db.query(`SELECT perfil_destino, liberado_por,
      codigo_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex') AS hash_correto,
      expira_em = NOW() + INTERVAL '7 days' AS prazo_correto
      FROM public.convites_aluno WHERE id = $1`, [invitation.id, invitation.codigo])).rows[0]
    assert.deepEqual(row, { perfil_destino: 'PROFESSOR', liberado_por: adminId, hash_correto: true, prazo_correto: true })
  })

  await scenario('professor cadastrado por ADMIN entra com MFA e emite convite para aluno', async () => {
    await asUser(adminId)
    const invitation = await issue()
    const newId = await signup(await prepare(invitation), invitation.email, { perfil: 'ADMIN', perfil_destino: 'ADMIN', situacao: 'INATIVO', rgm: 'forjado' })
    const profile = (await db.query('SELECT perfil, situacao, organizacao_id, rgm FROM public.perfis WHERE id = $1', [newId])).rows[0]
    assert.deepEqual(profile, { perfil: 'PROFESSOR', situacao: 'ATIVO', organizacao_id: orgId, rgm: null })
    const acceptance = (await db.query('SELECT termos_versao, privacidade_versao FROM public.aceites_termos WHERE usuario_id = $1', [newId])).rows[0]
    assert.deepEqual(acceptance, { termos_versao: TERMS_VERSION, privacidade_versao: PRIVACY_VERSION })
    const metadata = (await db.query<{ raw_user_meta_data: object }>('SELECT raw_user_meta_data FROM auth.users WHERE id = $1', [newId])).rows[0].raw_user_meta_data
    assert.equal('ticket_cadastro' in metadata, false)

    const sessionId = randomUUID()
    await db.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [sessionId, newId])
    await asUser(newId, 'aal2', sessionId)
    const access = (await db.query<{ perfil: { perfil: string; situacao: string } }>('SELECT public.registrar_acesso() AS perfil')).rows[0].perfil
    assert.equal(access.perfil, 'PROFESSOR')
    assert.equal(access.situacao, 'ATIVO')
    const studentInvite = await issue('ALUNO', 'aluno-do-professor@exemplo.com')
    const newStudentId = await signup(await prepare(studentInvite), studentInvite.email, { perfil: 'PROFESSOR' })
    assert.equal((await db.query<{ perfil: string }>('SELECT perfil FROM public.perfis WHERE id = $1', [newStudentId])).rows[0].perfil, 'ALUNO')
    const events = (await db.query<{ evento: string }>('SELECT evento FROM public.eventos_seguranca WHERE usuario_id = $1 ORDER BY evento', [newId])).rows
    assert.deepEqual(events.map((event) => event.evento), ['CADASTRO_REALIZADO', 'LOGIN_SUCESSO'])
  })

  for (const [label, id, aal, role, organization] of [
    ['professor não convida professor', teacherId, 'aal2', 'PROFESSOR', orgId],
    ['professor não convida aluno de outra escola', teacherId, 'aal2', 'ALUNO', otherOrgId],
    ['aluno não convida professor', studentId, 'aal2', 'PROFESSOR', orgId],
    ['aluno não convida aluno', studentId, 'aal2', 'ALUNO', orgId],
    ['ADMIN sem MFA não convida', adminId, 'aal1', 'PROFESSOR', orgId],
    ['professor sem MFA não convida', teacherId, 'aal1', 'ALUNO', orgId],
    ['usuário sem perfil não convida', randomUUID(), 'aal2', 'PROFESSOR', orgId],
  ]) {
    await scenario(label, async () => {
      await asUser(id, aal)
      await assert.rejects(issue(role, 'negado@exemplo.com', organization), /Acesso não autorizado/)
    })
  }

  for (const id of [adminId, teacherId]) {
    await scenario(`${id === adminId ? 'ADMIN' : 'PROFESSOR'} inativo não emite convites`, async () => {
      await db.query("UPDATE public.perfis SET situacao = 'INATIVO' WHERE id = $1", [id])
      await asUser(id)
      await assert.rejects(issue(id === adminId ? 'PROFESSOR' : 'ALUNO'), /Acesso não autorizado/)
    })
  }

  await scenario('chamar a função privada diretamente não permite ao professor emitir professor', async () => {
    await asUser(teacherId)
    await assert.rejects(db.query("SELECT examentech_private.emitir_convite($1, $2, 'PROFESSOR')", ['negado@exemplo.com', orgId]), /Acesso não autorizado/)
  })

  for (const destination of ['ADMIN', null]) {
    await scenario(`nem ADMIN pode emitir convite com destino ${destination}`, async () => {
      await asUser(adminId)
      await assert.rejects(db.query('SELECT examentech_private.emitir_convite($1, $2, $3)', ['negado@exemplo.com', orgId, destination]), /Tipo de convite inválido/)
    })
  }

  await scenario('anônimo não pode emitir convites', async () => {
    await db.exec('SET LOCAL ROLE anon')
    await assert.rejects(issue(), /permission denied/)
  })

  await scenario('ADMIN não emite professor para escola inativa', async () => {
    await db.query("UPDATE public.organizacoes SET situacao = 'INATIVO' WHERE id = $1", [orgId])
    await asUser(adminId)
    await assert.rejects(issue(), /Organização sem código ativo/)
  })

  for (const condition of ['convite expirado', 'convite revogado', 'ticket expirado', 'organização inativa', 'código rotacionado', 'e-mail diferente', 'sem aceite', 'termos antigos', 'termos da 009', 'política antiga', 'aceite como texto']) {
    await scenario(`professor: ${condition} impede cadastro e preserva o convite`, async () => {
      await asUser(adminId)
      const invitation = await issue()
      const ticket = await prepare(invitation)
      if (condition === 'convite expirado') await db.query("UPDATE public.convites_aluno SET expira_em = NOW() - INTERVAL '1 minute' WHERE id = $1", [invitation.id])
      if (condition === 'convite revogado') await db.query("UPDATE public.convites_aluno SET situacao = 'REVOGADO' WHERE id = $1", [invitation.id])
      if (condition === 'ticket expirado') await db.query("UPDATE public.tickets_cadastro_aluno SET expira_em = NOW() - INTERVAL '1 minute' WHERE convite_id = $1", [invitation.id])
      if (condition === 'organização inativa') await db.query("UPDATE public.organizacoes SET situacao = 'INATIVO' WHERE id = $1", [orgId])
      if (condition === 'código rotacionado') await db.query('UPDATE public.organizacoes SET token_login = $2 WHERE id = $1', [orgId, 'C'.repeat(21)])
      const extra = condition === 'sem aceite' ? { termos_aceitos: false }
        : condition === 'termos antigos' ? { termos_versao: '2026-09-27' }
        : condition === 'termos da 009' ? { termos_versao: '2026-09-27-v2' }
        : condition === 'política antiga' ? { privacidade_versao: '2026-09-27' }
        : condition === 'aceite como texto' ? { termos_aceitos: 'true' } : {}
      const newId = randomUUID()
      await db.exec('SAVEPOINT cadastro')
      await assert.rejects(signup(ticket, condition === 'e-mail diferente' ? 'outra@exemplo.com' : invitation.email, extra, newId), /convite válido|aceite da versão atual/)
      await db.exec('ROLLBACK TO SAVEPOINT cadastro; RESET ROLE')
      for (const table of ['auth.users', 'public.perfis']) assert.equal((await db.query(`SELECT * FROM ${table} WHERE id = $1`, [newId])).rows.length, 0)
      assert.equal((await db.query('SELECT * FROM public.aceites_termos WHERE usuario_id = $1', [newId])).rows.length, 0)
      assert.equal((await db.query('SELECT * FROM public.eventos_seguranca WHERE usuario_id = $1', [newId])).rows.length, 0)
      assert.equal((await db.query<{ utilizado_em: unknown }>('SELECT utilizado_em FROM public.convites_aluno WHERE id = $1', [invitation.id])).rows[0].utilizado_em, null)
      assert.equal((await db.query<{ utilizado_em: unknown }>('SELECT utilizado_em FROM public.tickets_cadastro_aluno WHERE convite_id = $1', [invitation.id])).rows[0].utilizado_em, null)
    })
  }

  await scenario('ticket de professor não pode ser usado duas vezes', async () => {
    await asUser(adminId)
    const invitation = await issue()
    const ticket = await prepare(invitation)
    await signup(ticket, invitation.email)
    await db.exec('SAVEPOINT repeticao')
    await assert.rejects(signup(ticket, invitation.email), /convite válido/)
    await db.exec('ROLLBACK TO SAVEPOINT repeticao; RESET ROLE')
    assert.equal((await db.query('SELECT * FROM auth.users WHERE email = $1', [invitation.email])).rows.length, 1)
  })

  await scenario('permissão no banco impede mudar perfil_destino de convite pelo navegador', async () => {
    await asUser(adminId)
    await assert.rejects(db.query("UPDATE public.convites_aluno SET perfil_destino = 'PROFESSOR' WHERE id = $1", [pendingInvite.id]), /permission denied/)
  })

  await scenario('auditoria não é visível a professor ou aluno, nem a ADMIN sem MFA', async () => {
    for (const [id, aal] of [[teacherId, 'aal2'], [studentId, 'aal2'], [adminId, 'aal1']]) {
      await asUser(id, aal)
      assert.equal((await db.query('SELECT * FROM public.eventos_seguranca')).rows.length, 0)
    }
    await asUser(adminId)
    assert.equal((await db.query('SELECT * FROM public.eventos_seguranca')).rows.length, 2)
  })

  await scenario('ADMIN não pode apagar eventos pela aplicação', async () => {
    await asUser(adminId)
    await assert.rejects(db.query('DELETE FROM public.eventos_seguranca'), /permission denied/)
  })

  await scenario('010 mantém escrita de aceites restrita ao gatilho', async () => {
    await asUser(adminId)
    await assert.rejects(db.query('SELECT examentech_private.registrar_aceite_termos()'), /permission denied/)
  })
})
