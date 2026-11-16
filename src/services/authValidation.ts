const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Limite técnico de entrada; o formato institucional não fixa uma quantidade de dígitos.
export function normalizeRgm(value: string): string {
  return value.trim().toUpperCase()
}

export function validateRgm(value: string): string | null {
  const rgm = normalizeRgm(value)
  if (rgm && !/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(rgm)) {
    return 'Informe um RGM com até 50 caracteres, usando letras, números, ponto, hífen, barra ou sublinhado.'
  }
  // O convite define o perfil: o banco exige o RGM quando o destino é ALUNO.
  return null
}

export function validateLoginFields(email: string, password: string): string | null {
  if (!email.trim() || !password) {
    return 'Preencha o e-mail e a senha.'
  }

  if (!EMAIL_PATTERN.test(email.trim())) {
    return 'Digite um e-mail válido.'
  }

  return null
}

export function validateRecoveryEmail(email: string): string | null {
  if (!EMAIL_PATTERN.test(email.trim())) return 'Digite um e-mail válido.'
  return null
}

export function validateNewPassword(password: string, confirmation: string): string | null {
  if (!password || !confirmation) return 'Preencha a nova senha e a confirmação.'
  if (password.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.'
  if (password !== confirmation) return 'As senhas não são iguais.'
  return null
}

export function validateRegistrationFields(
  name: string,
  email: string,
  password: string,
  confirmation: string,
  rgm = '',
): string | null {
  if (!name.trim() || !email.trim() || !password || !confirmation) {
    return 'Preencha todos os campos.'
  }

  if (!EMAIL_PATTERN.test(email.trim())) {
    return 'Digite um e-mail válido.'
  }

  if (password.length < 8) {
    return 'A senha precisa ter pelo menos 8 caracteres.'
  }

  if (password !== confirmation) {
    return 'As senhas não são iguais.'
  }

  return validateRgm(rgm)
}

export function validateInvitationFields(
  organizationCode: string,
  invitationCode: string,
): string | null {
  const organization = organizationCode.trim()
  const invitation = invitationCode.trim()

  if (!organization || !invitation) {
    return 'Informe o código da organização e o convite individual.'
  }

  if (organization.length !== 21) {
    return `O código da organização precisa ter 21 caracteres. Foram informados ${organization.length}.`
  }
  if (!/^[A-Za-z0-9_-]{21}$/.test(organization)) {
    return 'O código da organização contém caracteres inválidos. Copie somente o código, sem aspas ou espaços no meio.'
  }
  if (invitation.length !== 64) {
    return `O convite individual precisa ter 64 caracteres. Foram informados ${invitation.length}.`
  }
  if (!/^[a-fA-F0-9]{64}$/.test(invitation)) {
    return 'O convite individual contém caracteres inválidos. Copie somente o código gerado para o seu e-mail, sem aspas ou espaços no meio.'
  }

  return null
}
