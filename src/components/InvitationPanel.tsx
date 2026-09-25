import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import '../styles/invitations.css'

type InvitationPanelProps = {
  profile: 'Administrador' | 'Professor'
}

type Organization = {
  id: string
  nome: string
  situacao: string
}

type OrganizationCode = {
  id: string
  nome: string
  codigo: string
}

type StudentInvitation = {
  codigo: string
  expira_em: string
  email: string
  organizacao_id: string
}

function readOrganizationCode(value: unknown): OrganizationCode | null {
  if (!value || typeof value !== 'object') return null

  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string' ||
    typeof item.nome !== 'string' ||
    typeof item.codigo !== 'string' ||
    !item.codigo
  ) {
    return null
  }

  return { id: item.id, nome: item.nome, codigo: item.codigo }
}

function readStudentInvitation(value: unknown): StudentInvitation | null {
  if (!value || typeof value !== 'object') return null

  const item = value as Record<string, unknown>
  if (
    typeof item.codigo !== 'string' ||
    !item.codigo ||
    typeof item.expira_em !== 'string' ||
    typeof item.email !== 'string' ||
    typeof item.organizacao_id !== 'string'
  ) {
    return null
  }

  return {
    codigo: item.codigo,
    expira_em: item.expira_em,
    email: item.email,
    organizacao_id: item.organizacao_id,
  }
}

export function InvitationPanel({ profile }: InvitationPanelProps) {
  const isAdmin = profile === 'Administrador'
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('')
  const [teacherOrganizationId, setTeacherOrganizationId] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [studentEmail, setStudentEmail] = useState('')
  const [organizationCode, setOrganizationCode] = useState<OrganizationCode | null>(null)
  const [studentInvitation, setStudentInvitation] = useState<StudentInvitation | null>(null)
  const [contextLoading, setContextLoading] = useState(true)
  const [creatingOrganization, setCreatingOrganization] = useState(false)
  const [rotatingCode, setRotatingCode] = useState(false)
  const [creatingInvitation, setCreatingInvitation] = useState(false)
  const [contextError, setContextError] = useState('')
  const [organizationError, setOrganizationError] = useState('')
  const [invitationError, setInvitationError] = useState('')

  useEffect(() => {
    let active = true

    async function loadContext() {
      if (isAdmin) {
        const { data, error } = await supabase.rpc('listar_organizacoes_ativas')

        if (!active) return

        if (error || !Array.isArray(data)) {
          setContextError('Não foi possível carregar as organizações. Atualize a página e tente novamente.')
        } else {
          const available = data.filter(
            (item: unknown): item is Organization =>
              item !== null &&
              typeof item === 'object' &&
              'id' in item &&
              'nome' in item &&
              'situacao' in item &&
              typeof item.id === 'string' &&
              typeof item.nome === 'string' &&
              item.situacao === 'ATIVO',
          ).sort((first, second) => first.nome.localeCompare(second.nome, 'pt-BR'))
          setOrganizations(available)
          setSelectedOrganizationId(available[0]?.id ?? '')
        }
      } else {
        const { data: userData, error: userError } = await supabase.auth.getUser()

        if (!active) return

        if (userError || !userData.user) {
          setContextError('Não foi possível confirmar sua conta. Entre novamente.')
        } else {
          const { data, error } = await supabase
            .from('perfis')
            .select('organizacao_id')
            .eq('id', userData.user.id)
            .single()

          if (!active) return

          if (error || !data) {
            setContextError('Não foi possível consultar sua organização.')
          } else if (typeof data.organizacao_id !== 'string') {
            setContextError('Seu perfil ainda não está vinculado a uma organização. Procure o administrador.')
          } else {
            setTeacherOrganizationId(data.organizacao_id)
          }
        }
      }

      if (active) setContextLoading(false)
    }

    void loadContext().catch(() => {
      if (active) {
        setContextError('Não foi possível carregar os dados dos convites.')
        setContextLoading(false)
      }
    })

    return () => {
      active = false
    }
  }, [isAdmin])

  const busy = creatingOrganization || rotatingCode || creatingInvitation
  const invitationOrganizationId = isAdmin
    ? selectedOrganizationId
    : teacherOrganizationId

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isAdmin || busy) return

    const name = organizationName.trim()
    if (!name) {
      setOrganizationError('Informe o nome da organização.')
      return
    }

    setCreatingOrganization(true)
    setOrganizationCode(null)
    setOrganizationError('')

    try {
      const { data, error } = await supabase.rpc('criar_organizacao_com_codigo', {
        p_nome: name,
      })
      const result = readOrganizationCode(data)

      if (error || !result) throw new Error('Falha ao criar organização.')

      setOrganizations((current) =>
        [...current, { id: result.id, nome: result.nome, situacao: 'ATIVO' }]
          .sort((first, second) => first.nome.localeCompare(second.nome, 'pt-BR')),
      )
      setSelectedOrganizationId(result.id)
      setOrganizationName('')
      setStudentInvitation(null)
      setOrganizationCode(result)
    } catch {
      setOrganizationError('Não foi possível criar a organização. Confira seus dados e tente novamente.')
    } finally {
      setCreatingOrganization(false)
    }
  }

  async function rotateOrganizationCode() {
    if (!isAdmin || busy || !selectedOrganizationId) return

    const confirmed = window.confirm(
      'Gerar um novo código? O código anterior desta organização deixará de funcionar.',
    )
    if (!confirmed) return

    setRotatingCode(true)
    setOrganizationCode(null)
    setOrganizationError('')

    try {
      const { data, error } = await supabase.rpc('rotacionar_codigo_organizacao', {
        p_organizacao_id: selectedOrganizationId,
      })
      const result = readOrganizationCode(data)

      if (error || !result || result.id !== selectedOrganizationId) {
        throw new Error('Falha ao gerar novo código.')
      }

      setOrganizationCode(result)
    } catch {
      setOrganizationError('Não foi possível gerar o novo código. Tente novamente.')
    } finally {
      setRotatingCode(false)
    }
  }

  async function createStudentInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const email = studentEmail.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInvitationError('Digite um e-mail válido para o aluno.')
      return
    }
    if (!invitationOrganizationId) {
      setInvitationError('Selecione ou vincule uma organização antes de gerar o convite.')
      return
    }

    setCreatingInvitation(true)
    setStudentInvitation(null)
    setInvitationError('')

    try {
      const { data, error } = await supabase.rpc('emitir_convite_aluno', {
        p_email: email,
        p_organizacao_id: invitationOrganizationId,
      })
      const result = readStudentInvitation(data)

      if (error || !result || result.organizacao_id !== invitationOrganizationId) {
        throw new Error('Falha ao emitir convite.')
      }

      setStudentEmail('')
      setStudentInvitation(result)
    } catch {
      setInvitationError('Não foi possível gerar o convite. Confira o e-mail e tente novamente.')
    } finally {
      setCreatingInvitation(false)
    }
  }

  return (
    <section className="invitation-panel" aria-labelledby="invitation-panel-title">
      <div className="invitation-heading">
        <p className="invitation-eyebrow">ACESSO INSTITUCIONAL</p>
        <h2 id="invitation-panel-title">Organizações e convites</h2>
        <p>Os códigos são gerados pelo sistema e vinculados à organização.</p>
      </div>

      {contextLoading && <p className="invitation-muted" role="status">Carregando informações...</p>}
      {contextError && <p className="invitation-alert invitation-alert-error" role="alert">{contextError}</p>}

      {isAdmin && (
        <div className="invitation-card">
          <h3>Organização</h3>
          <p className="invitation-muted">Cadastre uma instituição ou gere um novo código de acesso para uma existente.</p>

          <form onSubmit={createOrganization} className="invitation-form">
            <label htmlFor="new-organization-name">Nome da organização</label>
            <input
              id="new-organization-name"
              value={organizationName}
              onChange={(event) => setOrganizationName(event.target.value)}
              disabled={busy}
              maxLength={120}
              autoComplete="organization"
            />
            <button type="submit" disabled={busy || contextLoading}>
              {creatingOrganization ? 'Criando...' : 'Criar organização e código'}
            </button>
          </form>

          {organizations.length > 0 && (
            <div className="invitation-rotate">
              <label htmlFor="organization-choice">Organização existente</label>
              <select
                id="organization-choice"
                value={selectedOrganizationId}
                onChange={(event) => {
                  setSelectedOrganizationId(event.target.value)
                  setOrganizationCode(null)
                  setStudentInvitation(null)
                }}
                disabled={busy || contextLoading}
              >
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>{organization.nome}</option>
                ))}
              </select>
              <p className="invitation-warning">Ao gerar um novo código, o anterior deixa de funcionar.</p>
              <button
                type="button"
                className="invitation-secondary-button"
                onClick={() => void rotateOrganizationCode()}
                disabled={busy || contextLoading || !selectedOrganizationId}
              >
                {rotatingCode ? 'Gerando...' : 'Gerar novo código da organização'}
              </button>
            </div>
          )}

          {organizationError && <p className="invitation-alert invitation-alert-error" role="alert">{organizationError}</p>}
          {organizationCode && (
            <div className="invitation-result" role="status">
              <strong>Código de {organizationCode.nome}</strong>
              <code>{organizationCode.codigo}</code>
              <p>Copie e guarde este código agora. Ele não será mostrado novamente depois que você sair desta tela.</p>
            </div>
          )}
        </div>
      )}

      <div className="invitation-card">
        <h3>Convite para aluno</h3>
        <p className="invitation-muted">
          {isAdmin
            ? 'Escolha a organização acima e informe o e-mail do aluno.'
            : 'O convite será vinculado à organização do seu perfil.'}
        </p>

        <form onSubmit={createStudentInvitation} className="invitation-form">
          <label htmlFor="invited-student-email">E-mail do aluno</label>
          <input
            id="invited-student-email"
            type="email"
            value={studentEmail}
            onChange={(event) => setStudentEmail(event.target.value)}
            disabled={busy || contextLoading || !invitationOrganizationId}
            placeholder="aluno@exemplo.com"
            maxLength={254}
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={busy || contextLoading || !invitationOrganizationId}
          >
            {creatingInvitation ? 'Gerando...' : 'Gerar convite'}
          </button>
        </form>

        {invitationError && <p className="invitation-alert invitation-alert-error" role="alert">{invitationError}</p>}
        {studentInvitation && (
          <div className="invitation-result" role="status">
            <strong>Convite para {studentInvitation.email}</strong>
            <code>{studentInvitation.codigo}</code>
            <p>
              Copie e entregue o código ao aluno por um canal seguro antes de sair desta tela.
              {Number.isFinite(Date.parse(studentInvitation.expira_em)) && (
                <> Válido até {new Date(studentInvitation.expira_em).toLocaleString('pt-BR')}.</>
              )}
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
