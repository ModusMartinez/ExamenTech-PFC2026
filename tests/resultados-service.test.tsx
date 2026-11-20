import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { listarMeusResultados } from '../src/services/resultadosAvaliacao'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.restoreAllMocks())

const resultados = Array.from({ length: 51 }, (_, i) => ({
  tentativa_id: `10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  avaliacao_id: `20000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  titulo: `Resultado ${i}`, turma_nome: 'Turma de teste', publicado_em: '2026-11-18T12:00:00Z',
}))

test('consulta a página solicitada e preserva o item que sinaliza a próxima página', async () => {
  mocks.rpc.mockResolvedValue({ data: resultados, error: null })
  expect(await listarMeusResultados()).toHaveLength(51)
  expect(mocks.rpc).toHaveBeenLastCalledWith('listar_meus_resultados', { p_pagina: 0 })
  mocks.rpc.mockResolvedValue({ data: [], error: null })
  expect(await listarMeusResultados(2)).toEqual([])
  expect(mocks.rpc).toHaveBeenLastCalledWith('listar_meus_resultados', { p_pagina: 2 })
})

test.each([-1, 0.5, NaN, Infinity, 2147483648])('recusa página inválida %s antes da consulta', async pagina => {
  await expect(listarMeusResultados(pagina)).rejects.toThrow('Página inválida.')
  expect(mocks.rpc).not.toHaveBeenCalled()
})

test('recusa falhas, registros inválidos, duplicados e respostas acima do limite', async () => {
  for (const resposta of [
    { data: [], error: { code: '42501' } },
    { data: [...resultados, resultados[0]], error: null },
    { data: [resultados[0], resultados[0]], error: null },
    { data: [{ ...resultados[0], publicado_em: 'inválido' }], error: null },
  ]) {
    mocks.rpc.mockResolvedValue(resposta)
    await expect(listarMeusResultados()).rejects.toThrow()
  }
})
