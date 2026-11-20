// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TurmasPanel } from '../src/components/TurmasPanel'
import type { Turma } from '../src/services/turmas'

const mocks = vi.hoisted(() => ({ listar: vi.fn(), criar: vi.fn(), getSession: vi.fn(), fetch: vi.fn() }))
vi.mock('../src/services/turmas', () => ({
  listarTurmas: mocks.listar, criarTurma: mocks.criar,
}))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))
const turma: Turma = {
  id: 'turma-teste', nome: 'Engenharia 8B', professor_id: 'professor-teste',
  codigo_ingresso: 'ABCDEF123456', situacao: 'ATIVA', criado_em: '2026-10-20T12:00:00Z',
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.listar.mockResolvedValue([])
  mocks.criar.mockResolvedValue(turma)
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'sessao-simulada' } }, error: null })
  mocks.fetch.mockImplementation(async () => Response.json({ alunos: [] }))
  vi.stubGlobal('fetch', mocks.fetch)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('professor consulta lista vazia e cria uma turma com nome normalizado', async () => {
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: '  Engenharia 8B  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar turma' }))
  await screen.findByText('Turma “Engenharia 8B” criada.')
  expect(mocks.criar).toHaveBeenCalledExactlyOnceWith('Engenharia 8B')
  expect(screen.getByText('ABCDEF123456')).toBeTruthy()
  expect((screen.getByLabelText('Nome da turma') as HTMLInputElement).value).toBe('')
})

test('validação impede enviar nome curto', async () => {
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: 'AB' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar turma' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(mocks.criar).not.toHaveBeenCalled()
})

test('erro na criação mantém o nome para corrigir ou tentar novamente', async () => {
  mocks.criar.mockRejectedValue(new Error('Acesso não autorizado.'))
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: 'Engenharia 8B' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar turma' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Acesso não autorizado.')
  expect((screen.getByLabelText('Nome da turma') as HTMLInputElement).value).toBe('Engenharia 8B')
  expect(screen.queryByText('ABCDEF123456')).toBeNull()
})

test('administrador consulta turmas sem formulário de criação', async () => {
  mocks.listar.mockResolvedValue([turma])
  render(<TurmasPanel profile="Administrador" />)
  await screen.findByText('Engenharia 8B')
  expect(screen.queryByLabelText('Nome da turma')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Criar turma' })).toBeNull()
  expect(screen.getByText('professor-teste')).toBeTruthy()
})

test('atualizar recupera a lista depois de falha', async () => {
  mocks.listar.mockRejectedValueOnce(new Error('Serviço indisponível.')).mockResolvedValueOnce([turma])
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Serviço indisponível.')
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
  await screen.findByText('Engenharia 8B')
  expect(screen.queryByText('Serviço indisponível.')).toBeNull()
})

test('envio em andamento não cria duas turmas e bloqueia atualização concorrente', async () => {
  let finish: (result: Turma) => void = () => {}
  mocks.criar.mockImplementation(() => new Promise<Turma>((resolve) => { finish = resolve }))
  render(<TurmasPanel profile="Professor" />)
  await screen.findByText('Nenhuma turma cadastrada.')
  fireEvent.change(screen.getByLabelText('Nome da turma'), { target: { value: turma.nome } })
  const form = screen.getByLabelText('Nome da turma').closest('form')!
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(mocks.criar).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('button', { name: 'Atualizar' }) as HTMLButtonElement).disabled).toBe(true)
  finish(turma)
  await waitFor(() => expect(screen.getByText('ABCDEF123456')).toBeTruthy())
})

const alunos = Array.from({ length: 51 }, (_, index) => ({
  id: `matricula-${index}`, aluno_nome: `Aluno ${index}`, aluno_rgm: index === 0 ? '12345678901' : null,
}))

test.each(['Professor', 'Administrador'] as const)('%s abre alunos da turma sem ampliar consulta para outros perfis', async (profile) => {
  mocks.listar.mockResolvedValue([turma])
  mocks.fetch.mockResolvedValueOnce(Response.json({ alunos: alunos.slice(0, 2) }))
  render(<TurmasPanel profile={profile} />)
  const button = await screen.findByRole('button', { name: `Alunos de ${turma.nome}` })
  expect(mocks.fetch).not.toHaveBeenCalled()
  fireEvent.click(button)
  await screen.findByRole('cell', { name: 'Aluno 0' })
  expect(screen.getByText('12345678901')).toBeTruthy()
  expect(screen.getByText('Não informado')).toBeTruthy()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(`/api/matriculas?turma_id=${turma.id}&pagina=0`, {
    method: 'GET', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' }, body: undefined,
  })
  expect(screen.queryByRole('button', { name: /Aprovar|Excluir/ })).toBeNull()
  fireEvent.click(button)
  expect(screen.queryByRole('table')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

test('paginação exibe 50 alunos, avança, volta e atualização reinicia na primeira página', async () => {
  mocks.listar.mockResolvedValue([turma])
  mocks.fetch.mockImplementation(async (url: string) => Response.json({ alunos: url.endsWith('pagina=1') ? alunos.slice(50) : alunos }))
  render(<TurmasPanel profile="Professor" />)
  fireEvent.click(await screen.findByRole('button', { name: `Alunos de ${turma.nome}` }))
  const table = await screen.findByRole('table')
  expect(within(table).getAllByRole('row')).toHaveLength(51)
  expect(screen.queryByRole('cell', { name: 'Aluno 50' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Próxima' }))
  await screen.findByRole('cell', { name: 'Aluno 50' })
  expect(screen.getByText('Página 2')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Próxima' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Anterior' }))
  await screen.findByRole('cell', { name: 'Aluno 0' })
  fireEvent.click(screen.getByRole('button', { name: 'Próxima' }))
  await screen.findByRole('cell', { name: 'Aluno 50' })
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar alunos' }))
  await screen.findByRole('cell', { name: 'Aluno 0' })
  expect(screen.getByText('Página 1')).toBeTruthy()
  expect(mocks.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
})

test('trocar de turma não mostra resposta atrasada e reinicia a lista', async () => {
  const outra = { ...turma, id: 'outra-turma', nome: 'Segunda turma' }
  mocks.listar.mockResolvedValue([turma, outra])
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  render(<TurmasPanel profile="Professor" />)
  fireEvent.click(await screen.findByRole('button', { name: `Alunos de ${turma.nome}` }))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: 'Atualizar alunos' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: `Alunos de ${outra.nome}` }))
  await screen.findByText('Nenhum aluno nesta página.')
  await act(async () => finish(Response.json({ alunos: alunos.slice(0, 2) })))
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getByRole('region', { name: `Alunos de ${outra.nome}` })).toBeTruthy()
  expect(screen.queryByRole('region', { name: `Alunos de ${turma.nome}` })).toBeNull()
})

test.each([401, 403, 404, 503])('erro %i oculta lista anterior e permite atualizar', async (status) => {
  mocks.listar.mockResolvedValue([turma])
  mocks.fetch.mockResolvedValueOnce(Response.json({ alunos: alunos.slice(0, 1) }))
  render(<TurmasPanel profile="Administrador" />)
  fireEvent.click(await screen.findByRole('button', { name: `Alunos de ${turma.nome}` }))
  await screen.findByRole('table')
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Consulta indisponível.' }, { status }))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar alunos' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Consulta indisponível.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('Nenhum aluno nesta página.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar alunos' }))
  await screen.findByText('Nenhum aluno nesta página.')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('ausência de sessão, falha de rede ou resposta malformada não simulam lista vazia', async () => {
  mocks.listar.mockResolvedValue([turma])
  mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null })
  render(<TurmasPanel profile="Professor" />)
  fireEvent.click(await screen.findByRole('button', { name: `Alunos de ${turma.nome}` }))
  await screen.findByText('Sua sessão terminou. Entre novamente.')
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockRejectedValueOnce(new TypeError('Erro interno'))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar alunos' }))
  await screen.findByText(/Confira sua conexão/)
  for (const response of [Response.json({ alunos: [{}] }), Response.json({ alunos: null }),
    Response.json({ alunos: Array(52).fill(alunos[0]) }), new Response('<html>Erro</html>')]) {
    mocks.fetch.mockResolvedValueOnce(response)
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar alunos' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Nenhum aluno nesta página.')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  }
})

const inativada = {
  id: alunos[0].id, turma_id: turma.id, turma_nome: turma.nome,
  situacao: 'INATIVA', solicitado_em: '2026-10-23T12:00:00Z',
}

async function abrirAlunos(profile: 'Professor' | 'Administrador' = 'Professor') {
  mocks.listar.mockResolvedValue([turma])
  mocks.fetch.mockResolvedValueOnce(Response.json({ alunos: alunos.slice(0, 2) }))
  render(<TurmasPanel profile={profile} />)
  fireEvent.click(await screen.findByRole('button', { name: `Alunos de ${turma.nome}` }))
  return screen.findByRole('button', { name: 'Inativar matrícula de Aluno 0' })
}

test('cancelar confirmação mantém matrícula sem enviar PATCH', async () => {
  vi.mocked(window.confirm).mockReturnValue(false)
  fireEvent.click(await abrirAlunos())
  expect(window.confirm).toHaveBeenCalledExactlyOnceWith('Inativar a matrícula de Aluno 0 em “Engenharia 8B”?\nO histórico será mantido.')
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('cell', { name: 'Aluno 0' })).toBeTruthy()
})

test.each(['Professor', 'Administrador'] as const)('%s confirma inativação e atualiza lista somente após sucesso', async (profile) => {
  const button = await abrirAlunos(profile)
  mocks.fetch.mockResolvedValueOnce(Response.json({ matricula: inativada }))
  fireEvent.click(button)
  const notice = await screen.findByText('Matrícula de Aluno 0 inativada.')
  await screen.findByText('Nenhum aluno nesta página.')
  expect(mocks.fetch).toHaveBeenNthCalledWith(2, '/api/matriculas', {
    method: 'PATCH', headers: { Authorization: 'Bearer sessao-simulada', 'Content-Type': 'application/json' },
    body: JSON.stringify({ matricula_id: alunos[0].id, acao: 'inativar' }),
  })
  expect(mocks.fetch.mock.calls[2][0]).toBe(`/api/matriculas?turma_id=${turma.id}&pagina=0`)
  expect(document.activeElement).toBe(notice.parentElement)
  expect(screen.queryByRole('button', { name: 'Inativar matrícula de Aluno 0' })).toBeNull()
})

test('inativação em andamento bloqueia repetição, outra matrícula e navegação da lista', async () => {
  const button = await abrirAlunos()
  let finish!: (value: Response) => void
  mocks.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
  for (const name of ['Inativar matrícula de Aluno 0', 'Inativar matrícula de Aluno 1', 'Atualizar alunos', 'Anterior', 'Próxima']) {
    expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
  }
  expect(window.confirm).toHaveBeenCalledTimes(1)
  expect(screen.getByText('Inativando...')).toBeTruthy()
  await act(async () => finish(Response.json({ matricula: inativada })))
  await screen.findByText('Matrícula de Aluno 0 inativada.')
})

test.each([401, 403, 404, 409, 503])('inativação recusada (%i) mantém a linha sem mostrar sucesso', async (status) => {
  const button = await abrirAlunos()
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Inativação não confirmada.' }, { status }))
  fireEvent.click(button)
  expect((await screen.findByRole('alert')).textContent).toBe('Inativação não confirmada.')
  expect(screen.getByRole('cell', { name: 'Aluno 0' })).toBeTruthy()
  expect(screen.queryByText('Matrícula de Aluno 0 inativada.')).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(button.hasAttribute('disabled')).toBe(false)
})

test('resposta com outro ID/situação ou falha de rede não remove a matrícula', async () => {
  const button = await abrirAlunos()
  for (const matricula of [{ ...inativada, id: 'outra-matricula' }, { ...inativada, situacao: 'ATIVA' }, {}]) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ matricula }))
    fireEvent.click(button)
    await screen.findByRole('alert')
    expect(screen.getByRole('cell', { name: 'Aluno 0' })).toBeTruthy()
    expect(screen.queryByText('Matrícula de Aluno 0 inativada.')).toBeNull()
  }
  mocks.fetch.mockRejectedValueOnce(new TypeError('Falha de rede'))
  fireEvent.click(button)
  await screen.findByText(/Confira sua conexão/)
  expect(screen.getByRole('cell', { name: 'Aluno 0' })).toBeTruthy()
})

test('inativação confirmada não vira falha quando a consulta seguinte está indisponível', async () => {
  const button = await abrirAlunos()
  mocks.fetch.mockResolvedValueOnce(Response.json({ matricula: inativada }))
  mocks.fetch.mockResolvedValueOnce(Response.json({ message: 'Lista indisponível.' }, { status: 503 }))
  fireEvent.click(button)
  await screen.findByText('Matrícula de Aluno 0 inativada.')
  await screen.findByText('Lista indisponível.')
  expect(screen.queryByRole('table')).toBeNull()
})
