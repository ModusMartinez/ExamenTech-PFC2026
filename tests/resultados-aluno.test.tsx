import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ResultadosAlunoPanel } from '../src/components/ResultadosAlunoPanel'

const servicos = vi.hoisted(() => ({ listar: vi.fn(), consultar: vi.fn() }))
vi.mock('../src/services/resultadosAvaliacao', () => ({ listarMeusResultados: servicos.listar, consultarMeuResultado: servicos.consultar }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('o aluno parte da lista vazia e consulta sua prova corrigida quando o servidor confirma a publicação', async () => {
  const publicado = { tentativa_id: 'tentativa-1', titulo: 'Prova de teste', turma_nome: 'Turma A', publicado_em: '2026-11-09T12:00:00Z' }
  servicos.listar.mockResolvedValueOnce([]).mockResolvedValueOnce([publicado])
  servicos.consultar.mockResolvedValue({ ...publicado, nota: 5, pontos_obtidos: 1, pontos_totais: 2, questoes: [{
    id: 'questao-1', ordem: 1, enunciado: 'Qual é o procedimento correto?', resposta: 'Segunda', pontos: 1, maximo: 2,
    alternativas: [{ id: 'a', texto: 'Segunda', marcada: true, correta: false }, { id: 'b', texto: 'Primeira', marcada: false, correta: true }],
    comentario: 'Revise esta etapa.',
  }] })
  render(<ResultadosAlunoPanel onVoltar={vi.fn()} />)
  await screen.findByText('Nenhum resultado foi publicado para você.')
  expect(servicos.consultar).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar resultados' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Ver resultado de Prova de teste' }))
  await screen.findByText('Nota final 5,00 de 10')
  expect(screen.getByText('Revise esta etapa.', { exact: false })).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Alternativas da questão 1' }).textContent).toBe('Segunda · Sua escolhaPrimeira · Correta')
  expect(servicos.consultar).toHaveBeenCalledExactlyOnceWith('tentativa-1')
})

const resultados = Array.from({ length: 103 }, (_, i) => ({
  tentativa_id: `10000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
  avaliacao_id: `20000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
  titulo: `Resultado antigo ${i + 1}`, turma_nome: 'Turma A', publicado_em: '2026-11-18T12:00:00Z',
}))

test('alcança resultados antigos e preserva a página ao voltar da prova corrigida', async () => {
  servicos.listar.mockImplementation(async (pagina: number) => resultados.slice(pagina * 50, pagina * 50 + 51))
  servicos.consultar.mockResolvedValue({ ...resultados[50], nota: 8, pontos_obtidos: 8, pontos_totais: 10, questoes: [] })
  render(<ResultadosAlunoPanel onVoltar={vi.fn()} />)
  await screen.findByRole('heading', { name: 'Resultado antigo 1' })
  expect(screen.getAllByRole('button', { name: /^Ver resultado de / })).toHaveLength(50)
  expect(screen.queryByRole('heading', { name: 'Resultado antigo 51' })).toBeNull()
  let nav = within(screen.getByRole('navigation', { name: 'Paginação dos resultados' }))
  expect(nav.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(nav.getByRole('button', { name: 'Próxima' }))
  await screen.findByRole('heading', { name: 'Resultado antigo 51' })
  expect(servicos.listar).toHaveBeenLastCalledWith(1)
  fireEvent.click(screen.getByRole('button', { name: 'Ver resultado de Resultado antigo 51' }))
  await screen.findByText('Nota final 8,00 de 10')
  expect(servicos.consultar).toHaveBeenCalledExactlyOnceWith(resultados[50].tentativa_id)
  fireEvent.click(screen.getByRole('button', { name: 'Voltar aos resultados' }))
  await screen.findByRole('button', { name: 'Ver resultado de Resultado antigo 51' })
  expect(servicos.listar).toHaveBeenCalledTimes(2)
  nav = within(screen.getByRole('navigation', { name: 'Paginação dos resultados' }))
  expect(nav.getByText('Página 2')).toBeTruthy()
  fireEvent.click(nav.getByRole('button', { name: 'Próxima' }))
  await screen.findByRole('heading', { name: 'Resultado antigo 101' })
  expect(screen.getAllByRole('button', { name: /^Ver resultado de / })).toHaveLength(3)
  expect(nav.getByRole('button', { name: 'Próxima' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar resultados' }))
  await screen.findByRole('heading', { name: 'Resultado antigo 1' })
  expect(nav.getByText('Página 1')).toBeTruthy()
  expect(servicos.listar).toHaveBeenLastCalledWith(0)
})

test('trata carregamento, falha e página vazia sem exibir resultados da página anterior', async () => {
  servicos.listar.mockResolvedValue(resultados.slice(0, 51))
  render(<ResultadosAlunoPanel onVoltar={vi.fn()} />)
  await screen.findByRole('heading', { name: 'Resultado antigo 1' })
  const nav = within(screen.getByRole('navigation', { name: 'Paginação dos resultados' }))
  let rejeitar!: (causa: Error) => void
  servicos.listar.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejeitar = reject }))
  fireEvent.click(nav.getByRole('button', { name: 'Próxima' }))
  expect(screen.queryByRole('heading', { name: 'Resultado antigo 1' })).toBeNull()
  expect(nav.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(true)
  await act(async () => rejeitar(new Error('Consulta indisponível.')))
  await screen.findByRole('alert')
  expect(nav.getByRole('button', { name: 'Próxima' }).hasAttribute('disabled')).toBe(true)
  servicos.listar.mockResolvedValueOnce([])
  fireEvent.click(nav.getByRole('button', { name: 'Anterior' }))
  await screen.findByText('Nenhum resultado foi publicado para você.')
  servicos.listar.mockResolvedValueOnce(resultados.slice(0, 51))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar resultados' }))
  await screen.findByRole('heading', { name: 'Resultado antigo 1' })
  servicos.listar.mockResolvedValueOnce([])
  fireEvent.click(nav.getByRole('button', { name: 'Próxima' }))
  await screen.findByText('Nenhum resultado nesta página.')
  expect(nav.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(false)
})
