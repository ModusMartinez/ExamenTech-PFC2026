import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AdminMfaPanel } from '../src/components/AdminMfaPanel'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const usuario = { id: '230698c3-cb6a-4e5d-a289-f78d7f425b32', nome: 'Aluno fictício', email: 'aluno@example.test', perfil: 'ALUNO' }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('fetch', mocks.fetch)
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token-teste' } }, error: null })
  mocks.fetch.mockResolvedValue(Response.json({ usuarios: [usuario] }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function selecionar() {
  fireEvent.change(screen.getByLabelText('Nome ou e-mail do usuário'), { target: { value: 'aluno' } })
  fireEvent.click(screen.getByRole('button', { name: 'Buscar usuário' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Redefinir 2FA de Aluno fictício' }))
}

test('exige seleção e confirmação explícita antes de enviar reset, bloqueia envio duplicado e mostra sucesso confirmado', async () => {
  render(<AdminMfaPanel />)
  await selecionar()
  const confirm = screen.getByRole('button', { name: 'Confirmar redefinição' })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('checkbox'))
  let finish!: (response: Response) => void
  mocks.fetch.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.click(confirm); fireEvent.click(confirm)
  expect(confirm.hasAttribute('disabled')).toBe(true)
  await act(async () => { finish(Response.json({ redefinido: true })) })
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.fetch).toHaveBeenLastCalledWith('/api/redefinir-mfa', expect.objectContaining({
    body: JSON.stringify({ usuario_id: usuario.id, confirmado: true }),
    headers: { Authorization: 'Bearer token-teste', 'Content-Type': 'application/json' },
  }))
  expect(screen.getByRole('status').textContent).toContain('No próximo acesso será exigida nova configuração')
  expect(screen.queryByRole('checkbox')).toBeNull()
})

test('cancelamento não altera MFA e falha de rede não é apresentada como sucesso', async () => {
  render(<AdminMfaPanel />)
  await selecionar()
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Redefinir 2FA de Aluno fictício' }))
  fireEvent.click(screen.getByRole('checkbox'))
  mocks.fetch.mockRejectedValue(new TypeError('Falha privada'))
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar redefinição' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Confira a auditoria antes de repetir')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByText('Falha privada')).toBeNull()
})
