import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { MfaStep } from './components/MfaStep'
import { InvitationPanel } from './components/InvitationPanel'
import { AuditPanel } from './components/AuditPanel'
import { TurnstileWidget } from './components/TurnstileWidget'
import { LegalModal } from './components/LegalModal'
import { LegalFooter } from './components/LegalFooter'
import { LegalPage } from './components/LegalPage'
import { TERMS_VERSION, PRIVACY_VERSION } from './content/legalDocuments'
import type { LegalDocumentType } from './content/legalDocuments'
import { supabase } from './lib/supabase'
import { resolveAccess } from './services/access'
import type { AccessState, AccessUser } from './services/access'
import {
  validateInvitationFields,
  validateLoginFields,
  validateRegistrationFields,
} from './services/authValidation'
import './App.css'

const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
const invitationsEnabled = import.meta.env.VITE_INVITES_ENABLED === 'true'

const turnstileSiteKey =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ||
  (import.meta.env.DEV ? TURNSTILE_TEST_SITE_KEY : '')

function App() {
  // São páginas públicas: a leitura não depende da sessão nem do MFA.
  const path = window.location.pathname.replace(/\/$/, '')
  let documentType: LegalDocumentType | null = null
  if (path === '/termos') documentType = 'termos'
  if (path === '/privacidade') documentType = 'privacidade'

  return (
    <div className="site-layout">
      {documentType ? <LegalPage documentType={documentType} /> : <AccessApp />}
      <LegalFooter openInNewTab={!documentType} />
    </div>
  )
}

function AccessApp() {
  const [page, setPage] =
    useState<'login' | 'cadastro' | 'mfa-setup' | 'mfa-verify'>('login')
  const [loggedUser, setLoggedUser] = useState<AccessUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0)
  const [registerTurnstileToken, setRegisterTurnstileToken] = useState('')
  const [registerTurnstileResetSignal, setRegisterTurnstileResetSignal] =
    useState(0)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const [name, setName] = useState('')
  const [registerEmail, setRegisterEmail] = useState('')
  const [registerPassword, setRegisterPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [organizationCode, setOrganizationCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [registerError, setRegisterError] = useState('')
  const [registerCaptchaError, setRegisterCaptchaError] = useState('')
  const [loading, setLoading] = useState(false)
  const [legalModal, setLegalModal] = useState<{
    documentType: LegalDocumentType
    requireAcceptance: boolean
  } | null>(null)
  const [acceptedTermsVersion, setAcceptedTermsVersion] = useState<string | null>(null)
  const registerNameRef = useRef<HTMLInputElement>(null)
  const registeringRef = useRef(false)
  const checkAccessRef = useRef<() => Promise<void>>(async () => {})

  const applyAccess = useCallback(async (access: AccessState) => {
    // Nunca manter dados de outra conta visíveis durante uma nova verificação.
    setLoggedUser(null)

    if (access.kind === 'signed-out') {
      setPage((current) => current === 'cadastro' ? 'cadastro' : 'login')
      return
    }

    // Uma sessão iniciada em outra aba encerra a tentativa de cadastro local.
    setLegalModal(null)
    setAcceptedTermsVersion(null)

    if (access.kind === 'denied') {
      setPage('login')
      setLoginError(access.message)
      await supabase.auth.signOut({ scope: 'local' })
      return
    }

    if (access.kind === 'setup-totp') {
      setPage('mfa-setup')
      return
    }

    if (access.kind === 'verify-totp') {
      setMfaFactorId(access.factorId)
      setPage('mfa-verify')
      return
    }

    setLoggedUser(access.user)
    setLoginError('')
  }, [])

  useEffect(() => {
    let active = true
    let latestCheck = 0
    let scheduledCheck: ReturnType<typeof setTimeout> | null = null

    async function checkAccess() {
      if (scheduledCheck) {
        clearTimeout(scheduledCheck)
        scheduledCheck = null
      }
      const checkId = ++latestCheck
      setCheckingSession(true)
      setLoggedUser(null)

      try {
        const access = await resolveAccess(supabase)
        if (active && checkId === latestCheck) await applyAccess(access)
      } catch {
        if (active && checkId === latestCheck) {
          setPage('login')
          setLoginError('Não foi possível verificar sua sessão. Tente entrar novamente.')
        }
      } finally {
        if (active && checkId === latestCheck) setCheckingSession(false)
      }
    }

    function scheduleCheck() {
      if (registeringRef.current) return

      latestCheck += 1
      setLoggedUser(null)
      setCheckingSession(true)
      if (scheduledCheck) clearTimeout(scheduledCheck)
      scheduledCheck = setTimeout(() => {
        scheduledCheck = null
        if (active) void checkAccess()
      }, 0)
    }

    checkAccessRef.current = checkAccess
    void checkAccess()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event) => {
        // O signUp pode emitir SIGNED_IN antes de devolver seu resultado.
        // Durante o envio, quem decide a tela e a mensagem é handleRegister.
        if (registeringRef.current) return

        if (event === 'SIGNED_OUT') {
          latestCheck += 1
          if (scheduledCheck) clearTimeout(scheduledCheck)
          setLoggedUser(null)
          setPage((current) => current === 'cadastro' ? 'cadastro' : 'login')
          setCheckingSession(false)
          return
        }

        if (
          event === 'SIGNED_IN' ||
          event === 'TOKEN_REFRESHED' ||
          event === 'USER_UPDATED' ||
          event === 'MFA_CHALLENGE_VERIFIED'
        ) {
          // Chamadas assíncronas ao Supabase ficam fora do callback de Auth.
          scheduleCheck()
        }
      },
    )

    return () => {
      active = false
      latestCheck += 1
      if (scheduledCheck) clearTimeout(scheduledCheck)
      checkAccessRef.current = async () => {}
      subscription.unsubscribe()
    }
  }, [applyAccess])

  useEffect(() => {
    // Login e cadastro são telas públicas: voltar à janela não deve desmontar
    // o formulário nem o CAPTCHA. Sessões autenticadas continuam conferidas.
    if (!loggedUser && page !== 'mfa-setup' && page !== 'mfa-verify') return

    function checkOnFocus() {
      void checkAccessRef.current()
    }

    window.addEventListener('focus', checkOnFocus)
    return () => window.removeEventListener('focus', checkOnFocus)
  }, [loggedUser, page])

  useEffect(() => {
    if (page === 'cadastro') registerNameRef.current?.focus()
  }, [page])

  function startRegistration() {
    setAcceptedTermsVersion(null)
    setLegalModal({ documentType: 'termos', requireAcceptance: true })
  }

  function acceptTermsAndRegister() {
    setAcceptedTermsVersion(TERMS_VERSION)
    setLegalModal(null)
    setPage('cadastro')
    setTurnstileToken('')
    setRegisterTurnstileToken('')
    setRegisterCaptchaError('')
    setLoginError('')
    setSuccessMessage('')
  }

  function resetTurnstile() {
    setTurnstileToken('')
    setTurnstileResetSignal((current) => current + 1)
  }

  function resetRegisterTurnstile() {
    setRegisterTurnstileToken('')
    setRegisterTurnstileResetSignal((current) => current + 1)
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault()

    if (loading) return

    setLoginError('')
    setSuccessMessage('')

    const typedEmail = email.trim().toLowerCase()

    const fieldError = validateLoginFields(typedEmail, password)

    if (fieldError) {
      setLoginError(fieldError)
      return
    }

    if (!turnstileToken) {
      setLoginError('Conclua a verificação de segurança para continuar.')
      return
    }

    setLoading(true)

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: typedEmail,
        password,
        options: { captchaToken: turnstileToken },
      })

      if (error) {
        setLoginError(
          error.code === 'email_not_confirmed'
            ? 'Confirme seu e-mail antes de entrar.'
            : error.code === 'captcha_failed'
              ? 'A verificação de segurança falhou. Tente novamente.'
              : 'E-mail ou senha incorretos.',
        )
        return
      }

      setPassword('')
      // SIGNED_IN aciona a conferência da sessão, MFA e perfil.
    } catch {
      await supabase.auth.signOut({ scope: 'local' })
      setLoginError('Não foi possível concluir o acesso. Tente novamente.')
    } finally {
      resetTurnstile()
      setLoading(false)
    }
  }

  async function handleRegister(event: FormEvent) {
    event.preventDefault()

    if (loading || registeringRef.current) {
      return
    }

    setRegisterError('')
    setRegisterCaptchaError('')

    if (acceptedTermsVersion !== TERMS_VERSION) {
      setRegisterError('Leia e aceite os Termos de Uso antes de continuar.')
      setLegalModal({ documentType: 'termos', requireAcceptance: true })
      return
    }

    const newName = name.trim()
    const newEmail = registerEmail.trim().toLowerCase()

    const fieldError = validateRegistrationFields(
      newName,
      newEmail,
      registerPassword,
      confirmPassword,
    )

    if (fieldError) {
      setRegisterError(fieldError)
      return
    }

    if (invitationsEnabled) {
      const invitationFieldError = validateInvitationFields(
        organizationCode,
        invitationCode,
      )

      if (invitationFieldError) {
        setRegisterError(invitationFieldError)
        return
      }
    }

    if (!registerTurnstileToken) {
      setRegisterCaptchaError('Conclua a verificação de segurança para continuar.')
      return
    }

    registeringRef.current = true
    setLoading(true)

    try {
      const registrationData: {
        nome: string
        ticket_cadastro?: string
        termos_aceitos: boolean
        termos_versao: string
        privacidade_versao: string
      } = {
        nome: newName,
        termos_aceitos: true,
        termos_versao: TERMS_VERSION,
        privacidade_versao: PRIVACY_VERSION,
      }

      if (invitationsEnabled) {
        // O banco troca os códigos por um ticket temporário. A verificação
        // definitiva acontece no gatilho do Auth durante o cadastro.
        const { data: ticketData, error: ticketError } = await supabase.rpc(
          'preparar_cadastro',
          {
            p_email: newEmail,
            p_codigo_organizacao: organizationCode.trim(),
            p_codigo_convite: invitationCode.trim(),
          },
        )
        const ticket = (ticketData as { ticket?: unknown } | null)?.ticket

        if (ticketError || typeof ticket !== 'string' || !ticket) {
          setRegisterError(
            ticketError?.code === 'P2001'
              ? 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.'
              : ticketError?.code === 'PGRST202' ||
                  ticketError?.code === '42883' ||
                  ticketError?.code === '55000'
                ? 'O cadastro por convite ainda não está disponível. Procure o administrador.'
                : 'Não foi possível validar os códigos. Confira-os com a organização.',
          )
          return
        }

        registrationData.ticket_cadastro = ticket
      }

      // Os gatilhos criam o perfil e registram a versão dos termos aceita.
      const { data, error } = await supabase.auth.signUp({
        email: newEmail,
        password: registerPassword,
        options: {
          emailRedirectTo: window.location.origin,
          captchaToken: registerTurnstileToken,
          data: registrationData,
        },
      })

      if (error) {
        if (error.code === 'user_already_exists' || error.code === 'email_exists') {
          setRegisterError('Não foi possível cadastrar este e-mail. Se já possui conta, utilize-a.')
        } else if (error.code === 'weak_password') {
          setRegisterError('Escolha uma senha mais forte, com letras, números e símbolos.')
        } else if (error.status === 429) {
          setRegisterError('Muitas tentativas de cadastro. Aguarde alguns minutos e tente novamente.')
        } else {
          setRegisterError('Não foi possível concluir o cadastro. Confira o convite ou tente mais tarde.')
        }
        return
      }

      if (!data.user) {
        setRegisterError('Não foi possível confirmar o cadastro. Tente novamente mais tarde.')
        return
      }

      setEmail(newEmail)
      setPassword('')
      setName('')
      setRegisterEmail('')
      setRegisterPassword('')
      setConfirmPassword('')
      setOrganizationCode('')
      setInvitationCode('')
      setAcceptedTermsVersion(null)

      setLoginError('')
      setPage('login')

      if (data.session) {
        await supabase.auth.signOut({ scope: 'local' })
        setSuccessMessage('Cadastro realizado. Entre para configurar seu Authenticator.')
      } else {
        setSuccessMessage('Solicitação recebida. Confira seu e-mail para confirmar o cadastro.')
      }
    } catch {
      setRegisterError('Não foi possível acessar o serviço de cadastro. Tente novamente.')
    } finally {
      registeringRef.current = false
      resetRegisterTurnstile()
      setLoading(false)
    }
  }

  async function handleLogout() {
    const { error } = await supabase.auth.signOut({ scope: 'local' })

    if (error) {
      throw new Error('Não foi possível sair da conta. Tente novamente.')
    }

    setLoggedUser(null)
    setPage('login')
    setTurnstileToken('')
    setRegisterTurnstileToken('')
    setEmail('')
    setPassword('')
    setShowPassword(false)
    setLoginError('')
    setAcceptedTermsVersion(null)
    setLegalModal(null)
  }

  if (checkingSession) {
    return <main className="auth-loading">Verificando sua sessão...</main>
  }

  if (loggedUser) {
    return (
      <Dashboard
        user={loggedUser}
        onLogout={handleLogout}
      />
    )
  }

  return (
    <main className="app-container">
      <section className="banner-section">
        <div className="brand-logo">
          <span className="logo-icon">ET</span>
          <span>ExamenTech</span>
        </div>

        <div className="banner-text">
          <p className="overline">AMBIENTE ACADÊMICO</p>

          <h1>
            Segurança e organização para cada avaliação.
          </h1>

          <p>
            Acesse provas, atividades e informações acadêmicas
            em um único ambiente.
          </p>
        </div>

        <p className="copyright">
          © {new Date().getFullYear()} ExamenTech · Sistema de
          Gerenciamento Acadêmico
        </p>
      </section>

      <section className="form-section">
        <div className="form-wrapper">
          <div className="brand-logo-mobile">
            <span className="logo-icon">ET</span>
            <span>ExamenTech</span>
          </div>

          {page === 'login' ? (
            <>
              <header className="form-header">
                <p className="overline">ACESSO AO SISTEMA</p>
                <h2>Boas-vindas</h2>
                <p className="subtitle">
                  Informe seus dados para continuar.
                </p>
              </header>

              <form noValidate onSubmit={handleLogin}>
                <div className="input-group">
                  <label htmlFor="email">E-mail</label>

                  <input
                    id="email"
                    type="email"
                    placeholder="seuemail@examentech.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="password">Senha</label>

                  <div className="password-wrapper">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Digite sua senha"
                      value={password}
                      onChange={(event) =>
                        setPassword(event.target.value)
                      }
                      autoComplete="current-password"
                    />

                    <button
                      type="button"
                      className="btn-toggle-password"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? 'Ocultar' : 'Mostrar'}
                    </button>
                  </div>
                </div>

                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  action="login"
                  resetSignal={turnstileResetSignal}
                  onVerify={(token) => {
                    setTurnstileToken(token)
                    setLoginError('')
                  }}
                  onExpire={() => {
                    setTurnstileToken('')
                    setLoginError('A verificação expirou. Conclua-a novamente.')
                  }}
                  onError={(message) => {
                    setTurnstileToken('')
                    setLoginError(message)
                  }}
                />

                <p className="security-note">
                  O Turnstile protege o acesso. A senha é verificada pelo
                  Supabase Auth e não é armazenada neste aplicativo.
                </p>

                {loginError && (
                  <div className="alert error" role="alert">
                    {loginError}
                  </div>
                )}

                {successMessage && (
                  <div className="alert success" role="status">
                    {successMessage}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading || !turnstileToken}
                  aria-busy={loading}
                >
                  {loading
                    ? 'Validando acesso...'
                    : turnstileToken
                      ? 'Entrar'
                      : 'Conclua a verificação'}
                </button>
              </form>

              <div className="form-footer">
                Ainda não possui uma conta?

                <button
                  type="button"
                  className="btn-link"
                  disabled={loading}
                  onClick={startRegistration}
                >
                  Criar conta
                </button>
              </div>
            </>
          ) : page === 'cadastro' ? (
            <>
              <header className="form-header">
                <button
                  type="button"
                  className="btn-back"
                  disabled={loading}
                  onClick={() => {
                    setPage('login')
                    setRegisterTurnstileToken('')
                    setRegisterError('')
                    setRegisterCaptchaError('')
                    setAcceptedTermsVersion(null)
                  }}
                >
                  ← Voltar
                </button>

                <p className="overline">CADASTRO POR CONVITE</p>
                <h2>Crie sua conta</h2>

                <p className="subtitle">
                  Seu convite define se a conta será de aluno ou professor.
                </p>
              </header>

              <form noValidate onSubmit={handleRegister}>
                <div className="input-group">
                  <label htmlFor="name">
                    Nome completo
                  </label>

                  <input
                    id="name"
                    ref={registerNameRef}
                    type="text"
                    disabled={loading}
                    value={name}
                    onChange={(event) =>
                      setName(event.target.value)
                    }
                    autoComplete="name"
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="register-email">
                    E-mail
                  </label>

                  <input
                    id="register-email"
                    type="email"
                    disabled={loading}
                    value={registerEmail}
                    onChange={(event) =>
                      setRegisterEmail(event.target.value)
                    }
                    autoComplete="email"
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="register-password">
                    Senha
                  </label>

                  <input
                    id="register-password"
                    type="password"
                    disabled={loading}
                    placeholder="Mínimo de 8 caracteres"
                    value={registerPassword}
                    onChange={(event) =>
                      setRegisterPassword(event.target.value)
                    }
                    autoComplete="new-password"
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="confirm-password">
                    Confirmar senha
                  </label>

                  <input
                    id="confirm-password"
                    type="password"
                    disabled={loading}
                    value={confirmPassword}
                    onChange={(event) =>
                      setConfirmPassword(event.target.value)
                    }
                    autoComplete="new-password"
                  />
                </div>

                {invitationsEnabled && (
                  <>
                    <div className="input-group">
                      <label htmlFor="organization-code">Código da organização</label>
                      <input
                        id="organization-code"
                        type="text"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={128}
                        disabled={loading}
                        value={organizationCode}
                        onChange={(event) => setOrganizationCode(event.target.value)}
                      />
                    </div>

                    <div className="input-group">
                      <label htmlFor="invitation-code">Convite individual</label>
                      <input
                        id="invitation-code"
                        type="text"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={128}
                        disabled={loading}
                        value={invitationCode}
                        onChange={(event) => setInvitationCode(event.target.value)}
                      />
                    </div>

                    <p className="security-note">
                      Convites para professores são emitidos pelo administrador.
                      Para alunos, pelo professor ou administrador da organização.
                    </p>
                  </>
                )}

                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  action="cadastro"
                  resetSignal={registerTurnstileResetSignal}
                  onVerify={(token) => {
                    setRegisterTurnstileToken(token)
                    setRegisterCaptchaError('')
                  }}
                  onExpire={() => {
                    setRegisterTurnstileToken('')
                    setRegisterCaptchaError('A verificação expirou. Conclua-a novamente.')
                  }}
                  onError={(message) => {
                    setRegisterTurnstileToken('')
                    setRegisterCaptchaError(message)
                  }}
                />

                {registerError && (
                  <div className="alert error" role="alert">
                    {registerError}
                  </div>
                )}

                {registerCaptchaError && (
                  <div className="alert error" role="alert">
                    {registerCaptchaError}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading || !registerTurnstileToken}
                  aria-busy={loading}
                >
                  {loading
                    ? 'Criando conta...'
                    : registerTurnstileToken
                      ? 'Criar conta'
                      : 'Conclua a verificação'}
                </button>
              </form>
            </>
          ) : (
            <MfaStep
              mode={page === 'mfa-setup' ? 'setup' : 'verify'}
              factorId={mfaFactorId}
              onComplete={() => checkAccessRef.current()}
              onCancel={handleLogout}
            />
          )}

        </div>
      </section>

      {legalModal && (
        <LegalModal
          documentType={legalModal.documentType}
          onClose={() => setLegalModal(null)}
          onAccept={legalModal.requireAcceptance ? acceptTermsAndRegister : undefined}
        />
      )}
    </main>
  )
}

type DashboardProps = {
  user: AccessUser
  onLogout: () => Promise<void>
}

function Dashboard({ user, onLogout }: DashboardProps) {
  const [logoutError, setLogoutError] = useState('')
  const [dashboardView, setDashboardView] = useState<'inicio' | 'auditoria'>('inicio')
  const nameParts = user.name.split(' ')

  const initials = nameParts
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase()

  const firstName = nameParts[0]
  const showingAudit = user.profile === 'Administrador' && dashboardView === 'auditoria'

  return (
    <div className="dashboard-container">
      <nav className="dashboard-nav">
        <div className="brand-logo">
          <span className="logo-icon">ET</span>
          <span>ExamenTech</span>
        </div>

        <button
          type="button"
          className="btn-outline"
          onClick={() => {
            setLogoutError('')
            void onLogout().catch(() => {
              setLogoutError('Não foi possível sair da conta. Tente novamente.')
            })
          }}
        >
          Sair
        </button>
      </nav>

      <main className={showingAudit ? 'dashboard-content dashboard-content-audit' : 'dashboard-content'}>
        {logoutError && <div className="alert error" role="alert">{logoutError}</div>}
        {user.profile === 'Administrador' && (
          <nav className="dashboard-section-nav" aria-label="Seções do painel">
            <button type="button" aria-pressed={dashboardView === 'inicio'} onClick={() => setDashboardView('inicio')}>
              Início
            </button>
            <button type="button" aria-pressed={dashboardView === 'auditoria'} onClick={() => setDashboardView('auditoria')}>
              Auditoria
            </button>
          </nav>
        )}

        {showingAudit ? <AuditPanel /> : (
          <>
            <p className="overline">PAINEL INICIAL</p>
            <h1>Olá, {firstName}.</h1>
            <p className="subtitle">Você está conectado ao sistema ExamenTech.</p>

            <div className="profile-card">
              <div className="avatar">{initials}</div>
              <div className="profile-info">
                <span className="label">USUÁRIO CONECTADO</span>
                <h2>{user.name}</h2>
                <p>{user.email}</p>
              </div>
              <div className="badge">{user.profile}</div>
            </div>

            <p className="verification-receipt">
              Acesso confirmado com autenticação em duas etapas.
            </p>

            {invitationsEnabled &&
              (user.profile === 'Administrador' || user.profile === 'Professor') && (
              <InvitationPanel profile={user.profile} />
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default App
