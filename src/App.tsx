import { useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Profile = 'Administrador' | 'Professor' | 'Aluno'

type User = {
  name: string
  email: string
  profile: Profile
}

type SavedUser = User & {
  password: string
}

const defaultUsers: SavedUser[] = [
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

function loadUsers(): SavedUser[] {
  const data = localStorage.getItem('examentech-usuarios')

  if (!data) {
    return []
  }

  try {
    return JSON.parse(data)
  } catch {
    return []
  }
}

function App() {
  const [page, setPage] = useState<'login' | 'cadastro'>('login')
  const [users, setUsers] = useState<SavedUser[]>(loadUsers)
  const [loggedUser, setLoggedUser] = useState<User | null>(null)

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

  const allUsers = [...defaultUsers, ...users]

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

    setLoading(true)
    await new Promise((resolve) => window.setTimeout(resolve, 700))
    setLoading(false)

    const foundUser = allUsers.find(
      (user) =>
        user.email.toLowerCase() === typedEmail &&
        user.password === password
    )

    if (!foundUser) {
      setLoginError('E-mail ou senha incorretos.')
      return
    }

    setLoggedUser({
      name: foundUser.name,
      email: foundUser.email,
      profile: foundUser.profile,
    })
  }

  async function handleRegister(event: FormEvent) {
    event.preventDefault()
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

    const emailAlreadyExists = allUsers.some(
      (user) => user.email.toLowerCase() === newEmail
    )

    if (emailAlreadyExists) {
      setRegisterError('Já existe uma conta com esse e-mail.')
      return
    }

    setLoading(true)
    await new Promise((resolve) => window.setTimeout(resolve, 700))
    setLoading(false)

    const newUser: SavedUser = {
      name: newName,
      email: newEmail,
      password: registerPassword,
      profile: 'Aluno',
    }

    const newUserList = [...users, newUser]

    setUsers(newUserList)
    localStorage.setItem('examentech-usuarios', JSON.stringify(newUserList))

    setEmail(newEmail)
    setPassword('')

    setName('')
    setRegisterEmail('')
    setRegisterPassword('')
    setConfirmPassword('')

    setPage('login')
    setSuccessMessage('Conta criada. Agora você já pode entrar.')
  }

  function handleLogout() {
    setLoggedUser(null)
    setEmail('')
    setPassword('')
    setShowPassword(false)
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

                {loginError && (
                  <div className="alert error">
                    {loginError}
                  </div>
                )}

                {successMessage && (
                  <div className="alert success">
                    {successMessage}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading}
                >
                  {loading ? 'Entrando...' : 'Entrar'}
                </button>
              </form>

              <div className="form-footer">
                Ainda não possui uma conta?

                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setPage('cadastro')
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
                    value={name}
                    onChange={(event) =>
                      setName(event.target.value)
                    }
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="register-email">
                    E-mail
                  </label>

                  <input
                    id="register-email"
                    type="email"
                    value={registerEmail}
                    onChange={(event) =>
                      setRegisterEmail(event.target.value)
                    }
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="register-password">
                    Senha
                  </label>

                  <input
                    id="register-password"
                    type="password"
                    placeholder="Mínimo de 6 caracteres"
                    value={registerPassword}
                    onChange={(event) =>
                      setRegisterPassword(event.target.value)
                    }
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="confirm-password">
                    Confirmar senha
                  </label>

                  <input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) =>
                      setConfirmPassword(event.target.value)
                    }
                  />
                </div>

                {registerError && (
                  <div className="alert error">
                    {registerError}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading}
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
  onLogout: () => void
}

function Dashboard({ user, onLogout }: DashboardProps) {
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
      </main>
    </div>
  )
}

export default App
