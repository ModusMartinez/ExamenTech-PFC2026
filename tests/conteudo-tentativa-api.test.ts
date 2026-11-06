import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'
import { createConteudoTentativaHandler } from '../api/conteudo-tentativa.ts'
import type { ConteudoTentativa } from '../src/services/tentativaValidation.ts'

const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
function request(query: string, method = 'GET') {
  return new Request(`http://localhost/api/conteudo-tentativa${query}`, { method, headers: { Authorization: 'Bearer test-session' } })
}

test('API de conteúdo integrada às permissões e à ordem salva no PostgreSQL', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { professor, colega, aluno, admin, turmaId, queryAs } = await prepararBancoAvaliacoes(db)
  for (const file of ['023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql', '025_iniciar_tentativa.sql',
    '026_ordem_tentativa.sql', '027_consultar_conteudo_tentativa.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  const avaliacao = (await queryAs<{ avaliacao: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
    $1,'Prova para consulta','PROVA',now()-interval '5 minutes',now()+interval '2 hours',60
  ) AS avaliacao`, [turmaId])).rows[0].avaliacao
  for (const tipo of ['OBJETIVA', 'DISSERTATIVA']) {
    const questao = (await queryAs<{ questao: { id: string } }>(professor,
      'SELECT public.criar_questao_rascunho($1,$2,$3,2.5) AS questao', [avaliacao.id, tipo, 'Enunciado de teste'])).rows[0].questao
    if (tipo === 'OBJETIVA') await queryAs(professor, "SELECT public.criar_alternativas_rascunho($1,ARRAY['Primeira','Segunda','Terceira'],2)", [questao.id])
  }
  await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [avaliacao.id])
  const tentativa = (await queryAs<{ tentativa: { id: string; iniciada_em: string; limite_em: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1) AS tentativa', [avaliacao.id])).rows[0].tentativa
  function apiFor(usuario = aluno, aal = 'aal2') {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      assert.equal(req.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(req.headers.get('authorization'), 'Bearer test-session')
      if (new URL(req.url).pathname === '/auth/v1/user') return Response.json({ id: usuario })
      assert.equal(new URL(req.url).pathname, '/rest/v1/rpc/consultar_conteudo_tentativa')
      assert.equal(req.method, 'POST')
      const params: Record<string, unknown> = await req.json()
      assert.deepEqual(params, { p_tentativa_id: tentativa.id })
      try {
        const result = await queryAs<{ conteudo: unknown }>(usuario,
          'SELECT public.consultar_conteudo_tentativa($1) AS conteudo', [params.p_tentativa_id], aal)
        return Response.json(result.rows[0].conteudo)
      } catch (error) {
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'SEGREDO_INTERNO' }, { status: 400 })
      }
    })
    return { transport, handler: createConteudoTentativaHandler({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'nao-usar' }, transport) }
  }
  const query = `?tentativa_id=${tentativa.id.toUpperCase()}`
  await t.test('retorna 200 na ordem salva e repetir a leitura não altera registros ou auditoria', async () => {
    const antes = (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows
    const { handler, transport } = apiFor()
    const response = await handler.fetch(request(query))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body: { conteudo: ConteudoTentativa } = await response.json()
    const original = (await queryAs<{ conteudo: ConteudoTentativa }>(aluno,
      'SELECT public.consultar_conteudo_tentativa($1) AS conteudo', [tentativa.id])).rows[0].conteudo
    assert.deepEqual(body, { conteudo: { ...original,
      iniciada_em: new Date(original.iniciada_em).toISOString(), limite_em: new Date(original.limite_em).toISOString() } })
    assert.equal(body.conteudo.questoes.length, 2)
    const objetiva = body.conteudo.questoes.find(q => q.tipo === 'OBJETIVA')!
    assert.equal(objetiva.alternativas.length, 3)
    for (const alternativa of objetiva.alternativas) assert.deepEqual(Object.keys(alternativa).sort(), ['id', 'ordem', 'texto'])
    assert.equal(transport.mock.callCount(), 2)
    assert.deepEqual(await (await handler.fetch(request(query))).json(), body)
    assert.deepEqual((await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows, antes)
  })

  await t.test('professor, admin e aluno sem MFA recebem 403; outro aluno e matrícula inativa recebem 404', async () => {
    for (const usuario of [professor, admin]) assert.equal((await apiFor(usuario).handler.fetch(request(query))).status, 403)
    assert.equal((await apiFor(aluno, 'aal1').handler.fetch(request(query))).status, 403)
    await db.query("UPDATE public.perfis SET perfil='ALUNO' WHERE id=$1", [colega])
    await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, colega])
    const alheia = await apiFor(colega).handler.fetch(request(query))
    assert.equal(alheia.status, 404)
    assert.deepEqual(Object.keys(await alheia.json()), ['message'])
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE aluno_id=$1", [aluno])
    assert.equal((await apiFor().handler.fetch(request(query))).status, 404)
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE aluno_id=$1", [aluno])
  })

  await t.test('prazo vencido recebe 409 sem conteúdo ou detalhes do banco', async () => {
    await db.query("UPDATE public.tentativas SET iniciada_em=now()-interval '1 hour',limite_em=now() WHERE id=$1", [tentativa.id])
    const response = await apiFor().handler.fetch(request(query))
    assert.equal(response.status, 409)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(await response.json()), ['message'])
  })
})

test('API de conteúdo: entrada, identidade e proteção da resposta', async (t) => {
  const alunoId = randomUUID(), tentativaId = randomUUID()
  const query = `?tentativa_id=${tentativaId}`
  const valid: ConteudoTentativa = {
    tentativa_id: tentativaId, avaliacao_id: randomUUID(), titulo: 'Prova de teste', tipo: 'PROVA',
    iniciada_em: '2026-11-09T19:00:00.000Z', limite_em: '2026-11-09T20:00:00.000Z',
    questoes: [
      { id: randomUUID(), tipo: 'OBJETIVA', enunciado: 'Questão objetiva', pontuacao: 1.25, ordem: 1,
        alternativas: [{ id: randomUUID(), texto: 'Primeira', ordem: 1 }, { id: randomUUID(), texto: 'Segunda', ordem: 2 }] },
      { id: randomUUID(), tipo: 'DISSERTATIVA', enunciado: 'Explique sua resposta.\nSegunda linha.', pontuacao: 2, ordem: 2, alternativas: [] },
    ],
  }
  function apiWith(result: unknown, status = 200) {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.endsWith('/auth/v1/user')) return Response.json({ id: alunoId })
      return Response.json(result, { status })
    })
    return { transport, handler: createConteudoTentativaHandler(env, transport) }
  }
  await t.test('recusa método, token ou parâmetro inválido antes de acessar o Supabase', async () => {
    const { handler, transport } = apiWith(valid)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await handler.fetch(request(query, method))
      assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET')
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    for (const token of ['', 'Basic abc', 'Bearer um dois']) {
      const req = request(query); req.headers.set('authorization', token)
      assert.equal((await handler.fetch(req)).status, 401)
    }
    for (const params of ['', '?tentativa_id=', '?tentativa_id=invalido', '?avaliacao_id=' + tentativaId,
      query + '&tentativa_id=' + tentativaId, query + '&aluno_id=' + alunoId, query + '&correta=true']) {
      const response = await handler.fetch(request(params))
      assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    assert.equal((await createConteudoTentativaHandler({}, transport).fetch(request(query))).status, 503)
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('sessão recusada retorna 401 e falha do Auth retorna 503 sem consultar o conteúdo', async () => {
    for (const [status, expected] of [[400, 401], [401, 401], [403, 401], [429, 503], [500, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'SEGREDO_INTERNO' }, { status }))
      const response = await createConteudoTentativaHandler(env, transport).fetch(request(query))
      assert.equal(response.status, expected)
      assert.doesNotMatch(await response.text(), /SEGREDO_INTERNO/)
      assert.equal(transport.mock.callCount(), 1)
    }
    for (const identity of [{}, { id: 'invalido' }]) {
      const transport = t.mock.fn(async () => Response.json(identity))
      assert.equal((await createConteudoTentativaHandler(env, transport).fetch(request(query))).status, 503)
      assert.equal(transport.mock.callCount(), 1)
    }
  })

  await t.test('remove gabarito e campos internos em todos os níveis e normaliza IDs e datas', async () => {
    const extra = { ...valid, tentativa_id: tentativaId.toUpperCase(), gabarito: 'restrito', aluno_id: alunoId,
      avaliacao_id: valid.avaliacao_id.toUpperCase(), iniciada_em: '2026-11-09T16:00:00-03:00',
      questoes: valid.questoes.map(q => ({ ...q, id: q.id.toUpperCase(), ordem_correta: 2, comentario_privado: 'restrito',
        alternativas: q.alternativas.map(a => ({ ...a, id: a.id.toUpperCase(), correta: true, justificativa: 'restrito' })) })),
    }
    const response = await apiWith(extra).handler.fetch(request(query))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { conteudo: valid })
    const atividade = { ...valid, tipo: 'ATIVIDADE', questoes: Array.from({ length: 51 }, (_, i) => ({ ...valid.questoes[1], id: randomUUID(), ordem: i + 1 })) }
    const completa = await apiWith(atividade).handler.fetch(request(query))
    assert.equal(completa.status, 200)
    assert.deepEqual(await completa.json(), { conteudo: atividade })
  })

  await t.test('resposta inválida ou de outra tentativa retorna 503 sem conteúdo parcial', async () => {
    const objetiva = valid.questoes[0], alternativa = objetiva.alternativas[0]
    const invalidQuestions = [null, [], { ...objetiva, id: 'invalido' }, { ...objetiva, tipo: 'OUTRA' },
      ...[0, 2, '1'].map(ordem => ({ ...objetiva, ordem })),
      ...[' ', 'ab', 'a'.repeat(10001), '\u0000abc'].map(enunciado => ({ ...objetiva, enunciado })),
      ...[0, -1, '1', 1.234, 10000].map(pontuacao => ({ ...objetiva, pontuacao })),
      ...[null, [], [alternativa], Array(6).fill(alternativa)].map(alternativas => ({ ...objetiva, alternativas })),
      { ...objetiva, tipo: 'DISSERTATIVA' },
    ]
    const invalidAlternatives = [null, [], { ...alternativa, id: 'invalido' }, { ...alternativa, ordem: 2 },
      { ...alternativa, ordem: '1' }, ...['', ' ', 'a'.repeat(2001), '\u0000abc'].map(texto => ({ ...alternativa, texto }))]
    const results = [null, [], {}, { ...valid, tentativa_id: randomUUID() }, { ...valid, avaliacao_id: 'invalido' },
      { ...valid, titulo: ' ' }, { ...valid, titulo: 'a'.repeat(151) }, { ...valid, tipo: 'OUTRA' },
      { ...valid, iniciada_em: '2026-02-30T19:00:00Z' }, { ...valid, iniciada_em: '2026-11-09T19:00:00' },
      { ...valid, limite_em: valid.iniciada_em }, { ...valid, limite_em: null }, { ...valid, questoes: [] },
      { ...valid, questoes: [objetiva, { ...valid.questoes[1], id: objetiva.id.toUpperCase() }] },
      { ...valid, questoes: [objetiva, { ...objetiva, id: randomUUID(), ordem: 2 }] },
      { ...valid, questoes: [{ ...objetiva, alternativas: [alternativa, { ...alternativa, ordem: 2 }] }] },
      { ...valid, questoes: [{ ...objetiva, alternativas: [alternativa, { ...objetiva.alternativas[1], texto: alternativa.texto }] }] },
      ...invalidQuestions.map(q => ({ ...valid, questoes: [q] })),
      ...invalidAlternatives.map(a => ({ ...valid, questoes: [{ ...objetiva, alternativas: [a, objetiva.alternativas[1]] }] })),
    ]
    for (const result of results) {
      const response = await apiWith(result).handler.fetch(request(query))
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(Object.keys(await response.json()), ['message'])
    }
  })

  await t.test('traduz erros SQL e falhas de serviço sem expor detalhes ou repetir a RPC', async () => {
    for (const [code, expected] of [['42501', 403], ['P0002', 404], ['55000', 409], ['XX000', 503]]) {
      const { handler, transport } = apiWith({ code, message: 'SEGREDO_INTERNO', details: valid }, 400)
      const response = await handler.fetch(request(query))
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await response.text(), /SEGREDO_INTERNO|questoes/)
      assert.equal(transport.mock.callCount(), 2)
    }
    for (const failure of ['rede', 'json', 'servico']) {
      const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url.endsWith('/auth/v1/user')) return Response.json({ id: alunoId })
        if (failure === 'rede') throw new TypeError('SEGREDO_INTERNO')
        return new Response('SEGREDO_INTERNO', { status: failure === 'json' ? 200 : 503 })
      })
      const response = await createConteudoTentativaHandler(env, transport).fetch(request(query))
      assert.equal(response.status, 503)
      assert.doesNotMatch(await response.text(), /SEGREDO_INTERNO/)
      assert.equal(transport.mock.callCount(), 2)
    }
  })
})
