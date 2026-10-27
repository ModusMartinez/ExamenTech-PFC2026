import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NovaAvaliacaoPanel } from '../src/components/NovaAvaliacaoPanel'
import { criarAvaliacaoRascunho } from '../src/services/avaliacoes'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({ listarTurmas: mocks.listar }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turmaId = '10000000-0000-0000-0000-000000000001'
const professorId = '20000000-0000-0000-0000-000000000001'
const turma = { id: turmaId, nome: 'Engenharia 8B', situacao: 'ATIVA', professor_id: professorId }
const dados = {
  turma_id: turmaId, titulo: 'Primeira prova', tipo: 'PROVA' as const,
  inicio_em: new Date('2026-11-09T19:00').toISOString(),
  fim_em: new Date('2026-11-09T21:00').toISOString(), duracao_minutos: 60,
}
const avaliacao = {
  ...dados, id: '30000000-0000-0000-0000-000000000001', professor_id: professorId,
  situacao: 'RASCUNHO', criado_em: '2026-10-27T12:00:00Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listar.mockResolvedValue([turma, { ...turma, id: 'inativa', nome: 'Turma encerrada', situacao: 'INATIVA' }])
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada', user: { id: professorId } } }, error: null })
  mocks.fetch.mockImplementation(async (_url, options) => Response.json({ avaliacao: { ...avaliacao, ...JSON.parse(options.body) } }, { status: 201 }))
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function preencher() {
  render(<NovaAvaliacaoPanel />)
  await screen.findByRole('option', { name: turma.nome })
  for (const [label, value] of [
    ['Turma', turmaId], ['Título', '  Primeira prova  '],
    ['Início', '2026-11-09T19:00'], ['Fim', '2026-11-09T21:00'], ['Duração (minutos)', '60'],
  ]) fireEvent.change(screen.getByLabelText(label), { target: { value } })
  return screen.getByRole('form', { name: 'Nova avaliação em rascunho' })
}

test.each(['PROVA', 'ATIVIDADE'])('cria %s com datas no fuso local, somente campos permitidos e confirmação do servidor', async (tipo) => {
  const form = await preencher()
  expect(screen.queryByRole('option', { name: 'Turma encerrada' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: tipo } })
  fireEvent.submit(form)
  const success = await screen.findByText('Avaliação “Primeira prova” criada em rascunho.')
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/avaliacoes', {
    method: 'POST', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...dados, tipo }),
  })
  expect(document.activeElement).toBe(success)
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Turma') as HTMLSelectElement).value).toBe('')
  expect(screen.queryByRole('button', { name: /Publicar|Editar/ })).toBeNull()
})

test.each([
  ['Turma', '', 'Selecione uma turma ativa.'],
  ['Título', '  ', 'Título deve ter de 3 a 150 caracteres.'],
  ['Título', 'a'.repeat(151), 'Título deve ter de 3 a 150 caracteres.'],
  ['Tipo', '', 'Selecione Prova ou Atividade.'],
  ['Início', '', 'Informe uma data e um horário de início válidos.'],
  ['Início', '2026-02-30T19:00', 'Informe uma data e um horário de início válidos.'],
  ['Fim', '', 'Fim deve ser posterior ao início.'],
  ['Fim', '2026-11-09T19:00', 'Fim deve ser posterior ao início.'],
  ['Fim', '2026-11-08T19:00', 'Fim deve ser posterior ao início.'],
  ...['', '0', '-1', '1.5', '2147483648'].map((value) => ['Duração (minutos)', value, 'Informe uma duração válida em minutos inteiros, maior que zero.']),
])('recusa %s inválido (%s), informa o erro e foca o campo', async (label, value, message) => {
  const form = await preencher()
  const input = screen.getByLabelText(label)
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(form)
  expect((await screen.findByRole('alert')).textContent).toBe(message)
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('carregamento bloqueia envio; lista vazia ou somente inativas não oferece cadastro', async () => {
  let finish!: (value: unknown[]) => void
  mocks.listar.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  render(<NovaAvaliacaoPanel />)
  expect(screen.getByText('Carregando turmas...')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Criar rascunho' }).matches(':disabled')).toBe(true)
  fireEvent.submit(screen.getByRole('form'))
  expect(mocks.fetch).not.toHaveBeenCalled()
  await act(async () => finish([{ ...turma, situacao: 'INATIVA' }]))
  await screen.findByText('Nenhuma turma ativa disponível.')
  expect(screen.getByRole('button', { name: 'Criar rascunho' }).matches(':disabled')).toBe(true)
  mocks.listar.mockResolvedValueOnce([])
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar turmas' }))
  await screen.findByText('Nenhuma turma ativa disponível.')
})

test('erro na consulta bloqueia envio e permite recarregar turmas', async () => {
  mocks.listar.mockRejectedValueOnce(new Error('Turmas indisponíveis.'))
  render(<NovaAvaliacaoPanel />)
  await screen.findByText('Turmas indisponíveis.')
  expect(screen.queryByText('Nenhuma turma ativa disponível.')).toBeNull()
  fireEvent.submit(screen.getByRole('form'))
  expect(mocks.fetch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar turmas' }))
  await screen.findByRole('option', { name: turma.nome })
  expect(screen.queryByRole('alert')).toBeNull()
})

test('envio em andamento bloqueia campos, atualização e POST duplicado', async () => {
  const form = await preencher()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.submit(form)
  fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText('Título').matches(':disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Atualizar turmas' }).matches(':disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Criando...' }).getAttribute('aria-busy')).toBe('true')
  await act(async () => finish(Response.json({ avaliacao }, { status: 201 })))
  await screen.findByText('Avaliação “Primeira prova” criada em rascunho.')
})

test.each([400, 401, 403, 404, 409, 503])('erro HTTP %i preserva campos sem confirmar criação ou repetir POST', async (status) => {
  const form = await preencher()
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Criação recusada.' }, { status }))
  fireEvent.submit(form)
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Criação recusada.')
  expect(document.activeElement).toBe(alert)
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('  Primeira prova  ')
  expect(screen.queryByText(/criada em rascunho/)).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('sessão ausente não envia; resposta incerta não confirma e não repete criação', async () => {
  const form = await preencher()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  fireEvent.submit(form)
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Sem conexão'))
  fireEvent.submit(form)
  await screen.findByText(/Confira os rascunhos da turma antes de reenviar/)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('  Primeira prova  ')
})

test('serviço recusa resposta malformada, status incorreto ou avaliação diferente da enviada', async () => {
  for (const response of [
    new Response('<html>Erro</html>'), Response.json(null), Response.json({ avaliacao }, { status: 200 }),
    ...[{}, { ...avaliacao, situacao: 'PUBLICADA' }, { ...avaliacao, professor_id: turmaId },
      { ...avaliacao, titulo: 'Outra avaliação' }, { ...avaliacao, turma_id: professorId },
      { ...avaliacao, duracao_minutos: 20 }, { ...avaliacao, inicio_em: '2026-11-09T08:00:00Z' }]
      .map((item) => Response.json({ avaliacao: item }, { status: 201 })),
  ]) {
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(criarAvaliacaoRascunho(dados)).rejects.toThrow('Não foi possível confirmar a criação.')
  }
  mocks.fetch.mockClear()
  await expect(criarAvaliacaoRascunho({ ...dados, titulo: ' ' })).rejects.toThrow('Confira os campos')
  expect(mocks.fetch).not.toHaveBeenCalled()
})
