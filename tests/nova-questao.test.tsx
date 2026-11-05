import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import { criarQuestaoRascunho } from '../src/services/questoes'
import type { DadosQuestaoRascunho } from '../src/services/questaoValidation'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({ listarTurmas: mocks.listar, criarTurma: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turma = {
  id: '10000000-0000-0000-0000-000000000001', nome: 'Turma de teste', professor_id: '20000000-0000-0000-0000-000000000001',
  situacao: 'ATIVA', codigo_ingresso: 'ABCDEF123456', criado_em: '2026-10-20T12:00:00Z',
}
const inativa = { ...turma, id: '10000000-0000-0000-0000-000000000002', nome: 'Turma inativa', situacao: 'INATIVA' }
const avaliacao = {
  id: '30000000-0000-0000-0000-000000000001', turma_id: turma.id, professor_id: turma.professor_id,
  titulo: 'Prova de Engenharia', tipo: 'PROVA', inicio_em: '2026-11-09T22:00:00Z',
  fim_em: '2026-11-10T00:00:00Z', duracao_minutos: 60, situacao: 'RASCUNHO', criado_em: '2026-10-28T12:00:00Z',
}
const atividade = { ...avaliacao, id: '30000000-0000-0000-0000-000000000002', titulo: 'Atividade de revisão', tipo: 'ATIVIDADE' }
const dados: DadosQuestaoRascunho = { avaliacao_id: avaliacao.id, tipo: 'OBJETIVA', enunciado: 'Qual é a finalidade de um teste de integração?', pontuacao: 2.5 }
const questao = { ...dados, id: '40000000-0000-0000-0000-000000000001', ordem: 3, criado_em: '2026-10-29T12:00:00Z' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listar.mockResolvedValue([turma, inativa])
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada', user: { id: turma.professor_id } } }, error: null })
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.startsWith('/api/avaliacoes?')) return Response.json({
      avaliacoes: [avaliacao, atividade].map((item) => ({ ...item, turma_id: url.endsWith(inativa.id) ? inativa.id : turma.id })), limite: 50,
    })
    if (url === '/api/questoes') return Response.json({ questao: { ...questao, ...JSON.parse(String(options.body)) } }, { status: 201 })
    throw new Error('Rota inesperada')
  })
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function abrirRascunhos(profile: 'Professor' | 'Administrador' = 'Professor', nome = turma.nome) {
  render(<TurmasPanel profile={profile} />)
  fireEvent.click(await screen.findByRole('button', { name: `Rascunhos de ${nome}` }))
  await screen.findByRole('table')
}
async function abrirQuestao(titulo = avaliacao.titulo) {
  await abrirRascunhos()
  fireEvent.click(screen.getByRole('button', { name: `Nova questão em ${titulo}` }))
  mocks.fetch.mockClear()
  return screen.getByRole('form', { name: 'Nova questão em rascunho' })
}
function preencher(enunciado = dados.enunciado, pontos = '2,5') {
  fireEvent.change(screen.getByLabelText('Enunciado'), { target: { value: enunciado } })
  fireEvent.change(screen.getByLabelText('Pontuação'), { target: { value: pontos } })
}

test.each([
  ['OBJETIVA', avaliacao, '2,5', 2.5], ['DISSERTATIVA', atividade, '0.29', 0.29],
] as const)('cadastra %s na avaliação escolhida e foca a confirmação', async (tipo, item, pontos, pontuacao) => {
  const form = await abrirQuestao(item.titulo)
  expect(document.activeElement).toBe(screen.getByLabelText('Tipo'))
  expect(within(form).getByText(item.titulo)).toBeTruthy()
  expect(within(form).queryByLabelText('Avaliação')).toBeNull()
  expect(within(form).queryByLabelText(/Alternativa|Gabarito/)).toBeNull()
  preencher(`  ${dados.enunciado}  `, pontos)
  fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: tipo } })
  fireEvent.submit(form)
  const success = await screen.findByText(`Questão 3 criada em “${item.titulo}”.`)
  expect(document.activeElement).toBe(success)
  expect(screen.queryByRole('form', { name: 'Nova questão em rascunho' })).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/questoes', {
    method: 'POST', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    body: JSON.stringify({ avaliacao_id: item.id, tipo, enunciado: dados.enunciado, pontuacao }),
  })
})

test.each(['Administrador', 'Professor'] as const)('%s não cadastra em turma inativa; admin não recebe a ação em turma ativa', async (profile) => {
  await abrirRascunhos(profile, profile === 'Administrador' ? turma.nome : inativa.nome)
  expect(screen.queryByRole('button', { name: /^Nova questão em / })).toBeNull()
  expect(screen.queryByRole('form', { name: 'Nova questão em rascunho' })).toBeNull()
})

test('cancelar descarta os campos, não envia e devolve foco ao botão da avaliação', async () => {
  await abrirQuestao()
  preencher()
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  const button = screen.getByRole('button', { name: `Nova questão em ${avaliacao.titulo}` })
  expect(document.activeElement).toBe(button)
  expect(mocks.fetch).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect((screen.getByLabelText('Enunciado') as HTMLTextAreaElement).value).toBe('')
  expect((screen.getByLabelText('Pontuação') as HTMLInputElement).value).toBe('1')
})

test.each([
  ['Tipo', ''], ['Enunciado', ''], ['Enunciado', 'AB'], ['Enunciado', '📝'.repeat(10001)],
  ['Pontuação', ''], ['Pontuação', '0'], ['Pontuação', '-1'], ['Pontuação', '10000'],
  ['Pontuação', '2,555'], ['Pontuação', '1e2'], ['Pontuação', '0x10'], ['Pontuação', '1.000,50'],
])('validação de %s foca o campo e impede o envio', async (label, value) => {
  const form = await abrirQuestao()
  preencher()
  const input = screen.getByLabelText(label)
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(form)
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('aceita 10 mil caracteres Unicode e pontuação máxima sem cortar ou arredondar', async () => {
  const form = await abrirQuestao()
  preencher('📝'.repeat(10000), '9999,99')
  fireEvent.submit(form)
  await screen.findByText(`Questão 3 criada em “${avaliacao.titulo}”.`)
  const payload = JSON.parse(mocks.fetch.mock.calls[0][1].body)
  expect([...payload.enunciado]).toHaveLength(10000)
  expect(payload.pontuacao).toBe(9999.99)
})

test('um formulário por vez e envio duplo bloqueado durante a criação', async () => {
  const form = await abrirQuestao()
  preencher()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.submit(form)
  fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  for (const label of ['Tipo', 'Enunciado', 'Pontuação']) expect(screen.getByLabelText(label).matches(':disabled')).toBe(true)
  for (const name of ['Cancelar', 'Atualizar rascunhos', `Editar ${avaliacao.titulo}`, `Nova questão em ${atividade.titulo}`]) {
    expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true)
  }
  expect(screen.getByRole('button', { name: 'Criando...' }).getAttribute('aria-busy')).toBe('true')
  await act(async () => finish(Response.json({ questao }, { status: 201 })))
  await screen.findByText(`Questão 3 criada em “${avaliacao.titulo}”.`)
  fireEvent.click(screen.getByRole('button', { name: `Editar ${avaliacao.titulo}` }))
  expect(screen.getByRole('button', { name: `Nova questão em ${atividade.titulo}` }).matches(':disabled')).toBe(true)
})

test.each([400, 401, 403, 404, 409, 503])('erro %i preserva campos e foca a mensagem sem confirmar criação', async (status) => {
  const form = await abrirQuestao()
  preencher()
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Criação recusada.' }, { status }))
  fireEvent.submit(form)
  const alert = await screen.findByRole('alert')
  expect(document.activeElement).toBe(alert)
  expect(alert.textContent).toBe('Criação recusada.')
  expect((screen.getByLabelText('Enunciado') as HTMLTextAreaElement).value).toBe(dados.enunciado)
  expect((screen.getByLabelText('Pontuação') as HTMLInputElement).value).toBe('2,5')
  expect(screen.getByRole('button', { name: 'Criar questão' }).matches(':disabled')).toBe(false)
  expect(screen.queryByText(/Questão 3 criada/)).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('sessão ausente e falha de rede preservam o formulário sem repetir o POST', async () => {
  const form = await abrirQuestao()
  preencher()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  fireEvent.submit(form)
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Sem conexão'))
  fireEvent.submit(form)
  await screen.findByText(/Verifique se a questão foi salva antes de reenviar/)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect((screen.getByLabelText('Enunciado') as HTMLTextAreaElement).value).toBe(dados.enunciado)
})

test('trocar de turma ignora a resposta de criação atrasada', async () => {
  const form = await abrirQuestao()
  preencher()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${inativa.nome}` }))
  await screen.findByRole('table', { name: `Avaliações em rascunho de ${inativa.nome}` })
  await act(async () => finish(Response.json({ questao }, { status: 201 })))
  expect(screen.queryByText(/Questão 3 criada/)).toBeNull()
  expect(screen.queryByRole('form', { name: 'Nova questão em rascunho' })).toBeNull()
})

test('serviço recusa resposta incompleta, divergente ou sem 201 e valida antes da rede', async () => {
  for (const response of [new Response('<html>Erro</html>'), Response.json(null), Response.json({ questao }),
    ...[{}, { ...questao, avaliacao_id: atividade.id }, { ...questao, tipo: 'DISSERTATIVA' },
      { ...questao, enunciado: 'Outro enunciado' }, { ...questao, pontuacao: 1 }, { ...questao, ordem: 0 },
      { ...questao, id: 'inválido' }, { ...questao, criado_em: 'inválido' }]
      .map((item) => Response.json({ questao: item }, { status: 201 }))]) {
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(criarQuestaoRascunho(dados)).rejects.toThrow('Não foi possível confirmar a criação.')
  }
  mocks.fetch.mockClear()
  mocks.getSession.mockClear()
  await expect(criarQuestaoRascunho({ ...dados, avaliacao_id: 'inválido' })).rejects.toThrow('Confira os campos')
  expect(mocks.getSession).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})
