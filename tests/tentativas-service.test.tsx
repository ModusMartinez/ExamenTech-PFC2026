import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { consultarConteudoTentativa, iniciarTentativa } from '../src/services/tentativas'
import type { ConteudoTentativa, TentativaIniciada } from '../src/services/tentativaValidation'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))

const tentativa: TentativaIniciada = {
  id: 'a0000000-0000-0000-0000-000000000001', avaliacao_id: 'b0000000-0000-0000-0000-000000000001',
  aluno_id: 'c0000000-0000-0000-0000-000000000001', situacao: 'EM_ANDAMENTO',
  iniciada_em: '2026-11-09T19:00:00.000Z', limite_em: '2026-11-09T20:00:00.000Z',
}
const conteudo: ConteudoTentativa = {
  tentativa_id: tentativa.id, avaliacao_id: tentativa.avaliacao_id, titulo: 'Prova de teste', tipo: 'PROVA',
  iniciada_em: tentativa.iniciada_em, limite_em: tentativa.limite_em,
  questoes: [
    { id: 'd0000000-0000-0000-0000-000000000001', tipo: 'DISSERTATIVA', ordem: 1,
      enunciado: 'Explique a consulta.\nApresente um exemplo.', pontuacao: 2, alternativas: [] },
    { id: 'd0000000-0000-0000-0000-000000000002', tipo: 'OBJETIVA', ordem: 2,
      enunciado: 'Qual alternativa está correta?', pontuacao: 1.5, alternativas: [
        { id: 'e0000000-0000-0000-0000-000000000002', texto: 'Segunda alternativa cadastrada', ordem: 1 },
        { id: 'e0000000-0000-0000-0000-000000000001', texto: 'Primeira alternativa cadastrada', ordem: 2 },
      ] },
  ],
}
const session = { access_token: 'sessao-simulada', user: { id: tentativa.aluno_id } }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getSession.mockResolvedValue({ data: { session }, error: null })
})
afterEach(() => vi.unstubAllGlobals())

test('início envia avaliação e versão do aviso com a sessão atual e confere a confirmação', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ tentativa: {
    ...tentativa, id: tentativa.id.toUpperCase(), iniciada_em: '2026-11-09T16:00:00-03:00', campo_interno: 'restrito',
  } }, { status: 201 }))
  expect(await iniciarTentativa(tentativa.avaliacao_id.toUpperCase())).toEqual(tentativa)
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/iniciar-tentativa', {
    method: 'POST', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    cache: 'no-store', body: JSON.stringify({ avaliacao_id: tentativa.avaliacao_id, aviso_versao: EXAM_NOTICE_VERSION }),
  })
})

test('consulta mantém a ordem salva e entrega somente campos permitidos, sem gabarito', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ conteudo: {
    ...conteudo, gabarito: 'restrito', questoes: conteudo.questoes.map(q => ({ ...q, ordem_correta: 1,
      alternativas: q.alternativas.map(a => ({ ...a, correta: true })) })),
  } }))
  expect(await consultarConteudoTentativa(tentativa.id.toUpperCase())).toEqual(conteudo)
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(`/api/conteudo-tentativa?tentativa_id=${tentativa.id}`, {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada' }, cache: 'no-store',
  })
})

test('IDs inválidos são recusados antes de consultar sessão ou API', async () => {
  await expect(iniciarTentativa('inválido')).rejects.toThrow('ID da avaliação inválido.')
  await expect(consultarConteudoTentativa('inválido')).rejects.toThrow('ID da tentativa inválido.')
  expect(mocks.getSession).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('sessão ausente ou com erro impede início e consulta', async () => {
  for (const result of [{ data: { session: null }, error: null }, { data: { session }, error: new Error('Sessão inválida') }]) {
    mocks.getSession.mockResolvedValue(result)
    await expect(iniciarTentativa(tentativa.avaliacao_id)).rejects.toThrow('Sua sessão terminou.')
    await expect(consultarConteudoTentativa(tentativa.id)).rejects.toThrow('Sua sessão terminou.')
  }
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test.each([401, 403, 404, 409, 503])('erro HTTP %i preserva a mensagem da API sem repetir a operação', async status => {
  for (const executar of [() => iniciarTentativa(tentativa.avaliacao_id), () => consultarConteudoTentativa(tentativa.id)]) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Operação indisponível para esta tentativa.' }, { status }))
    await expect(executar()).rejects.toThrow('Operação indisponível para esta tentativa.')
  }
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

test('perda de resposta no início informa a possível criação e não repete o POST', async () => {
  mocks.fetch.mockRejectedValueOnce(new TypeError('Falha de rede'))
  await expect(iniciarTentativa(tentativa.avaliacao_id)).rejects.toThrow(/A tentativa pode ter sido criada/)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('confirmação inválida, de outro aluno ou avaliação não é aceita como início', async () => {
  const responses = [
    Response.json({ tentativa }, { status: 200 }), Response.json(null, { status: 201 }),
    Response.json({}, { status: 201 }), new Response('<html>Indisponível</html>', { status: 503 }),
    ...[{ ...tentativa, aluno_id: 'c0000000-0000-0000-0000-000000000002' },
      { ...tentativa, avaliacao_id: 'b0000000-0000-0000-0000-000000000002' },
      { ...tentativa, situacao: 'FINALIZADA' }, { ...tentativa, limite_em: tentativa.iniciada_em },
    ].map(tentativa => Response.json({ tentativa }, { status: 201 })),
  ]
  for (const response of responses) {
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(iniciarTentativa(tentativa.avaliacao_id)).rejects.toThrow(/A tentativa pode ter sido criada/)
  }
  expect(mocks.fetch).toHaveBeenCalledTimes(responses.length)
})

test('falha de consulta não devolve conteúdo anterior nem inicia outra tentativa', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ conteudo }))
  expect(await consultarConteudoTentativa(tentativa.id)).toEqual(conteudo)
  const responses = [Response.json({ conteudo }, { status: 201 }), Response.json(null), Response.json({}),
    Response.json({ conteudo: { ...conteudo, tentativa_id: 'a0000000-0000-0000-0000-000000000002' } }),
    Response.json({ conteudo: { ...conteudo, questoes: [] } }), new Response('<html>Falha</html>', { status: 503 }),
    Response.json({ message: 123 }, { status: 409 }), Response.json({ message: ' ' }, { status: 503 })]
  for (const response of responses) {
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(consultarConteudoTentativa(tentativa.id)).rejects.toThrow('Não foi possível carregar o conteúdo da tentativa.')
  }
  mocks.fetch.mockRejectedValueOnce(new TypeError('Falha de rede'))
  await expect(consultarConteudoTentativa(tentativa.id)).rejects.toThrow('Confira sua conexão.')
  expect(mocks.fetch).toHaveBeenCalledTimes(responses.length + 2)
  expect(mocks.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
})

test('uma nova chamada consulta a sessão atual e usa o token renovado', async () => {
  mocks.fetch.mockImplementation(async () => Response.json({ conteudo }))
  await consultarConteudoTentativa(tentativa.id)
  mocks.getSession.mockResolvedValueOnce({ data: { session: { ...session, access_token: 'sessao-renovada' } }, error: null })
  await consultarConteudoTentativa(tentativa.id)
  expect(mocks.getSession).toHaveBeenCalledTimes(2)
  expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer sessao-renovada')
})
