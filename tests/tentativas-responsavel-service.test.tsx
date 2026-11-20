import { beforeEach, expect, test, vi } from 'vitest'
import { listarTentativasResponsavel } from '../src/services/examManagement'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
const avaliacao = '10000000-0000-0000-0000-000000000001'
const tentativa = { id: '20000000-0000-0000-0000-000000000001', avaliacao_id: avaliacao,
  aluno_id: '30000000-0000-0000-0000-000000000001', aluno_nome: 'Aluno de teste',
  situacao: 'FINALIZADA', ciclo: 1, iniciada_em: '2026-11-18T10:00:00Z',
  limite_em: '2026-11-18T11:00:00Z', encerrada_em: '2026-11-18T10:30:00Z' }

beforeEach(() => { vi.resetAllMocks(); mocks.rpc.mockResolvedValue({ data: [], error: null }) })

test('consulta a página solicitada e aceita o registro adicional que indica a próxima', async () => {
  mocks.rpc.mockResolvedValue({ data: Array.from({ length: 51 }, (_, index) => ({ ...tentativa,
    id: `20000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}` })), error: null })
  expect(await listarTentativasResponsavel(avaliacao)).toHaveLength(51)
  expect(mocks.rpc).toHaveBeenLastCalledWith('listar_tentativas_responsavel', { p_avaliacao_id: avaliacao, p_pagina: 0 })
  mocks.rpc.mockResolvedValue({ data: [], error: null })
  expect(await listarTentativasResponsavel(avaliacao, 2)).toEqual([])
  expect(mocks.rpc).toHaveBeenLastCalledWith('listar_tentativas_responsavel', { p_avaliacao_id: avaliacao, p_pagina: 2 })
})

test.each([-1, 0.5, NaN, Infinity, 2147483648])('recusa página inválida %s antes da consulta', async pagina => {
  await expect(listarTentativasResponsavel(avaliacao, pagina)).rejects.toThrow('Página inválida.')
  expect(mocks.rpc).not.toHaveBeenCalled()
})

test('recusa falhas e respostas com excesso de itens ou outra avaliação', async () => {
  for (const response of [
    { data: [], error: { code: '42501' } },
    { data: Array(52).fill(tentativa), error: null },
    { data: [{ ...tentativa, avaliacao_id: 'outra' }], error: null },
    { data: [{ ...tentativa, iniciada_em: 'data inválida' }], error: null },
  ]) {
    mocks.rpc.mockResolvedValue(response)
    await expect(listarTentativasResponsavel(avaliacao)).rejects.toThrow()
  }
})
