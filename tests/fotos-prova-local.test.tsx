import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FotosProvaLocalPanel } from '../src/components/FotosProvaLocalPanel'

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
const getUserMedia = vi.fn()
const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()

function cameraStream() {
  const track = {
    readyState: 'live', muted: false, stop: vi.fn(),
    onended: null as null | (() => void), onmute: null, onunmute: null,
  }
  return { track, stream: {
    getTracks: () => [track], getVideoTracks: () => [track],
  } as unknown as MediaStream }
}

beforeEach(() => {
  vi.resetAllMocks()
  let nextUrl = 0
  createObjectURL.mockImplementation(() => `blob:local-${++nextUrl}`)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640)
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480)
  vi.spyOn(HTMLVideoElement.prototype, 'readyState', 'get').mockReturnValue(4)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['foto local'], { type: 'image/jpeg' }))
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

async function startWithInitialPhoto() {
  const { stream, track } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<FotosProvaLocalPanel />)
  expect(getUserMedia).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Ligar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Tirar foto inicial' }))
  await waitFor(() => expect(screen.getByText('Fotos nesta página: 1/4')).toBeTruthy())
  return track
}

test('simula quatro fotos sem enviar dados e limpa as prévias', async () => {
  const track = await startWithInitialPhoto()
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar simulação de 30 segundos' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })

  expect(screen.getByText('Fotos nesta página: 4/4')).toBeTruthy()
  expect(screen.getByText(/Simulação concluída/)).toBeTruthy()
  expect(createObjectURL).toHaveBeenCalledTimes(4)
  expect(track.stop).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Limpar fotos e recomeçar' }))
  expect(screen.getByText('Fotos nesta página: 0/4')).toBeTruthy()
  expect(revokeObjectURL).toHaveBeenCalledTimes(4)
})

test('desconexão interrompe o agendamento e impede novas capturas', async () => {
  const track = await startWithInitialPhoto()
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar simulação de 30 segundos' }))
  act(() => track.onended?.())
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByText(/A câmera ficou indisponível/)).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(createObjectURL).toHaveBeenCalledTimes(1)
  expect(screen.getByText('Fotos nesta página: 1/4')).toBeTruthy()
})
