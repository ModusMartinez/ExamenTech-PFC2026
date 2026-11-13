import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
