import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { consultarRespostasTentativa, ErroSalvamentoResposta, salvarRespostaTentativa } from '../src/services/respostasTentativa'
import { ErroAcessoTentativa, ErroConexaoTentativa } from '../src/services/tentativaValidation'
import type { DadosRespostaTentativa, RespostaTentativa } from '../src/services/respostaValidation'

const chaveExecucao = '12345678-1234-4321-8765-123456789abc'
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), rpc: vi.fn(), respostaRpc: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession }, rpc: mocks.rpc } }))

const entrada: DadosRespostaTentativa = {
  tentativa_id: 'a0000000-0000-0000-0000-000000000001', questao_id: 'b0000000-0000-0000-0000-000000000001',
  versao: 2, alternativa_id: 'c0000000-0000-0000-0000-000000000001', texto: null,
}
const resposta: RespostaTentativa = {
  ...entrada, id: 'd0000000-0000-0000-0000-000000000001',
  criado_em: '2026-11-09T19:00:00.000Z', atualizado_em: '2026-11-09T19:01:00.000Z',
}
const sessao = { access_token: 'sessao-simulada' }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.rpc.mockReturnValue({ abortSignal: () => ({ retry: mocks.respostaRpc }) })
  mocks.getSession.mockResolvedValue({ data: { session: sessao }, error: null })
})
afterEach(() => vi.unstubAllGlobals())

test('consulta normaliza IDs, mantém versões e entrega só os campos permitidos', async () => {
  mocks.respostaRpc.mockResolvedValue({ data: [{ ...resposta, tentativa_id: entrada.tentativa_id.toUpperCase(),
    criado_em: '2026-11-09T16:00:00-03:00', salva_em: resposta.atualizado_em, correta: true }], error: null })
  expect(await consultarRespostasTentativa(entrada.tentativa_id.toUpperCase(), chaveExecucao)).toEqual([resposta])
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('consultar_respostas_tentativa', { p_tentativa_id: entrada.tentativa_id, p_chave_execucao: chaveExecucao })
  mocks.respostaRpc.mockResolvedValueOnce({ data: [], error: null })
  expect(await consultarRespostasTentativa(entrada.tentativa_id, chaveExecucao)).toEqual([])
})

test('consulta recusa registros de outra tentativa, duplicados, sem versão ou malformados', async () => {
  for (const data of [null, {}, [null], [{ ...resposta, tentativa_id: resposta.id }],
    [{ ...resposta, versao: undefined }], [{ ...resposta, versao: 0 }], [{ ...resposta, texto: 'Conteúdo incompatível' }],
    [{ ...resposta, atualizado_em: 'data-inválida' }], [resposta, { ...resposta, id: entrada.questao_id }],
    [resposta, { ...resposta, questao_id: resposta.id }],
  ]) {
    mocks.respostaRpc.mockResolvedValueOnce({ data, error: null })
    await expect(consultarRespostasTentativa(entrada.tentativa_id, chaveExecucao)).rejects.toThrow('As respostas anteriores não puderam ser confirmadas.')
  }
})

test('falha da consulta não vira lista vazia nem expõe erro interno', async () => {
  mocks.respostaRpc.mockResolvedValueOnce({ data: [resposta], error: { message: 'INTERNO' } })
  await expect(consultarRespostasTentativa(entrada.tentativa_id, chaveExecucao)).rejects.toThrow('Não foi possível recuperar as respostas já salvas.')
  mocks.respostaRpc.mockResolvedValueOnce({ data: null, error: {}, status: 0 })
  await expect(consultarRespostasTentativa(entrada.tentativa_id, chaveExecucao)).rejects.toThrow('Não foi possível recuperar as respostas já salvas.')
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
})

test('dados inválidos são recusados antes da sessão ou da requisição', async () => {
  await expect(consultarRespostasTentativa('inválido', chaveExecucao)).rejects.toThrow('Tentativa inválida.')
  for (const dados of [{ ...entrada, tentativa_id: 'inválido' }, { ...entrada, questao_id: '' },
    ...[0, -1, 1.5, NaN, 2147483648].map(versao => ({ ...entrada, versao })),
    { ...entrada, texto: 'Dois conteúdos' }, { ...entrada, alternativa_id: 'inválida' },
    ...['\u0000', '\ud800', '😀'.repeat(10001)].map(texto => ({ ...entrada, alternativa_id: null, texto })),
  ]) {
    await expect(salvarRespostaTentativa(dados, chaveExecucao)).rejects.toMatchObject({ codigo: 'RECUSADA' })
  }
  expect(mocks.getSession).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('salvamento envia a versão fornecida, usa a sessão atual e valida a confirmação', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ resposta: { ...resposta, id: resposta.id.toUpperCase(), correta: true } }))
  expect(await salvarRespostaTentativa({ ...entrada, tentativa_id: entrada.tentativa_id.toUpperCase() }, chaveExecucao)).toEqual(resposta)
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/salvar-resposta-tentativa', {
    method: 'POST', cache: 'no-store',
    headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json', 'X-ExamenTech-Execucao': chaveExecucao },
    signal: expect.any(AbortSignal), body: JSON.stringify(entrada),
  })
  expect(mocks.rpc).not.toHaveBeenCalled()
  mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'sessao-renovada' } }, error: null })
  mocks.fetch.mockResolvedValueOnce(Response.json({ resposta: { ...resposta, versao: 3 } }))
  expect((await salvarRespostaTentativa({ ...entrada, versao: 3 }, chaveExecucao)).versao).toBe(3)
  expect(mocks.getSession).toHaveBeenCalledTimes(2)
  expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer sessao-renovada')
})

test('preserva texto e aceita limpeza explícita sem remover a resposta do histórico', async () => {
  for (const texto of ['  Resposta\n' + '😀'.repeat(9988), '', null]) {
    const dados = { ...entrada, alternativa_id: null, texto }
    const salva = { ...resposta, alternativa_id: null, texto: texto === '' ? null : texto }
    mocks.fetch.mockResolvedValueOnce(Response.json({ resposta: salva }))
    expect(await salvarRespostaTentativa(dados, chaveExecucao)).toEqual(salva)
    expect(JSON.parse(mocks.fetch.mock.lastCall?.[1].body)).toEqual(dados)
  }
})

test('sessão ausente, inválida ou indisponível impede o POST', async () => {
  for (const result of [{ data: { session: null }, error: null }, { data: { session: sessao }, error: { message: 'INTERNO' } }]) {
    mocks.getSession.mockResolvedValueOnce(result)
    await expect(salvarRespostaTentativa(entrada, chaveExecucao)).rejects.toBeInstanceOf(ErroAcessoTentativa)
  }
  mocks.getSession.mockRejectedValueOnce(new Error('INTERNO'))
  await expect(salvarRespostaTentativa(entrada, chaveExecucao)).rejects.toBeInstanceOf(ErroAcessoTentativa)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test.each([400, 404, 405, 413, 415])('HTTP %i preserva a recusa sem repetir a chamada', async status => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Salvamento recusado.' }, { status }))
  await expect(salvarRespostaTentativa(entrada, chaveExecucao)).rejects.toMatchObject({ codigo: 'RECUSADA', message: 'Salvamento recusado.' })
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('conflito não busca uma versão mais nova nem repete o salvamento', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Versão desatualizada.' }, { status: 409 }))
  const erro = await salvarRespostaTentativa(entrada, chaveExecucao).catch((cause: unknown) => cause)
  expect(erro).toBeInstanceOf(ErroSalvamentoResposta)
  expect(erro).toMatchObject({ codigo: 'CONFLITO', message: 'Versão desatualizada.' })
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.rpc).not.toHaveBeenCalled()
})

test('falha de transporte é sinalizada à execução e não repete o salvamento', async () => {
  mocks.fetch.mockRejectedValueOnce(new TypeError('Falha de rede'))
  await expect(salvarRespostaTentativa(entrada, chaveExecucao)).rejects.toBeInstanceOf(ErroConexaoTentativa)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test.each([401, 403])('HTTP %i sinaliza perda de acesso à sessão', async status => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Salvamento recusado.' }, { status }))
  await expect(salvarRespostaTentativa(entrada, chaveExecucao)).rejects.toBeInstanceOf(ErroAcessoTentativa)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('erro de servidor, JSON inválido ou confirmação divergente nunca confirma uma gravação', async () => {
  const responses = [
    Response.json({ message: 'INTERNO' }, { status: 503 }), new Response('<html>Erro</html>', { status: 502 }),
    new Response('{', { status: 200 }), Response.json({ resposta }, { status: 201 }), Response.json(null), Response.json([]), Response.json({}),
    ...[{ ...resposta, id: 'inválido' }, { ...resposta, tentativa_id: resposta.id }, { ...resposta, questao_id: resposta.id },
      { ...resposta, versao: 3 }, { ...resposta, alternativa_id: resposta.id }, { ...resposta, atualizado_em: 'data-inválida' },
    ].map(resposta => Response.json({ resposta })),
  ]
  for (const response of responses) {
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(salvarRespostaTentativa(entrada, chaveExecucao)).rejects.toMatchObject({ codigo: 'NAO_CONFIRMADA', message: expect.stringContaining('mesmo conteúdo e a mesma versão') })
  }
  mocks.fetch.mockResolvedValueOnce(Response.json({ resposta: { ...resposta, alternativa_id: null, texto: 'Sem espaços' } }))
  await expect(salvarRespostaTentativa({ ...entrada, alternativa_id: null, texto: ' Sem espaços ' }, chaveExecucao)).rejects.toMatchObject({ codigo: 'NAO_CONFIRMADA' })
  expect(mocks.fetch).toHaveBeenCalledTimes(responses.length + 1)
})

test('alteração do objeto original enquanto aguarda sessão não muda a versão em trânsito', async () => {
  let liberarSessao!: (value: { data: { session: typeof sessao }; error: null }) => void
  mocks.getSession.mockReturnValueOnce(new Promise(resolve => { liberarSessao = resolve }))
  mocks.fetch.mockResolvedValueOnce(Response.json({ resposta }))
  const dados = { ...entrada }
  const envio = salvarRespostaTentativa(dados, chaveExecucao)
  dados.versao = 3
  dados.alternativa_id = resposta.id
  liberarSessao({ data: { session: sessao }, error: null })
  expect(await envio).toEqual(resposta)
  expect(JSON.parse(mocks.fetch.mock.lastCall?.[1].body)).toEqual(entrada)
})
