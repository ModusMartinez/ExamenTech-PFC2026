import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('045: RGM fica vinculado ao ticket e protege novos cadastros sem modificar contas anteriores', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const org = randomUUID(), admin = randomUUID(), adminSession = randomUUID()
  const code = 'A'.repeat(21)
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,supabase_auth_admin;
    CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT,raw_user_meta_data JSONB DEFAULT '{}');
    CREATE TABLE auth.sessions(id UUID PRIMARY KEY,user_id UUID REFERENCES auth.users(id));
    GRANT INSERT,SELECT ON auth.users TO supabase_auth_admin;
    CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::JSONB,'{}') $$;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULLIF(auth.jwt()->>'sub','')::UUID $$;
    CREATE TABLE public.organizacoes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),nome TEXT NOT NULL,
      token_login TEXT NOT NULL UNIQUE,situacao TEXT NOT NULL DEFAULT 'ATIVO');
  `)
  async function migrate(name: string) {
    await db.exec(await readFile(new URL(`../database/${name}`, import.meta.url), 'utf8'))
  }
  for (const file of ['001_perfis.sql','002_eventos_seguranca.sql','003_cadastro_publico_aluno.sql','004_convites_organizacoes.sql']) await migrate(file)
  await db.query("INSERT INTO public.organizacoes(id,nome,token_login,codigo_rotacionado_em) VALUES($1,'Teste',$2,NOW())",[org,code])
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[admin,'admin@example.test'])
  await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)',[adminSession,admin])
  await db.query("UPDATE public.perfis SET perfil='ADMIN',situacao='ATIVO',organizacao_id=$1 WHERE id=$2",[org,admin])
  const historicalA = randomUUID(), historicalB = randomUUID()
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)',[
    historicalA,'historico-a@example.test',historicalB,'historico-b@example.test',
  ])
  await db.query('UPDATE public.perfis SET rgm=$1 WHERE id=$2',['antigo',historicalA])
  await db.query('UPDATE public.perfis SET rgm=$1 WHERE id=$2',[' ANTIGO ',historicalB])
  for (const file of ['005_ativar_convite_cadastro.sql','006_auditoria_cadastro_login.sql','007_cadastro_sem_aprovacao.sql','008_aceite_termos.sql','009_convites_professor.sql']) await migrate(file)
  const before = (await db.query('SELECT * FROM public.perfis WHERE id=$1',[admin])).rows[0]
  await assert.rejects(migrate('045_rgm_cadastro.sql'),/RGMs duplicados após normalização/)
  await db.exec('ROLLBACK')
  assert.equal((await db.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='public.tickets_cadastro_aluno'::regclass AND attname='rgm_validado') AS present`)).rows[0].present,false)
  assert.deepEqual((await db.query<{ rgm: string }>('SELECT rgm FROM public.perfis WHERE id IN ($1,$2) ORDER BY rgm',[historicalA,historicalB])).rows.map((row) => row.rgm),[' ANTIGO ','antigo'])
  // A revisão manual do dado legado é simulada só neste banco isolado de teste.
  await db.query('UPDATE public.perfis SET rgm=NULL WHERE id=$1',[historicalB])
  await migrate('045_rgm_cadastro.sql')
  await migrate('045_rgm_cadastro.sql')
  assert.deepEqual((await db.query('SELECT * FROM public.perfis WHERE id=$1',[admin])).rows[0], before)

  async function issue(email: string, profile = 'ALUNO') {
    return db.transaction(async (tx) => {
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:admin,aal:'aal2',session_id:adminSession})])
      await tx.exec('SET LOCAL ROLE authenticated')
      return (await tx.query<{ convite: { codigo: string } }>(`SELECT public.${profile === 'ALUNO' ? 'emitir_convite_aluno' : 'emitir_convite_professor'}($1,$2) AS convite`,[email,org])).rows[0].convite.codigo
    })
  }
  async function prepare(email: string, invitation: string, rgm: string, legacy = false) {
    return db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE anon')
      const result = legacy
        ? await tx.query<{ result: { ticket: string } }>('SELECT public.preparar_cadastro($1,$2,$3) AS result',[email,code,invitation])
        : await tx.query<{ result: { ticket: string } }>('SELECT public.preparar_cadastro_com_rgm($1,$2,$3,$4) AS result',[email,code,invitation,rgm])
      return result.rows[0].result.ticket
    })
  }
  async function signup(email: string, ticket: string, extra: object = {}) {
    const id = randomUUID()
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE supabase_auth_admin')
      await tx.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id,email,JSON.stringify({
        nome:'Aluno',ticket_cadastro:ticket,termos_aceitos:true,termos_versao:'2026-09-27-v2',privacidade_versao:'2026-09-27',...extra,
      })])
    })
    return id
  }

  const invitation = await issue('aluno@example.test')
  for (const [rgm, expected] of [['','P2010'],['12 34','P2011'],['A'.repeat(51),'P2011']]) {
    await assert.rejects(prepare('aluno@example.test',invitation,rgm), (error: unknown) => {
      assert.equal((error as { code: string }).code,expected)
      return true
    })
  }
  assert.equal((await db.query<{ total: number }>('SELECT count(*)::INT AS total FROM public.tickets_cadastro_aluno')).rows[0].total,0)
  const ticket = await prepare('aluno@example.test',invitation,' 00ab-123 ')
  const id = await signup('aluno@example.test',ticket,{rgm:'99999',perfil:'ADMIN'})
  assert.deepEqual((await db.query('SELECT rgm,perfil FROM public.perfis WHERE id=$1',[id])).rows[0],{rgm:'00AB-123',perfil:'ALUNO'})
  const otherInvitation = await issue('outro@example.test')
  await assert.rejects(prepare('outro@example.test',otherInvitation,'00aB-123'), /RGM já cadastrado/)

  // O endpoint anterior continua disponível para compatibilidade, mas não contorna a exigência.
  const oldTicket = await prepare('outro@example.test',otherInvitation,'',true)
  await assert.rejects(signup('outro@example.test',oldTicket,{rgm:'outro'}), /RGM validado/)
  assert.equal((await db.query<{ state: string }>("SELECT situacao AS state FROM public.convites_aluno WHERE email='outro@example.test'")).rows[0].state,'LIBERADO')
  const validTicket = await prepare('outro@example.test',otherInvitation,'000456')
  const secondId = await signup('outro@example.test',validTicket)
  assert.equal((await db.query<{ rgm: string }>('SELECT rgm FROM public.perfis WHERE id=$1',[secondId])).rows[0].rgm,'000456')

  const teacherInvitation = await issue('professor@example.test','PROFESSOR')
  const teacherId = await signup('professor@example.test',await prepare('professor@example.test',teacherInvitation,''))
  assert.deepEqual((await db.query('SELECT rgm,perfil FROM public.perfis WHERE id=$1',[teacherId])).rows[0],{rgm:null,perfil:'PROFESSOR'})

  // Duas emissões podem passar pelo precheck antes de existir perfil; a unicidade decide no INSERT.
  const inviteA = await issue('concorrente-a@example.test'), inviteB = await issue('concorrente-b@example.test')
  const ticketA = await prepare('concorrente-a@example.test',inviteA,'DUP-1')
  const ticketB = await prepare('concorrente-b@example.test',inviteB,'dup-1')
  await signup('concorrente-a@example.test',ticketA)
  await assert.rejects(signup('concorrente-b@example.test',ticketB), /RGM já cadastrado/)
  assert.equal((await db.query<{ state: string }>("SELECT situacao AS state FROM public.convites_aluno WHERE email='concorrente-b@example.test'")).rows[0].state,'LIBERADO')
  await assert.rejects(prepare('invalido@example.test','f'.repeat(64),'DUP-1'), /Códigos inválidos/)

  // A implantação de identidade mantém os documentos antigos e valida as duas variantes atuais.
  const acceptanceBefore = (await db.query('SELECT * FROM public.aceites_termos WHERE usuario_id=$1',[id])).rows
  for (const file of ['011_turmas.sql','012_matriculas.sql','046_redefinicao_mfa.sql',
    '047_ingresso_primeira_turma.sql','048_documentos_identidade.sql']) await migrate(file)
  const diagnostic = await db.query<Record<string, boolean>>(await readFile(
    new URL('../docs/diagnostico-identidade-1211.sql', import.meta.url), 'utf8'))
  assert.ok(Object.values(diagnostic.rows[0]).every(value => value === true))
  assert.deepEqual((await db.query('SELECT * FROM public.aceites_termos WHERE usuario_id=$1',[id])).rows,acceptanceBefore)
  for (const [index, terms, privacy] of [
    [1,'2026-11-12-v11','2026-11-12-v8'],
    [2,'2026-11-12-v12','2026-11-12-v9'],
  ] as const) {
    const newEmail = `documentos-${index}@example.test`
    const newInvite = await issue(newEmail)
    const newId = await signup(newEmail,await prepare(newEmail,newInvite,`DOC-${index}`),{
      termos_versao:terms,privacidade_versao:privacy,
    })
    assert.deepEqual((await db.query('SELECT termos_versao,privacidade_versao FROM public.aceites_termos WHERE usuario_id=$1',[newId])).rows[0],{
      termos_versao:terms,privacidade_versao:privacy,
    })
    assert.equal((await db.query<{ rgm: string }>('SELECT rgm FROM public.perfis WHERE id=$1',[newId])).rows[0].rgm,`DOC-${index}`)
  }
  for (const [index, terms, privacy] of [
    [1,'2026-09-27-v2','2026-09-27'],
    [2,'2026-11-12-v11','2026-11-12-v9'],
    [3,'2026-11-12-v12','2026-11-12-v8'],
  ] as const) {
    const newEmail = `documentos-invalidos-${index}@example.test`
    const newInvite = await issue(newEmail)
    const newTicket = await prepare(newEmail,newInvite,`INV-${index}`)
    await assert.rejects(signup(newEmail,newTicket,{termos_versao:terms,privacidade_versao:privacy}),/aceite da versão atual/)
    assert.equal((await db.query<{ total: number }>('SELECT count(*)::INT AS total FROM auth.users WHERE email=$1',[newEmail])).rows[0].total,0)
    assert.equal((await db.query<{ state: string }>('SELECT situacao AS state FROM public.convites_aluno WHERE email=$1',[newEmail])).rows[0].state,'LIBERADO')
  }
  const unauthorizedEmail = 'sem-aceite@example.test'
  const unauthorizedInvite = await issue(unauthorizedEmail)
  await assert.rejects(signup(unauthorizedEmail,await prepare(unauthorizedEmail,unauthorizedInvite,'NO-ACCEPT'),{
    termos_aceitos:'true',termos_versao:'2026-11-12-v11',privacidade_versao:'2026-11-12-v8',
  }),/aceite da versão atual/)
  await t.test('RF02 bloqueia professor novo até aprovação auditada por administrador com MFA', async () => {
    await migrate('054_aprovacao_professores.sql')
    const email = 'aguardando-aprovacao@example.test'
    const invite = await issue(email, 'PROFESSOR')
    const professor = await signup(email, await prepare(email, invite, ''), {
      nome: 'Professor novo', termos_versao: '2026-11-12-v11', privacidade_versao: '2026-11-12-v8',
    })
    const sessaoProfessor = randomUUID()
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [sessaoProfessor, professor])
    const executar = (sql: string, params: unknown[] = [], sub = admin, sessao = adminSession, aal = 'aal2') =>
      db.transaction(async tx => {
        await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub, aal, session_id: sessao })])
        await tx.exec('SET LOCAL ROLE authenticated')
        return tx.query(sql, params)
      })
    const listar = 'SELECT public.listar_professores_pendentes() AS pendentes'
    const aprovar = 'SELECT public.aprovar_professor($1) AS aprovado'
    const acessar = () => executar("SELECT public.registrar_acesso()->>'situacao' AS situacao", [], professor, sessaoProfessor)
    assert.deepEqual((await acessar()).rows, [{ situacao: 'PENDENTE' }])
    assert.deepEqual((await db.query('SELECT situacao FROM public.perfis WHERE id=$1', [teacherId])).rows, [{ situacao: 'ATIVO' }])
    const [{ pendentes }] = (await executar(listar)).rows as { pendentes: { email: string }[] }[]
    assert.deepEqual(pendentes.map(item => item.email), [email])
    await assert.rejects(executar(listar, [], professor, sessaoProfessor), { code: '42501' })
    await assert.rejects(executar(aprovar, [professor], professor, sessaoProfessor), { code: '42501' })
    await assert.rejects(executar(aprovar, [professor], admin, adminSession, 'aal1'), { code: '42501' })
    assert.deepEqual((await executar(aprovar, [professor])).rows, [{ aprovado: true }])
    assert.deepEqual((await executar(aprovar, [professor])).rows, [{ aprovado: false }])
    assert.deepEqual((await acessar()).rows, [{ situacao: 'ATIVO' }])
    assert.deepEqual((await executar(listar)).rows, [{ pendentes: [] }])
    assert.deepEqual((await db.query(
      "SELECT usuario_id FROM public.eventos_seguranca WHERE evento='PROFESSOR_APROVADO' AND recurso_id=$1", [professor]
    )).rows, [{ usuario_id: admin }])
  })

})
