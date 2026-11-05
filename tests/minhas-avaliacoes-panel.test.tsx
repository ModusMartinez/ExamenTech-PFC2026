import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MinhasAvaliacoesPanel } from '../src/components/MinhasAvaliacoesPanel'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))

const avaliacao = {
  id: '10000000-0000-0000-0000-000000000001', turma_id: '20000000-0000-0000-0000-000000000001',
  turma_nome: 'Engenharia 8B', titulo: 'Prova de banco de dados', tipo: 'PROVA',
  inicio_em: '2026-11-09T19:00:00.000Z', fim_em: '2026-11-09T21:00:00.000Z', duracao_minutos: 60,
  situacao: 'PUBLICADA', publicada_em: '2026-11-05T12:00:00.000Z',
}
const atividade = {
  ...avaliacao, id: '10000000-0000-0000-0000-000000000002', turma_id: '20000000-0000-0000-0000-000000000002',
  turma_nome: 'Engenharia 8A', titulo: 'Atividade de algoritmos', tipo: 'ATIVIDADE', duracao_minutos: 30,
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada' } }, error: null })
  mocks.fetch.mockImplementation(async () => Response.json({ avaliacoes: [avaliacao, atividade] }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('consulta real do frontend apresenta os campos, foco e horários locais sem ações de execução', async () => {
  render(<MinhasAvaliacoesPanel />)
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Minhas avaliações' }))
  const tabela = await screen.findByRole('table', { name: 'Minhas avaliações' })
  expect(within(tabela).getAllByRole('row')).toHaveLength(3)
  for (const texto of [avaliacao.titulo, avaliacao.turma_nome, atividade.titulo, atividade.turma_nome, 'Prova', 'Atividade', '60 min', '30 min']) {
    expect(within(tabela).getByText(texto)).toBeTruthy()
  }
  const time = tabela.querySelector('time')
  expect(time?.getAttribute('datetime')).toBe(avaliacao.inicio_em)
  expect(time?.textContent).toBe(new Date(avaliacao.inicio_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))
  expect(screen.getByText(/Horários:/).textContent).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
  expect(screen.getByRole('region', { name: 'Tabela de minhas avaliações' }).getAttribute('tabindex')).toBe('0')
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/minhas-avaliacoes', {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada' }, cache: 'no-store',
  })
  expect(screen.queryByRole('button', { name: /Iniciar|Responder|Editar|Publicar/ })).toBeNull()
  expect(screen.queryByText('sessao-simulada')).toBeNull()
})

test('carregamento bloqueia consultas repetidas e lista vazia tem mensagem própria', async () => {
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  render(<MinhasAvaliacoesPanel />)
  expect(screen.getByRole('status').textContent).toBe('Carregando avaliações...')
  const button = screen.getByRole('button', { name: 'Atualizar' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  await act(async () => finish(Response.json({ avaliacoes: [] })))
  expect(screen.getByRole('status').textContent).toBe('Nenhuma avaliação publicada nas suas turmas ativas.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(button.hasAttribute('disabled')).toBe(false)
})

test('Atualizar substitui a lista e retira avaliações que deixaram de ser acessíveis', async () => {
  render(<MinhasAvaliacoesPanel />)
  await screen.findByText(avaliacao.titulo)
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [atividade] }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await waitFor(() => expect(screen.queryByText(avaliacao.titulo)).toBeNull())
  await screen.findByText(atividade.titulo)
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [] }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText('Nenhuma avaliação publicada nas suas turmas ativas.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledTimes(3)
  expect(mocks.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
})

test.each([401, 403, 503])('erro HTTP %i oculta lista anterior e permite nova consulta', async (status) => {
  render(<MinhasAvaliacoesPanel />)
  await screen.findByText(avaliacao.titulo)
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível para esta sessão.' }, { status }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Consulta indisponível para esta sessão.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText(/Nenhuma avaliação publicada/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText(avaliacao.titulo)
  expect(screen.queryByRole('alert')).toBeNull()
})

test('sessão ausente ou com erro impede a chamada à API', async () => {
  for (const sessao of [
    { data: { session: null }, error: null },
    { data: { session: { access_token: 'sessao-simulada' } }, error: new Error('Sessão inválida') },
  ]) {
    mocks.getSession.mockResolvedValueOnce(sessao)
    const view = render(<MinhasAvaliacoesPanel />)
    expect((await screen.findByRole('alert')).textContent).toBe('Sua sessão terminou. Entre novamente.')
    expect(mocks.fetch).not.toHaveBeenCalled()
    view.unmount()
  }
})

test('falha de rede não expõe detalhes e não apresenta lista vazia', async () => {
  mocks.fetch.mockRejectedValueOnce(new TypeError('Detalhe interno'))
  render(<MinhasAvaliacoesPanel />)
  expect((await screen.findByRole('alert')).textContent).toContain('Confira sua conexão')
  expect(screen.queryByText(/Detalhe interno|Nenhuma avaliação/)).toBeNull()
})

test('contratos inválidos, rascunhos, duplicações e HTML são recusados', async () => {
  for (const response of [
    Response.json({ avaliacoes: null }), Response.json({ avaliacoes: [{}] }),
    Response.json({ avaliacoes: [{ ...avaliacao, situacao: 'RASCUNHO' }] }),
    Response.json({ avaliacoes: [{ ...avaliacao, fim_em: 'inválida' }] }),
    Response.json({ avaliacoes: [avaliacao, avaliacao] }),
    Response.json({ avaliacoes: Array(51).fill(avaliacao) }),
    Response.json({ avaliacoes: [avaliacao] }, { status: 201 }),
    new Response('<html>Indisponível</html>', { status: 503 }),
  ]) {
    mocks.fetch.mockResolvedValueOnce(response)
    const view = render(<MinhasAvaliacoesPanel />)
    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível conferir sua lista de avaliações.')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText(/Nenhuma avaliação/)).toBeNull()
    view.unmount()
  }
})

test('texto longo e marcação são texto simples; campos extras não aparecem', async () => {
  const titulo = '<img src=x onerror=alert(1)> ' + 'Avaliação '.repeat(12)
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [{
    ...avaliacao, titulo, turma_nome: 'Engenharia '.repeat(8).trim(), gabarito: 'Gabarito restrito',
  }] }))
  render(<MinhasAvaliacoesPanel />)
  expect((await screen.findByRole('rowheader')).textContent).toBe(titulo.trim())
  expect(document.querySelector('img')).toBeNull()
  expect(screen.queryByText('Gabarito restrito')).toBeNull()
})

test('resposta atrasada de tela fechada não substitui a lista ao reabrir', async () => {
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  const view = render(<MinhasAvaliacoesPanel />)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  view.unmount()
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [atividade] }))
  render(<MinhasAvaliacoesPanel />)
  await screen.findByText(atividade.titulo)
  await act(async () => finish(Response.json({ avaliacoes: [avaliacao] })))
  expect(screen.queryByText(avaliacao.titulo)).toBeNull()
  expect(screen.getByText(atividade.titulo)).toBeTruthy()
})
