import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import { listarAvaliacoesRascunho } from '../src/services/avaliacoes'
import type { Turma } from '../src/services/turmas'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({ listarTurmas: mocks.listar, criarTurma: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turma: Turma = {
  id: '10000000-0000-0000-0000-000000000001', nome: 'Engenharia 8B',
  professor_id: '20000000-0000-0000-0000-000000000001', codigo_ingresso: 'ABCDEF123456',
  situacao: 'ATIVA', criado_em: '2026-10-20T12:00:00Z',
}
const outra: Turma = { ...turma, id: '10000000-0000-0000-0000-000000000002', nome: 'Turma anterior', situacao: 'INATIVA' }
const avaliacao = {
  id: '30000000-0000-0000-0000-000000000001', turma_id: turma.id, professor_id: turma.professor_id,
  titulo: 'Prova de Engenharia', tipo: 'PROVA', inicio_em: '2026-11-09T22:00:00Z',
  fim_em: '2026-11-10T00:00:00Z', duracao_minutos: 60, situacao: 'RASCUNHO', criado_em: '2026-10-28T12:00:00Z',
}
const atividade = { ...avaliacao, id: '30000000-0000-0000-0000-000000000002', titulo: 'Atividade de revisão', tipo: 'ATIVIDADE' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listar.mockResolvedValue([turma, outra])
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada' } }, error: null })
  mocks.fetch.mockImplementation(async () => Response.json({ avaliacoes: [], limite: 50 }))
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function abrir(profile: 'Professor' | 'Administrador' = 'Professor', nome = turma.nome) {
  render(<TurmasPanel profile={profile} />)
  const button = await screen.findByRole('button', { name: `Rascunhos de ${nome}` })
  expect(mocks.fetch).not.toHaveBeenCalled()
  fireEvent.click(button)
  return button
}

test.each(['Professor', 'Administrador'] as const)('%s abre e fecha rascunhos, mostrando campos e ordem recebida sem ações de escrita', async (profile) => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [atividade, avaliacao], limite: 50 }))
  const button = await abrir(profile)
  const table = await screen.findByRole('table', { name: `Avaliações em rascunho de ${turma.nome}` })
  expect(within(table).getAllByRole('columnheader').map((item) => item.textContent)).toEqual(['Título', 'Tipo', 'Início', 'Fim', 'Duração', 'Situação'])
  expect(within(table).getAllByRole('rowheader').map((item) => item.textContent)).toEqual([atividade.titulo, avaliacao.titulo])
  expect(within(table).getByRole('cell', { name: 'Prova' })).toBeTruthy()
  expect(within(table).getByRole('cell', { name: 'Atividade' })).toBeTruthy()
  expect(within(table).getAllByRole('cell', { name: '60 min' })).toHaveLength(2)
  expect(within(table).getAllByRole('cell', { name: 'Rascunho' })).toHaveLength(2)
  const dates = table.querySelectorAll('time')
  expect(dates[0].dateTime).toBe('2026-11-09T22:00:00.000Z')
  expect(dates[0].textContent).toBe(new Date(avaliacao.inicio_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))
  expect(dates[1].textContent).toBe(new Date(avaliacao.fim_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(`/api/avaliacoes?turma_id=${turma.id}`, {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada' }, cache: 'no-store',
  })
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(screen.queryByRole('button', { name: /Publicar|Editar|Excluir/ })).toBeNull()
  fireEvent.click(button)
  expect(screen.queryByRole('table')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

test('turma inativa permite consultar rascunhos e atualizar uma lista vazia', async () => {
  await abrir('Administrador', outra.nome)
  await screen.findByText('Nenhum rascunho nesta turma.')
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [{ ...avaliacao, turma_id: outra.id }], limite: 50 }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByRole('rowheader', { name: avaliacao.titulo })
  expect(screen.queryByText('Nenhum rascunho nesta turma.')).toBeNull()
  expect(mocks.fetch.mock.calls.every(([url, options]) => url.endsWith(outra.id) && options.method === 'GET')).toBe(true)
})

test('trocar de turma ignora resposta atrasada e bloqueia atualização durante a consulta', async () => {
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  await abrir()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByText('Carregando rascunhos...')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Atualizar rascunhos' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${outra.nome}` }))
  await screen.findByText('Nenhum rascunho nesta turma.')
  await act(async () => finish(Response.json({ avaliacoes: [avaliacao], limite: 50 })))
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('region', { name: `Rascunhos de ${turma.nome}` })).toBeNull()
  expect(screen.getByRole('region', { name: `Rascunhos de ${outra.nome}` })).toBeTruthy()
})

test.each([401, 403, 404, 503])('erro %i oculta resultado anterior e permite nova consulta', async (status) => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [avaliacao], limite: 50 }))
  await abrir()
  await screen.findByRole('table')
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível.' }, { status }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Consulta indisponível.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('Nenhum rascunho nesta turma.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByText('Nenhum rascunho nesta turma.')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('sessão ausente e falhas de rede/JSON não viram lista vazia', async () => {
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  await abrir()
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Falha de rede'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByText(/Confira sua conexão/)
  mocks.fetch.mockResolvedValueOnce(new Response('<html>Erro</html>'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByText('Não foi possível conferir a lista de rascunhos.')
  expect(screen.queryByText('Nenhum rascunho nesta turma.')).toBeNull()
})

test.each([
  null, [], {}, { avaliacoes: null, limite: 50 }, { avaliacoes: [], limite: 100 }, { avaliacoes: [] },
  ...[{}, { ...avaliacao, turma_id: outra.id }, { ...avaliacao, situacao: 'PUBLICADA' },
    { ...avaliacao, inicio_em: 'inválido' }, { ...avaliacao, duracao_minutos: '60' }]
    .map((item) => ({ avaliacoes: [item], limite: 50 })),
  { avaliacoes: [avaliacao, avaliacao], limite: 50 },
  { avaliacoes: Array.from({ length: 51 }, (_, i) => ({ ...avaliacao, id: `30000000-0000-0000-0000-${String(i).padStart(12, '0')}` })), limite: 50 },
])('recusa resposta fora do contrato (%j)', async (result) => {
  mocks.fetch.mockResolvedValueOnce(Response.json(result))
  await expect(listarAvaliacoesRascunho(turma.id)).rejects.toThrow('Não foi possível conferir a lista de rascunhos.')
})

test('lista 50 registros sem truncamento silencioso e informa o limite', async () => {
  const avaliacoes = Array.from({ length: 50 }, (_, i) => ({
    ...avaliacao, id: `30000000-0000-0000-0000-${String(i).padStart(12, '0')}`, titulo: `Rascunho ${i}`,
  }))
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes, limite: 50 }))
  await abrir()
  expect(within(await screen.findByRole('table')).getAllByRole('row')).toHaveLength(51)
  expect(screen.getByText(/Até 50 rascunhos mais recentes/)).toBeTruthy()
})

test('ID inválido não consulta sessão nem rede; erro de sessão não envia requisição', async () => {
  await expect(listarAvaliacoesRascunho('inválido')).rejects.toThrow('ID da turma inválido.')
  expect(mocks.getSession).not.toHaveBeenCalled()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: new Error('Falha de sessão') })
  await expect(listarAvaliacoesRascunho(turma.id)).rejects.toThrow('Sua sessão terminou.')
  expect(mocks.fetch).not.toHaveBeenCalled()
})
