import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import App from '../src/App'
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/content/legalDocuments'

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
vi.mock('../src/components/AuditPanel', () => ({ AuditPanel: () => <p>Consulta de auditoria</p> }))
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
  window.history.replaceState({}, '', '/')
  // jsdom não implementa o dialog nativo. O foco preso e o fundo inativo
  // também precisam ser conferidos em um navegador real.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', '') } },
    close: { configurable: true, value() { this.removeAttribute('open') } },
  })
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
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
})

async function openRegistration() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Boas-vindas' })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  acceptTerms()
  expect(screen.getByRole('heading', { name: 'Crie sua conta' })).toBeTruthy()
}

function acceptTerms() {
  const checkbox = screen.getByRole('checkbox', { name: 'Li e aceito os Termos de Uso.' })
  expect((checkbox as HTMLInputElement).checked).toBe(false)
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: 'Continuar para o cadastro' }))
}

async function fillRegistration() {
  await openRegistration()
  for (const [label, value] of [
    ['Nome completo', 'Aluno de teste'],
    ['E-mail', email],
    ['Senha', 'SenhaDeTeste123!'],
    ['Confirmar senha', 'SenhaDeTeste123!'],
    ['Código da organização', 'A'.repeat(21)],
    ['Convite individual', 'b'.repeat(64)],
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

test('antes do cadastro mostra termos com aceite desmarcado e botão desabilitado', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Boas-vindas' })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))

  expect(screen.getByRole('dialog', { name: 'Termos de Uso' })).toBeTruthy()
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement
  const button = screen.getByRole('button', { name: 'Continuar para o cadastro' })
  expect(checkbox.checked).toBe(false)
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(screen.queryByLabelText('Nome completo')).toBeNull()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.signUp).not.toHaveBeenCalled()

  fireEvent.click(checkbox)
  expect(button.hasAttribute('disabled')).toBe(false)
  fireEvent.click(checkbox)
  expect(button.hasAttribute('disabled')).toBe(true)
})

for (const closeAction of ['Cancelar', 'Fechar documento', 'Escape']) {
  test(`${closeAction} fecha os termos sem abrir cadastro e reabre sem aceite`, async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Boas-vindas' })
    const trigger = screen.getByRole('button', { name: 'Criar conta' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Termos de Uso' }))
    fireEvent.click(screen.getByRole('checkbox'))

    if (closeAction === 'Escape') {
      fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: closeAction }))
    }

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(document.body.style.overflow).toBe('')
    expect(screen.queryByLabelText('Nome completo')).toBeNull()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.signUp).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
}

test('a política pode ser consultada dentro dos termos sem aceitar ou abrir cadastro', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Boas-vindas' })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  fireEvent.click(screen.getByRole('button', { name: 'Consultar Política de Privacidade' }))
  expect(screen.getByRole('dialog', { name: 'Política de Privacidade' })).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continuar para o cadastro' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Voltar aos termos', exact: true }))
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  expect(mocks.signUp).not.toHaveBeenCalled()
})

for (const [documentName, path] of [['Termos de Uso', '/termos'], ['Política de Privacidade', '/privacidade']]) {
  test(`${documentName} tem link público no rodapé sem exigir aceite`, async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Boas-vindas' })
    const link = screen.getByRole('link', { name: `${documentName} (abre em nova aba)` })
    expect(link.getAttribute('href')).toBe(path)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.closest('footer')).toBe(screen.getByRole('contentinfo'))
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continuar para o cadastro' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('Nome completo')).toBeNull()
    expect(mocks.signUp).not.toHaveBeenCalled()
  })

  test(`${path} abre diretamente sem montar autenticação ou pedir aceite`, () => {
    window.history.replaceState({}, '', path)
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: documentName })).toBeTruthy()
    expect(document.title).toBe(`${documentName} | ExamenTech`)
    expect(screen.getByRole('link', { name: 'modusmartinezex@gmail.com' }).getAttribute('href')).toBe('mailto:modusmartinezex@gmail.com')
    for (const name of ['João Pedro Martinez Landeira', 'Kenny Nascimento Pires', 'André Kenzo Narawa Nishiguchi']) {
      expect(screen.getByRole('article').textContent).toContain(name)
    }
    expect(screen.getByRole('contentinfo').querySelectorAll('a')).toHaveLength(2)
    expect(screen.getByRole('link', { name: documentName, exact: true }).getAttribute('target')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(mocks.resolveAccess).not.toHaveBeenCalled()
    expect(mocks.onAuthStateChange).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.signUp).not.toHaveBeenCalled()
  })
}

test('aceitar abre e foca o cadastro; voltar ao login exige novo aceite', async () => {
  await openRegistration()
  expect(document.activeElement).toBe(screen.getByLabelText('Nome completo'))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '← Voltar' }))
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
})

test('links dos documentos preservam cadastro e aceite ao abrir em nova aba', async () => {
  await fillRegistration()
  const link = screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' })
  expect(link.getAttribute('target')).toBe('_blank')
  await runEvent(() => fireEvent.focus(globalThis.window))
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByLabelText('E-mail').getAttribute('value')).toBe(email)
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  await screen.findByText('Solicitação recebida. Confira seu e-mail para confirmar o cadastro.')
  expect(mocks.signUp).toHaveBeenCalledTimes(1)
})

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
  expect(mocks.rpc).toHaveBeenCalledWith('preparar_cadastro', {
    p_email: email, p_codigo_organizacao: 'A'.repeat(21), p_codigo_convite: 'b'.repeat(64),
  })
  expect(mocks.signUp).toHaveBeenCalledWith(expect.objectContaining({
    email,
    options: expect.objectContaining({
      captchaToken: 'captcha-simulado',
      data: {
        nome: 'Aluno de teste', ticket_cadastro: 'ticket-simulado',
        termos_aceitos: true, termos_versao: TERMS_VERSION, privacidade_versao: PRIVACY_VERSION,
      },
    }),
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  acceptTerms()
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

test('login em outra aba fecha o modal de cadastro e encaminha para MFA', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Boas-vindas' })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  fireEvent.click(screen.getByRole('checkbox'))
  mocks.resolveAccess.mockResolvedValue({ kind: 'setup-totp' })
  await runEvent(() => authCallback('SIGNED_IN', session))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByLabelText('Nome completo')).toBeNull()
  expect(screen.getByText('Etapa MFA: setup')).toBeTruthy()
  expect(mocks.signUp).not.toHaveBeenCalled()
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

test('cadastro compartilhado não permite escolher nem enviar o perfil da conta', async () => {
  await fillRegistration()
  expect(screen.getByText('Seu convite define se a conta será de aluno ou professor.')).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  await screen.findByText('Solicitação recebida. Confira seu e-mail para confirmar o cadastro.')
  const metadata = mocks.signUp.mock.calls[0][0].options.data
  expect(metadata).not.toHaveProperty('perfil')
  expect(metadata).not.toHaveProperty('perfil_destino')
})

for (const profile of ['Professor', 'Aluno', 'Administrador']) {
  test(`painel ${profile}: auditoria disponível somente ao administrador`, async () => {
    mocks.resolveAccess.mockResolvedValue({ kind: 'ready', user: { name: 'Conta Teste', email, profile } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Olá, Conta.' })
    expect(screen.getByRole('contentinfo').querySelectorAll('a')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Política de Privacidade (abre em nova aba)' }).getAttribute('href')).toBe('/privacidade')
    if (profile === 'Administrador') {
      fireEvent.click(screen.getByRole('button', { name: 'Auditoria' }))
      expect(screen.getByText('Consulta de auditoria')).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Início' }))
      expect(screen.getByRole('heading', { name: 'Olá, Conta.' })).toBeTruthy()
    } else {
      expect(screen.queryByRole('button', { name: 'Auditoria' })).toBeNull()
      expect(screen.queryByText('Consulta de auditoria')).toBeNull()
    }
  })
}

test('rodapé fica disponível durante a verificação de sessão', () => {
  mocks.resolveAccess.mockReturnValue(new Promise(() => {}))
  render(<App />)
  expect(screen.getByText('Verificando sua sessão...')).toBeTruthy()
  expect(screen.getByRole('contentinfo').querySelectorAll('a')).toHaveLength(2)
})

for (const [kind, mode] of [['setup-totp', 'setup'], ['verify-totp', 'verify']]) {
  test(`rodapé permanece disponível na etapa MFA ${mode}`, async () => {
    mocks.resolveAccess.mockResolvedValue({ kind, factorId: 'fator-simulado' })
    render(<App />)
    await screen.findByText(`Etapa MFA: ${mode}`)
    expect(screen.getByRole('contentinfo').querySelectorAll('a')).toHaveLength(2)
  })
}

test('política descreve a demonstração e a retenção manual, sem prometer limpeza automática', () => {
  window.history.replaceState({}, '', '/privacidade/')
  render(<App />)
  const text = screen.getByRole('article').textContent
  for (const detail of ['3 meses', 'coleta de cada registro', 'manual nesta versão', 'não existe limpeza automática', 'Locaweb', 'Vercel', 'Supabase', 'Cloudflare']) {
    expect(text).toContain(detail)
  }
  expect(text).not.toContain('ainda não definido')
})
