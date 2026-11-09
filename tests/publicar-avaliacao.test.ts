import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'
import { createPublicarAvaliacaoHandler } from '../api/publicar-avaliacao.ts'
import { createAvaliacoesHandler } from '../api/avaliacoes.ts'

test('publicação: API integrada às regras e à auditoria no PostgreSQL local', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, colega, aluno, admin, sessions, queryAs, turmaId, avaliacaoId } = await prepararBancoAvaliacoes(db)
  const migration = await readFile(new URL('../database/023_publicar_avaliacao.sql', import.meta.url), 'utf8')
  const original = (await db.query<Record<string, unknown>>('SELECT * FROM public.avaliacoes WHERE id=$1', [avaliacaoId])).rows[0]
  await db.exec(migration)
  const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
  const publicarSql = 'SELECT public.publicar_avaliacao($1) AS avaliacao'
  const events = async () => (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
  async function estado(id: string) {
    return (await db.query<{ situacao: string; publicada_em: Date | null }>('SELECT situacao,publicada_em FROM public.avaliacoes WHERE id=$1', [id])).rows[0]
  }
  async function criarAvaliacao(tipo = 'PROVA') {
    return (await queryAs<{ avaliacao: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Avaliação para publicação',$2,now()+interval '1 day',now()+interval '1 day 2 hours',60
    ) AS avaliacao`, [turmaId, tipo])).rows[0].avaliacao.id
  }
  async function criarQuestao(id: string, tipo = 'OBJETIVA') {
    return (await queryAs<{ questao: { id: string } }>(professor,
      "SELECT public.criar_questao_rascunho($1,$2,'Questão de teste',2.5) AS questao", [id, tipo])).rows[0].questao.id
  }
  async function completarObjetiva(id: string) {
    const questao = await criarQuestao(id)
    await queryAs(professor, "SELECT public.criar_alternativas_rascunho($1,ARRAY['Resposta A','Resposta B'],2)", [questao])
    return questao
  }
  function request(payload: unknown, method = 'POST', query = '') {
    return new Request(`http://localhost/api/publicar-avaliacao${query}`, {
      method, headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
      body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(payload),
    })
  }
  // Apenas HTTP/Auth são simulados; a função, as permissões e a transação são reais no PGlite.
  function apiFor(id: string, aal = 'aal2') {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      assert.equal(req.headers.get('apikey'), 'public-test-key')
      assert.equal(req.headers.get('authorization'), 'Bearer test-session')
      if (url.pathname === '/auth/v1/user') return Response.json({ id, app_metadata: {}, user_metadata: {} })
      try {
        if (url.pathname === '/rest/v1/perfis') {
          assert.equal(url.searchParams.get('id'), `eq.${id}`)
          return Response.json((await queryAs(id, 'SELECT perfil,situacao FROM public.perfis WHERE id=$1', [id], aal)).rows)
        }
        if (url.pathname === '/rest/v1/turmas') {
          return Response.json((await queryAs(id, 'SELECT id FROM public.turmas WHERE id=$1', [url.searchParams.get('id')?.slice(3)], aal)).rows)
        }
        if (url.pathname === '/rest/v1/avaliacoes') {
          const publicadas = url.searchParams.get('situacao') === 'in.(PUBLICADA,CANCELADA)'
          assert.equal(url.searchParams.get('select'), 'id,turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos,situacao,criado_em' + (publicadas ? ',publicada_em,cancelada_em' : ''))
          assert.equal(url.searchParams.get('order'), `${publicadas ? 'publicada_em' : 'criado_em'}.desc,id.desc`)
          assert.equal(url.searchParams.get('limit'), '50')
          return Response.json((await queryAs(id, `SELECT * FROM public.avaliacoes WHERE turma_id=$1 AND situacao=ANY($2::text[])
            ORDER BY ${publicadas ? 'publicada_em' : 'criado_em'} DESC,id DESC LIMIT 50`,
          [url.searchParams.get('turma_id')?.slice(3), publicadas ? ['PUBLICADA', 'CANCELADA'] : ['RASCUNHO']], aal)).rows)
        }
        assert.equal(url.pathname, '/rest/v1/rpc/publicar_avaliacao')
        assert.equal(req.method, 'POST')
        const params: Record<string, unknown> = await req.json()
        assert.deepEqual(Object.keys(params), ['p_avaliacao_id'])
        return Response.json((await queryAs<{ avaliacao: unknown }>(id, publicarSql, [params.p_avaliacao_id], aal)).rows[0].avaliacao)
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'Detalhe interno' }, { status: 400 })
      }
    })
    return { transport, handler: createPublicarAvaliacaoHandler(env, transport), listagem: createAvaliacoesHandler(env, transport) }
  }

  await t.test('migração preserva rascunhos; publica prova mista e atividade dissertativa uma única vez', async () => {
    assert.deepEqual((await db.query('SELECT * FROM public.avaliacoes WHERE id=$1', [avaliacaoId])).rows[0], { ...original, publicada_em: null })
    for (const tipo of ['PROVA', 'ATIVIDADE']) {
      const id = await criarAvaliacao(tipo)
      if (tipo === 'PROVA') await completarObjetiva(id)
      await criarQuestao(id, 'DISSERTATIVA')
      const before = (await db.query<Record<string, unknown>>('SELECT * FROM public.avaliacoes WHERE id=$1', [id])).rows[0]
      const response = await apiFor(professor).handler.fetch(request({ avaliacao_id: id.toUpperCase() }))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const result = (await response.json()).avaliacao
      assert.deepEqual(Object.keys(result).sort(), ['id', 'publicada_em', 'situacao'])
      assert.equal(result.id, id); assert.equal(result.situacao, 'PUBLICADA')
      assert.ok(Number.isFinite(Date.parse(result.publicada_em)))
      assert.deepEqual((await db.query('SELECT * FROM public.avaliacoes WHERE id=$1', [id])).rows[0],
        { ...before, situacao: 'PUBLICADA', publicada_em: new Date(result.publicada_em) })
      const audit = await db.query("SELECT usuario_id,evento,acao,recurso_id FROM public.eventos_seguranca WHERE recurso_id=$1 AND evento='AVALIACAO_PUBLICADA'", [id])
      assert.deepEqual(audit.rows, [{ usuario_id: professor, evento: 'AVALIACAO_PUBLICADA', acao: 'publicar_avaliacao', recurso_id: id }])
      const logged = await events()
      assert.equal((await apiFor(professor).handler.fetch(request({ avaliacao_id: id }))).status, 409)
      assert.deepEqual(await events(), logged)
      assert.deepEqual(await estado(id), { situacao: 'PUBLICADA', publicada_em: new Date(result.publicada_em) })
    }
  })

  await t.test('recusa avaliação vazia e objetiva com conjunto incompleto, repetido, sem gabarito ou fora de ordem', async () => {
    const id = await criarAvaliacao()
    const { handler } = apiFor(professor)
    assert.equal((await handler.fetch(request({ avaliacao_id: id }))).status, 400)
    const q = await criarQuestao(id)
    // Dados incompletos simulam importações manuais; a publicação deve recusá-los também.
    for (const alternativas of [[], [['A', 1, true]], [['A', 1, false], ['B', 2, false]],
      [['A', 1, true], ['A', 2, false]], [['A', 2, true], ['B', 3, false]]]) {
      await db.query('DELETE FROM public.alternativas WHERE questao_id=$1', [q])
      for (const [texto, ordem, correta] of alternativas) {
        await db.query('INSERT INTO public.alternativas(questao_id,texto,ordem,correta) VALUES ($1,$2,$3,$4)', [q, texto, ordem, correta])
      }
      const before = await events()
      assert.equal((await handler.fetch(request({ avaliacao_id: id }))).status, 400)
      assert.deepEqual(await estado(id), { situacao: 'RASCUNHO', publicada_em: null })
      assert.deepEqual(await events(), before)
    }
    await db.query('DELETE FROM public.alternativas WHERE questao_id=$1', [q])
    await queryAs(professor, "SELECT public.criar_alternativas_rascunho($1,ARRAY['A','B','C','D','E'],5)", [q])
    const dissertativa = await criarQuestao(id, 'DISSERTATIVA')
    await db.query("INSERT INTO public.alternativas(questao_id,texto,ordem,correta) VALUES ($1,'Indevida',1,true)", [dissertativa])
    assert.equal((await handler.fetch(request({ avaliacao_id: id }))).status, 400)
    await db.query('DELETE FROM public.alternativas WHERE questao_id=$1', [dissertativa])
    assert.equal((await handler.fetch(request({ avaliacao_id: id }))).status, 200)
  })

  await t.test('valida janela pelo relógio do banco; duração deve caber no intervalo', async () => {
    const id = await criarAvaliacao()
    await criarQuestao(id, 'DISSERTATIVA')
    await db.query("UPDATE public.avaliacoes SET inicio_em=now()-interval '2 hours',fim_em=now()-interval '1 hour' WHERE id=$1", [id])
    await assert.rejects(queryAs(professor, publicarSql, [id]), { code: '23514' })
    await db.query("UPDATE public.avaliacoes SET inicio_em=now()+interval '1 day',fim_em=now()+interval '1 day 30 minutes' WHERE id=$1", [id])
    await assert.rejects(queryAs(professor, publicarSql, [id]), { code: '23514' })
    assert.deepEqual(await estado(id), { situacao: 'RASCUNHO', publicada_em: null })
    await db.query("UPDATE public.avaliacoes SET inicio_em=now()-interval '30 minutes',fim_em=now()+interval '30 minutes' WHERE id=$1", [id])
    assert.equal((await apiFor(professor).handler.fetch(request({ avaliacao_id: id }))).status, 200)
  })

  await t.test('autoria, perfil, organização, turma, sessão e MFA são exigidos inclusive por RPC direta', async () => {
    const id = await criarAvaliacao()
    await completarObjetiva(id)
    const before = await events()
    for (const user of [admin, aluno]) {
      assert.equal((await apiFor(user).handler.fetch(request({ avaliacao_id: id }))).status, 403)
      await assert.rejects(queryAs(user, publicarSql, [id]), { code: '42501' })
    }
    const other = await apiFor(colega).handler.fetch(request({ avaliacao_id: id }))
    const missing = await apiFor(professor).handler.fetch(request({ avaliacao_id: randomUUID() }))
    assert.equal(other.status, 404); assert.equal(missing.status, 404)
    assert.deepEqual(await other.json(), await missing.json())
    await assert.rejects(queryAs(colega, publicarSql, [id]), { code: 'P0002' })
    await assert.rejects(queryAs(professor, publicarSql, [null]), { code: 'P0002' })
    assert.equal((await apiFor(professor, 'aal1').handler.fetch(request({ avaliacao_id: id }))).status, 403)
    await assert.rejects(queryAs(professor, publicarSql, [id], 'aal1'), { code: '42501' })
    const session = sessions.get(professor)!
    for (const invalid of [randomUUID(), sessions.get(colega)!]) {
      sessions.set(professor, invalid)
      assert.equal((await apiFor(professor).handler.fetch(request({ avaliacao_id: id }))).status, 403)
      await assert.rejects(queryAs(professor, publicarSql, [id]), { code: '42501' })
    }
    sessions.set(professor, session)
    for (const [table, target] of [['perfis', professor], ['organizacoes', org]]) {
      await db.query(`UPDATE public.${table} SET situacao='INATIVO' WHERE id=$1`, [target])
      assert.equal((await apiFor(professor).handler.fetch(request({ avaliacao_id: id }))).status, 403)
      await assert.rejects(queryAs(professor, publicarSql, [id]), { code: '42501' })
      await db.query(`UPDATE public.${table} SET situacao='ATIVO' WHERE id=$1`, [target])
    }
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    assert.equal((await apiFor(professor).handler.fetch(request({ avaliacao_id: id }))).status, 409)
    await db.query("UPDATE public.turmas SET situacao='ATIVA',professor_id=$1 WHERE id=$2", [colega, turmaId])
    for (const user of [professor, colega]) await assert.rejects(queryAs(user, publicarSql, [id]), { code: 'P0002' })
    await db.query('UPDATE public.turmas SET professor_id=$1 WHERE id=$2', [professor, turmaId])
    const orgOutra = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Outra escola','OUTRA-ESCOLA-TESTE')", [orgOutra])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [orgOutra, professor])
    await assert.rejects(queryAs(professor, publicarSql, [id]), { code: 'P0002' })
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, professor])
    assert.deepEqual(await estado(id), { situacao: 'RASCUNHO', publicada_em: null })
    assert.deepEqual(await events(), before)
  })

  await t.test('publicação bloqueia mudanças na estrutura e mantém o gabarito inacessível ao aluno', async () => {
    const id = await criarAvaliacao()
    const q = await completarObjetiva(id)
    await queryAs(professor, publicarSql, [id])
    const before = await events()
    await assert.rejects(queryAs(professor, `SELECT public.editar_avaliacao_rascunho(
      $1,'Alterada','ATIVIDADE',now()+interval '2 days',now()+interval '3 days',30)`, [id]), { code: '55000' })
    await assert.rejects(criarQuestao(id), { code: '55000' })
    await assert.rejects(queryAs(professor, "SELECT public.criar_alternativas_rascunho($1,ARRAY['C','D'],1)", [q]), { code: '55000' })
    for (const user of [professor, admin, aluno]) {
      for (const sql of ["UPDATE public.avaliacoes SET titulo='Alterada' WHERE id=$1",
        "UPDATE public.avaliacoes SET situacao='RASCUNHO',publicada_em=NULL WHERE id=$1", 'DELETE FROM public.avaliacoes WHERE id=$1']) {
        await assert.rejects(queryAs(user, sql, [id]), { code: '42501' })
      }
      await assert.rejects(queryAs(user, 'UPDATE public.questoes SET pontuacao=9 WHERE id=$1', [q]), { code: '42501' })
      await assert.rejects(queryAs(user, 'UPDATE public.alternativas SET correta=false WHERE questao_id=$1', [q]), { code: '42501' })
    }
    for (const user of [aluno, colega]) {
      assert.deepEqual((await queryAs(user, 'SELECT * FROM public.avaliacoes WHERE id=$1', [id])).rows, [])
      assert.deepEqual((await queryAs(user, 'SELECT * FROM public.questoes WHERE avaliacao_id=$1', [id])).rows, [])
      assert.deepEqual((await queryAs(user, 'SELECT * FROM public.alternativas WHERE questao_id=$1', [q])).rows, [])
    }
    for (const user of [professor, admin]) {
      assert.equal((await queryAs(user, 'SELECT id FROM public.avaliacoes WHERE id=$1', [id])).rows.length, 1)
      assert.deepEqual((await queryAs(user, "SELECT id FROM public.avaliacoes WHERE id=$1 AND situacao='RASCUNHO'", [id])).rows, [])
    }
    assert.deepEqual(await events(), before)
  })

  await t.test('falha da auditoria desfaz publicação; perda da resposta não repete a transação', async () => {
    const id = await criarAvaliacao()
    await criarQuestao(id, 'DISSERTATIVA')
    const before = await events()
    await db.exec(`CREATE FUNCTION public.falhar_publicacao() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN IF NEW.evento='AVALIACAO_PUBLICADA' THEN RAISE EXCEPTION 'Detalhe interno'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER falhar_publicacao BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_publicacao();`)
    const failed = await apiFor(professor).handler.fetch(request({ avaliacao_id: id }))
    assert.equal(failed.status, 503)
    assert.equal(JSON.stringify(await failed.json()).includes('Detalhe interno'), false)
    assert.deepEqual(await estado(id), { situacao: 'RASCUNHO', publicada_em: null })
    assert.deepEqual(await events(), before)
    await db.exec('DROP TRIGGER falhar_publicacao ON public.eventos_seguranca; DROP FUNCTION public.falhar_publicacao();')
    const { transport } = apiFor(professor)
    let chamadasRpc = 0
    const handler = createPublicarAvaliacaoHandler(env, async (input, init) => {
      const response = await transport(input, init)
      if (new Request(input, init).url.includes('/rpc/')) { chamadasRpc++; throw new Error('Resposta perdida') }
      return response
    })
    assert.equal((await handler.fetch(request({ avaliacao_id: id }))).status, 503)
    assert.equal(chamadasRpc, 1)
    assert.equal((await estado(id)).situacao, 'PUBLICADA')
    assert.equal((await apiFor(professor).handler.fetch(request({ avaliacao_id: id }))).status, 409)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE recurso_id=$1 AND evento='AVALIACAO_PUBLICADA'", [id])).rows.length, 1)
  })

  await t.test('entrada inválida é recusada antes de acessar Auth ou banco', async () => {
    const { handler, transport } = apiFor(professor)
    for (const payload of [null, [], {}, 'texto', { avaliacao_id: 1 }, { avaliacao_id: 'inválido' },
      { avaliacao_id: avaliacaoId, professor_id: professor }, { avaliacao_id: avaliacaoId, situacao: 'PUBLICADA' }]) {
      assert.equal((await handler.fetch(request(payload))).status, 400)
    }
    assert.equal((await handler.fetch(request({ avaliacao_id: avaliacaoId }, 'POST', '?extra=1'))).status, 400)
    const noToken = request({ avaliacao_id: avaliacaoId }); noToken.headers.delete('Authorization')
    assert.equal((await handler.fetch(noToken)).status, 401)
    const badType = request({ avaliacao_id: avaliacaoId }); badType.headers.set('Content-Type', 'text/plain')
    assert.equal((await handler.fetch(badType)).status, 415)
    assert.equal((await handler.fetch(new Request('http://localhost/api/publicar-avaliacao', {
      method: 'POST', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }, body: '{',
    }))).status, 400)
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await handler.fetch(request({}, method))
      assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST')
    }
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('não confirma publicação com falha de Auth, perfil ou resposta inválida do banco', async () => {
    const body = { avaliacao_id: avaliacaoId }
    for (const [status, expected] of [[401, 401], [403, 401], [429, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'Detalhe interno' }, { status }))
      assert.equal((await createPublicarAvaliacaoHandler(env, transport).fetch(request(body))).status, expected)
      assert.equal(transport.mock.callCount(), 1)
    }
    assert.equal((await createPublicarAvaliacaoHandler({}).fetch(request(body))).status, 503)
    const valid = { id: avaliacaoId, situacao: 'PUBLICADA', publicada_em: '2026-11-05T20:00:00Z' }
    const cases: [string, unknown, number, number][] = [
      ['perfis', [], 200, 403], ['perfis', { code: 'XX000' }, 500, 503],
      ...[null, [], {}, { ...valid, id: randomUUID() }, { ...valid, situacao: 'RASCUNHO' },
        { ...valid, publicada_em: null }, { ...valid, publicada_em: '2026-02-30T12:00:00Z' }]
        .map((value): [string, unknown, number, number] => ['rpc/publicar_avaliacao', value, 200, 503]),
    ]
    for (const [route, value, status, expected] of cases) {
      const { transport } = apiFor(professor)
      const handler = createPublicarAvaliacaoHandler(env, (input, init) => new Request(input, init).url.includes(`/rest/v1/${route}`)
        ? Promise.resolve(Response.json(value, { status })) : transport(input, init))
      assert.equal((await handler.fetch(request(body))).status, expected)
    }
  })

  function consultar(situacao = 'PUBLICADA', turma = turmaId) {
    return new Request(`http://localhost/api/avaliacoes?turma_id=${turma}&situacao=${situacao}`, { headers: { Authorization: 'Bearer test-session' } })
  }

  await t.test('professor e admin consultam publicadas por turma; mantém isolamento e filtro de rascunhos', async () => {
    const logged = await events()
    const expected = (await db.query("SELECT id FROM public.avaliacoes WHERE turma_id=$1 AND situacao='PUBLICADA' ORDER BY publicada_em DESC,id DESC LIMIT 50", [turmaId])).rows
    assert.ok(expected.length > 1)
    for (const user of [professor, admin]) {
      const response = await apiFor(user).listagem.fetch(consultar())
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const result = await response.json()
      assert.equal(result.limite, 50)
      assert.deepEqual(result.avaliacoes.map((item: { id: string }) => ({ id: item.id })), expected)
      for (const item of result.avaliacoes) {
        assert.equal(item.situacao, 'PUBLICADA')
        assert.ok(Number.isFinite(Date.parse(item.publicada_em)))
        assert.equal('questoes' in item || 'correta' in item, false)
      }
      const drafts = await apiFor(user).listagem.fetch(consultar('RASCUNHO'))
      assert.equal(drafts.status, 200)
      assert.ok((await drafts.json()).avaliacoes.every((item: { situacao: string }) => item.situacao === 'RASCUNHO'))
    }
    assert.equal((await apiFor(aluno).listagem.fetch(consultar())).status, 403)
    assert.equal((await apiFor(professor, 'aal1').listagem.fetch(consultar())).status, 403)
    assert.equal((await apiFor(colega).listagem.fetch(consultar())).status, 404)
    assert.equal((await apiFor(professor).listagem.fetch(consultar('PUBLICADA', randomUUID()))).status, 404)
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    assert.equal((await apiFor(professor).listagem.fetch(consultar())).status, 200)
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [turmaId])
    assert.deepEqual(await events(), logged)
  })

  await t.test('consulta vazia, limite de 50 e ordenação por publicação com desempate por ID', async () => {
    const turma = (await queryAs<{ id: string }>(professor, "INSERT INTO public.turmas(nome) VALUES ('Turma da listagem') RETURNING id")).rows[0].id
    const { listagem } = apiFor(professor)
    assert.deepEqual(await (await listagem.fetch(consultar('PUBLICADA', turma))).json(), { avaliacoes: [], limite: 50 })
    // Massa local de listagem, com criação em ordem inversa à publicação.
    await db.query(`INSERT INTO public.avaliacoes(turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos,situacao,publicada_em,criado_em)
      SELECT $1,$2,'Publicada '||n,'PROVA',now(),now()+interval '2 hours',60,'PUBLICADA',
        now()+make_interval(mins => n / 2),now()-make_interval(mins => n) FROM generate_series(1,51) AS n`, [turma, professor])
    const response = await listagem.fetch(consultar('PUBLICADA', turma))
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.avaliacoes.length, 50)
    const expected = (await db.query("SELECT id FROM public.avaliacoes WHERE turma_id=$1 ORDER BY publicada_em DESC,id DESC LIMIT 50", [turma])).rows
    assert.deepEqual(result.avaliacoes.map((item: { id: string }) => ({ id: item.id })), expected)
  })

  await t.test('consulta recusa filtros e respostas inválidas sem tratar falha como lista vazia', async () => {
    const { listagem, transport } = apiFor(professor)
    for (const query of [`turma_id=${turmaId}&situacao=CANCELADA`, `turma_id=${turmaId}&situacao=`,
      `turma_id=${turmaId}&situacao=PUBLICADA&situacao=RASCUNHO`, `turma_id=${turmaId}&turma_id=${turmaId}`,
      `turma_id=${turmaId}&situacao=PUBLICADA&aluno_id=${aluno}`]) {
      assert.equal((await listagem.fetch(new Request(`http://localhost/api/avaliacoes?${query}`, { headers: { Authorization: 'Bearer test-session' } }))).status, 400)
    }
    assert.equal(transport.mock.callCount(), 0)
    const sample = (await (await listagem.fetch(consultar())).json()).avaliacoes[0]
    for (const value of [null, [sample, sample], Array(51).fill(sample), [{ ...sample, turma_id: randomUUID() }],
      [{ ...sample, situacao: 'RASCUNHO' }], [{ ...sample, publicada_em: null }], [{ ...sample, publicada_em: 'inválida' }]]) {
      const handler = createAvaliacoesHandler(env, (input, init) => new Request(input, init).url.includes('/rest/v1/avaliacoes')
        ? Promise.resolve(Response.json(value)) : transport(input, init))
      assert.equal((await handler.fetch(consultar())).status, 503)
    }
    const unavailable = createAvaliacoesHandler(env, (input, init) => new Request(input, init).url.includes('/rest/v1/avaliacoes')
      ? Promise.resolve(Response.json({ message: 'Falha interna' }, { status: 500 })) : transport(input, init))
    assert.equal((await unavailable.fetch(consultar())).status, 503)
  })

  await t.test('reaplicação preserva publicações e eventos; funções seguem restritas', async () => {
    const before = (await db.query('SELECT * FROM public.avaliacoes ORDER BY id')).rows
    const logged = await events()
    await db.exec(migration)
    assert.deepEqual((await db.query('SELECT * FROM public.avaliacoes ORDER BY id')).rows, before)
    assert.deepEqual(await events(), logged)
    for (const schema of ['public', 'examentech_private']) {
      const privileges = await db.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,
        has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated`, [`${schema}.publicar_avaliacao(uuid)`])
      assert.deepEqual(privileges.rows, [{ anon: false, authenticated: true }])
    }
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE anon')
      return tx.query(publicarSql, [avaliacaoId])
    }), { code: '42501' })
  })
})
