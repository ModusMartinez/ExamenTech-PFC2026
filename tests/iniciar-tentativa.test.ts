import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'
import { createIniciarTentativaHandler } from '../api/iniciar-tentativa.ts'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments.ts'

const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
function request(body: unknown, method = 'POST', query = '') {
  const payload = body && typeof body === 'object' && !Array.isArray(body) && 'avaliacao_id' in body &&
    !('aviso_versao' in body) ? { ...body, aviso_versao: EXAM_NOTICE_VERSION } : body
  return new Request(`http://localhost/api/iniciar-tentativa${query}`, {
    method, headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
    body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(payload),
  })
}

test('API de início integrada às regras, ao aviso e ao sorteio das queries até 037', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, aluno, admin, sessions, queryAs, turmaId, avaliacaoId } = await prepararBancoCamera(db)
  await db.exec(await readFile(new URL('../database/037_camera_sem_interrupcao.sql', import.meta.url), 'utf8'))
  async function publicar() {
    const id = (await queryAs<{ avaliacao: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Prova para início','PROVA',now()-interval '5 minutes',now()+interval '2 hours',60
    ) AS avaliacao`, [turmaId])).rows[0].avaliacao.id
    await queryAs(professor, "SELECT public.criar_questao_rascunho($1,'DISSERTATIVA','Questão de teste',2)", [id])
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [id])
    return id
  }
  function apiFor(usuario = aluno, aal = 'aal2') {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      assert.equal(req.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(req.headers.get('authorization'), 'Bearer test-session')
      if (new URL(req.url).pathname === '/auth/v1/user') return Response.json({ id: usuario })
      assert.equal(new URL(req.url).pathname, '/rest/v1/rpc/iniciar_tentativa')
      assert.equal(req.method, 'POST')
      const params: Record<string, unknown> = await req.json()
      assert.deepEqual(Object.keys(params), ['p_avaliacao_id', 'p_aviso_versao'])
      try {
        const result = await queryAs<{ tentativa: unknown }>(usuario, 'SELECT public.iniciar_tentativa($1,$2) AS tentativa',
          [params.p_avaliacao_id, params.p_aviso_versao], aal)
        return Response.json(result.rows[0].tentativa)
      } catch (error) {
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'Detalhe interno' }, { status: 400 })
      }
    })
    return { transport, handler: createIniciarTentativaHandler(env, transport) }
  }
  const publicada = await publicar()
  await t.test('retorna 201 com metadados da própria tentativa; repetição retorna 409 sem novo evento', async () => {
    const { handler, transport } = apiFor()
    const req = request({ avaliacao_id: publicada.toUpperCase() })
    req.headers.set('Content-Type', 'Application/JSON; charset=utf-8')
    const response = await handler.fetch(req)
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { tentativa } = await response.json()
    assert.deepEqual(Object.keys(tentativa).sort(), ['aluno_id', 'avaliacao_id', 'id', 'iniciada_em', 'limite_em', 'situacao'])
    assert.equal(tentativa.aluno_id, aluno)
    assert.equal(tentativa.avaliacao_id, publicada)
    assert.equal(tentativa.situacao, 'EM_ANDAMENTO')
    assert.equal((await db.query<{ aviso_versao: string }>('SELECT aviso_versao FROM public.tentativas WHERE id=$1', [tentativa.id])).rows[0].aviso_versao, EXAM_NOTICE_VERSION)
    assert.equal(Date.parse(tentativa.limite_em) - Date.parse(tentativa.iniciada_em), 3600000)
    assert.equal(transport.mock.callCount(), 2)
    const original = (await db.query('SELECT * FROM public.tentativas WHERE id=$1', [tentativa.id])).rows
    const eventos = (await db.query('SELECT * FROM public.eventos_seguranca WHERE recurso_id=$1', [tentativa.id])).rows
    const questoes = (await db.query<{ ordem: number }>('SELECT * FROM public.tentativa_questoes WHERE tentativa_id=$1', [tentativa.id])).rows
    assert.equal(questoes.length, 1)
    assert.equal(questoes[0].ordem, 1)
    assert.equal(eventos.length, 1)
    assert.equal((await handler.fetch(request({ avaliacao_id: publicada }))).status, 409)
    assert.deepEqual((await db.query('SELECT * FROM public.tentativas WHERE id=$1', [tentativa.id])).rows, original)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca WHERE recurso_id=$1', [tentativa.id])).rows, eventos)
    assert.deepEqual((await db.query('SELECT * FROM public.tentativa_questoes WHERE tentativa_id=$1', [tentativa.id])).rows, questoes)
  })

  await t.test('perfil/MFA/sessão inválidos retornam 403 e não criam tentativa', async () => {
    const id = await publicar()
    for (const usuario of [professor, admin]) assert.equal((await apiFor(usuario).handler.fetch(request({ avaliacao_id: id }))).status, 403)
    assert.equal((await apiFor(aluno, 'aal1').handler.fetch(request({ avaliacao_id: id }))).status, 403)
    const original = sessions.get(aluno)!
    sessions.set(aluno, sessions.get(professor)!)
    assert.equal((await apiFor().handler.fetch(request({ avaliacao_id: id }))).status, 403)
    sessions.set(aluno, original)
    for (const table of ['perfis', 'organizacoes']) {
      const key = table === 'perfis' ? aluno : org
      await db.query(`UPDATE public.${table} SET situacao='INATIVO' WHERE id=$1`, [key])
      assert.equal((await apiFor().handler.fetch(request({ avaliacao_id: id }))).status, 403)
      await db.query(`UPDATE public.${table} SET situacao='ATIVO' WHERE id=$1`, [key])
    }
    assert.deepEqual((await db.query('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [id])).rows, [])
  })

  await t.test('404 para avaliação inexistente ou matrícula inativa; 409 para rascunho, turma inativa e horário', async () => {
    const { handler } = apiFor()
    const id = await publicar()
    const missing = await handler.fetch(request({ avaliacao_id: randomUUID() }))
    assert.equal(missing.status, 404)
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    const denied = await handler.fetch(request({ avaliacao_id: id }))
    assert.equal(denied.status, 404)
    assert.deepEqual(await denied.json(), await missing.json())
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    assert.equal((await handler.fetch(request({ avaliacao_id: avaliacaoId }))).status, 409)
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    assert.equal((await handler.fetch(request({ avaliacao_id: id }))).status, 409)
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [turmaId])
    for (const janela of ["inicio_em=now()+interval '1 hour',fim_em=now()+interval '2 hours'", "inicio_em=now()-interval '2 hours',fim_em=now()-interval '1 hour'"]) {
      await db.query(`UPDATE public.avaliacoes SET ${janela} WHERE id=$1`, [id])
      assert.equal((await handler.fetch(request({ avaliacao_id: id }))).status, 409)
    }
    assert.deepEqual((await db.query('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [id])).rows, [])
  })

  await t.test('perda da resposta após gravar retorna 503, sem repetir a RPC nem reiniciar', async () => {
    const id = await publicar()
    const { transport } = apiFor()
    const handler = createIniciarTentativaHandler(env, async (input, init) => {
      const response = await transport(input, init)
      if (new Request(input, init).url.includes('/rpc/')) throw new TypeError('Resposta perdida')
      return response
    })
    const response = await handler.fetch(request({ avaliacao_id: id }))
    assert.equal(response.status, 503)
    assert.match((await response.json()).message, /pode ter sido criada/)
    assert.equal(transport.mock.callCount(), 2)
    const rows = (await db.query<{ id: string }>('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [id])).rows
    assert.equal(rows.length, 1)
    assert.equal((await apiFor().handler.fetch(request({ avaliacao_id: id }))).status, 409)
    assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='TENTATIVA_INICIADA' AND recurso_id=$1", [rows[0].id])).rows.length, 1)
  })
})

test('API de início: validações de entrada, identidade e resposta', async (t) => {
  const avaliacaoId = randomUUID(), alunoId = randomUUID()
  const body = { avaliacao_id: avaliacaoId }
  const valid = {
    id: randomUUID(), avaliacao_id: avaliacaoId, aluno_id: alunoId, situacao: 'EM_ANDAMENTO',
    iniciada_em: '2026-11-09T19:00:00Z', limite_em: '2026-11-09T20:00:00Z',
  }
  await t.test('rejeita entradas extras ou inválidas antes de consultar o Supabase', async () => {
    const transport = t.mock.fn(async () => Response.json({}))
    const handler = createIniciarTentativaHandler(env, transport)
    for (const entrada of [null, [], 'texto', {}, { avaliacao_id: 1 }, { avaliacao_id: 'inválido' },
      { ...body, aviso_versao: 'antigo' },
      ...['aluno_id', 'iniciada_em', 'limite_em', 'situacao'].map((key) => ({ ...body, [key]: 'forjado' }))]) {
      assert.equal((await handler.fetch(request(entrada))).status, 400)
    }
    const missingNotice = new Request('http://localhost/api/iniciar-tentativa', {
      method: 'POST', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal((await handler.fetch(missingNotice)).status, 400)
    const malformed = request(body)
    assert.equal((await handler.fetch(new Request(malformed, { body: '{' }))).status, 400)
    for (const method of ['GET', 'PATCH', 'DELETE', 'HEAD']) {
      const response = await handler.fetch(request(body, method))
      assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST')
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    const noToken = request(body); noToken.headers.delete('authorization')
    assert.equal((await handler.fetch(noToken)).status, 401)
    const invalidToken = request(body); invalidToken.headers.set('authorization', 'Bearer um dois')
    assert.equal((await handler.fetch(invalidToken)).status, 401)
    const text = request(body); text.headers.set('content-type', 'text/plain')
    assert.equal((await handler.fetch(text)).status, 415)
    assert.equal((await handler.fetch(request(body, 'POST', '?aluno_id=' + alunoId))).status, 400)
    assert.equal((await createIniciarTentativaHandler({}, transport).fetch(request(body))).status, 503)
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('sessão inválida retorna 401; falha do Auth retorna 503 sem chamar a RPC', async () => {
    for (const [status, expected] of [[400, 401], [401, 401], [403, 401], [429, 503], [500, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'Detalhe interno' }, { status }))
      const response = await createIniciarTentativaHandler(env, transport).fetch(request(body))
      assert.equal(response.status, expected)
      assert.equal(transport.mock.callCount(), 1)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await response.text(), /Detalhe interno/)
    }
    for (const user of [{}, { id: 'inválido' }]) {
      const transport = t.mock.fn(async () => Response.json(user))
      assert.equal((await createIniciarTentativaHandler(env, transport).fetch(request(body))).status, 503)
      assert.equal(transport.mock.callCount(), 1)
    }
  })

  function apiWith(result: unknown, status = 200) {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.endsWith('/auth/v1/user')) return Response.json({ id: alunoId })
      return Response.json(result, { status })
    })
    return { transport, handler: createIniciarTentativaHandler(env, transport) }
  }
  await t.test('recusa confirmação inválida, de outro aluno ou de outra avaliação', async () => {
    for (const result of [null, [], {}, { ...valid, id: 'inválido' }, { ...valid, aluno_id: randomUUID() },
      { ...valid, avaliacao_id: randomUUID() }, { ...valid, situacao: 'FINALIZADA' },
      { ...valid, iniciada_em: '2026-02-30T19:00:00Z' }, { ...valid, limite_em: null },
      { ...valid, iniciada_em: '2026-11-09T19:00:00' }, { ...valid, limite_em: valid.iniciada_em },
      { ...valid, limite_em: '2026-11-09T18:00:00Z' }]) {
      const response = await apiWith(result).handler.fetch(request(body))
      assert.equal(response.status, 503)
      assert.equal('tentativa' in await response.json(), false)
    }
  })
  await t.test('normaliza UUID/data e devolve somente os campos permitidos', async () => {
    const response = await apiWith({ ...valid, id: valid.id.toUpperCase(),
      iniciada_em: '2026-11-09T16:00:00-03:00', questoes: [], gabarito: 'restrito',
    }).handler.fetch(request(body))
    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { tentativa: { ...valid, iniciada_em: '2026-11-09T19:00:00.000Z', limite_em: '2026-11-09T20:00:00.000Z' } })
  })
  await t.test('falha do banco ou conteúdo não JSON retorna 503 sem expor detalhes nem repetir o POST', async () => {
    for (const [code, expected] of [['42501', 403], ['P0002', 404], ['55000', 409], ['XX000', 503]]) {
      const { handler, transport } = apiWith({ code, message: 'Detalhe interno' }, 400)
      const response = await handler.fetch(request(body))
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await response.text(), /Detalhe interno/)
      assert.equal(transport.mock.callCount(), 2)
    }
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      new Request(input, init).url.endsWith('/auth/v1/user')
        ? Response.json({ id: alunoId }) : new Response('<html>Detalhe interno</html>', { status: 503 }))
    const response = await createIniciarTentativaHandler(env, transport).fetch(request(body))
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /Detalhe interno/)
    assert.equal(transport.mock.callCount(), 2)
  })
})
