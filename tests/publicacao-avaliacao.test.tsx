import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import { listarAvaliacoesPublicadas, publicarAvaliacao } from '../src/services/avaliacoes'
import type { AvaliacaoPublicada, AvaliacaoRascunho } from '../src/services/avaliacaoValidation'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({ listarTurmas: mocks.listar, criarTurma: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turma = { id: '10000000-0000-0000-0000-000000000001', nome: 'Engenharia 8B',
  professor_id: '20000000-0000-0000-0000-000000000001', situacao: 'ATIVA', codigo_ingresso: 'ABCDEF123456', criado_em: '2026-10-20T12:00:00Z' }
const outra = { ...turma, id: '10000000-0000-0000-0000-000000000002', nome: 'Outra turma' }
const avaliacao: AvaliacaoRascunho = { id: '30000000-0000-0000-0000-000000000001', turma_id: turma.id, professor_id: turma.professor_id,
  titulo: 'Prova de Engenharia', tipo: 'PROVA', inicio_em: '2026-11-09T22:00:00Z', fim_em: '2026-11-10T00:00:00Z',
  duracao_minutos: 60, situacao: 'RASCUNHO', criado_em: '2026-10-28T12:00:00Z' }
const publicada: AvaliacaoPublicada = { ...avaliacao, situacao: 'PUBLICADA', publicada_em: '2026-11-05T13:00:00.000Z' }
const confirmacao = { id: publicada.id, situacao: publicada.situacao, publicada_em: publicada.publicada_em }
let rascunhos: AvaliacaoRascunho[]
let publicadas: AvaliacaoPublicada[]

beforeEach(() => {
  vi.resetAllMocks()
  rascunhos = [avaliacao]; publicadas = []
  mocks.listar.mockResolvedValue([turma, outra])
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada', user: { id: turma.professor_id } } }, error: null })
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.startsWith('/api/avaliacoes?')) {
      const query = new URL(url, 'http://localhost').searchParams
      const registros = query.get('situacao') === 'PUBLICADA' ? publicadas : rascunhos
      return Response.json({ avaliacoes: registros.filter((item) => item.turma_id === query.get('turma_id')), limite: 50 })
    }
    if (url === '/api/publicar-avaliacao' && options.method === 'POST') {
      publicadas = [publicada]; rascunhos = []
      return Response.json({ avaliacao: confirmacao })
    }
    throw new Error('Rota inesperada')
  })
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function abrir(profile: 'Professor' | 'Administrador' = 'Professor') {
  render(<TurmasPanel profile={profile} />)
  await screen.findByRole('button', { name: `Rascunhos de ${turma.nome}` })
  expect(mocks.fetch).not.toHaveBeenCalled()
}
async function abrirConfirmacao() {
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${turma.nome}` }))
  const button = await screen.findByRole('button', { name: `Publicar ${avaliacao.titulo}` })
  fireEvent.click(button)
  const form = screen.getByRole('form', { name: 'Publicar avaliação' })
  expect(within(form).getByText(avaliacao.titulo)).toBeTruthy()
  expect(within(form).getByText(/não será possível alterar/)).toBeTruthy()
  expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Cancelar' }))
  return { form, button }
}

test('cancelar não publica e devolve foco; confirmar remove o rascunho e atualiza publicadas abertas', async () => {
  await abrir()
  fireEvent.click(screen.getByRole('button', { name: `Publicadas de ${turma.nome}` }))
  await screen.findByText('Nenhuma avaliação publicada nesta turma.')
  const { form, button } = await abrirConfirmacao()
  expect(mocks.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  fireEvent.click(within(form).getByRole('button', { name: 'Cancelar' }))
  expect(document.activeElement).toBe(button)
  expect(screen.queryByRole('form', { name: 'Publicar avaliação' })).toBeNull()
  fireEvent.click(button)
  fireEvent.submit(screen.getByRole('form', { name: 'Publicar avaliação' }))
  const notice = await screen.findByText(`Avaliação “${avaliacao.titulo}” publicada.`)
  expect(document.activeElement).toBe(notice)
  await screen.findByText('Nenhum rascunho nesta turma.')
  const table = await screen.findByRole('table', { name: `Avaliações publicadas de ${turma.nome}` })
  expect(within(table).getByRole('rowheader', { name: avaliacao.titulo })).toBeTruthy()
  expect(within(table).queryByRole('button')).toBeNull()
  const posts = mocks.fetch.mock.calls.filter(([, options]) => options.method === 'POST')
  expect(posts).toEqual([['/api/publicar-avaliacao', {
    method: 'POST', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    cache: 'no-store', body: JSON.stringify({ avaliacao_id: avaliacao.id }),
  }]])
  fireEvent.click(screen.getByRole('button', { name: `Publicadas de ${turma.nome}` }))
  fireEvent.click(screen.getByRole('button', { name: `Publicadas de ${turma.nome}` }))
  await screen.findByRole('table', { name: `Avaliações publicadas de ${turma.nome}` })
})

test.each(['Administrador', 'Professor'] as const)('%s consulta publicadas em turma inativa sem publicar ou editar', async (profile) => {
  mocks.listar.mockResolvedValue([{ ...turma, situacao: 'INATIVA' }])
  publicadas = [{ ...publicada, titulo: `${'Título longo '.repeat(9)}<script>teste</script>` }]
  await abrir(profile)
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${turma.nome}` }))
  await screen.findByRole('table', { name: `Avaliações em rascunho de ${turma.nome}` })
  expect(screen.queryByRole('button', { name: /^Publicar |^Editar / })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: `Publicadas de ${turma.nome}` }))
  const table = await screen.findByRole('table', { name: `Avaliações publicadas de ${turma.nome}` })
  expect(within(table).getByRole('rowheader').textContent).toBe(publicadas[0].titulo)
  expect(table.querySelector('script')).toBeNull()
  expect(within(table).getAllByRole('columnheader').map((item) => item.textContent)).toEqual(['Título', 'Tipo', 'Início', 'Fim', 'Duração', 'Publicada em'])
  expect(table.querySelectorAll('time')[2].dateTime).toBe(publicada.publicada_em)
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Avaliações publicadas' }))
  expect(mocks.fetch).toHaveBeenCalledWith(`/api/avaliacoes?turma_id=${turma.id}&situacao=PUBLICADA`, {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada' }, cache: 'no-store',
  })
})

test('admin em turma ativa também não recebe o botão Publicar', async () => {
  await abrir('Administrador')
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${turma.nome}` }))
  await screen.findByRole('table')
  expect(screen.queryByRole('button', { name: /^Publicar / })).toBeNull()
})

test('envio duplicado é bloqueado e resposta após fechar rascunhos é ignorada', async () => {
  await abrir()
  const { form } = await abrirConfirmacao()
  let finish!: (response: Response) => void
  mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
  mocks.fetch.mockClear()
  fireEvent.submit(form); fireEvent.submit(form)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(form.querySelector('fieldset')?.disabled).toBe(true)
  for (const name of ['Atualizar rascunhos', `Editar ${avaliacao.titulo}`, `Nova questão em ${avaliacao.titulo}`]) {
    expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
  }
  fireEvent.click(screen.getByRole('button', { name: `Rascunhos de ${turma.nome}` }))
  await act(async () => { finish(Response.json({ avaliacao: confirmacao })) })
  expect(screen.queryByText(`Avaliação “${avaliacao.titulo}” publicada.`)).toBeNull()
  expect(screen.queryByRole('form', { name: 'Publicar avaliação' })).toBeNull()
})

test.each([400, 401, 403, 409, 503])('falha %i mantém rascunho e confirmação, sem reenviar', async (status) => {
  await abrir()
  const { form } = await abrirConfirmacao()
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Publicação recusada.' }, { status }))
  mocks.fetch.mockClear()
  fireEvent.submit(form)
  const notice = await screen.findByRole('alert')
  expect(notice.textContent).toBe('Publicação recusada.')
  expect(document.activeElement).toBe(notice)
  expect(screen.getByRole('rowheader', { name: avaliacao.titulo })).toBeTruthy()
  expect(screen.getByRole('form', { name: 'Publicar avaliação' })).toBe(form)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

test('lista mostra carregamento, erro e vazio; troca de turma ignora consulta atrasada', async () => {
  await abrir()
  let finish!: (response: Response) => void
  mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: `Publicadas de ${turma.nome}` }))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByText('Carregando publicadas...')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Atualizar publicadas' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: `Publicadas de ${outra.nome}` }))
  await screen.findByText('Nenhuma avaliação publicada nesta turma.')
  await act(async () => { finish(Response.json({ avaliacoes: [publicada], limite: 50 })) })
  expect(screen.queryByRole('table')).toBeNull()
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: [{ ...publicada, turma_id: outra.id }], limite: 50 }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar publicadas' }))
  await screen.findByRole('table')
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível.' }, { status: 503 }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar publicadas' }))
  await screen.findByText('Consulta indisponível.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('Nenhuma avaliação publicada nesta turma.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar publicadas' }))
  await screen.findByText('Nenhuma avaliação publicada nesta turma.')
})

test('serviços validam ID, sessão, confirmação e lista; falhas não geram sucesso', async () => {
  await expect(publicarAvaliacao('inválido')).rejects.toThrow('ID da avaliação inválido.')
  await expect(listarAvaliacoesPublicadas('inválido')).rejects.toThrow('ID da turma inválido.')
  expect(mocks.getSession).not.toHaveBeenCalled()
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  await expect(publicarAvaliacao(avaliacao.id)).rejects.toThrow('Sua sessão terminou.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Rede indisponível'))
  await expect(publicarAvaliacao(avaliacao.id)).rejects.toThrow(/Confira Publicadas/)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  for (const value of [null, {}, [], { ...confirmacao, id: outra.id }, { ...confirmacao, situacao: 'RASCUNHO' },
    { ...confirmacao, publicada_em: null }, { ...confirmacao, publicada_em: '2026-02-30T12:00:00Z' }]) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacao: value }))
    await expect(publicarAvaliacao(avaliacao.id)).rejects.toThrow(/Confira Publicadas/)
  }
  mocks.fetch.mockResolvedValueOnce(new Response('JSON inválido'))
  await expect(publicarAvaliacao(avaliacao.id)).rejects.toThrow(/Confira Publicadas/)
  mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacao: confirmacao }, { status: 201 }))
  await expect(publicarAvaliacao(avaliacao.id)).rejects.toThrow(/Confira Publicadas/)
  for (const registros of [[publicada, publicada], [avaliacao], [{ ...publicada, turma_id: outra.id }],
    [{ ...publicada, publicada_em: null }], Array(51).fill(publicada)]) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ avaliacoes: registros, limite: 50 }))
    await expect(listarAvaliacoesPublicadas(turma.id)).rejects.toThrow('Não foi possível conferir a lista de publicadas.')
  }
  publicadas = Array.from({ length: 50 }, (_, i) => ({ ...publicada, id: `30000000-0000-0000-0000-${String(i).padStart(12, '0')}` }))
  expect(await listarAvaliacoesPublicadas(turma.id)).toHaveLength(50)
})
