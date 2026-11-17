import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import App from '../src/App'
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/content/legalDocuments'

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  resolveRecoveryAccess: vi.fn(),
  getSession: vi.fn(),
  rpc: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  consultarIngressoAluno: vi.fn(),
}))

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: {
      getSession: mocks.getSession,
      signUp: mocks.signUp,
      signOut: mocks.signOut,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      updateUser: mocks.updateUser,
      onAuthStateChange: mocks.onAuthStateChange,
    },
  },
}))
vi.mock('../src/services/access', () => ({
  resolveAccess: mocks.resolveAccess,
  resolveRecoveryAccess: mocks.resolveRecoveryAccess,
}))
vi.mock('../src/services/ingressoAluno', () => ({ consultarIngressoAluno: mocks.consultarIngressoAluno }))
vi.mock('../src/components/DashboardOverview', () => ({ DashboardOverview: () => <h2>Indicadores acadêmicos</h2> }))
vi.mock('../src/components/InvitationPanel', () => ({ InvitationPanel: () => null }))
vi.mock('../src/components/AuditPanel', () => ({ AuditPanel: () => <p>Consulta de auditoria</p> }))
vi.mock('../src/components/NovaAvaliacaoPanel', () => ({ NovaAvaliacaoPanel: () => <>
  <p>Cadastro de rascunho</p>
  <label>Título do rascunho<input /></label>
</> }))
vi.mock('../src/components/MatriculasPanel', () => ({
  MatriculasPanel: ({ profile }: { profile: string }) => <p>Pendências para {profile}</p>,
}))
vi.mock('../src/components/MinhasMatriculasPanel', () => ({
  MinhasMatriculasPanel: () => <p>Consulta das minhas matrículas</p>,
}))
vi.mock('../src/components/MfaStep', () => ({
  MfaStep: ({ mode, onComplete }: { mode: string; onComplete: () => Promise<void> }) => <>
    <p>Etapa MFA: {mode}</p>
    <button type="button" onClick={() => void onComplete()}>Confirmar MFA simulado</button>
  </>,
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
  mocks.resolveRecoveryAccess.mockResolvedValue({ kind: 'verified' })
  mocks.consultarIngressoAluno.mockResolvedValue({ fase: 'LIBERADO', acesso_liberado: true, matriculas_pendentes: 0 })
  mocks.rpc.mockResolvedValue({ data: { ticket: 'ticket-simulado' }, error: null })
  mocks.signUp.mockResolvedValue({ data: { user: session.user, session: null }, error: null })
  mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
  mocks.updateUser.mockResolvedValue({ data: { user: session.user }, error: null })
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
  await screen.findByRole('heading', { name: 'Acessar o Sistema' })
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
    ['RGM', ' 00ab-123 '],
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await act(async () => {
      callback()
      // Executa a verificação agendada pelo Auth sem esperar tempo real.
      await vi.runOnlyPendingTimersAsync()
    })
  } finally {
    vi.useRealTimers()
  }
}

test('antes do cadastro mostra termos com aceite desmarcado e botão desabilitado', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Acessar o Sistema' })
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
    await screen.findByRole('heading', { name: 'Acessar o Sistema' })
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
  await screen.findByRole('heading', { name: 'Acessar o Sistema' })
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
    await screen.findByRole('heading', { name: 'Acessar o Sistema' })
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

for (const [field, value, message] of [
  ['Código da organização', 'A'.repeat(20), 'O código da organização precisa ter 21 caracteres. Foram informados 20.'],
  ['Convite individual', 'b'.repeat(63), 'O convite individual precisa ter 64 caracteres. Foram informados 63.'],
]) {
  test(`cadastro identifica ${field} incompleto antes de pedir ticket, sem exibir o código`, async () => {
    await fillRegistration()
    fireEvent.change(screen.getByLabelText(field), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
    await screen.findByText(message)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.signUp).not.toHaveBeenCalled()
    expect(screen.getByLabelText(field).getAttribute('value')).toBe(value)
  })
}

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
  expect(screen.getByRole('heading', { name: 'Acessar o Sistema' })).toBeTruthy()
  expect(screen.getByLabelText('E-mail').getAttribute('value')).toBe(email)
  expect(mocks.rpc).toHaveBeenCalledWith('preparar_cadastro_com_rgm', {
    p_email: email, p_codigo_organizacao: 'A'.repeat(21), p_codigo_convite: 'b'.repeat(64),
    p_rgm: '00AB-123',
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
  expect(screen.getByLabelText('RGM').getAttribute('value')).toBe('')
})

test('RGM inválido impede pedir ticket e criar conta', async () => {
  await fillRegistration()
  fireEvent.change(screen.getByLabelText('RGM'), { target: { value: '12 34' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  expect(screen.getByRole('alert').textContent).toContain('RGM')
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.signUp).not.toHaveBeenCalled()
})

for (const [code, message] of [
  ['P2010', 'Informe o RGM para concluir o cadastro de aluno.'],
  ['P2011', 'O RGM informado é inválido. Confira o registro fornecido pela instituição.'],
  ['P2012', 'Este RGM já está cadastrado. Confira com o responsável pela instituição.'],
]) {
  test(`cadastro mostra falha de RGM ${code} sem iniciar Auth`, async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code } })
    await fillRegistration()
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
    await screen.findByText(message)
    expect(mocks.signUp).not.toHaveBeenCalled()
  })
}

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
  expect(screen.getByRole('heading', { name: 'Acessar o Sistema' })).toBeTruthy()
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
})

test('eventos de login fora do cadastro continuam exigindo MFA', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Acessar o Sistema' })
  mocks.resolveAccess.mockResolvedValue({ kind: 'setup-totp' })
  await runEvent(() => authCallback('SIGNED_IN', session))
  expect(screen.getByText('Etapa MFA: setup')).toBeTruthy()
  await runEvent(() => authCallback('SIGNED_OUT', null))
  expect(screen.getByRole('heading', { name: 'Acessar o Sistema' })).toBeTruthy()
})

test('login em outra aba fecha o modal de cadastro e encaminha para MFA', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Acessar o Sistema' })
  fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
  fireEvent.click(screen.getByRole('checkbox'))
  mocks.resolveAccess.mockResolvedValue({ kind: 'setup-totp' })
  await runEvent(() => authCallback('SIGNED_IN', session))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByLabelText('Nome completo')).toBeNull()
  expect(screen.getByText('Etapa MFA: setup')).toBeTruthy()
  expect(mocks.signUp).not.toHaveBeenCalled()
})

test.each(['Professor', 'Administrador', 'Aluno'])('voltar à janela preserva a navegação de %s', async profile => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Pessoa Teste', email, profile },
  })
  render(<App />)
  await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
  fireEvent.click(screen.getByRole('button', { name: 'Início' }))
  const heading = screen.getByRole('heading', { name: 'Olá, Pessoa.' })
  const checks = mocks.resolveAccess.mock.calls.length

  fireEvent(window, new Event('blur'))
  fireEvent(document, new Event('visibilitychange'))
  await runEvent(() => fireEvent.focus(window))

  expect(screen.getByRole('heading', { name: 'Olá, Pessoa.' })).toBe(heading)
  expect(mocks.resolveAccess).toHaveBeenCalledTimes(checks)
})

test('reconfirmação e renovação da mesma conta preservam um rascunho durante e após a consulta', async () => {
  const access = { kind: 'ready', user: { name: 'Professor Teste', email, profile: 'Professor' } }
  mocks.resolveAccess.mockResolvedValue(access)
  render(<App />)
  await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
  authCallback('INITIAL_SESSION', session)
  fireEvent.click(screen.getByRole('button', { name: 'Nova avaliação' }))
  const input = screen.getByRole('textbox', { name: 'Título do rascunho' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'Prova em elaboração' } })

  for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'] as const) {
    let finish!: (value: typeof access) => void
    mocks.resolveAccess.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await runEvent(() => authCallback(event, session))
    expect(screen.queryByText('Verificando sua sessão...')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Título do rascunho' })).toBe(input)
    expect(input.value).toBe('Prova em elaboração')
    await act(async () => finish(access))
    expect(screen.getByRole('textbox', { name: 'Título do rascunho' })).toBe(input)
    expect(input.value).toBe('Prova em elaboração')
  }
  expect(mocks.resolveAccess).toHaveBeenCalledTimes(4)
})

test('falha na reconfirmação permite repetir a consulta sem perder o formulário', async () => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Professor Teste', email, profile: 'Professor' },
  })
  render(<App />)
  await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
  authCallback('INITIAL_SESSION', session)
  fireEvent.click(screen.getByRole('button', { name: 'Nova avaliação' }))
  const input = screen.getByRole('textbox', { name: 'Título do rascunho' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'Rascunho preservado' } })
  mocks.resolveAccess.mockRejectedValueOnce(new Error('Rede indisponível.'))

  await runEvent(() => authCallback('TOKEN_REFRESHED', session))
  expect(screen.getByRole('alert').textContent).toContain('Não foi possível confirmar sua sessão.')
  expect(screen.getByRole('textbox', { name: 'Título do rascunho' })).toBe(input)
  fireEvent.click(screen.getByRole('button', { name: 'Verificar sessão' }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Título do rascunho' })).toBe(input)
  expect(input.value).toBe('Rascunho preservado')
})

test('saída da conta invalida uma reconfirmação ainda pendente', async () => {
  const access = { kind: 'ready', user: { name: 'Professor Teste', email, profile: 'Professor' } }
  mocks.resolveAccess.mockResolvedValue(access)
  render(<App />)
  await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
  authCallback('INITIAL_SESSION', session)
  let finish!: (value: typeof access) => void
  mocks.resolveAccess.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await runEvent(() => authCallback('TOKEN_REFRESHED', session))
  await runEvent(() => authCallback('SIGNED_OUT', null))
  await act(async () => finish(access))
  expect(screen.getByRole('heading', { name: 'Acessar o Sistema' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Nova avaliação' })).toBeNull()
})

test('troca de conta remove o formulário anterior antes de validar o novo acesso', async () => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Professor Teste', email, profile: 'Professor' },
  })
  render(<App />)
  await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
  authCallback('INITIAL_SESSION', session)
  fireEvent.click(screen.getByRole('button', { name: 'Nova avaliação' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Rascunho da primeira conta' } })
  let finish!: (value: object) => void
  mocks.resolveAccess.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const otherSession = { ...session, user: { ...session.user, id: 'outra-conta' } }

  await runEvent(() => authCallback('SIGNED_IN', otherSession))
  expect(screen.getByText('Verificando sua sessão...')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  await act(async () => finish({ kind: 'ready', user: { name: 'Outro Professor', email: 'outro@example.test', profile: 'Professor' } }))
  expect(screen.getByRole('heading', { name: 'Indicadores acadêmicos' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Nova avaliação' }))
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
})

test('mudança de perfil na mesma conta reinicia a navegação com as novas permissões', async () => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Pessoa Teste', email, profile: 'Professor' },
  })
  render(<App />)
  await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
  authCallback('INITIAL_SESSION', session)
  fireEvent.click(screen.getByRole('button', { name: 'Nova avaliação' }))
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Pessoa Teste', email, profile: 'Administrador' },
  })
  await runEvent(() => authCallback('USER_UPDATED', session))
  expect(screen.getByRole('heading', { name: 'Indicadores acadêmicos' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Título do rascunho' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Nova avaliação' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Auditoria' })).toBeTruthy()
})

test('reconfirmação da mesma conta preserva a etapa MFA enquanto aguarda a consulta', async () => {
  const access = { kind: 'setup-totp' }
  mocks.resolveAccess.mockResolvedValue(access)
  render(<App />)
  await screen.findByText('Etapa MFA: setup')
  authCallback('INITIAL_SESSION', session)
  const button = screen.getByRole('button', { name: 'Confirmar MFA simulado' })
  let finish!: (value: typeof access) => void
  mocks.resolveAccess.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await runEvent(() => authCallback('SIGNED_IN', session))
  expect(screen.getByRole('button', { name: 'Confirmar MFA simulado' })).toBe(button)
  await act(async () => finish(access))
  expect(screen.getByRole('button', { name: 'Confirmar MFA simulado' })).toBe(button)
})

test('revalidação silenciosa identifica perfil bloqueado e encerra o acesso', async () => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Aluno Teste', email, profile: 'Aluno' },
  })
  render(<App />)
  await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
  authCallback('INITIAL_SESSION', session)
  fireEvent.click(screen.getByRole('button', { name: 'Início' }))
  await screen.findByRole('heading', { name: 'Olá, Aluno.' })
  mocks.resolveAccess.mockResolvedValue({ kind: 'denied', message: 'Perfil bloqueado.' })
  await runEvent(() => authCallback('TOKEN_REFRESHED', session))
  expect(screen.getByText('Perfil bloqueado.')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Acessar o Sistema' })).toBeTruthy()
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
  test(`painel ${profile}: navegação respeita o perfil e mantém os links legais`, async () => {
    mocks.resolveAccess.mockResolvedValue({ kind: 'ready', user: { name: 'Conta Teste', email, profile } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Indicadores acadêmicos' })
    fireEvent.click(screen.getByRole('button', { name: 'Início' }))
    await screen.findByRole('heading', { name: 'Olá, Conta.' })
    expect(screen.getByRole('contentinfo').querySelectorAll('a')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Política de Privacidade (abre em nova aba)' }).getAttribute('href')).toBe('/privacidade')
    if (profile === 'Professor') {
      fireEvent.click(screen.getByRole('button', { name: 'Nova avaliação' }))
      expect(screen.getByText('Cadastro de rascunho')).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Início' }))
      expect(screen.queryByText('Cadastro de rascunho')).toBeNull()
    } else {
      expect(screen.queryByRole('button', { name: 'Nova avaliação' })).toBeNull()
    }
    if (profile === 'Aluno') {
      expect(screen.queryByRole('button', { name: 'Turmas' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Matrículas' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Solicitar matrícula' }))
      expect(screen.getByLabelText('Código da turma')).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Minhas matrículas' }))
      expect(screen.getByText('Consulta das minhas matrículas')).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Início' }))
      expect(screen.queryByLabelText('Código da turma')).toBeNull()
      expect(screen.queryByText('Consulta das minhas matrículas')).toBeNull()
    } else {
      expect(screen.queryByRole('button', { name: 'Solicitar matrícula' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Minhas matrículas' })).toBeNull()
      expect(screen.queryByLabelText('Código da turma')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Matrículas' }))
      expect(screen.getByText(`Pendências para ${profile}`)).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Início' }))
    }
    if (profile === 'Administrador') {
      expect(screen.getByRole('button', { name: 'Redefinir 2FA', exact: true })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Auditoria' }))
      expect(screen.getByText('Consulta de auditoria')).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Início' }))
      expect(screen.getByRole('heading', { name: 'Olá, Conta.' })).toBeTruthy()
    } else {
      expect(screen.queryByRole('button', { name: 'Redefinir 2FA', exact: true })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Auditoria' })).toBeNull()
      expect(screen.queryByText('Consulta de auditoria')).toBeNull()
    }
  })
}

test('aluno aguardando a primeira turma acessa matrícula e documentos, sem abrir painel acadêmico', async () => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Aluno Teste', email, profile: 'Aluno' },
  })
  mocks.consultarIngressoAluno.mockResolvedValue({ fase: 'PENDENTE', acesso_liberado: false, matriculas_pendentes: 1 })
  render(<App />)
  await screen.findByRole('heading', { name: 'Ingresso na primeira turma' })
  await screen.findByRole('button', { name: 'Minhas matrículas' })
  expect(screen.queryByRole('button', { name: 'Minhas provas' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Indicadores acadêmicos' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Política de Privacidade (abre em nova aba)' })).toBeTruthy()
})

test('rodapé fica disponível durante a verificação de sessão', () => {
  mocks.resolveAccess.mockReturnValue(new Promise(() => {}))
  render(<App />)
  expect(screen.getByText('Verificando sua sessão...')).toBeTruthy()
  expect(screen.getByRole('contentinfo').querySelectorAll('a')).toHaveLength(2)
})

test('aluno tem uma única seção Minhas provas com a simulação, sem aba de pré-prova', async () => {
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Aluno Teste', email, profile: 'Aluno' },
  })
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada' } }, error: null })
  vi.mocked(fetch).mockResolvedValue(Response.json({ avaliacoes: [] }))
  render(<App />)
  const provas = await screen.findByRole('button', { name: 'Minhas provas', exact: true })
  expect(screen.getAllByRole('button', { name: 'Minhas provas', exact: true })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Pré-prova' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Avaliações da equipe (teste)' })).toBeNull()
  fireEvent.click(provas)
  expect(screen.getByRole('heading', { name: 'Minhas provas' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Teste local da câmera durante a prova' })).toBeTruthy()
  await screen.findByText('Não há avaliações publicadas para suas turmas ativas.')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/minhas-avaliacoes', expect.any(Object))
})

test('solicita link de recuperação com CAPTCHA e retorno ao próprio site', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Acessar o Sistema' })
  fireEvent.click(screen.getByRole('button', { name: 'Esqueci minha senha' }))
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Validar CAPTCHA de login' }))
  fireEvent.click(screen.getByRole('button', { name: 'Enviar link de recuperação' }))

  await screen.findByText('Se este e-mail estiver cadastrado, você receberá um link para redefinir a senha.')
  expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(email, {
    redirectTo: window.location.origin,
    captchaToken: 'captcha-simulado',
  })
})

test('link de recuperação passa por MFA e permite definir a nova senha sem abrir o painel', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Acessar o Sistema' })
  mocks.resolveRecoveryAccess.mockResolvedValueOnce({ kind: 'verify-totp', factorId: 'fator-simulado' })
    .mockResolvedValue({ kind: 'verified' })
  mocks.updateUser.mockImplementation(async () => {
    authCallback('USER_UPDATED', session)
    return { data: { user: session.user }, error: null }
  })

  await runEvent(() => authCallback('PASSWORD_RECOVERY', session))
  expect(screen.getByText('Etapa MFA: verify')).toBeTruthy()
  expect(mocks.resolveAccess).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar MFA simulado' }))
  await screen.findByRole('heading', { name: 'Crie uma nova senha' })
  expect(screen.queryByRole('heading', { name: 'Olá, Aluno.' })).toBeNull()

  fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'NovaSenha123!' } })
  fireEvent.change(screen.getByLabelText('Confirmar nova senha'), { target: { value: 'NovaSenha123!' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
  await screen.findByText('Senha alterada. Entre com a nova senha e confirme o Authenticator.')
  expect(mocks.updateUser).toHaveBeenCalledWith({ password: 'NovaSenha123!' })
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
  expect(screen.getByRole('heading', { name: 'Acessar o Sistema' })).toBeTruthy()
})

test('retorno inicial de recuperação não abre o painel antes do evento do Supabase', async () => {
  window.history.replaceState({}, '', '/#access_token=simulado&type=recovery')
  mocks.resolveAccess.mockResolvedValue({
    kind: 'ready', user: { name: 'Aluno Teste', email, profile: 'Aluno' },
  })
  mocks.resolveRecoveryAccess.mockResolvedValue({ kind: 'verify-totp', factorId: 'fator-simulado' })
  render(<App />)
  expect(screen.getByText('Verificando sua sessão...')).toBeTruthy()
  expect(mocks.resolveAccess).not.toHaveBeenCalled()
  expect(mocks.resolveRecoveryAccess).not.toHaveBeenCalled()
  await runEvent(() => authCallback('PASSWORD_RECOVERY', session))
  await screen.findByText('Etapa MFA: verify')
  expect(mocks.resolveAccess).not.toHaveBeenCalled()
  expect(screen.queryByRole('heading', { name: 'Olá, Aluno.' })).toBeNull()
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
