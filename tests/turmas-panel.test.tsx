// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import type { Turma } from '../src/services/turmas'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), criar: vi.fn() }))
vi.mock('../src/services/turmas', () => ({
  listarTurmas: mocks.listar, criarTurma: mocks.criar,
}))
const turma: Turma = {
  id: 'turma-teste', nome: 'Engenharia 8B', professor_id: 'professor-teste',
  codigo_ingresso: 'ABCDEF123456', situacao: 'ATIVA', criado_em: '2026-10-20T12:00:00Z',
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.listar.mockResolvedValue([])
  mocks.criar.mockResolvedValue(turma)
})
afterEach(cleanup)

test('professor consulta lista vazia e cria uma turma com nome normalizado', async () => {
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: '  Engenharia 8B  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar turma' }))
  await screen.findByText('Turma “Engenharia 8B” criada.')
  expect(mocks.criar).toHaveBeenCalledExactlyOnceWith('Engenharia 8B')
  expect(screen.getByText('ABCDEF123456')).toBeTruthy()
  expect((screen.getByLabelText('Nome da turma') as HTMLInputElement).value).toBe('')
})

test('validação impede enviar nome curto', async () => {
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: 'AB' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar turma' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(mocks.criar).not.toHaveBeenCalled()
})

test('erro na criação mantém o nome para corrigir ou tentar novamente', async () => {
  mocks.criar.mockRejectedValue(new Error('Acesso não autorizado.'))
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: 'Engenharia 8B' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar turma' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Acesso não autorizado.')
  expect((screen.getByLabelText('Nome da turma') as HTMLInputElement).value).toBe('Engenharia 8B')
  expect(screen.queryByText('ABCDEF123456')).toBeNull()
})

test('administrador consulta turmas sem formulário de criação', async () => {
  mocks.listar.mockResolvedValue([turma])
  render(<TurmasPanel profile="Administrador" />)
  await screen.findByText('Engenharia 8B')
  expect(screen.queryByLabelText('Nome da turma')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Criar turma' })).toBeNull()
  expect(screen.getByText('professor-teste')).toBeTruthy()
})

test('atualizar recupera a lista depois de falha', async () => {
  mocks.listar.mockRejectedValueOnce(new Error('Serviço indisponível.')).mockResolvedValueOnce([turma])
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Serviço indisponível.')
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText('Engenharia 8B')
  expect(screen.queryByText('Serviço indisponível.')).toBeNull()
})

test('envio em andamento não cria duas turmas e bloqueia atualização concorrente', async () => {
  let finish: (result: Turma) => void = () => {}
  mocks.criar.mockImplementation(() => new Promise<Turma>((resolve) => { finish = resolve }))
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: turma.nome } })
  const form = screen.getByLabelText('Nome da turma').closest('form')!
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(mocks.criar).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('button', { name: 'Atualizar' }) as HTMLButtonElement).disabled).toBe(true)
  finish(turma)
  await waitFor(() => expect(screen.getByText('ABCDEF123456')).toBeTruthy())
})
