import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import { editarAvaliacaoRascunho, listarAvaliacoesRascunho } from '../src/services/avaliacoes'
import type { Turma } from '../src/services/turmas'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({ listarTurmas: mocks.listar, criarTurma: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turma: Turma = {
  id: '10000000-0000-0000-0000-000000000001', nome: 'Engenharia 8B',
  professor_id: '20000000-0000-0000-0000-000000000001', codigo_ingresso: 'ABCDEF123456',
  situacao: 'ATIVA', criado_em: '2026-10-20T12:00:00Z',
}
const outra: Turma = { ...turma, id: '10000000-0000-0000-0000-000000000002', nome: 'Turma anterior', situacao: 'INATIVA' }
const avaliacao = {
  id: '30000000-0000-0000-0000-000000000001', turma_id: turma.id, professor_id: turma.professor_id,
  titulo: 'Prova de Engenharia', tipo: 'PROVA', inicio_em: '2026-11-09T22:00:00Z',
  fim_em: '2026-11-10T00:00:00Z', duracao_minutos: 60, situacao: 'RASCUNHO', criado_em: '2026-10-28T12:00:00Z',
}
const atividade = { ...avaliacao, id: '30000000-0000-0000-0000-000000000002', titulo: 'Atividade de revisão', tipo: 'ATIVIDADE' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listar.mockResolvedValue([turma, outra])
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada', user: { id: turma.professor_id } } }, error: null })
  mocks.fetch.mockImplementation(async () => Response.json({ avaliacoes: [], limite: 50 }))
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function abrir(profile: 'Professor' | 'Administrador' = 'Professor', nome = turma.nome) {
  render(<TurmasPanel profile={profile} />)
  const button = await screen.findByRole('button', { name: `Rascunhos de ${nome}` })
  expect(mocks.fetch).not.toHaveBeenCalled()
  fireEvent.click(button)
  return button
}

test.each(['Professor', 'Administrador'] as const)('%s abre e fecha rascunhos com campos, ordem e ações do perfil', async (profile) => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [atividade, avaliacao], limite: 50 }))
  const button = await abrir(profile)
  const table = await screen.findByRole('table', { name: `Avaliações em rascunho de ${turma.nome}` })
  expect(within(table).getAllByRole('columnheader').map((item) => item.textContent)).toEqual([
    'Título', 'Tipo', 'Início', 'Fim', 'Duração', 'Situação', ...(profile === 'Professor' ? ['Ações'] : []),
  ])
  expect(within(table).getAllByRole('rowheader').map((item) => item.textContent)).toEqual([atividade.titulo, avaliacao.titulo])
  expect(within(table).getByRole('cell', { name: 'Prova' })).toBeTruthy()
  expect(within(table).getByRole('cell', { name: 'Atividade' })).toBeTruthy()
  expect(within(table).getAllByRole('cell', { name: '60 min' })).toHaveLength(2)
  expect(within(table).getAllByRole('cell', { name: 'Rascunho' })).toHaveLength(2)
  const dates = table.querySelectorAll('time')
  expect(dates[0].dateTime).toBe('2026-11-09T22:00:00.000Z')
  expect(dates[0].textContent).toBe(new Date(avaliacao.inicio_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))
  expect(dates[1].textContent).toBe(new Date(avaliacao.fim_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(`/api/avaliacoes?turma_id=${turma.id}`, {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada' }, cache: 'no-store',
  })
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(screen.queryByRole('button', { name: /Publicar|Excluir/ })).toBeNull()
  expect(screen.queryAllByRole('button', { name: /^Editar / })).toHaveLength(profile === 'Professor' ? 2 : 0)
  fireEvent.click(button)
  expect(screen.queryByRole('table')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

test('turma inativa permite consultar rascunhos e atualizar uma lista vazia', async () => {
  await abrir('Administrador', outra.nome)
  await screen.findByText('Nenhum rascunho nesta turma.')
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [{ ...avaliacao, turma_id: outra.id }], limite: 50 }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByRole('rowheader', { name: avaliacao.titulo })
  expect(screen.queryByText('Nenhum rascunho nesta turma.')).toBeNull()
  expect(mocks.fetch.mock.calls.every(([url, options]) => url.endsWith(outra.id) && options.method === 'GET')).toBe(true)
})

test('trocar de turma ignora resposta atrasada e bloqueia atualização durante a consulta', async () => {
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  await abrir()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByText('Carregando rascunhos...')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Atualizar rascunhos' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${outra.nome}` }))
  await screen.findByText('Nenhum rascunho nesta turma.')
  await act(async () => finish(Response.json({ avaliacoes: [avaliacao], limite: 50 })))
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('region', { name: `Rascunhos de ${turma.nome}` })).toBeNull()
  expect(screen.getByRole('region', { name: `Rascunhos de ${outra.nome}` })).toBeTruthy()
})

test.each([401, 403, 404, 503])('erro %i oculta resultado anterior e permite nova consulta', async (status) => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [avaliacao], limite: 50 }))
  await abrir()
  await screen.findByRole('table')
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível.' }, { status }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Consulta indisponível.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('Nenhum rascunho nesta turma.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByText('Nenhum rascunho nesta turma.')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('sessão ausente e falhas de rede/JSON não viram lista vazia', async () => {
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  await abrir()
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Falha de rede'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByText(/Confira sua conexão/)
  mocks.fetch.mockResolvedValueOnce(new Response('<html>Erro</html>'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar rascunhos' }))
  await screen.findByText('Não foi possível conferir a lista de rascunhos.')
  expect(screen.queryByText('Nenhum rascunho nesta turma.')).toBeNull()
})

test.each([
  null, [], {}, { avaliacoes: null, limite: 50 }, { avaliacoes: [], limite: 100 }, { avaliacoes: [] },
  ...[{}, { ...avaliacao, turma_id: outra.id }, { ...avaliacao, situacao: 'PUBLICADA' },
    { ...avaliacao, inicio_em: 'inválido' }, { ...avaliacao, duracao_minutos: '60' }]
    .map((item) => ({ avaliacoes: [item], limite: 50 })),
  { avaliacoes: [avaliacao, avaliacao], limite: 50 },
  { avaliacoes: Array.from({ length: 51 }, (_, i) => ({ ...avaliacao, id: `30000000-0000-0000-0000-${String(i).padStart(12, '0')}` })), limite: 50 },
])('recusa resposta fora do contrato (%j)', async (result) => {
  mocks.fetch.mockResolvedValueOnce(Response.json(result))
  await expect(listarAvaliacoesRascunho(turma.id)).rejects.toThrow('Não foi possível conferir a lista de rascunhos.')
})

test('lista 50 registros sem truncamento silencioso e informa o limite', async () => {
  const avaliacoes = Array.from({ length: 50 }, (_, i) => ({
    ...avaliacao, id: `30000000-0000-0000-0000-${String(i).padStart(12, '0')}`, titulo: `Rascunho ${i}`,
  }))
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes, limite: 50 }))
  await abrir()
  expect(within(await screen.findByRole('table')).getAllByRole('row')).toHaveLength(51)
  expect(screen.getByText(/Até 50 rascunhos mais recentes/)).toBeTruthy()
})

test('ID inválido não consulta sessão nem rede; erro de sessão não envia requisição', async () => {
  await expect(listarAvaliacoesRascunho('inválido')).rejects.toThrow('ID da turma inválido.')
  expect(mocks.getSession).not.toHaveBeenCalled()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: new Error('Falha de sessão') })
  await expect(listarAvaliacoesRascunho(turma.id)).rejects.toThrow('Sua sessão terminou.')
  expect(mocks.fetch).not.toHaveBeenCalled()
})

async function abrirEdicao(item = avaliacao) {
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [item, atividade], limite: 50 }))
  await abrir()
  const button = await screen.findByRole('button', { name: `Editar ${item.titulo}` })
  fireEvent.click(button)
  mocks.fetch.mockClear()
  return screen.getByRole('form', { name: 'Editar avaliação em rascunho' })
}

test.each(['PROVA', 'ATIVIDADE'])('edita %s com campos preenchidos, fuso local e atualização da linha', async (tipo) => {
  const form = await abrirEdicao()
  expect(document.activeElement).toBe(screen.getByLabelText('Título'))
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe(avaliacao.titulo)
  expect(new Date((screen.getByLabelText('Início') as HTMLInputElement).value).toISOString()).toBe('2026-11-09T22:00:00.000Z')
  expect((screen.getByLabelText('Duração (minutos)') as HTMLInputElement).value).toBe('60')
  expect(within(form).queryByLabelText('Turma')).toBeNull()
  for (const [label, value] of [['Título', '  Revisão 2  '], ['Tipo', tipo], ['Início', '2026-11-12T19:00'],
    ['Fim', '2026-11-12T21:00'], ['Duração (minutos)', '45']]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
  const campos = { titulo: 'Revisão 2', tipo, inicio_em: new Date('2026-11-12T19:00').toISOString(),
    fim_em: new Date('2026-11-12T21:00').toISOString(), duracao_minutos: 45 }
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacao: { ...avaliacao, ...campos } }))
  fireEvent.submit(form)
  const success = await screen.findByText('Avaliação “Revisão 2” salva.')
  expect(document.activeElement).toBe(success)
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/avaliacoes', {
    method: 'PATCH', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    body: JSON.stringify({ avaliacao_id: avaliacao.id, ...campos }),
  })
  expect(screen.queryByRole('form', { name: 'Editar avaliação em rascunho' })).toBeNull()
  expect(screen.getAllByRole('rowheader').map((item) => item.textContent)).toEqual(['Revisão 2', atividade.titulo])
  expect(screen.getByRole('cell', { name: '45 min' })).toBeTruthy()
})

test('cancelar descarta alterações, não grava e devolve foco ao botão Editar', async () => {
  await abrirEdicao()
  fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Não salvar' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  const button = screen.getByRole('button', { name: `Editar ${avaliacao.titulo}` })
  expect(document.activeElement).toBe(button)
  expect(mocks.fetch).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe(avaliacao.titulo)
})

test('professor não recebe botão Editar em turma inativa', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [{ ...avaliacao, turma_id: outra.id }], limite: 50 }))
  await abrir('Professor', outra.nome)
  await screen.findByRole('table')
  expect(screen.queryByRole('button', { name: /^Editar / })).toBeNull()
})

test.each([
  ['Título', 'AB'], ['Título', '📝'.repeat(151)], ['Tipo', ''], ['Início', ''],
  ['Fim', '2026-11-08T19:00'], ['Duração (minutos)', '0'], ['Duração (minutos)', '1.5'],
])('edição recusa %s inválido (%s) e foca o campo', async (label, value) => {
  const form = await abrirEdicao()
  const input = screen.getByLabelText(label)
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(form)
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('edição bloqueia envio duplo, atualização e cancelamento enquanto salva', async () => {
  const form = await abrirEdicao()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.submit(form)
  fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  for (const label of ['Título', 'Tipo', 'Início', 'Fim', 'Duração (minutos)']) {
    expect(screen.getByLabelText(label).matches(':disabled')).toBe(true)
  }
  for (const name of ['Cancelar', 'Atualizar rascunhos', `Editar ${atividade.titulo}`]) {
    expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true)
  }
  await act(async () => finish(Response.json({ avaliacao })))
  await screen.findByText(`Avaliação “${avaliacao.titulo}” salva.`)
})

test.each([400, 401, 403, 404, 409, 503])('erro %i mantém a edição e não altera a tabela', async (status) => {
  const form = await abrirEdicao()
  fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Alteração pendente' } })
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Edição recusada.' }, { status }))
  fireEvent.submit(form)
  const alert = await screen.findByRole('alert')
  expect(document.activeElement).toBe(alert)
  expect(alert.textContent).toBe('Edição recusada.')
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Alteração pendente')
  expect(screen.getByRole('rowheader', { name: avaliacao.titulo })).toBeTruthy()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(/salva\./)).toBeNull()
})

test('edição preserva segundos quando o horário não foi modificado', async () => {
  const item = { ...avaliacao, inicio_em: '2026-11-09T22:00:15.123Z', fim_em: '2026-11-10T00:00:20.456Z' }
  const form = await abrirEdicao(item)
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacao: item }))
  fireEvent.submit(form)
  await screen.findByText(`Avaliação “${avaliacao.titulo}” salva.`)
  const body = JSON.parse(mocks.fetch.mock.calls[0][1].body)
  expect(body.inicio_em).toBe(item.inicio_em)
  expect(body.fim_em).toBe(item.fim_em)
})

test('fechar a turma ignora resposta de edição atrasada', async () => {
  const form = await abrirEdicao()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${outra.nome}` }))
  await screen.findByText('Nenhum rascunho nesta turma.')
  await act(async () => finish(Response.json({ avaliacao })))
  expect(screen.queryByText(/salva\./)).toBeNull()
  expect(screen.queryByRole('form', { name: 'Editar avaliação em rascunho' })).toBeNull()
})

test('sessão ausente e falha de rede não confirmam edição nem repetem PATCH', async () => {
  const form = await abrirEdicao()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  fireEvent.submit(form)
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Sem conexão'))
  fireEvent.submit(form)
  await screen.findByText(/Não foi possível confirmar a edição/)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('rowheader', { name: avaliacao.titulo })).toBeTruthy()
})

test('resposta inválida ou de outra avaliação nunca confirma a edição', async () => {
  const dados = { avaliacao_id: avaliacao.id, titulo: avaliacao.titulo, tipo: 'PROVA' as const,
    inicio_em: avaliacao.inicio_em, fim_em: avaliacao.fim_em, duracao_minutos: 60 }
  for (const response of [new Response('<html>Erro</html>'), Response.json(null), Response.json({ avaliacao }, { status: 201 }),
    ...[{}, { ...avaliacao, id: atividade.id }, { ...avaliacao, professor_id: outra.id }, { ...avaliacao, situacao: 'PUBLICADA' },
      { ...avaliacao, titulo: 'Outro título' }, { ...avaliacao, tipo: 'ATIVIDADE' }, { ...avaliacao, duracao_minutos: 45 },
      { ...avaliacao, inicio_em: '2026-11-09T21:00:00Z' }, { ...avaliacao, fim_em: '2026-11-10T01:00:00Z' }]
      .map((item) => Response.json({ avaliacao: item }))]) {
    mocks.fetch.mockResolvedValueOnce(response)
    await expect(editarAvaliacaoRascunho(dados)).rejects.toThrow('Não foi possível confirmar a edição.')
  }
  mocks.fetch.mockClear()
  await expect(editarAvaliacaoRascunho({ ...dados, avaliacao_id: 'inválido' })).rejects.toThrow('Confira os campos')
  expect(mocks.fetch).not.toHaveBeenCalled()
})
