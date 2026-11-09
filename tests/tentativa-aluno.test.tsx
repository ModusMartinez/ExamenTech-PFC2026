import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MinhasAvaliacoesPanel } from '../src/components/MinhasAvaliacoesPanel'
import { TentativaAlunoPanel } from '../src/components/TentativaAlunoPanel'
import type { AvaliacaoAluno } from '../src/services/avaliacaoValidation'
import type { ConteudoTentativa, TentativaIniciada } from '../src/services/tentativaValidation'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))

const avaliacao: AvaliacaoAluno = {
  id: '10000000-0000-0000-0000-000000000001', turma_id: '20000000-0000-0000-0000-000000000001',
  turma_nome: 'Engenharia 8B', titulo: 'Prova de banco de dados', tipo: 'PROVA',
  inicio_em: '2026-11-09T19:00:00.000Z', fim_em: '2026-11-09T21:00:00.000Z', duracao_minutos: 60,
  situacao: 'PUBLICADA', publicada_em: '2026-11-05T12:00:00.000Z',
}
const tentativa: TentativaIniciada = {
  id: '30000000-0000-0000-0000-000000000001', avaliacao_id: avaliacao.id,
  aluno_id: '40000000-0000-0000-0000-000000000001', situacao: 'EM_ANDAMENTO',
  iniciada_em: '2026-11-09T20:50:00.000Z', limite_em: avaliacao.fim_em,
}
const conteudo: ConteudoTentativa = {
  tentativa_id: tentativa.id, avaliacao_id: avaliacao.id, titulo: avaliacao.titulo, tipo: 'PROVA',
  iniciada_em: tentativa.iniciada_em, limite_em: tentativa.limite_em,
  questoes: [
    { id: '50000000-0000-0000-0000-000000000002', tipo: 'OBJETIVA', ordem: 1, pontuacao: 1.5,
      enunciado: 'Qual consulta retorna os alunos?\nConsidere somente matrículas ativas.', alternativas: [
        { id: '60000000-0000-0000-0000-000000000002', texto: 'Segunda alternativa cadastrada', ordem: 1 },
        { id: '60000000-0000-0000-0000-000000000001', texto: 'Primeira alternativa cadastrada', ordem: 2 },
      ] },
    { id: '50000000-0000-0000-0000-000000000001', tipo: 'DISSERTATIVA', ordem: 2, pontuacao: 2,
      enunciado: '<img src=x onerror=alert(1)> ' + 'Explique a consulta. '.repeat(30).trim(), alternativas: [] },
  ],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(tentativa.iniciada_em))
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getSession.mockResolvedValue({ data: { session: {
    access_token: 'sessao-simulada', user: { id: tentativa.aluno_id },
  } }, error: null })
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === '/api/minhas-avaliacoes') return Response.json({ avaliacoes: [avaliacao] })
    if (url === '/api/iniciar-tentativa') return Response.json({ tentativa }, { status: 201 })
    return Response.json({ conteudo })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function confirmar() {
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar início' }))
}

test('abrir e cancelar a confirmação não inicia tentativa e devolve foco à lista', async () => {
  render(<MinhasAvaliacoesPanel />)
  fireEvent.click(await screen.findByRole('button', { name: `Iniciar ${avaliacao.titulo}` }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancelar' }))
  expect(screen.getByText('Tentativa única, sem retomada. O tempo começa ao confirmar.')).toBeTruthy()
  expect(screen.getByText('Respostas e envio ainda indisponíveis.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Minhas avaliações' }))
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.fetch.mock.calls[0][1].method).toBe('GET')
})

test('confirmação inicia uma vez e apresenta conteúdo na ordem salva, sem gabarito nem campos de resposta', async () => {
  render(<MinhasAvaliacoesPanel />)
  fireEvent.click(await screen.findByRole('button', { name: `Iniciar ${avaliacao.titulo}` }))
  confirmar()
  const lista = await screen.findByRole('list', { name: 'Questões da tentativa' })
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Questões' }))
  expect(within(lista).getAllByRole('heading').map(h => h.textContent)).toEqual(['Questão 1', 'Questão 2'])
  const alternativas = screen.getByRole('list', { name: 'Alternativas da questão 1' })
  expect(within(alternativas).getAllByRole('listitem').map(li => li.textContent)).toEqual(conteudo.questoes[0].alternativas.map(a => a.texto))
  expect(screen.getByText('Objetiva · Pontuação: 1,5')).toBeTruthy()
  expect(screen.getByText(conteudo.questoes[1].enunciado)).toBeTruthy()
  expect(document.querySelector('img, input, textarea')).toBeNull()
  expect(screen.queryByText(/gabarito|correta/i)).toBeNull()
  expect(screen.queryByRole('button', { name: /Confirmar|Salvar|Enviar|Finalizar/ })).toBeNull()
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe(tentativa.limite_em)
  expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/minhas-avaliacoes', '/api/iniciar-tentativa', `/api/conteudo-tentativa?tentativa_id=${tentativa.id}`,
  ])
})

test('cliques ou envios repetidos durante o início não duplicam o POST, inclusive em StrictMode', async () => {
  let finish!: (response: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
  render(<StrictMode><TentativaAlunoPanel avaliacao={avaliacao} onCancelar={vi.fn()} /></StrictMode>)
  const form = screen.getByRole('form', { name: 'Iniciar avaliação' })
  confirmar()
  fireEvent.submit(form)
  fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: 'Cancelar' }).closest('fieldset')?.disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Iniciando...' }).getAttribute('aria-busy')).toBe('true')
  await act(async () => finish(Response.json({ tentativa }, { status: 201 })))
  await screen.findByRole('heading', { name: 'Questões' })
  expect(mocks.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
})

test.each([409, 503])('falha HTTP %i no início recebe foco e não consulta conteúdo nem repete início', async status => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Não é possível iniciar esta avaliação.' }, { status }))
  const cancelar = vi.fn()
  render(<TentativaAlunoPanel avaliacao={avaliacao} onCancelar={cancelar} />)
  confirmar()
  const alert = await screen.findByRole('alert')
  await waitFor(() => expect(document.activeElement).toBe(alert))
  expect(screen.queryByRole('button', { name: /Confirmar|Tentar carregar/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Voltar às avaliações' }))
  expect(cancelar).toHaveBeenCalledTimes(1)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('falha na consulta permite repetir somente o GET da mesma tentativa, mantendo o prazo', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ tentativa }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ message: 'Serviço temporariamente indisponível.' }, { status: 503 }))
  render(<TentativaAlunoPanel avaliacao={avaliacao} onCancelar={vi.fn()} />)
  confirmar()
  await screen.findByRole('alert')
  const retry = screen.getByRole('button', { name: 'Tentar carregar questões' })
  fireEvent.click(retry)
  fireEvent.click(retry)
  await screen.findByRole('heading', { name: 'Questões' })
  expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/iniciar-tentativa', `/api/conteudo-tentativa?tentativa_id=${tentativa.id}`, `/api/conteudo-tentativa?tentativa_id=${tentativa.id}`,
  ])
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe(tentativa.limite_em)
  expect(screen.queryByRole('alert')).toBeNull()
})

test.each([
  { avaliacao_id: '10000000-0000-0000-0000-000000000002' },
  { limite_em: '2026-11-09T21:01:00.000Z' },
])('conteúdo incompatível com a confirmação é recusado: %j', async alteracao => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ tentativa }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ conteudo: { ...conteudo, ...alteracao } }))
  render(<TentativaAlunoPanel avaliacao={avaliacao} onCancelar={vi.fn()} />)
  confirmar()
  expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível conferir o conteúdo da tentativa.')
  expect(screen.queryByRole('list', { name: 'Questões da tentativa' })).toBeNull()
})

test('prazo encerrado oculta questões sem enviar conclusão nem criar nova tentativa', async () => {
  render(<TentativaAlunoPanel avaliacao={avaliacao} onCancelar={vi.fn()} />)
  confirmar()
  await screen.findByRole('heading', { name: 'Questões' })
  vi.mocked(Date.now).mockReturnValue(Date.parse(tentativa.limite_em))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Prazo da tentativa encerrado.'), { timeout: 2000 })
  expect(screen.queryByRole('list', { name: 'Questões da tentativa' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('status'))
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

test('início confirmado após desmontar a tela não dispara consulta nem muda nova tela', async () => {
  let finish!: (response: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
  const view = render(<TentativaAlunoPanel avaliacao={avaliacao} onCancelar={vi.fn()} />)
  confirmar()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  view.unmount()
  render(<TentativaAlunoPanel avaliacao={avaliacao} onCancelar={vi.fn()} />)
  await act(async () => finish(Response.json({ tentativa }, { status: 201 })))
  expect(screen.getByRole('button', { name: 'Confirmar início' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Questões' })).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})
