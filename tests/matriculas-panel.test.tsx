import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MatriculasPanel } from '../src/components/MatriculasPanel'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))

const pendente = {
  id: '00000000-0000-4000-8000-000000000001', turma_id: 'turma-teste', turma_nome: 'Engenharia 8B',
  aluno_id: 'aluno-teste', aluno_nome: 'Aluno demonstrativo', aluno_rgm: '12345678900',
  situacao: 'PENDENTE', solicitado_em: '2026-10-22T12:00:00Z',
}
const outra = { ...pendente, id: '00000000-0000-4000-8000-000000000002',
  aluno_id: 'outro-aluno', aluno_nome: 'Outra aluna demonstrativa', aluno_rgm: null }
const approveButton = () => screen.getByRole('button', { name: `Aprovar matrícula de ${pendente.aluno_nome} na turma ${pendente.turma_nome}` })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada' } }, error: null })
  mocks.fetch.mockImplementation(async () => Response.json({ matriculas: [pendente, outra] }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('lista usa o serviço real do frontend e mostra aluno, RGM ou ID, turma e data', async () => {
  render(<MatriculasPanel profile="Professor" />)
  await screen.findByText(pendente.aluno_nome)
  expect(screen.getByText(`RGM: ${pendente.aluno_rgm}`)).toBeTruthy()
  expect(screen.getByText(`Aluno (ID): ${outra.aluno_id}`)).toBeTruthy()
  expect(screen.getAllByText(`Turma: ${pendente.turma_nome}`)).toHaveLength(2)
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe(pendente.solicitado_em)
  expect(screen.getByText(/sob sua responsabilidade/)).toBeTruthy()
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/matriculas', {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' }, body: undefined,
  })
  expect(screen.queryByText('sessao-simulada')).toBeNull()
})

test('aprovar envia somente o vínculo e busca novas pendências após confirmação do servidor', async () => {
  render(<MatriculasPanel profile="Administrador" />)
  await screen.findByText(pendente.aluno_nome)
  mocks.fetch.mockResolvedValueOnce(Response.json({ matricula: { ...pendente, situacao: 'ATIVA' } }))
  mocks.fetch.mockResolvedValueOnce(Response.json({ matriculas: [outra] }))
  fireEvent.click(approveButton())
  await screen.findByText(/Matrícula de Aluno demonstrativo.*aprovada/)
  await screen.findByText(outra.aluno_nome)
  expect(screen.queryByRole('button', { name: /Aprovar matrícula de Aluno demonstrativo/ })).toBeNull()
  expect(mocks.fetch).toHaveBeenNthCalledWith(2, '/api/matriculas', {
    method: 'PATCH', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    body: JSON.stringify({ matricula_id: pendente.id }),
  })
  expect(mocks.fetch).toHaveBeenCalledTimes(3)
  expect(document.activeElement?.textContent).toContain('aprovada')
})

test('carregamento e aprovação bloqueiam ações concorrentes e cliques repetidos', async () => {
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  render(<MatriculasPanel profile="Professor" />)
  expect(screen.getByText('Carregando solicitações...')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Atualizar' }).hasAttribute('disabled')).toBe(true)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  await act(async () => finish(Response.json({ matriculas: [pendente, outra] })))
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  const button = approveButton()
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
  expect(button.textContent).toBe('Aprovando...')
  expect(button.getAttribute('aria-busy')).toBe('true')
  for (const action of screen.getAllByRole('button')) expect(action.hasAttribute('disabled')).toBe(true)
  mocks.fetch.mockResolvedValueOnce(Response.json({ matriculas: [] }))
  await act(async () => finish(Response.json({ matricula: { ...pendente, situacao: 'ATIVA' } })))
  await screen.findByText('Nenhuma solicitação pendente.')
})

test.each([401, 403, 404, 409, 503])('erro %i não remove solicitação nem apresenta sucesso', async (status) => {
  render(<MatriculasPanel profile="Professor" />)
  await screen.findByText(pendente.aluno_nome)
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'A matrícula não pode ser aprovada.' }, { status }))
  fireEvent.click(approveButton())
  expect((await screen.findByRole('alert')).textContent).toContain('Atualize a lista')
  expect(screen.getByText(pendente.aluno_nome)).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  expect(approveButton().hasAttribute('disabled')).toBe(false)
  mocks.fetch.mockResolvedValueOnce(Response.json({ matriculas: [] }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText('Nenhuma solicitação pendente.')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('resposta incompleta, pendente ou de outro vínculo não confirma aprovação', async () => {
  render(<MatriculasPanel profile="Professor" />)
  await screen.findByText(pendente.aluno_nome)
  for (const matricula of [{}, pendente, { ...outra, situacao: 'ATIVA' }]) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ matricula }))
    fireEvent.click(approveButton())
    await screen.findByRole('alert')
    expect(screen.getByText(pendente.aluno_nome)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  }
})

test('sessão encerrada antes de aprovar não envia PATCH', async () => {
  render(<MatriculasPanel profile="Professor" />)
  await screen.findByText(pendente.aluno_nome)
  mocks.getSession.mockResolvedValue({ data: { session: null }, error: null })
  fireEvent.click(approveButton())
  expect((await screen.findByRole('alert')).textContent).toContain('Sua sessão terminou')
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('falha ao atualizar oculta lista anterior e permite tentar novamente', async () => {
  render(<MatriculasPanel profile="Professor" />)
  await screen.findByText(pendente.aluno_nome)
  mocks.fetch.mockRejectedValueOnce(new TypeError('Detalhe interno de rede'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Confira sua conexão')
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.queryByText('Detalhe interno de rede')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText(pendente.aluno_nome)
  expect(screen.queryByRole('alert')).toBeNull()
})

test('respostas inválidas de consulta mostram erro, nunca um falso estado vazio', async () => {
  render(<MatriculasPanel profile="Administrador" />)
  await screen.findByText(pendente.aluno_nome)
  for (const matriculas of [null, {}, [{}], [{ ...pendente, situacao: 'ATIVA' }],
    [{ ...pendente, aluno_rgm: 123 }], [{ ...pendente, solicitado_em: 'data-inválida' }],
    Array.from({ length: 51 }, () => pendente)]) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ matriculas }))
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText('Nenhuma solicitação pendente.')).toBeNull()
  }
})
