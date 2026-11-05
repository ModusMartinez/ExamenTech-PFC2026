import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import { cadastrarAlternativasRascunho, listarAlternativasRascunho } from '../src/services/alternativas'
import type { AlternativaRascunho } from '../src/services/alternativaValidation'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({ listarTurmas: mocks.listar, criarTurma: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turma = { id: '10000000-0000-0000-0000-000000000001', nome: 'Engenharia 8B',
  professor_id: '20000000-0000-0000-0000-000000000001', situacao: 'ATIVA', codigo_ingresso: 'ABCDEF123456', criado_em: '2026-10-20T12:00:00Z' }
const avaliacao = { id: '30000000-0000-0000-0000-000000000001', turma_id: turma.id, professor_id: turma.professor_id,
  titulo: 'Prova de Engenharia', tipo: 'PROVA', inicio_em: '2026-11-09T22:00:00Z', fim_em: '2026-11-10T00:00:00Z',
  duracao_minutos: 60, situacao: 'RASCUNHO', criado_em: '2026-10-28T12:00:00Z' }
const questao = { id: '40000000-0000-0000-0000-000000000001', avaliacao_id: avaliacao.id, tipo: 'OBJETIVA',
  enunciado: 'Qual é a finalidade de um teste de integração?', pontuacao: 2.5, ordem: 1, criado_em: '2026-10-29T12:00:00Z' }
const segunda = { ...questao, id: '40000000-0000-0000-0000-000000000002', ordem: 2 }
const dados = { questao_id: questao.id, alternativas: ['Testar uma função isolada', 'Testar a comunicação entre componentes'], ordem_correta: 2 }
const salvas: AlternativaRascunho[] = dados.alternativas.map((texto, index) => ({
  id: `50000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`, questao_id: questao.id,
  texto, ordem: index + 1, correta: index === 1, criado_em: '2026-11-04T12:00:00.000Z',
}))
let gravadas: Record<string, AlternativaRascunho[]>

beforeEach(() => {
  vi.resetAllMocks()
  gravadas = {}
  mocks.listar.mockResolvedValue([turma])
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada', user: { id: turma.professor_id } } }, error: null })
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.startsWith('/api/avaliacoes?')) return Response.json({ avaliacoes: [avaliacao], limite: 50 })
    if (url.startsWith('/api/questoes?')) return Response.json({ questoes: [questao, segunda,
      { ...questao, id: '40000000-0000-0000-0000-000000000003', tipo: 'DISSERTATIVA', ordem: 3 }], limite: 50 })
    if (url.startsWith('/api/alternativas?')) {
      const id = new URL(url, 'http://localhost').searchParams.get('questao_id')!
      return Response.json({ alternativas: gravadas[id] ?? [] })
    }
    if (url === '/api/alternativas' && options.method === 'POST') {
      const body = JSON.parse(String(options.body))
      gravadas[body.questao_id] = body.alternativas.map((texto: string, i: number) => ({ ...salvas[0],
        id: `50000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`, questao_id: body.questao_id, texto, ordem: i + 1, correta: i + 1 === body.ordem_correta }))
      return Response.json({ alternativas: gravadas[body.questao_id] }, { status: 201 })
    }
    throw new Error('Rota inesperada')
  })
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function abrir(profile: 'Professor' | 'Administrador' = 'Professor') {
  render(<TurmasPanel profile={profile} />)
  fireEvent.click(await screen.findByRole('button', { name: `Rascunhos de ${turma.nome}` }))
  fireEvent.click(await screen.findByRole('button', { name: `Questões de ${avaliacao.titulo}` }))
  const button = await screen.findByRole('button', { name: 'Alternativas da questão 1' })
  expect(screen.queryByRole('button', { name: 'Alternativas da questão 3' })).toBeNull()
  expect(mocks.fetch.mock.calls.some(([url]) => url.startsWith('/api/alternativas'))).toBe(false)
  mocks.fetch.mockClear()
  fireEvent.click(button)
  return button
}
async function abrirForm() {
  await abrir()
  const form = await screen.findByRole('form', { name: 'Cadastrar alternativas' })
  mocks.fetch.mockClear()
  return form
}
function preencher() {
  fireEvent.change(screen.getByLabelText('Alternativa 1'), { target: { value: `  ${dados.alternativas[0]}  ` } })
  fireEvent.change(screen.getByLabelText('Alternativa 2'), { target: { value: dados.alternativas[1] } })
  fireEvent.change(screen.getByLabelText('Alternativa correta'), { target: { value: '2' } })
}

test('professor cadastra e consulta o conjunto com gabarito, sem substituir alternativas existentes', async () => {
  const form = await abrirForm()
  expect(document.activeElement).toBe(screen.getByLabelText('Alternativa 1'))
  preencher()
  fireEvent.submit(form)
  const success = await screen.findByText('Alternativas da questão 1 cadastradas.')
  expect(document.activeElement).toBe(success)
  expect(screen.queryByRole('form', { name: 'Cadastrar alternativas' })).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/alternativas', {
    method: 'POST', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    cache: 'no-store', body: JSON.stringify(dados),
  })
  const items = within(screen.getByRole('list', { name: 'Alternativas da questão 1' })).getAllByRole('listitem')
  expect(items.map((item) => item.textContent)).toEqual([dados.alternativas[0], `${dados.alternativas[1]}Correta`])
  fireEvent.click(screen.getByRole('button', { name: 'Alternativas da questão 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Alternativas da questão 1' }))
  await screen.findByRole('list', { name: 'Alternativas da questão 1' })
  expect(screen.queryByRole('form', { name: 'Cadastrar alternativas' })).toBeNull()
})

test('adiciona até cinco, remove apenas a última e exige novo gabarito quando a correta é removida', async () => {
  const form = await abrirForm()
  expect(screen.getByRole('button', { name: 'Remover última' }).hasAttribute('disabled')).toBe(true)
  preencher()
  for (let i = 3; i <= 5; i++) {
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar alternativa' }))
    expect(document.activeElement).toBe(screen.getByLabelText(`Alternativa ${i}`))
    fireEvent.change(screen.getByLabelText(`Alternativa ${i}`), { target: { value: `Texto ${i}` } })
  }
  expect(screen.getByRole('button', { name: 'Adicionar alternativa' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('Alternativa correta'), { target: { value: '5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remover última' }))
  expect(document.activeElement).toBe(screen.getByLabelText('Alternativa 4'))
  expect((screen.getByLabelText('Alternativa correta') as HTMLSelectElement).value).toBe('0')
  expect(screen.queryByLabelText('Alternativa 5')).toBeNull()
  fireEvent.submit(form)
  expect(screen.getByRole('alert').textContent).toBe('Selecione a alternativa correta.')
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar alternativa' }))
  fireEvent.change(screen.getByLabelText('Alternativa 5'), { target: { value: '📝'.repeat(2000) } })
  fireEvent.change(screen.getByLabelText('Alternativa correta'), { target: { value: '5' } })
  fireEvent.submit(form)
  await screen.findByText('Alternativas da questão 1 cadastradas.')
  expect(gravadas[questao.id]).toHaveLength(5)
  expect(gravadas[questao.id][4].correta).toBe(true)
  expect([...gravadas[questao.id][4].texto]).toHaveLength(2000)
})

test.each(['', ' \n\t ', '📝'.repeat(2001), 'Texto\u0000inválido', dados.alternativas[1]])('texto inválido ou duplicado impede gravação e recebe foco (%#)', async (value) => {
  const form = await abrirForm()
  preencher()
  const input = screen.getByLabelText('Alternativa 1')
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(form)
  const invalid = value === dados.alternativas[1] ? screen.getByLabelText('Alternativa 2') : input
  expect(document.activeElement).toBe(invalid)
  expect(invalid.getAttribute('aria-invalid')).toBe('true')
  expect(invalid.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('cancelar descarta campos, não grava e devolve foco ao botão da questão', async () => {
  await abrirForm()
  preencher()
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Alternativas da questão 1' }))
  expect(mocks.fetch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Alternativas da questão 1' }))
  await screen.findByRole('form', { name: 'Cadastrar alternativas' })
  expect((screen.getByLabelText('Alternativa 1') as HTMLTextAreaElement).value).toBe('')
})

test.each(['Administrador', 'Professor'] as const)('%s consulta turma inativa; somente professor de turma ativa recebe formulário vazio', async (profile) => {
  if (profile === 'Professor') mocks.listar.mockResolvedValue([{ ...turma, situacao: 'INATIVA' }])
  await abrir(profile)
  await screen.findByText('Nenhuma alternativa nesta questão.')
  expect(screen.queryByRole('form', { name: 'Cadastrar alternativas' })).toBeNull()
  const texto = 'Texto longo\n<b>sem HTML</b> ' + '📝'.repeat(1900)
  gravadas[questao.id] = [{ ...salvas[0], texto }, salvas[1]]
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar alternativas' }))
  const items = within(await screen.findByRole('list', { name: 'Alternativas da questão 1' })).getAllByRole('listitem')
  expect(items[0].querySelector('.questao-enunciado')?.textContent).toBe(texto)
  expect(items[0].querySelector('b')).toBeNull()
  expect(items[1].textContent).toContain('Correta')
  expect(mocks.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
})

test('envio simultâneo bloqueado e resposta após trocar de questão ignorada', async () => {
  const form = await abrirForm()
  preencher()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.submit(form); fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText('Alternativa 1').matches(':disabled')).toBe(true)
  for (const name of ['Cancelar', 'Adicionar alternativa', 'Remover última', 'Atualizar alternativas']) {
    expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true)
  }
  expect(screen.getByRole('button', { name: 'Salvando...' }).getAttribute('aria-busy')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Alternativas da questão 2' }))
  await screen.findByRole('form', { name: 'Cadastrar alternativas' })
  await act(async () => finish(Response.json({ alternativas: salvas }, { status: 201 })))
  expect(screen.queryByText('Alternativas da questão 1 cadastradas.')).toBeNull()
  expect((screen.getByLabelText('Alternativa 1') as HTMLTextAreaElement).value).toBe('')
})

test.each([401, 403, 409, 503])('erro %i mantém textos e gabarito e não confirma cadastro', async (status) => {
  const form = await abrirForm()
  preencher()
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Cadastro recusado.' }, { status }))
  fireEvent.submit(form)
  const alert = await screen.findByRole('alert')
  expect(document.activeElement).toBe(alert)
  expect(alert.textContent).toBe('Cadastro recusado.')
  expect((screen.getByLabelText('Alternativa 1') as HTMLTextAreaElement).value).toContain(dados.alternativas[0])
  expect((screen.getByLabelText('Alternativa correta') as HTMLSelectElement).value).toBe('2')
  expect(screen.getByRole('button', { name: 'Salvar alternativas' }).matches(':disabled')).toBe(false)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('erro de consulta não abre cadastro; atualizar recupera e fechar ignora resposta atrasada', async () => {
  gravadas[questao.id] = salvas
  const button = await abrir()
  await screen.findByRole('list', { name: 'Alternativas da questão 1' })
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível.' }, { status: 503 }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar alternativas' }))
  await screen.findByText('Consulta indisponível.')
  expect(screen.queryByRole('form', { name: 'Cadastrar alternativas' })).toBeNull()
  expect(screen.queryByText(dados.alternativas[0])).toBeNull()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar alternativas' }))
  await waitFor(() => expect(screen.getByText('Carregando alternativas...')).toBeTruthy())
  fireEvent.click(button)
  await act(async () => finish(Response.json({ alternativas: salvas })))
  expect(screen.queryByText(dados.alternativas[0])).toBeNull()
  fireEvent.click(button)
  await screen.findByRole('list', { name: 'Alternativas da questão 1' })
})

test('sessão ausente e falha de rede preservam o formulário sem repetir cadastro', async () => {
  const form = await abrirForm()
  preencher()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  fireEvent.submit(form)
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Sem conexão'))
  fireEvent.submit(form)
  await screen.findByText(/Feche e reabra as alternativas/)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect((screen.getByLabelText('Alternativa correta') as HTMLSelectElement).value).toBe('2')
})

test('serviço valida entrada e não aceita lista inválida ou confirmação diferente do cadastro', async () => {
  for (const alternativas of [null, [salvas[0]], [salvas[0], salvas[0]],
    [{ ...salvas[0], questao_id: segunda.id }, salvas[1]], salvas.map((item) => ({ ...item, correta: false }))]) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ alternativas }))
    await expect(listarAlternativasRascunho(questao.id)).rejects.toThrow('Não foi possível consultar')
  }
  for (const response of [new Response('<html>Erro</html>'), Response.json(null), Response.json({ alternativas: salvas }),
    ...[[], [{ ...salvas[0], texto: 'Outro texto' }, salvas[1]], salvas.map((item) => ({ ...item, correta: !item.correta }))]
      .map((alternativas) => Response.json({ alternativas }, { status: 201 }))]) {
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(cadastrarAlternativasRascunho(dados)).rejects.toThrow('Não foi possível confirmar')
  }
  mocks.getSession.mockClear(); mocks.fetch.mockClear()
  await expect(listarAlternativasRascunho('inválido')).rejects.toThrow('ID da questão inválido.')
  await expect(cadastrarAlternativasRascunho({ ...dados, ordem_correta: 0 })).rejects.toThrow('Confira as alternativas')
  expect(mocks.getSession).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})
