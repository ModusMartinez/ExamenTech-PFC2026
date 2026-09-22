import { useState } from 'react'
import type { FormEvent } from 'react'
import { TurnstileWidget } from './components/TurnstileWidget'
import { supabase } from './lib/supabase'
import {
  TurnstileValidationError,
  validateTurnstileToken,
} from './services/turnstile'
import type { SuccessfulTurnstileValidation } from './services/turnstile'
import './App.css'

const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'

const turnstileSiteKey =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ||
  (import.meta.env.DEV ? TURNSTILE_TEST_SITE_KEY : '')

type Profile = 'Administrador' | 'Professor' | 'Aluno'

type User = {
  name: string
  email: string
  profile: Profile
}

type DemoUser = User & {
  password: string
}

// Contas de demonstração até a integração do login com o Supabase.
const defaultUsers: DemoUser[] = [
  {
    name: 'Mariana Costa',
    email: 'admin@examentech.com',
    password: '123456',
    profile: 'Administrador',
  },
  {
    name: 'Prof. Rafael Mendes',
    email: 'professor@examentech.com',
    password: '123456',
    profile: 'Professor',
  },
  {
    name: 'Lucas Ferreira',
    email: 'aluno@examentech.com',
    password: '123456',
    profile: 'Aluno',
  },
]

function App() {
  const [page, setPage] = useState<'login' | 'cadastro'>('login')
  const [loggedUser, setLoggedUser] = useState<User | null>(null)
  const [securityValidation, setSecurityValidation] =
    useState<SuccessfulTurnstileValidation | null>(null)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const [name, setName] = useState('')
  const [registerEmail, setRegisterEmail] = useState('')
  const [registerPassword, setRegisterPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [registerError, setRegisterError] = useState('')
  const [loading, setLoading] = useState(false)

  function resetTurnstile() {
    setTurnstileToken('')
    setTurnstileResetSignal((current) => current + 1)
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault()

    setLoginError('')
    setSuccessMessage('')

    const typedEmail = email.trim().toLowerCase()

    if (typedEmail === '' || password === '') {
      setLoginError('Preencha o e-mail e a senha.')
      return
    }

    const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail)

    if (!emailIsValid) {
      setLoginError('Digite um e-mail válido.')
      return
    }

    if (!turnstileToken) {
      setLoginError('Conclua a verificação de segurança para continuar.')
      return
    }

    setLoading(true)

    try {
      const validation = await validateTurnstileToken(turnstileToken)

      // O login por e-mail e senha continua simulado nesta etapa.
      await new Promise((resolve) => window.setTimeout(resolve, 700))

      const foundUser = defaultUsers.find(
        (user) =>
          user.email.toLowerCase() === typedEmail &&
          user.password === password
      )

      if (!foundUser) {
        setLoginError('E-mail ou senha incorretos.')
        resetTurnstile()
        return
      }

      setSecurityValidation(validation)
      setLoggedUser({
        name: foundUser.name,
        email: foundUser.email,
        profile: foundUser.profile,
      })
    } catch (error) {
      setLoginError(
        error instanceof TurnstileValidationError
          ? error.message
          : 'Não foi possível concluir a verificação de segurança.'
      )
      resetTurnstile()
    } finally {
      setLoading(false)
    }
  }

  async function handleRegister(event: FormEvent) {
    event.preventDefault()

    if (loading) {
      return
    }

    setRegisterError('')

    const newName = name.trim()
    const newEmail = registerEmail.trim().toLowerCase()

    if (
      !newName ||
      !newEmail ||
      !registerPassword ||
      !confirmPassword
    ) {
      setRegisterError('Preencha todos os campos.')
      return
    }

    const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)

    if (!emailIsValid) {
      setRegisterError('Digite um e-mail válido.')
      return
    }

    if (registerPassword.length < 6) {
      setRegisterError('A senha precisa ter pelo menos 6 caracteres.')
      return
    }

    if (registerPassword !== confirmPassword) {
      setRegisterError('As senhas não são iguais.')
      return
    }

    setLoading(true)

    try {
      // O trigger do banco usa esses dados para criar o perfil do aluno.
      const { data, error } = await supabase.auth.signUp({
        email: newEmail,
        password: registerPassword,
        options: {
          emailRedirectTo: window.location.origin,
          data: {
            nome: newName,
            perfil: 'ALUNO',
          },
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
          setRegisterError('Não foi possível concluir o cadastro. Tente novamente mais tarde.')
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

      setPage('login')

      if (data.session) {
        setSuccessMessage('Cadastro realizado. Sua conta está pendente de aprovação.')
      } else {
        setSuccessMessage('Solicitação recebida. Confira seu e-mail para confirmar o cadastro.')
      }
    } catch {
      setRegisterError('Não foi possível acessar o serviço de cadastro. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }

  function handleLogout() {
    setLoggedUser(null)
    setSecurityValidation(null)
    setTurnstileToken('')
    setEmail('')
    setPassword('')
    setShowPassword(false)
    setLoginError('')
  }

  if (loggedUser && securityValidation) {
    return (
      <Dashboard
        user={loggedUser}
        securityValidation={securityValidation}
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
                  Protegido por Cloudflare Turnstile. O token é validado no
                  servidor e não é armazenado.
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
                  onClick={() => {
                    setPage('cadastro')
                    setTurnstileToken('')
                    setLoginError('')
                    setSuccessMessage('')
                  }}
                >
                  Criar conta
                </button>
              </div>
            </>
          ) : (
            <>
              <header className="form-header">
                <button
                  type="button"
                  className="btn-back"
                  disabled={loading}
                  onClick={() => {
                    setPage('login')
                    setRegisterError('')
                  }}
                >
                  ← Voltar
                </button>

                <p className="overline">CADASTRO DE ALUNO</p>
                <h2>Crie sua conta</h2>

                <p className="subtitle">
                  Novas contas são cadastradas como aluno.
                </p>
              </header>

              <form noValidate onSubmit={handleRegister}>
                <div className="input-group">
                  <label htmlFor="name">
                    Nome completo
                  </label>

                  <input
                    id="name"
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
                    placeholder="Mínimo de 6 caracteres"
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

                {registerError && (
                  <div className="alert error" role="alert">
                    {registerError}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading}
                  aria-busy={loading}
                >
                  {loading ? 'Criando conta...' : 'Criar conta'}
                </button>
              </form>
            </>
          )}
        </div>
      </section>
    </main>
  )
}

type DashboardProps = {
  user: User
  securityValidation: SuccessfulTurnstileValidation
  onLogout: () => void
}

function Dashboard({ user, securityValidation, onLogout }: DashboardProps) {
  const nameParts = user.name.split(' ')

  const initials = nameParts
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase()

  const firstName = nameParts[0]

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
          onClick={onLogout}
        >
          Sair
        </button>
      </nav>

      <main className="dashboard-content">
        <p className="overline">PAINEL INICIAL</p>

        <h1>Olá, {firstName}.</h1>

        <p className="subtitle">
          Você está conectado ao sistema ExamenTech.
        </p>

        <div className="profile-card">
          <div className="avatar">
            {initials}
          </div>

          <div className="profile-info">
            <span className="label">
              USUÁRIO CONECTADO
            </span>

            <h2>{user.name}</h2>
            <p>{user.email}</p>
          </div>

          <div className="badge">
            {user.profile}
          </div>
        </div>

        <p className="verification-receipt">
          Verificação de segurança registrada no Supabase.
          <br />
          <span>Protocolo: {securityValidation.requestId}</span>
        </p>
      </main>
    </div>
  )
}

export default App
