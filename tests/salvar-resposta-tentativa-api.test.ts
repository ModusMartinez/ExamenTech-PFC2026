import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'
import { createSalvarRespostaTentativaHandler } from '../api/salvar-resposta-tentativa.ts'
import type { RespostaTentativa } from '../src/services/respostaValidation.ts'

const env = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' }
function request(body: unknown, method = 'POST', query = '') {
  return new Request(`http://localhost/api/salvar-resposta-tentativa${query}`, {
    method, headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
    body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body),
  })
}

test('API de respostas integrada à função 034 no banco da entrega0911', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { professor, colega, aluno, admin, turmaId, queryAs } = await prepararBancoExecucao(db)
  for (const file of ['033_preparar_respostas_com_versao.sql', '034_salvar_resposta_com_versao.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  const avaliacao = (await queryAs<{ avaliacao: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
    $1,'Prova de respostas','PROVA',now()-interval '5 minutes',now()+interval '2 hours',60
  ) AS avaliacao`, [turmaId])).rows[0].avaliacao.id
  async function criarQuestao(tipo: string) {
    return (await queryAs<{ questao: { id: string } }>(professor,
      'SELECT public.criar_questao_rascunho($1,$2,$3,2) AS questao', [avaliacao, tipo, 'Enunciado de teste'])).rows[0].questao.id
  }
  const objetiva = await criarQuestao('OBJETIVA'), dissertativa = await criarQuestao('DISSERTATIVA')
  const alternativas = (await queryAs<{ alternativas: { id: string }[] }>(professor,
    "SELECT public.criar_alternativas_rascunho($1,ARRAY['Primeira','Segunda'],2) AS alternativas", [objetiva])).rows[0].alternativas
  await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [avaliacao])
  const tentativa = (await queryAs<{ tentativa: { id: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS tentativa', [avaliacao, '2026-11-06-v2'])).rows[0].tentativa.id
  const entrada = { tentativa_id: tentativa, questao_id: objetiva, versao: 1, alternativa_id: alternativas[0].id }
  function apiFor(usuario = aluno, aal = 'aal2', perderConfirmacao = false) {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      assert.equal(req.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(req.headers.get('authorization'), 'Bearer test-session')
      if (new URL(req.url).pathname === '/auth/v1/user') return Response.json({ id: usuario })
      assert.equal(new URL(req.url).pathname, '/rest/v1/rpc/salvar_resposta_tentativa')
      assert.equal(req.method, 'POST')
      const params: Record<string, unknown> = await req.json()
      assert.deepEqual(Object.keys(params).sort(), ['p_tentativa_id', 'p_questao_id', 'p_versao', 'p_alternativa_id', 'p_texto'].sort())
      let resposta: unknown
      try {
        const result = await queryAs<{ resposta: unknown }>(usuario,
          'SELECT public.salvar_resposta_tentativa($1,$2,$3,$4,$5) AS resposta',
          [params.p_tentativa_id, params.p_questao_id, params.p_versao, params.p_alternativa_id, params.p_texto], aal)
        resposta = result.rows[0].resposta
      } catch (error) {
        return Response.json({ code: error instanceof Error && 'code' in error ? error.code : 'XX000', message: 'SEGREDO_INTERNO' }, { status: 400 })
      }
      if (perderConfirmacao) { perderConfirmacao = false; throw new TypeError('Confirmação perdida após commit no banco de teste') }
      return Response.json(resposta)
    })
    return { transport, handler: createSalvarRespostaTentativaHandler({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'nao-usar' }, transport) }
  }
  async function registros() {
    return {
      respostas: (await db.query('SELECT * FROM public.respostas_tentativa ORDER BY id')).rows,
      eventos: (await db.query("SELECT * FROM public.eventos_seguranca WHERE evento='RESPOSTA_SALVA' ORDER BY id")).rows,
    }
  }
  const antesTentativa = (await db.query('SELECT * FROM public.tentativas WHERE id=$1', [tentativa])).rows

  await t.test('salva, repete, altera e limpa a objetiva com confirmação 200 e sem duplicação', async () => {
    const { handler, transport } = apiFor()
    const response = await handler.fetch(request({ ...entrada, tentativa_id: tentativa.toUpperCase() }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body: { resposta: RespostaTentativa } = await response.json()
    assert.equal(body.resposta.alternativa_id, alternativas[0].id)
    assert.equal(body.resposta.texto, null)
    assert.equal(body.resposta.versao, 1)
    assert.equal(transport.mock.callCount(), 2)
    assert.deepEqual(await (await handler.fetch(request(entrada))).json(), body)
    assert.equal((await registros()).eventos.length, 1)
    assert.equal((await handler.fetch(request({ ...entrada, versao: 2, alternativa_id: alternativas[1].id }))).status, 200)
    const limpa = await handler.fetch(request({ ...entrada, versao: 3, alternativa_id: null }))
    const result: { resposta: RespostaTentativa } = await limpa.json()
    assert.equal(limpa.status, 200)
    assert.equal(result.resposta.id, body.resposta.id)
    assert.equal(result.resposta.criado_em, body.resposta.criado_em)
    assert.equal(result.resposta.alternativa_id, null)
    assert.equal((await registros()).respostas.length, 1)
    assert.equal((await registros()).eventos.length, 3)
  })

  await t.test('preserva texto, quebras de linha e 10 mil caracteres Unicode; vazio limpa a resposta', async () => {
    const { handler } = apiFor()
    const texto = '  <b>Resposta</b>\n' + '😀'.repeat(9981) + ' '
    assert.equal([...texto].length, 10000)
    const dados = { tentativa_id: tentativa, questao_id: dissertativa, versao: 1, texto }
    const response = await handler.fetch(request(dados))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).resposta.texto, texto)
    const limpa = await handler.fetch(request({ ...dados, versao: 2, texto: '' }))
    assert.equal(limpa.status, 200)
    assert.equal((await limpa.json()).resposta.texto, null)
  })

  await t.test('perda da confirmação retorna 503 e repetir os mesmos dados confirma sem novo evento', async () => {
    const { handler, transport } = apiFor(aluno, 'aal2', true)
    const dados = { ...entrada, versao: 4 }
    const response = await handler.fetch(request(dados))
    assert.equal(response.status, 503)
    assert.match((await response.json()).message, /mesmo conteúdo e a mesma versão/)
    assert.equal(transport.mock.callCount(), 2)
    const antes = await registros()
    const repetida = await handler.fetch(request(dados))
    assert.equal(repetida.status, 200)
    assert.equal((await repetida.json()).resposta.versao, 4)
    assert.deepEqual(await registros(), antes)
    assert.equal(transport.mock.callCount(), 4)
  })

  await t.test('recusas da função preservam respostas e retornam 400, 403, 404 ou 409', async () => {
    const antes = await registros()
    for (const usuario of [professor, admin]) assert.equal((await apiFor(usuario).handler.fetch(request(entrada))).status, 403)
    assert.equal((await apiFor(aluno, 'aal1').handler.fetch(request(entrada))).status, 403)
    await db.query("UPDATE public.perfis SET perfil='ALUNO' WHERE id=$1", [colega])
    await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, colega])
    assert.equal((await apiFor(colega).handler.fetch(request(entrada))).status, 404)
    const { handler } = apiFor()
    for (const [dados, status] of [
      [{ ...entrada, questao_id: randomUUID() }, 404], [{ ...entrada, alternativa_id: randomUUID() }, 400],
      [{ ...entrada, alternativa_id: null, texto: 'Texto em objetiva' }, 400],
      [{ ...entrada, questao_id: dissertativa }, 400], [entrada, 409],
    ] as const) {
      const response = await handler.fetch(request(dados))
      assert.equal(response.status, status)
      assert.deepEqual(Object.keys(await response.json()), ['message'])
    }
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE aluno_id=$1", [aluno])
    assert.equal((await handler.fetch(request({ ...entrada, versao: 5 }))).status, 404)
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE aluno_id=$1", [aluno])
    assert.deepEqual(await registros(), antes)
  })

  await t.test('falha de auditoria retorna 503 sem confirmar nem manter a alteração', async () => {
    const antes = await registros()
    await db.exec(`CREATE FUNCTION public.falhar_resposta_api() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.evento='RESPOSTA_SALVA' THEN RAISE EXCEPTION 'Falha simulada'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER falhar_resposta_api BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_resposta_api();`)
    try {
      const { handler, transport } = apiFor()
      assert.equal((await handler.fetch(request({ ...entrada, versao: 5 }))).status, 503)
      assert.equal(transport.mock.callCount(), 2)
      assert.deepEqual(await registros(), antes)
    } finally { await db.exec('DROP TRIGGER falhar_resposta_api ON public.eventos_seguranca; DROP FUNCTION public.falhar_resposta_api();') }
    assert.deepEqual((await db.query('SELECT * FROM public.tentativas WHERE id=$1', [tentativa])).rows, antesTentativa)
  })

  await t.test('prazo vencido bloqueia nova gravação e repetição da versão atual', async () => {
    const antes = await registros()
    await db.query("UPDATE public.tentativas SET iniciada_em=now()-interval '1 hour',limite_em=now() WHERE id=$1", [tentativa])
    for (const versao of [4, 5]) {
      const response = await apiFor().handler.fetch(request({ ...entrada, versao }))
      assert.equal(response.status, 409)
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    assert.deepEqual(await registros(), antes)
  })
})

test('API de respostas: contrato HTTP, identidade e confirmação segura', async t => {
  const aluno = randomUUID()
  const entrada = { tentativa_id: randomUUID(), questao_id: randomUUID(), versao: 1, alternativa_id: randomUUID(), texto: null }
  const valid: RespostaTentativa = { ...entrada, id: randomUUID(), criado_em: '2026-11-09T19:00:00.000Z', atualizado_em: '2026-11-09T19:00:00.000Z' }
  function apiWith(result: unknown, status = 200) {
    const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.endsWith('/auth/v1/user')) return Response.json({ id: aluno })
      return Response.json(result, { status })
    })
    return { transport, handler: createSalvarRespostaTentativaHandler(env, transport) }
  }

  await t.test('recusa método, token, URL, JSON e campos inválidos antes de acessar o Supabase', async () => {
    const { handler, transport } = apiWith(valid)
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await handler.fetch(request(entrada, method))
      assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST')
    }
    for (const token of ['', 'Basic abc', 'Bearer um dois']) {
      const req = request(entrada); req.headers.set('authorization', token)
      assert.equal((await handler.fetch(req)).status, 401)
    }
    assert.equal((await handler.fetch(request(entrada, 'POST', '?aluno_id=' + aluno))).status, 400)
    const mime = request(entrada); mime.headers.set('content-type', 'text/plain')
    assert.equal((await handler.fetch(mime)).status, 415)
    const malformed = new Request('http://localhost/api/salvar-resposta-tentativa', {
      method: 'POST', headers: request(entrada).headers, body: '{',
    })
    assert.equal((await handler.fetch(malformed)).status, 400)
    const invalid = [null, [], {}, { ...entrada, tentativa_id: 'invalido' }, { ...entrada, questao_id: null },
      ...[null, 0, -1, 1.5, '1', 2147483648].map(versao => ({ ...entrada, versao })),
      { tentativa_id: entrada.tentativa_id, questao_id: entrada.questao_id, versao: 1 },
      ...['', 1, [], {}].map(alternativa_id => ({ ...entrada, alternativa_id })),
      ...[1, [], {}, '\u0000', '\ud800', '😀'.repeat(10001)].map(texto => ({ ...entrada, alternativa_id: null, texto })),
      { ...entrada, texto: '' }, { ...entrada, texto: 'Dois tipos' },
      ...['aluno_id', 'correta', 'nota', 'atualizado_em', 'tipo'].map(key => ({ ...entrada, [key]: 'não permitido' })),
    ]
    for (const body of invalid) {
      const response = await handler.fetch(request(body))
      assert.equal(response.status, 400)
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    assert.equal((await createSalvarRespostaTentativaHandler({}, transport).fetch(request(entrada))).status, 503)
    assert.equal(transport.mock.callCount(), 0)
  })

  await t.test('falha do Auth impede a RPC e não expõe mensagem interna', async () => {
    for (const [status, expected] of [[400, 401], [401, 401], [403, 401], [429, 503], [500, 503]]) {
      const transport = t.mock.fn(async () => Response.json({ message: 'SEGREDO_INTERNO' }, { status }))
      const response = await createSalvarRespostaTentativaHandler(env, transport).fetch(request(entrada))
      assert.equal(response.status, expected)
      assert.doesNotMatch(await response.text(), /SEGREDO_INTERNO/)
      assert.equal(transport.mock.callCount(), 1)
    }
    for (const identity of [{}, { id: 'invalido' }, { id: 123 }]) {
      const transport = t.mock.fn(async () => Response.json(identity))
      assert.equal((await createSalvarRespostaTentativaHandler(env, transport).fetch(request(entrada))).status, 503)
      assert.equal(transport.mock.callCount(), 1)
    }
  })

  await t.test('confirma somente campos permitidos, normaliza IDs/datas e aceita limpeza explícita', async () => {
    const extra = { ...valid, id: valid.id.toUpperCase(), alternativa_id: valid.alternativa_id?.toUpperCase(),
      tentativa_id: valid.tentativa_id.toUpperCase(), questao_id: valid.questao_id.toUpperCase(),
      criado_em: '2026-11-09T16:00:00-03:00', correta: true, gabarito: 'restrito', nota: 10 }
    const response = await apiWith(extra).handler.fetch(request(entrada))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { resposta: valid })
    for (const content of [{ texto: '' }, { texto: null }, { alternativa_id: null }]) {
      const { handler } = apiWith({ ...valid, alternativa_id: null })
      const limpa = await handler.fetch(request({ tentativa_id: entrada.tentativa_id, questao_id: entrada.questao_id, versao: 1, ...content }))
      assert.equal(limpa.status, 200)
      assert.equal((await limpa.json()).resposta.texto, null)
    }
  })

  await t.test('confirmação inválida ou divergente não é apresentada como resposta salva', async () => {
    for (const result of [null, [], {}, { ...valid, id: 'invalido' },
      { ...valid, tentativa_id: randomUUID() }, { ...valid, questao_id: randomUUID() },
      { ...valid, alternativa_id: randomUUID() }, { ...valid, alternativa_id: null },
      ...[0, 2, '1', null].map(versao => ({ ...valid, versao })),
      { ...valid, texto: 'texto indevido' }, { ...valid, texto: undefined }, { ...valid, alternativa_id: undefined },
      { ...valid, criado_em: '2026-02-30T19:00:00Z' }, { ...valid, criado_em: '2026-11-09T19:00:00' },
      { ...valid, atualizado_em: null }, { ...valid, atualizado_em: '2026-11-09T18:59:00Z' },
    ]) {
      const response = await apiWith(result).handler.fetch(request(entrada))
      assert.equal(response.status, 503)
      assert.deepEqual(Object.keys(await response.json()), ['message'])
    }
    const texto = ' Resposta\nSem trim '
    for (const returned of ['Resposta\nSem trim', texto + ' alterada', null, '', 'x'.repeat(10001)]) {
      const response = await apiWith({ ...valid, alternativa_id: null, texto: returned }).handler.fetch(request({ ...entrada, alternativa_id: null, texto }))
      assert.equal(response.status, 503)
    }
  })

  await t.test('traduz erros SQL e falhas de transporte sem vazar conteúdo nem repetir a RPC', async () => {
    for (const [code, expected] of [['42501', 403], ['P0002', 404], ['55000', 409], ['23514', 400], ['22P02', 400], ['XX000', 503]]) {
      const { handler, transport } = apiWith({ code, message: 'SEGREDO_INTERNO', details: valid }, 400)
      const response = await handler.fetch(request(entrada))
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await response.text(), /SEGREDO_INTERNO|tentativa_id|gabarito/)
      assert.equal(transport.mock.callCount(), 2)
    }
    for (const failure of ['rede', 'json', 'servico']) {
      const transport = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url.endsWith('/auth/v1/user')) return Response.json({ id: aluno })
        if (failure === 'rede') throw new TypeError('SEGREDO_INTERNO')
        return new Response('SEGREDO_INTERNO', { status: failure === 'json' ? 200 : 503 })
      })
      const response = await createSalvarRespostaTentativaHandler(env, transport).fetch(request(entrada))
      assert.equal(response.status, 503)
      assert.doesNotMatch(await response.text(), /SEGREDO_INTERNO/)
      assert.equal(transport.mock.callCount(), 2)
    }
  })
})
