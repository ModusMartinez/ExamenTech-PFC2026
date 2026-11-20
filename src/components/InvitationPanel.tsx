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

type Invitation = {
  codigo: string
  expira_em: string
  email: string
  organizacao_id: string
  perfil_destino: 'ALUNO' | 'PROFESSOR'
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

function readInvitation(value: unknown): Invitation | null {
  if (!value || typeof value !== 'object') return null

  const item = value as Record<string, unknown>
  if (
    typeof item.codigo !== 'string' ||
    !item.codigo ||
    typeof item.expira_em !== 'string' ||
    typeof item.email !== 'string' ||
    typeof item.organizacao_id !== 'string' ||
    (item.perfil_destino !== 'ALUNO' && item.perfil_destino !== 'PROFESSOR')
  ) {
    return null
  }

  return {
    codigo: item.codigo,
    expira_em: item.expira_em,
    email: item.email,
    organizacao_id: item.organizacao_id,
    perfil_destino: item.perfil_destino,
  }
}

export function InvitationPanel({ profile }: InvitationPanelProps) {
  const isAdmin = profile === 'Administrador'
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('')
  const [teacherOrganizationId, setTeacherOrganizationId] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [invitationEmail, setInvitationEmail] = useState('')
  const [selectedProfile, setSelectedProfile] = useState<'ALUNO' | 'PROFESSOR'>('ALUNO')
  const [organizationCode, setOrganizationCode] = useState<OrganizationCode | null>(null)
  const [invitation, setInvitation] = useState<Invitation | null>(null)
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
  const invitationProfile = isAdmin ? selectedProfile : 'ALUNO'
  const recipientLabel = invitationProfile === 'PROFESSOR' ? 'professor' : 'aluno'

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
      setInvitation(null)
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

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const email = invitationEmail.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInvitationError(`Digite um e-mail válido para o ${recipientLabel}.`)
      return
    }
    if (!invitationOrganizationId) {
      setInvitationError('Selecione ou vincule uma organização antes de gerar o convite.')
      return
    }

    setCreatingInvitation(true)
    setInvitation(null)
    setInvitationError('')

    try {
      const functionName = invitationProfile === 'PROFESSOR'
        ? 'emitir_convite_professor'
        : 'emitir_convite_aluno'
      const { data, error } = await supabase.rpc(functionName, {
        p_email: email,
        p_organizacao_id: invitationOrganizationId,
      })
      const result = readInvitation(data)

      if (error || !result || result.organizacao_id !== invitationOrganizationId ||
          result.perfil_destino !== invitationProfile) {
        throw new Error('Falha ao emitir convite.')
      }

      setInvitationEmail('')
      setInvitation(result)
    } catch {
      setInvitationError('Não foi possível gerar o convite. Confira o e-mail e tente novamente.')
    } finally {
      setCreatingInvitation(false)
    }
  }

  return (
    <section className="invitation-panel" aria-labelledby="invitation-panel-title">
      <div className="invitation-heading">
        <p className="invitation-eyebrow">ACESSO ADMINISTRADOR</p>
        <h2 id="invitation-panel-title">Organizações e convites</h2>
        <p>Admin. Cadastro de organização</p>
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
                  setInvitation(null)
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
              <p>Copie e guarde este código agora. Ele não será mostrado novamente.</p>
            </div>
          )}
        </div>
      )}

      <div className="invitation-card">
        <h3>Convite para {recipientLabel}</h3>
        <p className="invitation-muted">
          {isAdmin
            ? 'Escolha a organização, o tipo de conta e o e-mail de quem receberá o convite.'
            : 'Você pode convidar alunos da organização do seu perfil. Convites para professores são emitidos pelo administrador.'}
        </p>

        <form onSubmit={createInvitation} className="invitation-form">
          {isAdmin && (
            <>
              <label htmlFor="invitation-profile">Tipo de conta</label>
              <select
                id="invitation-profile"
                value={selectedProfile}
                disabled={busy || contextLoading}
                onChange={(event) => {
                  setSelectedProfile(event.target.value === 'PROFESSOR' ? 'PROFESSOR' : 'ALUNO')
                  setInvitation(null)
                  setInvitationError('')
                }}
              >
                <option value="ALUNO">Aluno</option>
                <option value="PROFESSOR">Professor</option>
              </select>
            </>
          )}
          <label htmlFor="invited-email">E-mail do {recipientLabel}</label>
          <input
            id="invited-email"
            type="email"
            value={invitationEmail}
            onChange={(event) => setInvitationEmail(event.target.value)}
            disabled={busy || contextLoading || !invitationOrganizationId}
            placeholder={`${recipientLabel}@exemplo.com`}
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
        {invitation && (
          <div className="invitation-result" role="status">
            <strong>Convite de {recipientLabel} para {invitation.email}</strong>
            <code>{invitation.codigo}</code>
            <p>
              Envie o código ao {recipientLabel} por um canal seguro antes de sair desta tela.
              {Number.isFinite(Date.parse(invitation.expira_em)) && (
                <> Válido até {new Date(invitation.expira_em).toLocaleString('pt-BR')}.</>
              )}
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
