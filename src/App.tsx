import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { MfaStep } from './components/MfaStep'
import { InvitationPanel } from './components/InvitationPanel'
import { AuditPanel } from './components/AuditPanel'
import { TurmasPanel } from './components/TurmasPanel'
import { NovaAvaliacaoPanel } from './components/NovaAvaliacaoPanel'
import { SolicitarMatriculaPanel } from './components/SolicitarMatriculaPanel'
import { MatriculasPanel } from './components/MatriculasPanel'
import { MinhasMatriculasPanel } from './components/MinhasMatriculasPanel'
import { MinhasAvaliacoesPanel } from './components/MinhasAvaliacoesPanel'
import { TurnstileWidget } from './components/TurnstileWidget'
import { LegalModal } from './components/LegalModal'
import { LegalFooter } from './components/LegalFooter'
import { DashboardOverview } from './components/DashboardOverview'
import { LegalPage } from './components/LegalPage'
import { TERMS_VERSION, PRIVACY_VERSION } from './content/legalDocuments'
import type { LegalDocumentType } from './content/legalDocuments'
import { supabase } from './lib/supabase'
import { resolveAccess, resolveRecoveryAccess } from './services/access'
import type { AccessState, AccessUser, RecoveryAccessState } from './services/access'
import {
  validateInvitationFields,
  validateLoginFields,
  validateNewPassword,
  validateRecoveryEmail,
  validateRegistrationFields,
} from './services/authValidation'
import './App.css'

const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
const invitationsEnabled = import.meta.env.VITE_INVITES_ENABLED === 'true'
// O início depende da configuração conferida com a sequência canônica do banco.
const monitoredExamsEnabled = import.meta.env.VITE_MONITORED_EXAMS_ENABLED === 'true'

const turnstileSiteKey =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ||
  (import.meta.env.DEV ? TURNSTILE_TEST_SITE_KEY : '')

type AuthPage =
  | 'login' | 'cadastro' | 'mfa-setup' | 'mfa-verify'
  | 'request-password' | 'reset-password' | 'invalid-recovery'

function isRecoveryRedirect() {
  return new URLSearchParams(window.location.search).get('type') === 'recovery' ||
    new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery'
}

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
  const recoveryPendingRef = useRef(isRecoveryRedirect())
  const recoveryConfirmedRef = useRef(false)
  const [page, setPage] = useState<AuthPage>(
    () => isRecoveryRedirect() ? 'reset-password' : 'login',
  )
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
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [recoveryError, setRecoveryError] = useState('')
  const [recoverySent, setRecoverySent] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState('')

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

  const applyAccess = useCallback(async (access: AccessState | RecoveryAccessState) => {
    // Nunca manter dados de outra conta visíveis durante uma nova verificação.
    setLoggedUser(null)

    if (access.kind === 'signed-out') {
      setPage((current) => recoveryPendingRef.current
        ? 'invalid-recovery'
        : current === 'cadastro' || current === 'request-password' ? current : 'login')
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

    if (access.kind === 'verified') {
      setPage('reset-password')
      setRecoveryError('')
      return
    }

    setLoggedUser(access.user)
    setLoginError('')
  }, [])

  useEffect(() => {
    let active = true
    let latestCheck = 0
    let scheduledCheck: ReturnType<typeof setTimeout> | null = null
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null

    async function checkAccess() {
      // Um link na URL ainda não prova que o Supabase o aceitou. Aguarde o
      // evento PASSWORD_RECOVERY antes de consultar ou alterar a conta.
      if (recoveryPendingRef.current && !recoveryConfirmedRef.current) return
      if (scheduledCheck) {
        clearTimeout(scheduledCheck)
        scheduledCheck = null
      }
      const checkId = ++latestCheck
      setCheckingSession(true)
      setLoggedUser(null)

      try {
        const access = recoveryPendingRef.current
          ? await resolveRecoveryAccess(supabase)
          : await resolveAccess(supabase)
        if (active && checkId === latestCheck) await applyAccess(access)
      } catch {
        if (active && checkId === latestCheck) {
          if (recoveryPendingRef.current) {
            setPage('invalid-recovery')
            setRecoveryError('Não foi possível confirmar o link de recuperação. Solicite outro e-mail.')
          } else {
            setPage('login')
            setLoginError('Não foi possível verificar sua sessão. Tente entrar novamente.')
          }
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

    if (recoveryPendingRef.current) {
      recoveryTimeout = setTimeout(() => {
        if (!active || recoveryConfirmedRef.current) return
        setPage('invalid-recovery')
        setCheckingSession(false)
        setRecoveryError('Não foi possível confirmar o link de recuperação. Solicite outro e-mail.')
      }, 10000)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event) => {
        // O signUp pode emitir SIGNED_IN antes de devolver seu resultado.
        // Durante o envio, quem decide a tela e a mensagem é handleRegister.
        if (registeringRef.current) return

        if (event === 'SIGNED_OUT') {
          recoveryPendingRef.current = false
          recoveryConfirmedRef.current = false
          if (recoveryTimeout) clearTimeout(recoveryTimeout)
          latestCheck += 1
          if (scheduledCheck) clearTimeout(scheduledCheck)
          setLoggedUser(null)
          setPage((current) => current === 'cadastro' || current === 'request-password' ? current : 'login')
          setCheckingSession(false)
          return
        }

        if (event === 'PASSWORD_RECOVERY') {
          recoveryPendingRef.current = true
          recoveryConfirmedRef.current = true
          if (recoveryTimeout) clearTimeout(recoveryTimeout)
          setRecoveryError('')
          scheduleCheck()
          return
        }

        // A alteração da senha emite USER_UPDATED antes da saída da sessão.
        if (recoveryPendingRef.current && event === 'USER_UPDATED') return

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
      if (recoveryTimeout) clearTimeout(recoveryTimeout)
      checkAccessRef.current = async () => {}
      subscription.unsubscribe()
    }
  }, [applyAccess])

  useEffect(() => {
    // Login e cadastro são telas públicas: voltar à janela não deve desmontar
    // o formulário nem o CAPTCHA. Sessões autenticadas continuam conferidas.
    if (!loggedUser && page !== 'mfa-setup' && page !== 'mfa-verify' && page !== 'reset-password') return

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

  function openPasswordRecovery() {
    setRecoveryEmail(email)
    setRecoveryError('')
    setRecoverySent(false)
    setLoginError('')
    resetTurnstile()
    setPage('request-password')
  }

  async function requestPasswordReset(event: FormEvent) {
    event.preventDefault()
    if (loading) return

    setRecoveryError('')
    const typedEmail = recoveryEmail.trim().toLowerCase()
    const fieldError = validateRecoveryEmail(typedEmail)
    if (fieldError) {
      setRecoveryError(fieldError)
      return
    }
    if (!turnstileToken) {
      setRecoveryError('Conclua a verificação de segurança para continuar.')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(typedEmail, {
        redirectTo: window.location.origin,
        captchaToken: turnstileToken,
      })
      if (error) {
        setRecoveryError(error.code === 'captcha_failed'
          ? 'A verificação de segurança falhou. Tente novamente.'
          : error.status === 429
            ? 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
            : 'Não foi possível solicitar a recuperação agora. Tente novamente.')
        return
      }
      setRecoverySent(true)
    } catch {
      setRecoveryError('Não foi possível solicitar a recuperação agora. Tente novamente.')
    } finally {
      resetTurnstile()
      setLoading(false)
    }
  }

  async function updatePassword(event: FormEvent) {
    event.preventDefault()
    if (loading) return

    setRecoveryError('')
    const fieldError = validateNewPassword(newPassword, newPasswordConfirmation)
    if (fieldError) {
      setRecoveryError(fieldError)
      return
    }

    setLoading(true)
    try {
      if (!recoveryConfirmedRef.current) {
        setRecoveryError('Solicite um novo link de recuperação para alterar a senha.')
        return
      }
      const access = await resolveRecoveryAccess(supabase)
      if (access.kind !== 'verified') {
        setRecoveryError('Confirme novamente o código do Authenticator para alterar a senha.')
        await checkAccessRef.current()
        return
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) {
        setRecoveryError(error.code === 'weak_password'
          ? 'Escolha uma senha mais forte, com letras, números e símbolos.'
          : 'Não foi possível alterar a senha. Tente novamente.')
        return
      }

      setNewPassword('')
      setNewPasswordConfirmation('')
      setPassword('')
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' })
      if (signOutError) {
        setRecoveryError('Senha alterada, mas não foi possível sair da conta. Clique em “Sair da conta” e entre novamente.')
        return
      }
      recoveryPendingRef.current = false
      recoveryConfirmedRef.current = false
      setPage('login')
      setSuccessMessage('Senha alterada. Entre com a nova senha e confirme o Authenticator.')
    } catch {
      setRecoveryError('Não foi possível confirmar a sessão de recuperação. Tente novamente.')
    } finally {
      setLoading(false)
    }
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

                <button
                  type="button"
                  className="btn-link recovery-link"
                  disabled={loading}
                  onClick={openPasswordRecovery}
                >
                  Esqueci minha senha
                </button>

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
          ) : page === 'request-password' ? (
            <>
              <header className="form-header">
                <button type="button" className="btn-back" disabled={loading} onClick={() => {
                  setPage('login')
                  setRecoveryError('')
                  resetTurnstile()
                }}>
                  ← Voltar
                </button>
                <p className="overline">RECUPERAÇÃO DE ACESSO</p>
                <h2>Redefinir senha</h2>
                <p className="subtitle">Enviaremos um link para o e-mail da sua conta.</p>
              </header>

              <form noValidate onSubmit={requestPasswordReset}>
                <div className="input-group">
                  <label htmlFor="recovery-email">E-mail</label>
                  <input
                    id="recovery-email"
                    type="email"
                    autoComplete="email"
                    disabled={loading}
                    value={recoveryEmail}
                    onChange={(event) => setRecoveryEmail(event.target.value)}
                  />
                </div>

                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  action="login"
                  resetSignal={turnstileResetSignal}
                  onVerify={(token) => {
                    setTurnstileToken(token)
                    setRecoveryError('')
                  }}
                  onExpire={() => {
                    setTurnstileToken('')
                    setRecoveryError('A verificação expirou. Conclua-a novamente.')
                  }}
                  onError={(message) => {
                    setTurnstileToken('')
                    setRecoveryError(message)
                  }}
                />

                {recoveryError && <div className="alert error" role="alert">{recoveryError}</div>}
                {recoverySent && <div className="alert success" role="status">
                  Se este e-mail estiver cadastrado, você receberá um link para redefinir a senha.
                </div>}

                <button type="submit" className="btn-primary" disabled={loading || !turnstileToken} aria-busy={loading}>
                  {loading ? 'Enviando...' : 'Enviar link de recuperação'}
                </button>
              </form>
            </>
          ) : page === 'reset-password' ? (
            <>
              <header className="form-header">
                <p className="overline">RECUPERAÇÃO DE ACESSO</p>
                <h2>Crie uma nova senha</h2>
                <p className="subtitle">O Authenticator foi confirmado. Defina a senha para entrar novamente.</p>
              </header>

              <form noValidate onSubmit={updatePassword}>
                <div className="input-group">
                  <label htmlFor="new-password">Nova senha</label>
                  <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    disabled={loading}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label htmlFor="new-password-confirmation">Confirmar nova senha</label>
                  <input
                    id="new-password-confirmation"
                    type="password"
                    autoComplete="new-password"
                    disabled={loading}
                    value={newPasswordConfirmation}
                    onChange={(event) => setNewPasswordConfirmation(event.target.value)}
                  />
                </div>
                {recoveryError && <div className="alert error" role="alert">{recoveryError}</div>}
                <button type="submit" className="btn-primary" disabled={loading} aria-busy={loading}>
                  {loading ? 'Alterando senha...' : 'Salvar nova senha'}
                </button>
              </form>
              <button type="button" className="btn-back mfa-cancel" disabled={loading} onClick={() => void handleLogout()}>
                Sair da conta
              </button>
            </>
          ) : page === 'invalid-recovery' ? (
            <>
              <header className="form-header">
                <p className="overline">RECUPERAÇÃO DE ACESSO</p>
                <h2>Link indisponível</h2>
                <p className="subtitle">O link pode ter expirado ou já ter sido utilizado.</p>
              </header>
              {recoveryError && <div className="alert error" role="alert">{recoveryError}</div>}
              <button type="button" className="btn-primary" onClick={() => {
                recoveryPendingRef.current = false
                recoveryConfirmedRef.current = false
                setRecoveryError('')
                setRecoverySent(false)
                setPage('request-password')
              }}>
                Solicitar novo link
              </button>
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
  const [dashboardView, setDashboardView] = useState<'dashboard' | 'inicio' | 'auditoria' | 'turmas' | 'matricula' | 'aprovacoes' | 'minhas-matriculas' | 'nova-avaliacao' | 'provas'>('dashboard')
  const [draftsTarget, setDraftsTarget] = useState<string | null>(null)
  const [examActive, setExamActive] = useState(false)
  const [examNotice, setExamNotice] = useState('')
  const nameParts = user.name.split(' ')

  const initials = nameParts
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase()

  const firstName = nameParts[0]
  const showingAudit = user.profile === 'Administrador' && dashboardView === 'auditoria'
  const canViewTurmas = user.profile === 'Administrador' || user.profile === 'Professor'

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
          disabled={examActive}
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
        {dashboardView === 'inicio' && examNotice && <div className="alert error" role="alert">{examNotice}</div>}
        {(canViewTurmas || user.profile === 'Aluno') && (
          <nav className="dashboard-section-nav" aria-label="Seções do painel">
            <button type="button" disabled={examActive} aria-pressed={dashboardView === 'inicio'} onClick={() => setDashboardView('inicio')}>
              Início
            </button>
            {canViewTurmas && (
              <button type="button" disabled={examActive} aria-pressed={dashboardView === 'turmas'} onClick={() => { setDraftsTarget(null); setDashboardView('turmas') }}>
                Turmas
              </button>
            )}
            {user.profile === 'Aluno' && (
              <>
                <button type="button" disabled={examActive} aria-pressed={dashboardView === 'matricula'} onClick={() => setDashboardView('matricula')}>
                  Solicitar matrícula
                </button>
                <button type="button" disabled={examActive} aria-pressed={dashboardView === 'minhas-matriculas'} onClick={() => setDashboardView('minhas-matriculas')}>
                  Minhas matrículas
                </button>
                <button type="button" disabled={examActive} aria-pressed={dashboardView === 'provas'} onClick={() => setDashboardView('provas')}>
                  Minhas provas
                </button>
              </>
            )}
            {user.profile === 'Professor' && (
              <button type="button" disabled={examActive} aria-pressed={dashboardView === 'nova-avaliacao'} onClick={() => setDashboardView('nova-avaliacao')}>
                Nova avaliação
              </button>
            )}
            {canViewTurmas && (
              <button type="button" disabled={examActive} aria-pressed={dashboardView === 'aprovacoes'} onClick={() => setDashboardView('aprovacoes')}>
                Matrículas
              </button>
            )}
            {user.profile === 'Administrador' && (
              <button type="button" disabled={examActive} aria-pressed={dashboardView === 'auditoria'} onClick={() => setDashboardView('auditoria')}>
                Auditoria
              </button>
            )}
            <button type="button" disabled={examActive} aria-pressed={dashboardView === 'dashboard'} onClick={() => setDashboardView('dashboard')}>
              Dashboard
            </button>
          </nav>
        )}

        {dashboardView === 'dashboard' ? <DashboardOverview /> : showingAudit ? <AuditPanel /> : dashboardView === 'turmas' &&
          (user.profile === 'Administrador' || user.profile === 'Professor') ? (
          <TurmasPanel profile={user.profile} initialDraftsTurmaId={draftsTarget} />
        ) : dashboardView === 'nova-avaliacao' && user.profile === 'Professor' ? (
          <NovaAvaliacaoPanel onOpenDrafts={(turmaId) => { setDraftsTarget(turmaId); setDashboardView('turmas') }} />
        ) : dashboardView === 'matricula' && user.profile === 'Aluno' ? (
          <SolicitarMatriculaPanel />
        ) : dashboardView === 'minhas-matriculas' && user.profile === 'Aluno' ? (
          <MinhasMatriculasPanel />
        ) : dashboardView === 'provas' && user.profile === 'Aluno' ? (
          <MinhasAvaliacoesPanel layout="cards" executionEnabled={monitoredExamsEnabled}
            onActiveChange={setExamActive} onLeave={(message) => {
            setExamNotice(message)
            setExamActive(false)
            setDashboardView('inicio')
          }} />
        ) : dashboardView === 'aprovacoes' &&
          (user.profile === 'Administrador' || user.profile === 'Professor') ? (
          <MatriculasPanel profile={user.profile} />
        ) : (
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

            {user.profile === 'Professor' && <section className="exam-publish-shortcut" aria-labelledby="exam-publish-title">
              <h2 id="exam-publish-title">Criar e publicar uma prova</h2>
              <p>Crie um rascunho do tipo Prova. Depois, abra os rascunhos da turma, adicione as questões e publique.</p>
              <div className="exam-publish-actions">
                <button type="button" className="btn-primary" onClick={() => setDashboardView('nova-avaliacao')}>Criar prova</button>
                <button type="button" className="btn-primary" onClick={() => { setDraftsTarget(null); setDashboardView('turmas') }}>Ver rascunhos e publicar</button>
              </div>
            </section>}
            {user.profile === 'Administrador' && <p className="security-note">
              A criação e a publicação de provas são feitas pela conta do professor responsável pela turma.
            </p>}

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
