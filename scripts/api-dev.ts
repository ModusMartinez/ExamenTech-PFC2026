import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import turnstileHandler from '../api/validar-turnstile.ts'

const MAX_BODY_SIZE = 16 * 1024
const port = Number(process.env.API_PORT ?? 8787)

function toHeaders(source: IncomingHttpHeaders) {
  const headers = new Headers()

  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(', '))
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }

  return headers
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let receivedBytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    receivedBytes += buffer.length

    if (receivedBytes > MAX_BODY_SIZE) {
      throw new Error('REQUEST_TOO_LARGE')
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

const server = createServer(async (incomingRequest, outgoingResponse) => {
  try {
    const host = incomingRequest.headers.host ?? `127.0.0.1:${port}`
    const url = new URL(incomingRequest.url ?? '/', `http://${host}`)

    if (url.pathname !== '/api/validar-turnstile') {
      outgoingResponse.writeHead(404, { 'Content-Type': 'application/json' })
      outgoingResponse.end(JSON.stringify({ message: 'Rota não encontrada.' }))
      return
    }

    const method = incomingRequest.method ?? 'GET'
    const hasBody = !['GET', 'HEAD'].includes(method)
    const body = hasBody ? await readBody(incomingRequest) : undefined

    const request = new Request(url, {
      method,
      headers: toHeaders(incomingRequest.headers),
      body: body?.length ? body : undefined,
    })

    const response = await turnstileHandler.fetch(request)
    const responseBody = Buffer.from(await response.arrayBuffer())

    outgoingResponse.statusCode = response.status
    response.headers.forEach((value, name) => {
      outgoingResponse.setHeader(name, value)
    })
    outgoingResponse.end(responseBody)
  } catch (error) {
    const status =
      error instanceof Error && error.message === 'REQUEST_TOO_LARGE'
        ? 413
        : 500

    outgoingResponse.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    outgoingResponse.end(
      JSON.stringify({
        success: false,
        message:
          status === 413
            ? 'A requisição ultrapassou o tamanho permitido.'
            : 'Erro interno no servidor local.',
      }),
    )
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`API local disponível em http://127.0.0.1:${port}`)
})
