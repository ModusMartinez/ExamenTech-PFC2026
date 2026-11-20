import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ProvasAlunoPanel } from '../src/dev/legacy/ProvasAlunoPanel'

const services = vi.hoisted(() => ({
  listarProvasAluno: vi.fn(), iniciarTentativa: vi.fn(), interromperTentativa: vi.fn(),
  salvarResposta: vi.fn(), reportarFalhaCamera: vi.fn(),
  finalizarTentativa: vi.fn(),
}))
vi.mock('../src/dev/legacy/provas', () => services)

const provaId = '10000000-0000-0000-0000-000000000001'
const tentativaId = '20000000-0000-0000-0000-000000000001'
const questaoId = '30000000-0000-0000-0000-000000000001'
const alternativaId = '40000000-0000-0000-0000-000000000001'
const prova = {
  id: provaId, titulo: 'Prova de teste', inicio_em: '2020-01-01T00:00:00Z',
  fim_em: '2099-01-01T00:00:00Z', duracao_minutos: 30,
  tentativa_id: null, situacao: null, falhas_camera: null,
}
const tentativa = {
  id: tentativaId, avaliacao_id: provaId, situacao: 'EM_ANDAMENTO',
  falhas_camera: 0, tempo_restante_segundos: 1800,
  questoes: [{ id: questaoId, ordem: 1, tipo: 'OBJETIVA', enunciado: 'Quanto é 2 + 2?',
    pontuacao: 1, alternativas: [{ id: alternativaId, ordem: 1, texto: '4' },
      { id: '40000000-0000-0000-0000-000000000002', ordem: 2, texto: '5' }] }],
  respostas: [],
}
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
const getUserMedia = vi.fn()

function cameraStream() {
  const track = {
    stop: vi.fn(), onended: null as null | (() => void), onmute: null,
    onunmute: null, muted: false, readyState: 'live',
  }
  const stream = {
    getTracks: () => [track], getVideoTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia },
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  services.listarProvasAluno.mockResolvedValue([prova])
  services.iniciarTentativa.mockResolvedValue(tentativa)
  services.salvarResposta.mockResolvedValue({
    questao_id: questaoId, alternativa_id: alternativaId, texto: null,
    salvo_em: '2026-11-05T12:00:00Z',
  })
  services.reportarFalhaCamera.mockResolvedValue({ ...tentativa, situacao: 'INTERROMPIDA', falhas_camera: 1,
    questoes: [], respostas: [] })
  services.interromperTentativa.mockResolvedValue({ ...tentativa, situacao: 'INTERROMPIDA',
    questoes: [], respostas: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
})

test('início exige câmera e ciência; desconexão oculta questões e interrompe a tentativa', async () => {
  const { stream, track } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  const onLeave = vi.fn()
  const onActiveChange = vi.fn()
  render(<ProvasAlunoPanel onLeave={onLeave} onActiveChange={onActiveChange} />)

  fireEvent.click(await screen.findByRole('button', { name: 'Preparar prova' }))
  const begin = screen.getByRole('button', { name: 'Iniciar prova' }) as HTMLButtonElement
  expect(begin.disabled).toBe(true)
  expect(getUserMedia).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Ligar câmera' }))
  await screen.findByText(/Câmera conectada/)
  expect(begin.disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  expect(begin.disabled).toBe(false)
  fireEvent.click(begin)

  await screen.findByText('Quanto é 2 + 2?')
  expect(onActiveChange).toHaveBeenCalledWith(true)
  expect(services.iniciarTentativa).toHaveBeenCalledWith(provaId)
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await waitFor(() => expect(services.salvarResposta).toHaveBeenCalledWith(tentativaId,
    expect.objectContaining({ id: questaoId }), alternativaId))

  await act(async () => { track.onended?.() })
  expect(screen.queryByText('Quanto é 2 + 2?')).toBeNull()
  await waitFor(() => expect(services.reportarFalhaCamera).toHaveBeenCalledWith(tentativaId))
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('Não é possível voltar')))
  expect(track.stop).toHaveBeenCalled()
})

test('tentativa já iniciada não oferece novo início', async () => {
  services.listarProvasAluno.mockResolvedValue([{ ...prova, tentativa_id: tentativaId,
    situacao: 'INTERROMPIDA', falhas_camera: 1 }])
  render(<ProvasAlunoPanel onLeave={vi.fn()} onActiveChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Ver situação' }))
  expect(screen.getByText(/não pode ser reaberta/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Iniciar prova' })).toBeNull()
  expect(services.iniciarTentativa).not.toHaveBeenCalled()
})

test('saída voluntária exige confirmação e interrompe a tentativa', async () => {
  const { stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const onLeave = vi.fn()
  render(<ProvasAlunoPanel onLeave={onLeave} onActiveChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Preparar prova' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Ligar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar prova' }))
  await screen.findByText('Quanto é 2 + 2?')
  fireEvent.click(screen.getByRole('button', { name: 'Encerrar tentativa' }))
  await waitFor(() => expect(services.interromperTentativa).toHaveBeenCalledWith(tentativaId))
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('Não é possível voltar')))
})

test('erro ao iniciar continua visível depois da atualização da lista', async () => {
  const { stream, track } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  services.iniciarTentativa.mockRejectedValue(new Error('Banco e site usam versões diferentes da prova.'))
  render(<ProvasAlunoPanel onLeave={vi.fn()} onActiveChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Preparar prova' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Ligar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar prova' }))
  await waitFor(() => expect(screen.getByText('Banco e site usam versões diferentes da prova.')).toBeTruthy())
  expect(screen.getByRole('heading', { name: 'Teste local da câmera durante a prova' })).toBeTruthy()
  expect(track.stop).toHaveBeenCalled()
})

test('simulação local mantém a questão quando a câmera é desconectada sem iniciar tentativa real', async () => {
  const { stream, track } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<ProvasAlunoPanel onLeave={vi.fn()} onActiveChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Ligar câmera para simulação' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar teste local' }))
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  await act(async () => { track.onended?.() })
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  expect(screen.getByText(/A questão continua disponível/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Reconectar câmera' })).toBeTruthy()
  await waitFor(() => expect(track.stop).toHaveBeenCalled())
  expect(services.iniciarTentativa).not.toHaveBeenCalled()
})
