import { useState } from 'react'
import type { FormEvent } from 'react'
import { TurnstileWidget } from './components/TurnstileWidget'
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
  email: string
  name: string
  profile: Profile
}

type UserWithPassword = User & {
  password: string
}

// Usuários temporários para testar o login
const usuariosMockados: UserWithPassword[] = [
  {
    email: 'admin@sgpa.com',
    password: '123456',
    name: 'Mariana Costa',
    profile: 'Administrador',
  },
  {
    email: 'professor@sgpa.com',
    password: '123456',
    name: 'Prof. Rafael Mendes',
    profile: 'Professor',
  },
  {
    email: 'aluno@sgpa.com',
    password: '123456',
    name: 'Lucas Ferreira',
    profile: 'Aluno',
  },
]

function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [usuarioLogado, setUsuarioLogado] = useState<User | null>(null)
  const [securityValidation, setSecurityValidation] =
    useState<SuccessfulTurnstileValidation | null>(null)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0)

  function resetTurnstile() {
    setTurnstileToken('')
    setTurnstileResetSignal((current) => current + 1)
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')

    const emailFormatado = email.trim().toLowerCase()

    if (!emailFormatado || !password) {
      setError('Preencha o e-mail e a senha para continuar.')
      return
    }

    if (!emailFormatado.includes('@') || !emailFormatado.includes('.')) {
      setError('Digite um e-mail válido.')
      return
    }

    if (!turnstileToken) {
      setError('Conclua a verificação de segurança para continuar.')
      return
    }

    setLoading(true)

    try {
      const validation = await validateTurnstileToken(turnstileToken)

      // O login por credenciais continua temporariamente simulado.
      await new Promise((resolve) => window.setTimeout(resolve, 400))

      const usuarioEncontrado = usuariosMockados.find(
        (usuario) =>
          usuario.email === emailFormatado &&
          usuario.password === password,
      )

      if (!usuarioEncontrado) {
        setError('E-mail ou senha inválidos. Tente novamente.')
        resetTurnstile()
        return
      }

      setUsuarioLogado({
        email: usuarioEncontrado.email,
        name: usuarioEncontrado.name,
        profile: usuarioEncontrado.profile,
      })
      setSecurityValidation(validation)
    } catch (loginError) {
      const message =
        loginError instanceof TurnstileValidationError
          ? loginError.message
          : 'Não foi possível concluir a verificação de segurança.'

      setError(message)
      resetTurnstile()
    } finally {
      setLoading(false)
    }
  }

  function handleLogout() {
    setUsuarioLogado(null)
    setEmail('')
    setPassword('')
    setError('')
    setShowPassword(false)
    setTurnstileToken('')
    setSecurityValidation(null)
  }

  if (usuarioLogado && securityValidation) {
    return (
      <Dashboard
        user={usuarioLogado}
        securityValidation={securityValidation}
        onLogout={handleLogout}
      />
    )
  }

  return (
    <main className="sgpa-shell">
      <section className="sgpa-brand-panel">
        <div className="sgpa-brand">
          <span className="sgpa-brand-mark">SG</span>
          <span>SGPA</span>
        </div>

        <div className="sgpa-brand-content">
          <p className="sgpa-eyebrow">AMBIENTE ACADÊMICO</p>

          <h1>Segurança e organização para cada avaliação.</h1>

          <p>
            Acesse provas, atividades e informações acadêmicas em um único
            ambiente.
          </p>
        </div>

        <p className="sgpa-copyright">
          © {new Date().getFullYear()} SGPA · Sistema de Gerenciamento Seguro
          de Provas e Atividades Acadêmicas
        </p>
      </section>

      <section className="sgpa-login-panel">
        <div className="sgpa-login-card">
          <div className="sgpa-mobile-brand">
            <span className="sgpa-brand-mark">SG</span>
            <span>SGPA</span>
          </div>

          <header>
            <p className="sgpa-eyebrow">ACESSO AO SISTEMA</p>

            <h2>Boas-vindas</h2>

            <p className="sgpa-subtitle">
              Informe suas credenciais para continuar.
            </p>
          </header>

          <form noValidate onSubmit={handleLogin}>
            <label htmlFor="email">E-mail</label>

            <input
              id="email"
              type="email"
              placeholder="seuemail@sgpa.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />

            <label htmlFor="password">Senha</label>

            <div className="sgpa-password-field">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Digite sua senha"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />

              <button
                className="sgpa-password-toggle"
                type="button"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>

            <TurnstileWidget
              siteKey={turnstileSiteKey}
              resetSignal={turnstileResetSignal}
              onVerify={(token) => {
                setTurnstileToken(token)
                setError('')
              }}
              onExpire={() => {
                setTurnstileToken('')
                setError('A verificação expirou. Conclua-a novamente.')
              }}
              onError={(message) => {
                setTurnstileToken('')
                setError(message)
              }}
            />

            <p className="sgpa-security-note">
              Protegido por Cloudflare Turnstile. O token é validado no
              servidor e não é armazenado.
            </p>

            {error && (
              <p className="sgpa-alert" role="alert">
                {error}
              </p>
            )}

            <button
              className="sgpa-submit-button"
              type="submit"
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

function Dashboard({
  user,
  securityValidation,
  onLogout,
}: DashboardProps) {
  const initials = user.name
    .split(' ')
    .slice(0, 2)
    .map((name) => name[0])
    .join('')

  return (
    <main className="sgpa-dashboard">
      <header className="sgpa-dashboard-header">
        <div className="sgpa-brand">
          <span className="sgpa-brand-mark">SG</span>
          <span>SGPA</span>
        </div>

        <button
          className="sgpa-logout-button"
          type="button"
          onClick={onLogout}
        >
          Sair
        </button>
      </header>

      <section className="sgpa-dashboard-content">
        <p className="sgpa-eyebrow">PAINEL INICIAL</p>

        <h1>Olá, {user.name}.</h1>

        <p className="sgpa-subtitle">
          Você está conectado ao Sistema de Gerenciamento Seguro de Provas e
          Atividades Acadêmicas.
        </p>

        <article className="sgpa-user-card">
          <div className="sgpa-avatar">{initials}</div>

          <div>
            <span className="sgpa-user-label">USUÁRIO CONECTADO</span>
            <h2>{user.name}</h2>
            <p>{user.email}</p>
          </div>

          <span className="sgpa-profile-badge">
            {user.profile}
          </span>
        </article>

        <div className="sgpa-dashboard-notice">
          <strong>Login realizado com sucesso.</strong>

          <span>
            Cloudflare Turnstile validado e evento registrado no Supabase.
          </span>

          <code>Protocolo: {securityValidation.requestId}</code>
        </div>
      </section>
    </main>
  )
}

export default App
