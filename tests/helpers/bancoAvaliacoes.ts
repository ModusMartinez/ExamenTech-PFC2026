import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PGlite } from '@electric-sql/pglite'

export async function prepararBancoAvaliacoes(db: PGlite) {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS; CREATE ROLE supabase_auth_admin;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, supabase_auth_admin;
    CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB DEFAULT '{}');
    CREATE TABLE auth.sessions (id UUID PRIMARY KEY, user_id UUID REFERENCES auth.users(id));
    CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}')
    $$;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT NULLIF(auth.jwt() ->> 'sub', '')::UUID
    $$;
    CREATE TABLE public.organizacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nome TEXT NOT NULL,
      token_login TEXT UNIQUE NOT NULL, situacao TEXT NOT NULL DEFAULT 'ATIVO'
    );
  `)
  for (const file of ['001_perfis.sql', '002_eventos_seguranca.sql', '004_convites_organizacoes.sql',
    '006_auditoria_cadastro_login.sql', '011_turmas.sql', '012_matriculas.sql',
    '019_avaliacoes_rascunho.sql', '020_editar_avaliacao_rascunho.sql',
    '021_questoes_rascunho.sql', '022_alternativas_rascunho.sql']) {
    await db.exec(await readFile(new URL(`../../database/${file}`, import.meta.url), 'utf8'))
  }
  const org = randomUUID()
  const professor = randomUUID(), colega = randomUUID(), aluno = randomUUID(), admin = randomUUID()
  const sessions = new Map<string, string>()
  await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Escola fictícia','123456789012345678901')", [org])
  for (const [id, perfil] of [[professor, 'PROFESSOR'], [colega, 'PROFESSOR'], [aluno, 'ALUNO'], [admin, 'ADMIN']]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, `${id}@example.test`])
    await db.query("UPDATE public.perfis SET perfil=$1,situacao='ATIVO',organizacao_id=$2 WHERE id=$3", [perfil, org, id])
    const session = randomUUID()
    sessions.set(id, session)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [session, id])
  }
  async function queryAs<T = Record<string, unknown>>(id: string, sql: string, params: unknown[] = [], aal = 'aal2') {
    return db.transaction(async (tx) => {
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, aal, session_id: sessions.get(id) })])
      await tx.exec('SET LOCAL ROLE authenticated')
      return tx.query<T>(sql, params)
    })
  }
  const turmaId = (await queryAs<{ id: string }>(professor, "INSERT INTO public.turmas(nome) VALUES ('Turma de teste') RETURNING id")).rows[0].id
  await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, aluno])
  async function createAssessment() {
    return (await queryAs<{ avaliacao: { id: string } }>(professor,
      "SELECT public.criar_avaliacao_rascunho($1,'Prova de teste','PROVA','2026-11-09T19:00:00Z','2026-11-09T21:00:00Z',60) AS avaliacao", [turmaId])).rows[0].avaliacao.id
  }
  const avaliacaoId = await createAssessment()
  return { org, professor, colega, aluno, admin, sessions, queryAs, turmaId, createAssessment, avaliacaoId }
}
