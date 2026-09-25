export type Profile = 'Administrador' | 'Professor' | 'Aluno'

export type AccessUser = {
  name: string
  email: string
  profile: Profile
}

export type ProfileRecord = {
  nome: string
  email: string
  perfil: string
  situacao: string
}

export type ProfileDecision =
  | { kind: 'denied'; message: string }
  | { kind: 'ready'; user: AccessUser }

export function decideProfileAccess(record: ProfileRecord): ProfileDecision {
  if (record.situacao !== 'ATIVO') {
    return {
      kind: 'denied',
      message:
        record.situacao === 'PENDENTE'
          ? 'Sua conta ainda aguarda aprovação do administrador.'
          : 'Sua conta está inativa. Procure o administrador.',
    }
  }

  let profile: Profile | null = null

  switch (record.perfil) {
    case 'ADMIN':
      profile = 'Administrador'
      break
    case 'PROFESSOR':
      profile = 'Professor'
      break
    case 'ALUNO':
      profile = 'Aluno'
      break
  }

  if (!profile) {
    return { kind: 'denied', message: 'Seu perfil de acesso é inválido.' }
  }

  return {
    kind: 'ready',
    user: {
      name: record.nome,
      email: record.email,
      profile,
    },
  }
}
