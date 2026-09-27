import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuditPanel } from '../src/components/AuditPanel'

const mocks = vi.hoisted(() => ({
  from: vi.fn(), select: vi.fn(), order: vi.fn(), limit: vi.fn(), eq: vi.fn(), result: vi.fn(),
}))
vi.mock('../src/lib/supabase', () => ({ supabase: { from: mocks.from } }))

const row = {
  id: 'evento-teste', criado_em: '2026-09-27T15:00:00Z', evento: 'LOGIN_SUCESSO',
  provedor: 'SUPABASE_AUTH', acao: 'login', sucesso: true,
  usuario_id: '00000000-0000-4000-8000-000000000001', codigos_erro: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede não permitida neste teste.') }))
  const query = {
    select: mocks.select, order: mocks.order, limit: mocks.limit, eq: mocks.eq,
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      mocks.result().then(resolve, reject),
  }
  for (const mock of [mocks.from, mocks.select, mocks.order, mocks.limit, mocks.eq]) mock.mockReturnValue(query)
  mocks.result.mockResolvedValue({ data: [row], error: null })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('auditoria consulta somente campos necessários e limita aos 50 mais recentes', async () => {
  render(<AuditPanel />)
  await screen.findByText('LOGIN_SUCESSO')
  expect(mocks.from).toHaveBeenCalledWith('eventos_seguranca')
  expect(mocks.select).toHaveBeenCalledWith('id,criado_em,evento,provedor,acao,sucesso,usuario_id,codigos_erro')
  expect(mocks.limit).toHaveBeenCalledWith(50)
  expect(mocks.order).toHaveBeenNthCalledWith(1, 'criado_em', { ascending: false })
  expect(mocks.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
  expect(mocks.eq).not.toHaveBeenCalled()
  expect(screen.getByText(row.usuario_id)).toBeTruthy()
  expect(screen.getByText('Sucesso')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Excluir|Editar/ })).toBeNull()
})

test('filtro é aplicado na consulta do banco e não apenas nos eventos já carregados', async () => {
  render(<AuditPanel />)
  await screen.findByText('LOGIN_SUCESSO')
  mocks.result.mockResolvedValue({ data: [{ ...row, evento: 'LOGIN_NEGADO', sucesso: false, codigos_erro: ['PERFIL_INATIVO'] }], error: null })
  fireEvent.change(screen.getByLabelText('Tipo de evento'), { target: { value: 'LOGIN_NEGADO' } })
  await screen.findByText('LOGIN_NEGADO')
  expect(mocks.eq).toHaveBeenCalledWith('evento', 'LOGIN_NEGADO')
  expect(screen.queryByText('LOGIN_SUCESSO')).toBeNull()
  expect(screen.getByText('Falha / negado')).toBeTruthy()
  expect(screen.getByText('PERFIL_INATIVO')).toBeTruthy()

  fireEvent.change(screen.getByLabelText('Tipo de evento'), { target: { value: '' } })
  await screen.findByText('LOGIN_NEGADO')
  expect(mocks.result).toHaveBeenCalledTimes(3)
  expect(mocks.eq).toHaveBeenCalledTimes(1)
})

test('atualizar busca novamente e mostra o estado vazio sem manter eventos antigos', async () => {
  render(<AuditPanel />)
  await screen.findByText('LOGIN_SUCESSO')
  mocks.result.mockResolvedValue({ data: [], error: null })
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText('Nenhum evento encontrado para este filtro.')
  expect(mocks.result).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('table')).toBeNull()
})

test('carregamento impede cliques repetidos e informa o andamento', async () => {
  let finish!: (value: unknown) => void
  mocks.result.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  render(<AuditPanel />)
  expect(screen.getByText('Carregando eventos...')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Carregando...' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByLabelText('Tipo de evento').hasAttribute('disabled')).toBe(true)
  await act(async () => finish({ data: [], error: null }))
  expect(screen.getByRole('button', { name: 'Atualizar' }).hasAttribute('disabled')).toBe(false)
})

for (const failure of ['permissão', 'rede']) {
  test(`falha de ${failure} limpa dados anteriores e permite tentar novamente`, async () => {
    render(<AuditPanel />)
    await screen.findByText('LOGIN_SUCESSO')
    if (failure === 'rede') mocks.result.mockRejectedValue(new Error('Falha simulada'))
    else mocks.result.mockResolvedValue({ data: null, error: { message: 'erro interno' } })
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('LOGIN_SUCESSO')).toBeNull()
    expect(screen.queryByText('erro interno')).toBeNull()
    expect(screen.getByRole('button', { name: 'Atualizar' }).hasAttribute('disabled')).toBe(false)
  })
}

test('eventos sem usuário associado e detalhes vazios continuam legíveis', async () => {
  mocks.result.mockResolvedValue({ data: [{ ...row, usuario_id: null, evento: 'TURNSTILE_VALIDADO', provedor: 'CLOUDFLARE_TURNSTILE' }], error: null })
  render(<AuditPanel />)
  await screen.findByText('TURNSTILE_VALIDADO')
  expect(screen.getByText('Sem usuário associado')).toBeTruthy()
  expect(screen.getByText('—')).toBeTruthy()
})
