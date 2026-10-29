import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import { listarQuestoesRascunho } from '../src/services/questoes'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({ listarTurmas: mocks.listar, criarTurma: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turma = {
  id: '10000000-0000-0000-0000-000000000001', nome: 'Engenharia 8B', professor_id: '20000000-0000-0000-0000-000000000001',
  situacao: 'ATIVA', codigo_ingresso: 'ABCDEF123456', criado_em: '2026-10-20T12:00:00Z',
}
const avaliacao = {
  id: '30000000-0000-0000-0000-000000000001', turma_id: turma.id, professor_id: turma.professor_id,
  titulo: 'Prova de Engenharia', tipo: 'PROVA', inicio_em: '2026-11-09T22:00:00Z',
  fim_em: '2026-11-10T00:00:00Z', duracao_minutos: 60, situacao: 'RASCUNHO', criado_em: '2026-10-28T12:00:00Z',
}
const atividade = { ...avaliacao, id: '30000000-0000-0000-0000-000000000002', titulo: 'Atividade de revisão', tipo: 'ATIVIDADE' }
const questao = {
  id: '40000000-0000-0000-0000-000000000001', avaliacao_id: avaliacao.id, tipo: 'OBJETIVA',
  enunciado: 'Qual é a finalidade de um teste de integração?', pontuacao: 2.5, ordem: 1, criado_em: '2026-10-29T12:00:00Z',
}
const dissertativa = { ...questao, id: '40000000-0000-0000-0000-000000000002', ordem: 3, tipo: 'DISSERTATIVA',
  enunciado: 'Explique o resultado:\n<b>texto da questão</b>\n' + 'Enunciado longo. '.repeat(200), pontuacao: 0.29 }
const consulta = () => Response.json({ questoes: [questao, dissertativa], limite: 50 })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listar.mockResolvedValue([turma])
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada', user: { id: turma.professor_id } } }, error: null })
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.startsWith('/api/avaliacoes?')) return Response.json({ avaliacoes: [avaliacao, atividade], limite: 50 })
    if (url === '/api/questoes') return Response.json({ questao: { ...questao, ...JSON.parse(String(options.body)) } }, { status: 201 })
    if (url.endsWith(atividade.id)) return Response.json({ questoes: [], limite: 50 })
    return consulta()
  })
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function abrir(profile: 'Professor' | 'Administrador' = 'Professor') {
  render(<TurmasPanel profile={profile} />)
  fireEvent.click(await screen.findByRole('button', { name: `Rascunhos de ${turma.nome}` }))
  const button = await screen.findByRole('button', { name: `Questões de ${avaliacao.titulo}` })
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  mocks.fetch.mockClear()
  return button
}
const lista = () => screen.findByRole('list', { name: `Questões de ${avaliacao.titulo}` })

test.each(['Professor', 'Administrador'] as const)('%s consulta somente ao abrir, com enunciado completo, ordem e pontuação', async (profile) => {
  const button = await abrir(profile)
  fireEvent.click(button)
  const items = within(await lista()).getAllByRole('listitem')
  expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual(['Questão 1', 'Questão 3'])
  expect(items[0].textContent).toContain('Objetiva · Pontuação: 2,5')
  expect(items[1].textContent).toContain('Dissertativa · Pontuação: 0,29')
  expect(items[1].querySelector('.questao-enunciado')?.textContent).toBe(dissertativa.enunciado.trim())
  expect(items[1].querySelector('b')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Questões em rascunho' }))
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(`/api/questoes?avaliacao_id=${avaliacao.id}`, {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada' }, cache: 'no-store',
  })
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(button.getAttribute('aria-controls')!)).toBeTruthy()
  fireEvent.click(button)
  expect(screen.queryByRole('list', { name: `Questões de ${avaliacao.titulo}` })).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

test('professor consulta em turma inativa sem ações de criação ou edição', async () => {
  mocks.listar.mockResolvedValue([{ ...turma, situacao: 'INATIVA' }])
  fireEvent.click(await abrir())
  await lista()
  expect(screen.queryByRole('button', { name: /^Nova questão em / })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Editar / })).toBeNull()
})

test('lista vazia pode ser atualizada; limite de 50 é informado sem esconder registros', async () => {
  const button = await abrir()
  mocks.fetch.mockResolvedValueOnce(Response.json({ questoes: [], limite: 50 }))
  fireEvent.click(button)
  await screen.findByText('Nenhuma questão nesta avaliação.')
  const questoes = Array.from({ length: 50 }, (_, i) => ({ ...questao, ordem: i + 1,
    id: `40000000-0000-0000-0000-${String(i).padStart(12, '0')}` }))
  mocks.fetch.mockResolvedValueOnce(Response.json({ questoes, limite: 50 }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar questões' }))
  expect(within(await lista()).getAllByRole('listitem')).toHaveLength(50)
  expect(screen.getByText('Primeiras 50 questões, em ordem de cadastro.')).toBeTruthy()
})

test.each([401, 403, 404, 503])('erro %i esconde questões anteriores e permite tentar novamente', async (status) => {
  fireEvent.click(await abrir())
  await lista()
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível.' }, { status }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar questões' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Consulta indisponível.')
  expect(screen.queryByText(questao.enunciado)).toBeNull()
  expect(screen.queryByText('Nenhuma questão nesta avaliação.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar questões' }))
  await lista()
  expect(screen.queryByRole('alert')).toBeNull()
})

test.each(['avaliação', 'turma'])('fechar ou trocar de %s ignora consulta atrasada', async (destino) => {
  const button = await abrir()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.click(button)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByText('Carregando questões...')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Atualizar questões' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: destino === 'avaliação' ? `Questões de ${atividade.titulo}` : `Rascunhos de ${turma.nome}` }))
  if (destino === 'avaliação') await screen.findByText('Nenhuma questão nesta avaliação.')
  await act(async () => finish(consulta()))
  expect(screen.queryByText(questao.enunciado)).toBeNull()
  expect(screen.queryByRole('region', { name: `Questões de ${avaliacao.titulo}` })).toBeNull()
})

test('criar uma questão fecha a consulta; reabrir busca o registro novo', async () => {
  fireEvent.click(await abrir())
  await lista()
  fireEvent.click(screen.getByRole('button', { name: `Nova questão em ${avaliacao.titulo}` }))
  expect(screen.queryByText(questao.enunciado)).toBeNull()
  expect(screen.getByRole('button', { name: `Questões de ${atividade.titulo}` }).hasAttribute('disabled')).toBe(true)
  const enunciado = 'Nova questão criada para esta avaliação.'
  fireEvent.change(screen.getByLabelText('Enunciado'), { target: { value: enunciado } })
  fireEvent.submit(screen.getByRole('form', { name: 'Nova questão em rascunho' }))
  await screen.findByText(`Questão 1 criada em “${avaliacao.titulo}”.`)
  mocks.fetch.mockResolvedValueOnce(Response.json({ questoes: [{ ...questao, enunciado }], limite: 50 }))
  fireEvent.click(screen.getByRole('button', { name: `Questões de ${avaliacao.titulo}` }))
  await screen.findByText(enunciado)
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByRole('table')
  expect(screen.queryByText(enunciado)).toBeNull()
})

test('sessão ausente, rede e JSON inválido não são apresentados como lista vazia', async () => {
  const button = await abrir()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  fireEvent.click(button)
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Sem conexão'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar questões' }))
  await screen.findByText(/Confira sua conexão/)
  mocks.fetch.mockResolvedValueOnce(new Response('<html>Erro</html>'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar questões' }))
  await screen.findByText('Não foi possível conferir a lista de questões.')
  expect(screen.queryByText('Nenhuma questão nesta avaliação.')).toBeNull()
})

test('serviço recusa contrato inválido, questão alheia, duplicada ou fora de ordem', async () => {
  for (const result of [null, [], {}, { questoes: [] }, { questoes: [], limite: 100 },
    ...[[{}], [{ ...questao, avaliacao_id: atividade.id }], [questao, questao], [dissertativa, questao],
      [questao, { ...dissertativa, ordem: 1 }], [{ ...questao, pontuacao: '2.5' }], [{ ...questao, criado_em: 'inválido' }],
      Array.from({ length: 51 }, (_, i) => ({ ...questao, ordem: i + 1, id: `40000000-0000-0000-0000-${String(i).padStart(12, '0')}` }))]
      .map((questoes) => ({ questoes, limite: 50 }))]) {
    mocks.fetch.mockResolvedValueOnce(Response.json(result))
    await expect(listarQuestoesRascunho(avaliacao.id)).rejects.toThrow('Não foi possível conferir a lista de questões.')
  }
  mocks.fetch.mockResolvedValueOnce(Response.json({ questoes: [], limite: 50 }, { status: 201 }))
  await expect(listarQuestoesRascunho(avaliacao.id)).rejects.toThrow('Não foi possível conferir a lista de questões.')
  mocks.fetch.mockClear()
  mocks.getSession.mockClear()
  await expect(listarQuestoesRascunho('inválido')).rejects.toThrow('ID da avaliação inválido.')
  expect(mocks.getSession).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})
