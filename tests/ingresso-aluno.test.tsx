import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IngressoAlunoGate } from '../src/components/IngressoAlunoGate'
import { consultarIngressoAluno, lerIngressoAluno } from '../src/services/ingressoAluno'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('../src/components/SolicitarMatriculaPanel', () => ({ SolicitarMatriculaPanel: () => <p>Formulário de solicitação</p> }))
vi.mock('../src/components/MinhasMatriculasPanel', () => ({ MinhasMatriculasPanel: () => <p>Acompanhamento da matrícula</p> }))

const pending = { fase: 'PENDENTE', acesso_liberado: false, matriculas_pendentes: 1 }
const allowed = { fase: 'LIBERADO', acesso_liberado: true, matriculas_pendentes: 0 }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.rpc.mockResolvedValue({ data: pending, error: null })
})
afterEach(cleanup)

test('aguarda a resposta sem exibir conteúdo acadêmico', async () => {
  let finish: (value: object) => void = () => {}
  mocks.rpc.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  render(<IngressoAlunoGate onLogout={vi.fn()}><p>Questões da prova</p></IngressoAlunoGate>)
  expect(screen.queryByText('Questões da prova')).toBeNull()
  expect(screen.getByText('Verificando seu ingresso...')).toBeTruthy()
  await act(async () => { finish({ data: pending, error: null }) })
  expect(screen.queryByText('Questões da prova')).toBeNull()
  expect(await screen.findByText('Formulário de solicitação')).toBeTruthy()
})

test('pendente pode solicitar e acompanhar, mas só aprovação libera o painel', async () => {
  render(<IngressoAlunoGate onLogout={vi.fn()}><p>Minhas provas liberadas</p></IngressoAlunoGate>)
  await screen.findByText('Formulário de solicitação')
  fireEvent.click(screen.getByRole('button', { name: 'Minhas matrículas' }))
  expect(screen.getByText('Acompanhamento da matrícula')).toBeTruthy()
  expect(screen.queryByText('Minhas provas liberadas')).toBeNull()
  mocks.rpc.mockResolvedValueOnce({ data: allowed, error: null })
  fireEvent.click(screen.getByRole('button', { name: 'Verificar liberação' }))
  expect(await screen.findByText('Minhas provas liberadas')).toBeTruthy()
  expect(mocks.rpc).toHaveBeenCalledWith('consultar_ingresso_aluno')
})

test('aluno sem matrícula recebe caminho de ingresso, sem conteúdo acadêmico', async () => {
  mocks.rpc.mockResolvedValue({ data: { fase: 'SEM_MATRICULA', acesso_liberado: false, matriculas_pendentes: 0 }, error: null })
  render(<IngressoAlunoGate onLogout={vi.fn()}><p>Painel acadêmico</p></IngressoAlunoGate>)
  expect(await screen.findByText('Formulário de solicitação')).toBeTruthy()
  expect(screen.queryByText('Painel acadêmico')).toBeNull()
})

test('migração ausente bloqueia com instrução específica e permite tentar novamente', async () => {
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
  render(<IngressoAlunoGate onLogout={vi.fn()}><p>Painel acadêmico</p></IngressoAlunoGate>)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('migração 047'))
  expect(screen.queryByText('Formulário de solicitação')).toBeNull()
  expect(screen.queryByText('Painel acadêmico')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Verificar liberação' }))
  expect(await screen.findByText('Formulário de solicitação')).toBeTruthy()
})

test('falha de rede permite sair e não libera conteúdo', async () => {
  const logout = vi.fn().mockResolvedValue(undefined)
  mocks.rpc.mockRejectedValue(new Error('Sem conexão.'))
  render(<IngressoAlunoGate onLogout={logout}><p>Painel acadêmico</p></IngressoAlunoGate>)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sem conexão.')
  fireEvent.click(screen.getByRole('button', { name: 'Sair' }))
  expect(logout).toHaveBeenCalledOnce()
  expect(screen.queryByText('Painel acadêmico')).toBeNull()
})

test('respostas malformadas ou contraditórias não liberam ingresso', async () => {
  for (const data of [null, [], {}, { ...pending, acesso_liberado: true }, { ...allowed, acesso_liberado: false },
    { ...pending, matriculas_pendentes: 0 }, { ...allowed, matriculas_pendentes: -1 },
    { ...pending, fase: { toString: () => 'PENDENTE' } }]) {
    expect(lerIngressoAluno(data)).toBeNull()
    mocks.rpc.mockResolvedValueOnce({ data, error: null })
    await expect(consultarIngressoAluno()).rejects.toThrow('resposta de ingresso está inválida')
  }
})

test('desmontar antes do retorno não reabre o conteúdo', async () => {
  let finish: (value: object) => void = () => {}
  mocks.rpc.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  const { unmount } = render(<IngressoAlunoGate onLogout={vi.fn()}><p>Painel acadêmico</p></IngressoAlunoGate>)
  unmount()
  await act(async () => { finish({ data: allowed, error: null }) })
  expect(screen.queryByText('Painel acadêmico')).toBeNull()
})
