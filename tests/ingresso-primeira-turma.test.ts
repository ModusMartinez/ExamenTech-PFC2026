import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'

test('primeira turma: ingresso derivado, aprovação e restrições no banco', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const fixture = await prepararBancoAvaliacoes(db)
  for (const file of ['013_solicitar_matricula.sql', '014_aprovar_matricula.sql',
    '023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql', '047_ingresso_primeira_turma.sql']) {
    let source = await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8')
    // A fixture já aplicou 022. Carrega as RPCs antigas sem reduzir o catálogo de eventos.
    if (file.startsWith('013_') || file.startsWith('014_')) {
      source = source.replace(/BEGIN;[\s\S]*?(?=CREATE OR REPLACE FUNCTION)/, 'BEGIN;\n')
    }
    await db.exec(source)
  }
  await db.query("UPDATE public.avaliacoes SET situacao='PUBLICADA',publicada_em=now() WHERE id=$1", [fixture.avaliacaoId])
  const sql = 'SELECT public.consultar_ingresso_aluno() AS ingresso'
  async function readIngreso() {
    return (await fixture.queryAs<{ ingresso: { fase: string; acesso_liberado: boolean; matriculas_pendentes: number } }>(fixture.aluno, sql)).rows[0].ingresso
  }

  await t.test('aluno existente matriculado já está liberado sem alterar perfil', async () => {
    assert.deepEqual(await readIngreso(), { fase: 'LIBERADO', acesso_liberado: true, matriculas_pendentes: 0 })
  })

  await t.test('sem vínculo continua com conta ativa para solicitar matrícula', async () => {
    await db.query('DELETE FROM public.turma_alunos WHERE aluno_id=$1', [fixture.aluno])
    assert.deepEqual(await readIngreso(), { fase: 'SEM_MATRICULA', acesso_liberado: false, matriculas_pendentes: 0 })
    const { rows } = await db.query<{ situacao: string }>('SELECT situacao FROM public.perfis WHERE id=$1', [fixture.aluno])
    assert.equal(rows[0].situacao, 'ATIVO')
  })

  let matriculaId: string
  await t.test('solicitação real fica pendente e não libera o ingresso', async () => {
    const { rows } = await db.query<{ codigo_ingresso: string }>('SELECT codigo_ingresso FROM public.turmas WHERE id=$1', [fixture.turmaId])
    matriculaId = (await fixture.queryAs<{ matricula: { id: string } }>(fixture.aluno,
      'SELECT public.solicitar_matricula($1) AS matricula', [rows[0].codigo_ingresso])).rows[0].matricula.id
    assert.deepEqual(await readIngreso(), { fase: 'PENDENTE', acesso_liberado: false, matriculas_pendentes: 1 })
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [fixture.turmaId])
    assert.equal((await readIngreso()).fase, 'SEM_MATRICULA')
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [fixture.turmaId])
    assert.equal((await readIngreso()).fase, 'PENDENTE')
  })

  await t.test('aprovação pelo professor libera sem mudar o estado da conta', async () => {
    await fixture.queryAs(fixture.professor, 'SELECT public.aprovar_matricula($1)', [matriculaId])
    assert.equal((await readIngreso()).acesso_liberado, true)
  })

  async function availableAssessments() {
    return (await fixture.queryAs<{ avaliacoes: unknown[] }>(fixture.aluno,
      'SELECT public.listar_minhas_avaliacoes() AS avaliacoes')).rows[0].avaliacoes
  }

  await t.test('turma encerrada preserva ingresso e histórico, sem liberar prova da turma inativa', async () => {
    assert.equal((await availableAssessments()).length, 1)
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [fixture.turmaId])
    assert.equal((await readIngreso()).fase, 'LIBERADO')
    assert.deepEqual(await availableAssessments(), [])
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [fixture.turmaId])
  })

  await t.test('matrícula aprovada e depois inativa preserva ingresso, sem liberar novas provas do vínculo', async () => {
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE id=$1", [matriculaId])
    assert.equal((await readIngreso()).acesso_liberado, true)
    assert.deepEqual(await availableAssessments(), [])
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE id=$1", [matriculaId])
    assert.equal((await availableAssessments()).length, 1)
  })

  await t.test('vínculo de outro aluno não libera o ingresso e não aparece na resposta', async () => {
    const otherAluno = randomUUID()
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [otherAluno, `${otherAluno}@example.test`])
    await db.query("UPDATE public.perfis SET situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [fixture.org, otherAluno])
    const otherSession = randomUUID()
    fixture.sessions.set(otherAluno, otherSession)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [otherSession, otherAluno])
    const ingresso = (await fixture.queryAs<{ ingresso: object }>(otherAluno, sql)).rows[0].ingresso
    assert.deepEqual(ingresso, { fase: 'SEM_MATRICULA', acesso_liberado: false, matriculas_pendentes: 0 })
  })

  await t.test('turma de organização diferente não libera', async () => {
    const otherOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Outra escola','987654321098765432109')", [otherOrg])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [otherOrg, fixture.aluno])
    assert.equal((await readIngreso()).acesso_liberado, false)
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [fixture.org, fixture.aluno])
  })

  await t.test('professor e ADMIN não consultam este recurso discente', async () => {
    for (const id of [fixture.professor, fixture.admin]) {
      await assert.rejects(fixture.queryAs(id, sql), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '42501'))
    }
  })

  await t.test('MFA insuficiente e sessão removida são recusados', async () => {
    await assert.rejects(fixture.queryAs(fixture.aluno, sql, [], 'aal1'), /Ingresso exige/)
    await db.query('DELETE FROM auth.sessions WHERE user_id=$1', [fixture.aluno])
    await assert.rejects(readIngreso(), /Ingresso exige/)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [fixture.sessions.get(fixture.aluno), fixture.aluno])
  })

  await t.test('conta ou organização inativa não chega ao painel acadêmico', async () => {
    await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [fixture.aluno])
    await assert.rejects(readIngreso(), /Ingresso exige/)
    await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [fixture.aluno])
    await db.query("UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", [fixture.org])
    await assert.rejects(readIngreso(), /Ingresso exige/)
  })

  await t.test('anon não executa a função', async () => {
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE anon')
      return tx.query(sql)
    }), /permission denied/)
  })
})
