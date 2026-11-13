import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MinhasMatriculasPanel } from '../src/components/MinhasMatriculasPanel'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))

const matriculas = ['PENDENTE', 'ATIVA', 'INATIVA'].map((situacao, index) => ({
  id: `matricula-${index}`, turma_id: `turma-${index}`, turma_nome: `Engenharia ${index + 1}`,
  situacao, solicitado_em: '2026-10-23T12:00:00Z',
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada' } }, error: null })
  mocks.fetch.mockImplementation(async () => Response.json({ matriculas }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('lista apresenta turma, data e todas as situações usando o serviço real do frontend', async () => {
  render(<MinhasMatriculasPanel />)
  await screen.findByText(matriculas[0].turma_nome)
  for (const situacao of ['Pendente', 'Ativa', 'Inativa']) {
    expect(screen.getByText(`Situação: ${situacao}`)).toBeTruthy()
  }
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe(matriculas[0].solicitado_em)
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/matriculas?consulta=minhas', {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' }, body: undefined,
  })
  expect(screen.queryByRole('button', { name: /Aprovar|Cancelar|Excluir/ })).toBeNull()
  expect(screen.queryByText('sessao-simulada')).toBeNull()
})

test('Atualizar busca a situação aprovada no servidor sem alterar a matrícula', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ matriculas: [matriculas[0]] }))
  render(<MinhasMatriculasPanel />)
  await screen.findByText('Situação: Pendente')
  mocks.fetch.mockResolvedValueOnce(Response.json({ matriculas: [{ ...matriculas[0], situacao: 'ATIVA' }] }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText('Situação: Ativa')
  expect(screen.queryByText('Situação: Pendente')).toBeNull()
  expect(screen.getByText(matriculas[0].turma_nome)).toBeTruthy()
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
})

test('carregamento bloqueia atualização repetida e lista vazia orienta solicitar matrícula', async () => {
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  render(<MinhasMatriculasPanel />)
  expect(screen.getByText('Carregando suas matrículas...')).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Atualizar' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  await act(async () => finish(Response.json({ matriculas: [] })))
  expect(screen.getByText(/Nenhuma matrícula encontrada/)).toBeTruthy()
  expect(screen.queryByRole('list')).toBeNull()
  expect(button.hasAttribute('disabled')).toBe(false)
})

test.each([401, 403, 503])('falha HTTP %i mostra erro e não simula lista vazia', async (status) => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível para esta sessão.' }, { status }))
  render(<MinhasMatriculasPanel />)
  expect((await screen.findByRole('alert')).textContent).toBe('Consulta indisponível para esta sessão.')
  expect(screen.queryByText(/Nenhuma matrícula encontrada/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText(matriculas[0].turma_nome)
  expect(screen.queryByRole('alert')).toBeNull()
})

test('sem sessão não chama API', async () => {
  mocks.getSession.mockResolvedValue({ data: { session: null }, error: null })
  render(<MinhasMatriculasPanel />)
  expect((await screen.findByRole('alert')).textContent).toBe('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('falha de rede ao atualizar oculta dados anteriores e permite nova tentativa', async () => {
  render(<MinhasMatriculasPanel />)
  await screen.findByText(matriculas[0].turma_nome)
  mocks.fetch.mockRejectedValueOnce(new TypeError('Detalhe interno de teste'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Confira sua conexão')
  expect(screen.queryByRole('list')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText(matriculas[0].turma_nome)
})

test('contrato incompleto, situação desconhecida, data inválida ou HTML não são tratados como matrículas', async () => {
  render(<MinhasMatriculasPanel />)
  await screen.findByText(matriculas[0].turma_nome)
  for (const response of [
    Response.json({ matriculas: null }), Response.json({ matriculas: [{}] }),
    Response.json({ matriculas: [{ ...matriculas[0], situacao: 'APROVADA' }] }),
    Response.json({ matriculas: [{ ...matriculas[0], solicitado_em: 'inválida' }] }),
    Response.json({ matriculas: Array.from({ length: 51 }, () => matriculas[0]) }),
    new Response('<html>Indisponível</html>', { status: 503 }),
  ]) {
    mocks.fetch.mockResolvedValueOnce(response)
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText(/Nenhuma matrícula encontrada/)).toBeNull()
  }
})
