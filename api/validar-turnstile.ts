import { randomUUID } from 'node:crypto'

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const SUPABASE_AUDIT_PATH = '/rest/v1/eventos_seguranca'
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA'
const MAX_TOKEN_LENGTH = 2048
const EXPECTED_ACTION = 'login'

type Environment = Record<string, string | undefined>
type FetchImplementation = typeof fetch

type TurnstileResponse = {
  success?: boolean
  hostname?: string
  action?: string
  'error-codes'?: string[]
}

type EventType =
  | 'TURNSTILE_VALIDADO'
  | 'TURNSTILE_REJEITADO'
  | 'TURNSTILE_INDISPONIVEL'

type AuditEvent = {
  solicitacao_id: string
  evento: EventType
  provedor: 'CLOUDFLARE_TURNSTILE'
  acao: string
  sucesso: boolean
  hostname: string | null
  codigos_erro: string[]
}

type HandlerDependencies = {
  env?: Environment
  fetchImplementation?: FetchImplementation
  createRequestId?: () => string
}

function jsonResponse(status: number, body: object, extraHeaders?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

function getTurnstileSecret(env: Environment) {
  if (env.TURNSTILE_SECRET_KEY) {
    return env.TURNSTILE_SECRET_KEY
  }

  const isLocalDevelopment =
    !env.VERCEL_ENV &&
    env.NODE_ENV === 'development'

  return isLocalDevelopment ? TEST_SECRET_KEY : null
}

function getSupabaseConfiguration(env: Environment) {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const apiKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !apiKey) {
    return null
  }

  return {
    url: url.replace(/\/$/, ''),
    apiKey,
    usesLegacyServiceRoleKey: !apiKey.startsWith('sb_secret_'),
  }
}

function getExpectedHostnames(env: Environment) {
  return (env.TURNSTILE_EXPECTED_HOSTNAMES ?? '')
    .split(',')
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean)
}

function validateTurnstileContext(
  validation: TurnstileResponse,
  env: Environment,
  usesOfficialTestKey: boolean,
) {
  const errorCodes = [...(validation['error-codes'] ?? [])]
  let valid = validation.success === true

  if (
    valid &&
    !usesOfficialTestKey &&
    validation.action !== EXPECTED_ACTION
  ) {
    valid = false
    errorCodes.push('action-mismatch')
  }

  const expectedHostnames = getExpectedHostnames(env)
  const receivedHostname = validation.hostname?.toLowerCase()

  if (
    valid &&
    !usesOfficialTestKey &&
    expectedHostnames.length > 0 &&
    (!receivedHostname || !expectedHostnames.includes(receivedHostname))
  ) {
    valid = false
    errorCodes.push('hostname-mismatch')
  }

  return {
    valid,
    validation: {
      ...validation,
      'error-codes': errorCodes,
    },
  }
}

async function registerAuditEvent(
  event: AuditEvent,
  env: Environment,
  fetchImplementation: FetchImplementation,
) {
  const supabase = getSupabaseConfiguration(env)

  if (!supabase) {
    return false
  }

  try {
    const headers: Record<string, string> = {
      apikey: supabase.apiKey,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    }

    if (supabase.usesLegacyServiceRoleKey) {
      headers.Authorization = `Bearer ${supabase.apiKey}`
    }

    const response = await fetchImplementation(
      `${supabase.url}${SUPABASE_AUDIT_PATH}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
      },
    )

    return response.ok
  } catch {
    return false
  }
}

async function validateWithCloudflare(
  token: string,
  secret: string,
  requestId: string,
  fetchImplementation: FetchImplementation,
) {
  const response = await fetchImplementation(SITEVERIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      secret,
      response: token,
      idempotency_key: requestId,
    }),
  })

  if (!response.ok) {
    throw new Error(`Cloudflare respondeu com HTTP ${response.status}.`)
  }

  return (await response.json()) as TurnstileResponse
}

function createAuditEvent(
  requestId: string,
  event: EventType,
  validation?: TurnstileResponse,
): AuditEvent {
  return {
    solicitacao_id: requestId,
    evento: event,
    provedor: 'CLOUDFLARE_TURNSTILE',
    acao: validation?.action || 'login',
    sucesso: event === 'TURNSTILE_VALIDADO',
    hostname: validation?.hostname || null,
    codigos_erro: validation?.['error-codes'] ?? [],
  }
}

export function createTurnstileHandler(
  dependencies: HandlerDependencies = {},
) {
  const env = dependencies.env ?? process.env
  const fetchImplementation = dependencies.fetchImplementation ?? fetch
  const createRequestId = dependencies.createRequestId ?? randomUUID

  return {
    async fetch(request: Request) {
      if (request.method !== 'POST') {
        return jsonResponse(
          405,
          {
            success: false,
            code: 'METODO_NAO_PERMITIDO',
            message: 'Utilize POST para validar o token de segurança.',
          },
          { Allow: 'POST' },
        )
      }

      const contentType = request.headers.get('content-type') ?? ''

      if (!contentType.includes('application/json')) {
        return jsonResponse(415, {
          success: false,
          code: 'CONTEUDO_INVALIDO',
          message: 'Envie os dados no formato JSON.',
        })
      }

      let body: { token?: unknown }

      try {
        body = (await request.json()) as { token?: unknown }
      } catch {
        return jsonResponse(400, {
          success: false,
          code: 'JSON_INVALIDO',
          message: 'Não foi possível interpretar os dados enviados.',
        })
      }

      const token = typeof body.token === 'string' ? body.token.trim() : ''

      if (!token || token.length > MAX_TOKEN_LENGTH) {
        return jsonResponse(400, {
          success: false,
          code: 'TOKEN_INVALIDO',
          message: 'Conclua novamente a verificação de segurança.',
        })
      }

      const requestId = createRequestId()
      const secret = getTurnstileSecret(env)

      if (!secret) {
        return jsonResponse(500, {
          success: false,
          requestId,
          code: 'SERVICO_NAO_CONFIGURADO',
          message: 'A verificação de segurança não está configurada.',
        })
      }

      let validation: TurnstileResponse

      try {
        validation = await validateWithCloudflare(
          token,
          secret,
          requestId,
          fetchImplementation,
        )
      } catch {
        const auditSaved = await registerAuditEvent(
          createAuditEvent(requestId, 'TURNSTILE_INDISPONIVEL'),
          env,
          fetchImplementation,
        )

        return jsonResponse(502, {
          success: false,
          requestId,
          audited: auditSaved,
          code: 'PROVEDOR_INDISPONIVEL',
          message:
            'Não foi possível consultar o serviço de segurança. Tente novamente.',
        })
      }

      const contextValidation = validateTurnstileContext(
        validation,
        env,
        secret === TEST_SECRET_KEY,
      )
      validation = contextValidation.validation

      const validationSucceeded = contextValidation.valid
      const event = validationSucceeded
        ? 'TURNSTILE_VALIDADO'
        : 'TURNSTILE_REJEITADO'

      const auditSaved = await registerAuditEvent(
        createAuditEvent(requestId, event, validation),
        env,
        fetchImplementation,
      )

      if (!auditSaved) {
        return jsonResponse(503, {
          success: false,
          requestId,
          audited: false,
          code: 'AUDITORIA_INDISPONIVEL',
          message:
            'A verificação não pôde ser registrada. Tente novamente em instantes.',
        })
      }

      if (!validationSucceeded) {
        return jsonResponse(403, {
          success: false,
          requestId,
          audited: true,
          code: 'VERIFICACAO_RECUSADA',
          message: 'A verificação de segurança foi recusada. Tente novamente.',
        })
      }

      return jsonResponse(200, {
        success: true,
        requestId,
        audited: true,
        message: 'Verificação de segurança concluída.',
      })
    },
  }
}

export default createTurnstileHandler()
