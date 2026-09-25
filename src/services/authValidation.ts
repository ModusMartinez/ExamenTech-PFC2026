const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateLoginFields(email: string, password: string): string | null {
  if (!email.trim() || !password) {
    return 'Preencha o e-mail e a senha.'
  }

  if (!EMAIL_PATTERN.test(email.trim())) {
    return 'Digite um e-mail válido.'
  }

  return null
}

export function validateRegistrationFields(
  name: string,
  email: string,
  password: string,
  confirmation: string,
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

  return null
}

export function validateInvitationFields(
  organizationCode: string,
  studentCode: string,
): string | null {
  if (!organizationCode.trim() || !studentCode.trim()) {
    return 'Informe o código da organização e o convite individual.'
  }

  if (
    !/^[A-Za-z0-9_-]{21}$/.test(organizationCode.trim()) ||
    !/^[a-fA-F0-9]{64}$/.test(studentCode.trim())
  ) {
    return 'Um dos códigos informados é inválido.'
  }

  return null
}
