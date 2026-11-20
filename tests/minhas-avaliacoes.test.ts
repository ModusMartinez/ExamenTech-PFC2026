import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'
import { createMinhasAvaliacoesHandler } from '../api/minhas-avaliacoes.ts'
import type { AvaliacaoAluno } from '../src/services/avaliacaoValidation.ts'

const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
const consulta = 'SELECT public.listar_minhas_avaliacoes() AS avaliacoes'
function request(query = '', method = 'GET', authorization = 'Bearer test-session') {
  return new Request(`http://localhost/api/minhas-avaliacoes${query}`, { method, headers: { authorization } })
}

test('avaliações do aluno: API integrada às permissões do PostgreSQL local', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, colega, aluno, admin, sessions, queryAs, turmaId } = await prepararBancoAvaliacoes(db)
  await db.exec(await readFile(new URL('../database/023_publicar_avaliacao.sql', import.meta.url), 'utf8'))
  const migration = await readFile(new URL('../database/024_listar_minhas_avaliacoes.sql', import.meta.url), 'utf8')
  const before = (await db.query('SELECT * FROM public.avaliacoes ORDER BY id')).rows
  await db.exec(migration)

  async function turma(owner: string) {
    return (await queryAs<{ id: string }>(owner, "INSERT INTO public.turmas(nome) VALUES ('Outra turma') RETURNING id")).rows[0].id
  }
  async function publicar(turma: string, owner: string) {
    const id = (await queryAs<{ avaliacao: { id: string } }>(owner, `SELECT public.criar_avaliacao_rascunho(
      $1,'Prova publicada','PROVA',now()+interval '1 day',now()+interval '2 days',60
    ) AS avaliacao`, [turma])).rows[0].avaliacao.id
    const questao = (await queryAs<{ questao: { id: string } }>(owner,
      "SELECT public.criar_questao_rascunho($1,'OBJETIVA','Questão restrita',2) AS questao", [id])).rows[0].questao.id
    await queryAs(owner, "SELECT public.criar_alternativas_rascunho($1,ARRAY['Resposta A','Resposta B'],1)", [questao])
    await queryAs(owner, 'SELECT public.publicar_avaliacao($1)', [id])
    return id
  }
  // Auth/HTTP simulados; funções SQL, sessão, permissões e RLS executadas no banco local.
  function apiFor(id: string, aal = 'aal2') {
    return createMinhasAvaliacoesHandler(env, async (input, init) => {
      const req = new Request(input, init)
      assert.equal(req.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(req.headers.get('authorization'), 'Bearer test-session')
      if (new URL(req.url).pathname === '/auth/v1/user') return Response.json({ id })
      assert.equal(new URL(req.url).pathname, '/rest/v1/rpc/listar_minhas_avaliacoes')
      assert.equal(req.method, 'POST')
      assert.deepEqual(await req.json(), {})
      try {
        return Response.json((await queryAs<{ avaliacoes: unknown }>(id, consulta, [], aal)).rows[0].avaliacoes)
      } catch (error) {
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'Detalhe interno' }, { status: 400 })
      }
    })
  }
  async function listar(id = aluno) {
    const response = await apiFor(id).fetch(request())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const result: { avaliacoes: AvaliacaoAluno[] } = await response.json()
    return result.avaliacoes
  }

  await t.test('migração reaplicável preserva os dados e retorna lista vazia sem publicações', async () => {
    await db.exec(migration)
    assert.deepEqual((await db.query('SELECT * FROM public.avaliacoes ORDER BY id')).rows, before)
    assert.deepEqual(await listar(), [])
  })

  const propria = await publicar(turmaId, professor)
  const segundaTurma = await turma(professor), turmaAlheia = await turma(colega)
  await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [segundaTurma, aluno])
  const segunda = await publicar(segundaTurma, professor), alheia = await publicar(turmaAlheia, colega)
  const outroAluno = randomUUID()
  await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [outroAluno, 'outro@example.test'])
  await db.query("UPDATE public.perfis SET situacao='ATIVO',organizacao_id=$1 WHERE id=$2", [org, outroAluno])
  sessions.set(outroAluno, randomUUID())
  await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessions.get(outroAluno), outroAluno])
  await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaAlheia, outroAluno])

  await t.test('lista somente publicadas das próprias turmas e separa os alunos', async () => {
    const eventos = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
    const itens = await listar()
    assert.deepEqual(new Set(itens.map((a) => a.id)), new Set([propria, segunda]))
    assert.deepEqual((await listar(outroAluno)).map((a) => a.id), [alheia])
    for (const item of itens) {
      assert.deepEqual(Object.keys(item).sort(), ['duracao_minutos', 'fim_em', 'id', 'inicio_em', 'publicada_em', 'situacao', 'tipo', 'titulo', 'turma_id', 'turma_nome'])
      assert.equal(item.situacao, 'PUBLICADA')
    }
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, eventos)
    for (const table of ['avaliacoes', 'questoes', 'alternativas']) {
      assert.deepEqual((await queryAs(aluno, `SELECT * FROM public.${table}`)).rows, [])
    }
  })

  await t.test('matrícula pendente/inativa, turma inativa e organização diferente retiram o acesso', async () => {
    for (const situacao of ['PENDENTE', 'INATIVA']) {
      await db.query('UPDATE public.turma_alunos SET situacao=$1 WHERE turma_id=$2 AND aluno_id=$3', [situacao, turmaId, aluno])
      assert.deepEqual((await listar()).map((a) => a.id), [segunda])
    }
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    assert.deepEqual((await listar()).map((a) => a.id), [segunda])
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [turmaId])
    const outraOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Outra escola','outra-escola-teste')", [outraOrg])
    await db.query('UPDATE public.turmas SET organizacao_id=$1 WHERE id=$2', [outraOrg, turmaId])
    assert.deepEqual((await listar()).map((a) => a.id), [segunda])
    await db.query('UPDATE public.turmas SET organizacao_id=$1 WHERE id=$2', [org, turmaId])
  })

  await t.test('recusa professor/admin, perfil/organização inativos, AAL1 e sessão ausente ou alheia', async () => {
    for (const id of [professor, admin]) assert.equal((await apiFor(id).fetch(request())).status, 403)
    assert.equal((await apiFor(aluno, 'aal1').fetch(request())).status, 403)
    for (const table of ['perfis', 'organizacoes']) {
      const id = table === 'perfis' ? aluno : org
      await db.query(`UPDATE public.${table} SET situacao='INATIVO' WHERE id=$1`, [id])
      assert.equal((await apiFor(aluno).fetch(request())).status, 403)
      await db.query(`UPDATE public.${table} SET situacao='ATIVO' WHERE id=$1`, [id])
    }
    const ownSession = sessions.get(aluno)!
    for (const session of [randomUUID(), sessions.get(professor)!]) {
      sessions.set(aluno, session)
      assert.equal((await apiFor(aluno).fetch(request())).status, 403)
    }
    sessions.delete(aluno)
    assert.equal((await apiFor(aluno).fetch(request())).status, 403)
    sessions.set(aluno, ownSession)
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [ownSession])
    assert.equal((await apiFor(aluno).fetch(request())).status, 403)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [ownSession, aluno])
    for (const schema of ['public', 'examentech_private']) {
      await assert.rejects(db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE anon')
        await tx.query(`SELECT ${schema}.listar_minhas_avaliacoes()`)
      }), { code: '42501' })
      await assert.rejects(queryAs(randomUUID(), `SELECT ${schema}.listar_minhas_avaliacoes()`), { code: '42501' })
    }
  })

  await t.test('inclui avaliações encerradas; limita às 50 publicações mais recentes com desempate por ID', async () => {
    await db.query("UPDATE public.avaliacoes SET inicio_em=now()-interval '2 days',fim_em=now()-interval '1 day' WHERE id=$1", [propria])
    assert.ok((await listar()).some((a) => a.id === propria))
    await db.query(`INSERT INTO public.avaliacoes(turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos,situacao,publicada_em)
      SELECT $1,$2,'Publicação ' || n,'ATIVIDADE',now(),now()+interval '2 hours',30,'PUBLICADA',now()
      FROM generate_series(1,55) n`, [turmaId, professor])
    const expected = await db.query<{ id: string }>(`SELECT id FROM public.avaliacoes
      WHERE turma_id IN ($1,$2) AND situacao='PUBLICADA' ORDER BY publicada_em DESC,id DESC LIMIT 50`, [turmaId, segundaTurma])
    assert.deepEqual((await listar()).map((a) => a.id), expected.rows.map((a) => a.id))
  })
})

test('avaliações do aluno: entradas e falhas HTTP', async (t) => {
  const userId = randomUUID()
  const item = {
    id: randomUUID(), turma_id: randomUUID(), turma_nome: 'Turma A', titulo: 'Prova A', tipo: 'PROVA',
    inicio_em: '2026-11-09T19:00:00Z', fim_em: '2026-11-09T21:00:00Z', duracao_minutos: 60,
    situacao: 'PUBLICADA', publicada_em: '2026-11-05T19:00:00Z',
  }
  await t.test('recusa método, ausência de sessão e parâmetros sem chamar o Supabase', async () => {
    const transport = t.mock.fn(async () => Response.json({}))
    const handler = createMinhasAvaliacoesHandler(env, transport)
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const res = await handler.fetch(request('', method))
      assert.equal(res.status, 405); assert.equal(res.headers.get('allow'), 'GET')
    }
    assert.equal((await handler.fetch(request('', 'GET', ''))).status, 401)
    for (const query of ['?aluno_id=' + userId, '?turma_id=' + item.turma_id, '?situacao=RASCUNHO', '?pagina=1']) {
      assert.equal((await handler.fetch(request(query))).status, 400)
    }
    assert.equal((await createMinhasAvaliacoesHandler({}, transport).fetch(request())).status, 503)
    assert.equal(transport.mock.callCount(), 0)
  })
  await t.test('falha de autenticação impede a consulta e diferencia sessão inválida de indisponibilidade', async () => {
    for (const [status, expected] of [[401, 401], [403, 401], [500, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'Detalhe interno' }, { status }))
      const response = await createMinhasAvaliacoesHandler(env, transport).fetch(request())
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await response.text(), /Detalhe interno/)
      assert.equal(transport.mock.callCount(), 1)
    }
  })
  function apiWith(result: unknown, status = 200) {
    return createMinhasAvaliacoesHandler(env, async (input) => {
      if (String(input).endsWith('/auth/v1/user')) return Response.json({ id: userId })
      return Response.json(result, { status })
    })
  }
  await t.test('recusa respostas inválidas ou duplicadas e remove campos fora do contrato', async () => {
    for (const result of [null, {}, [null], [item, item], Array(51).fill(item),
      [{ ...item, id: 'inválido' }], [{ ...item, situacao: 'RASCUNHO' }], [{ ...item, turma_nome: '' }],
      [{ ...item, inicio_em: '2026-02-30T19:00:00Z' }], [{ ...item, fim_em: item.inicio_em }],
      [{ ...item, publicada_em: null }], [{ ...item, duracao_minutos: 0 }]]) {
      assert.equal((await apiWith(result).fetch(request())).status, 503)
    }
    const response = await apiWith([{ ...item, gabarito: 'A', questoes: [], professor_id: userId }]).fetch(request())
    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys((await response.json()).avaliacoes[0]).sort(), Object.keys(item).sort())
    assert.deepEqual(await (await apiWith([]).fetch(request())).json(), { avaliacoes: [] })
  })
  await t.test('falhas do banco e da rede não expõem detalhes internos', async () => {
    for (const [code, expected] of [['42501', 403], ['XX000', 503]]) {
      const response = await apiWith({ code, message: 'Detalhe interno' }, 400).fetch(request())
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await response.text(), /Detalhe interno/)
    }
    const broken = createMinhasAvaliacoesHandler(env, async (input) => {
      if (String(input).endsWith('/auth/v1/user')) return Response.json({ id: userId })
      throw new Error('Detalhe interno')
    })
    const response = await broken.fetch(request())
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /Detalhe interno/)
  })
})
