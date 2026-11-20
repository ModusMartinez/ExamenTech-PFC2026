import { beforeEach, expect, test, vi } from 'vitest'
import { encerrarTentativa, registrarFalhaCamera } from '../src/services/tentativas'

const chaveExecucao = '12345678-1234-4321-8765-123456789abc'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn(), retry: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
const tentativa = 'a0000000-0000-0000-0000-000000000001'
const solicitacao = 'b0000000-0000-0000-0000-000000000001'
const confirmado = { tentativa_id: tentativa, solicitacao_id: solicitacao, registrado_em: '2026-11-08T19:00:00Z' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.rpc.mockReturnValue({ abortSignal: mocks.abortSignal })
  mocks.abortSignal.mockReturnValue({ retry: mocks.retry })
  mocks.retry.mockResolvedValue({ data: confirmado, error: null })
})

test('envia somente os identificadores, limita a espera e confere a confirmação', async () => {
  await registrarFalhaCamera(tentativa.toUpperCase(), solicitacao.toUpperCase(), chaveExecucao)
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('registrar_falha_camera', {
    p_tentativa_id: tentativa, p_solicitacao_id: solicitacao, p_chave_execucao: chaveExecucao,
  })
  expect(mocks.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
  expect(mocks.retry).toHaveBeenCalledExactlyOnceWith(false)
})
test('recusa IDs e o antigo motivo CAMERA antes de enviar', async () => {
  await expect(registrarFalhaCamera('inválido', solicitacao, chaveExecucao)).rejects.toThrow('Ocorrência inválida')
  await expect(registrarFalhaCamera(tentativa, '', chaveExecucao)).rejects.toThrow('Ocorrência inválida')
  // @ts-expect-error Exercita entrada externa inválida além da proteção do TypeScript.
  await expect(encerrarTentativa(tentativa, 'CAMERA', chaveExecucao)).rejects.toThrow('Motivo de encerramento inválido')
  expect(mocks.rpc).not.toHaveBeenCalled()
})
test.each([null, {}, { ...confirmado, tentativa_id: solicitacao }, { ...confirmado, solicitacao_id: tentativa },
  { ...confirmado, registrado_em: 'ontem' }])('não confirma resposta inválida ou de outra ocorrência: %j', async value => {
  mocks.retry.mockResolvedValue({ data: value, error: null })
  await expect(registrarFalhaCamera(tentativa, solicitacao, chaveExecucao)).rejects.toThrow('Não foi possível confirmar')
})
test.each(['42501', 'P0002', '55000', '23514', 'XX000'])('trata erro %s sem revelar detalhes nem repetir', async code => {
  mocks.retry.mockResolvedValue({ data: null, error: { code, message: 'detalhe interno' } })
  await expect(registrarFalhaCamera(tentativa, solicitacao, chaveExecucao)).rejects.not.toThrow('detalhe interno')
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
})
test('falha de transporte não é tratada como ocorrência confirmada', async () => {
  mocks.retry.mockRejectedValue(new TypeError('Falha de rede'))
  await expect(registrarFalhaCamera(tentativa, solicitacao, chaveExecucao)).rejects.toThrow('A conexão foi perdida')
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
})
