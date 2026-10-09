type ValidationResponse = {
  success?: boolean
  requestId?: string
  audited?: boolean
  code?: string
  message?: string
}

export type SuccessfulTurnstileValidation = {
  requestId: string
  audited: true
}

export class TurnstileValidationError extends Error {
  readonly code: string

  constructor(message: string, code = 'ERRO_DE_VERIFICACAO') {
    super(message)
    this.name = 'TurnstileValidationError'
    this.code = code
  }
}

export async function validateTurnstileToken(
  token: string,
): Promise<SuccessfulTurnstileValidation> {
  let response: Response

  try {
    response = await fetch('/api/validar-turnstile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    })
  } catch {
    throw new TurnstileValidationError(
      'O serviço de segurança está indisponível. Tente novamente.',
      'SERVICO_INDISPONIVEL',
    )
  }

  let payload: ValidationResponse

  try {
    payload = (await response.json()) as ValidationResponse
  } catch {
    throw new TurnstileValidationError(
      'O serviço de segurança retornou uma resposta inválida.',
      'RESPOSTA_INVALIDA',
    )
  }

  if (!response.ok || payload.success !== true) {
    throw new TurnstileValidationError(
      payload.message || 'Não foi possível concluir a verificação de segurança.',
      payload.code,
    )
  }

  if (!payload.requestId || payload.audited !== true) {
    throw new TurnstileValidationError(
      'A verificação não pôde ser confirmada pelo servidor.',
      'CONFIRMACAO_INVALIDA',
    )
  }

  return {
    requestId: payload.requestId,
    audited: true,
  }
}
