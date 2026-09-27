import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import App from '../src/App'

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  rpc: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
}))

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: {
      signUp: mocks.signUp,
      signOut: mocks.signOut,
      onAuthStateChange: mocks.onAuthStateChange,
    },
  },
}))
vi.mock('../src/services/access', () => ({ resolveAccess: mocks.resolveAccess }))
vi.mock('../src/components/InvitationPanel', () => ({ InvitationPanel: () => null }))
vi.mock('../src/components/MfaStep', () => ({
  MfaStep: ({ mode }: { mode: string }) => <p>Etapa MFA: {mode}</p>,
}))
vi.mock('../src/components/TurnstileWidget', () => ({
  // Só substitui o CAPTCHA dentro dos testes. A aplicação mantém o widget real.
  TurnstileWidget: ({ action, onVerify, onExpire }: {
    action: string
    onVerify: (token: string) => void
    onExpire: () => void
  }) => (
    <>
      <button type="button" onClick={() => onVerify('captcha-simulado')}>
        Validar CAPTCHA de {action}
      </button>
      <button type="button" onClick={onExpire}>Expirar CAPTCHA</button>
    </>
  ),
}))

let authCallback: (event: AuthChangeEvent, session: Session | null) => void
const session = { user: { id: 'conta-de-teste' } } as Session
const email = 'aluno@example.com'

beforeEach(() => {
  vi.resetAllMocks()
  // Qualquer acesso de rede inesperado faz o teste falhar.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede não permitida neste teste.') }))
  mocks.resolveAccess.mockResolvedValue({ kind: 'signed-out' })
  mocks.rpc.mockResolvedValue({ data: { ticket: 'ticket-simulado' }, error: null })
  mocks.signUp.mockResolvedValue({ data: { user: session.user, session: null }, error: null })
  mocks.signOut.mockImplementation(async () => {
    authCallback('SIGNED_OUT', null)
    return { error: null }
  })
  mocks.onAuthStateChange.mockImplementation((callback) => {
    authCallback = callback
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openRegistration() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Boas-vindas' })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeTruthy()
}

async function fillRegistration() {
  await openRegistration()
  for (const [label, value] of [
    ['Nome completo', 'Aluno de teste'],
    ['E-mail', email],
    ['Senha', 'SenhaDeTeste123!'],
    ['Confirmar senha', 'SenhaDeTeste123!'],
    ['Código da organização', 'A'.repeat(21)],
    ['Convite individual do aluno', 'b'.repeat(64)],
  ]) fireEvent.change(screen.getByLabelText(label), { target: { value } })
  verifyCaptcha()
}

function verifyCaptcha() {
  fireEvent.click(screen.getByRole('button', { name: 'Validar CAPTCHA de cadastro' }))
}

async function runEvent(callback: () => void) {
  await act(async () => {
    callback()
    // Aguarda as verificações que o App agenda fora do callback de Auth.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

test('voltar à janela mantém o cadastro, os campos e o widget montado', async () => {
  await fillRegistration()
  const widget = screen.getByRole('button', { name: 'Validar CAPTCHA de cadastro' })
  const checks = mocks.resolveAccess.mock.calls.length

  await runEvent(() => fireEvent.focus(globalThis.window))

  expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeTruthy()
  expect(screen.getByLabelText('E-mail').getAttribute('value')).toBe(email)
  expect(screen.getByRole('button', { name: 'Validar CAPTCHA de cadastro' })).toBe(widget)
  expect(mocks.resolveAccess).toHaveBeenCalledTimes(checks)
  expect(mocks.signUp).not.toHaveBeenCalled()
})

test('SIGNED_OUT não fecha um formulário de cadastro que já estava aberto', async () => {
  await fillRegistration()
  await runEvent(() => authCallback('SIGNED_OUT', null))
  expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeTruthy()
  expect(screen.getByLabelText('Nome completo').getAttribute('value')).toBe('Aluno de teste')
})

test('erro de convite permanece visível após renovar o CAPTCHA e voltar à janela', async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023' } })
  await fillRegistration()
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  const message = 'Não foi possível validar os códigos. Confira-os com a organização.'
  await screen.findByText(message)

  verifyCaptcha()
  await runEvent(() => fireEvent.focus(globalThis.window))

  expect(screen.getByText(message)).toBeTruthy()
  expect(screen.getByLabelText('E-mail').getAttribute('value')).toBe(email)
  expect(mocks.signUp).not.toHaveBeenCalled()
})

test('falha no Auth mantém os dados e não some ao renovar o CAPTCHA', async () => {
  mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { status: 500 } })
  await fillRegistration()
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  const message = 'Não foi possível concluir o cadastro. Confira o convite ou tente mais tarde.'
  await screen.findByText(message)
  verifyCaptcha()
  expect(screen.getByText(message)).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeTruthy()
  expect(screen.getByLabelText('E-mail').getAttribute('value')).toBe(email)
})

test('renovar o CAPTCHA limpa apenas o aviso de CAPTCHA expirado', async () => {
  await fillRegistration()
  fireEvent.click(screen.getByRole('button', { name: 'Expirar CAPTCHA' }))
  expect(screen.getByText('A verificação expirou. Conclua-a novamente.')).toBeTruthy()
  verifyCaptcha()
  expect(screen.queryByText('A verificação expirou. Conclua-a novamente.')).toBeNull()
})

test('sucesso volta ao login com confirmação e limpa o formulário de cadastro', async () => {
  await fillRegistration()
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  await screen.findByText('Solicitação recebida. Confira seu e-mail para confirmar o cadastro.')
  expect(screen.getByRole('heading', { name: 'Boas-vindas' })).toBeTruthy()
  expect(screen.getByLabelText('E-mail').getAttribute('value')).toBe(email)
  expect(mocks.rpc).toHaveBeenCalledWith('preparar_cadastro_aluno', {
    p_email: email, p_codigo_organizacao: 'A'.repeat(21), p_codigo_convite: 'b'.repeat(64),
  })
  expect(mocks.signUp).toHaveBeenCalledWith(expect.objectContaining({
    email,
    options: expect.objectContaining({
      captchaToken: 'captcha-simulado',
      data: { nome: 'Aluno de teste', ticket_cadastro: 'ticket-simulado' },
    }),
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  expect(screen.getByLabelText('E-mail').getAttribute('value')).toBe('')
  expect(screen.getByLabelText('Senha').getAttribute('value')).toBe('')
})

test('SIGNED_IN durante o cadastro não abre MFA antes de terminar a solicitação', async () => {
  let finishSignup!: () => void
  mocks.signUp.mockImplementation(() => new Promise((resolve) => {
    authCallback('SIGNED_IN', session)
    finishSignup = () => resolve({ data: { user: session.user, session }, error: null })
  }))
  await fillRegistration()
  mocks.resolveAccess.mockResolvedValue({ kind: 'setup-totp' })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  await runEvent(() => fireEvent.focus(globalThis.window))

  expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Criando conta...' }).hasAttribute('disabled')).toBe(true)
  expect(mocks.signUp).toHaveBeenCalledTimes(1)
  await act(async () => finishSignup())

  await screen.findByText('Cadastro realizado. Entre para configurar seu Authenticator.')
  expect(screen.getByRole('heading', { name: 'Boas-vindas' })).toBeTruthy()
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('eventos de login fora do cadastro continuam exigindo MFA', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Boas-vindas' })
  mocks.resolveAccess.mockResolvedValue({ kind: 'setup-totp' })
  await runEvent(() => authCallback('SIGNED_IN', session))
  expect(screen.getByText('Etapa MFA: setup')).toBeTruthy()
  await runEvent(() => authCallback('SIGNED_OUT', null))
  expect(screen.getByRole('heading', { name: 'Boas-vindas' })).toBeTruthy()
})

test('voltar à janela ainda verifica uma sessão autenticada e nega perfil bloqueado', async () => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Aluno Teste', email, profile: 'Aluno' },
  })
  render(<App />)
  await screen.findByRole('heading', { name: 'Olá, Aluno.' })
  mocks.resolveAccess.mockResolvedValue({ kind: 'denied', message: 'Perfil bloqueado.' })
  await runEvent(() => fireEvent.focus(globalThis.window))
  expect(screen.getByText('Perfil bloqueado.')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Boas-vindas' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Olá, Aluno.' })).toBeNull()
})
