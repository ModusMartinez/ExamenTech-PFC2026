import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SolicitarMatriculaPanel } from '../src/components/SolicitarMatriculaPanel'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))

const matricula = {
  id: 'matricula-teste', turma_id: 'turma-teste', turma_nome: 'Engenharia de Software — 8º B',
  situacao: 'PENDENTE', solicitado_em: '2026-10-21T12:00:00Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada' } }, error: null })
  mocks.fetch.mockResolvedValue(Response.json({ matricula }, { status: 201 }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function submit(codigo = 'ABCDEF123456') {
  fireEvent.change(screen.getByLabelText('Código da turma'), { target: { value: codigo } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitação' }))
}

test('formulário usa o serviço do frontend com HTTP simulado e confirma a pendência', async () => {
  render(<SolicitarMatriculaPanel />)
  expect(mocks.getSession).not.toHaveBeenCalled()
  submit('  abcdef123456  ')
  const success = await screen.findByRole('status')
  expect(success.textContent).toContain(matricula.turma_nome)
  expect(success.textContent).toContain('pendente de aprovação')
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/matriculas', {
    method: 'POST', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo: 'ABCDEF123456' }),
  })
  expect((screen.getByLabelText('Código da turma') as HTMLInputElement).value).toBe('')
  expect(screen.queryByText('sessao-simulada')).toBeNull()
})

test('código vazio, incompleto, longo ou fora do formato não consulta sessão nem envia requisição', async () => {
  render(<SolicitarMatriculaPanel />)
  for (const codigo of ['', '   ', 'ABC', 'ABCDEF1234567', 'GBCDEF123456', 'ABC DEF123456']) {
    submit(codigo)
    expect((await screen.findByRole('alert')).textContent).toContain('12 caracteres')
    expect(screen.getByLabelText('Código da turma').getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(screen.getByLabelText('Código da turma'))
  }
  expect(mocks.getSession).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('envio em andamento bloqueia cliques e submits repetidos', async () => {
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve }))
  render(<SolicitarMatriculaPanel />)
  submit()
  fireEvent.submit(screen.getByLabelText('Código da turma').closest('form')!)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText('Código da turma').hasAttribute('disabled')).toBe(true)
  const button = screen.getByRole('button', { name: 'Enviando...' })
  expect(button.hasAttribute('disabled')).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('true')
  await act(async () => finish(Response.json({ matricula }, { status: 201 })))
  expect(screen.getByLabelText('Código da turma').hasAttribute('disabled')).toBe(false)
})

for (const [status, message] of [
  [400, 'Código de turma inválido ou indisponível.'],
  [401, 'Sessão inválida. Entre novamente.'],
  [403, 'Solicitação exige aluno ativo, organização ativa e MFA.'],
  [409, 'Já existe uma matrícula nesta turma. Consulte o responsável.'],
  [503, 'Não foi possível registrar a solicitação. Tente novamente.'],
] as const) {
  test(`erro ${status} da API é apresentado sem limpar o código nem simular sucesso`, async () => {
    mocks.fetch.mockResolvedValue(Response.json({ message }, { status }))
    render(<SolicitarMatriculaPanel />)
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect((screen.getByLabelText('Código da turma') as HTMLInputElement).value).toBe('ABCDEF123456')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Enviar solicitação' }).hasAttribute('disabled')).toBe(false)
  })
}

test('sem sessão ou com erro na sessão orienta novo login sem chamar API', async () => {
  render(<SolicitarMatriculaPanel />)
  for (const sessionError of [null, { message: 'Falha interna' }]) {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: sessionError })
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe('Sua sessão terminou. Entre novamente.')
  }
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('falha de conexão permite tentar novamente e sucesso anterior não esconde erro posterior', async () => {
  mocks.fetch.mockRejectedValueOnce(new TypeError('Detalhe interno de rede'))
  render(<SolicitarMatriculaPanel />)
  submit()
  expect((await screen.findByRole('alert')).textContent).toContain('Confira sua conexão')
  expect(screen.queryByText('Detalhe interno de rede')).toBeNull()
  submit()
  await screen.findByRole('status')
  expect(screen.queryByRole('alert')).toBeNull()
  mocks.fetch.mockResolvedValue(Response.json({ message: 'Já existe uma matrícula nesta turma.' }, { status: 409 }))
  submit()
  await screen.findByRole('alert')
  expect(screen.queryByRole('status')).toBeNull()
})

test('resposta não JSON ou matrícula incompleta nunca apresenta sucesso', async () => {
  render(<SolicitarMatriculaPanel />)
  for (const response of [
    new Response('<html>Serviço indisponível</html>', { status: 503 }),
    Response.json(null), Response.json([]), Response.json({ matricula: { turma_nome: 'Incompleta' } }),
    Response.json({ matricula: { ...matricula, situacao: 'ATIVA' } }),
    Response.json({ message: 10 }, { status: 503 }),
  ]) {
    mocks.fetch.mockResolvedValue(response)
    submit()
    await screen.findByRole('alert')
    expect(screen.queryByRole('status')).toBeNull()
    expect((screen.getByLabelText('Código da turma') as HTMLInputElement).value).toBe('ABCDEF123456')
  }
})
