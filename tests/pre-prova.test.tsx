import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PreProvaPanel } from '../src/components/PreProvaPanel'

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
const getUserMedia = vi.fn()

function cameraStream() {
  const track = {
    stop: vi.fn(),
    onended: null as null | (() => void),
    onmute: null as null | (() => void),
    onunmute: null as null | (() => void),
    muted: false,
    readyState: 'live',
  }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
  return { track, stream }
}

beforeEach(() => {
  getUserMedia.mockReset()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
})

test('treino de questão funciona sem ativar a câmera ou registrar uma prova', () => {
  render(<PreProvaPanel />)
  const verify = screen.getByRole('button', { name: 'Verificar resposta' })
  expect(verify.hasAttribute('disabled')).toBe(true)

  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  fireEvent.click(verify)
  expect(screen.getByText(/A resposta do exemplo é 5/)).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  expect(screen.queryByText(/A resposta do exemplo é 5/)).toBeNull()
  fireEvent.click(verify)
  expect(screen.getByText(/Correto!/)).toBeTruthy()
  expect(getUserMedia).not.toHaveBeenCalled()
})

test('a câmera só liga após o clique e é liberada ao sair da pré-prova', async () => {
  const { track, stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  const view = render(<PreProvaPanel />)

  expect(getUserMedia).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'user' }, audio: false })
  expect((screen.getByLabelText('Imagem ao vivo da sua câmera') as HTMLVideoElement).srcObject).toBe(stream)

  view.unmount()
  expect(track.stop).toHaveBeenCalledTimes(1)
})

test('permissão negada mostra orientação e permite tentar novamente', async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException('negada', 'NotAllowedError'))
  const { stream } = cameraStream()
  getUserMedia.mockResolvedValueOnce(stream)
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  expect((await screen.findByRole('alert')).textContent).toContain('foi negado')
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
})

test('cancelar a solicitação libera a câmera mesmo se a permissão chegar depois', async () => {
  let allow!: (stream: MediaStream) => void
  getUserMedia.mockReturnValue(new Promise<MediaStream>((resolve) => { allow = resolve }))
  const { track, stream } = cameraStream()
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  await act(async () => allow(stream))

  await waitFor(() => expect(track.stop).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('status').textContent).toBe('A câmera está desligada.')
})

test('desconexão após o teste invalida a prévia', async () => {
  const { track, stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  act(() => track.onended?.())

  expect(screen.getByRole('alert').textContent).toContain('desconectada')
  expect(track.stop).toHaveBeenCalledTimes(1)
})

test('perda temporária de sinal e retorno atualizam o aviso', async () => {
  const { track, stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  track.muted = true
  act(() => track.onmute?.())
  expect(screen.getByRole('alert').textContent).toContain('temporariamente sem sinal')
  expect(track.stop).not.toHaveBeenCalled()

  track.muted = false
  act(() => track.onunmute?.())
  expect(screen.getByRole('status').textContent).toContain('sinal da câmera voltou')
})

test('estado sem sinal é detectado mesmo quando o dispositivo não dispara um evento', async () => {
  const { track, stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  track.muted = true
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('temporariamente sem sinal'), { timeout: 2000 })
})

test('prévia preta pode ser sinalizada sem contar uma falha de prova', async () => {
  const { track, stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Minha imagem ficou preta' }))
  expect(screen.getByRole('alert').textContent).toContain('não vê sua imagem')
  expect(track.stop).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Testar câmera' }).hasAttribute('disabled')).toBe(false)
})

test('webcam removida é detectada mesmo se o navegador não disparar ended', async () => {
  const { track, stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  track.readyState = 'ended'
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('desconectada'), { timeout: 2000 })
  expect(track.stop).toHaveBeenCalledTimes(1)
})

test('permissão revogada após a conexão é informada na nova tentativa', async () => {
  const { track, stream } = cameraStream()
  getUserMedia.mockResolvedValueOnce(stream)
  getUserMedia.mockRejectedValueOnce(new DOMException('revogada', 'NotAllowedError'))
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  act(() => track.onended?.())
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('foi negado'))
  expect(track.stop).toHaveBeenCalledTimes(1)
})

test('webcam ocupada por outro aplicativo mostra erro sem manter a prévia', async () => {
  getUserMedia.mockRejectedValue(new DOMException('ocupada', 'NotReadableError'))
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  expect((await screen.findByRole('alert')).textContent).toContain('em uso por outro aplicativo')
  expect((screen.getByLabelText('Imagem ao vivo da sua câmera') as HTMLVideoElement).srcObject).toBeNull()
})

test('navegador sem acesso a getUserMedia orienta usar um endereço seguro', () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
  render(<PreProvaPanel />)

  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  expect(screen.getByRole('alert').textContent).toContain('HTTPS ou localhost')
  expect(getUserMedia).not.toHaveBeenCalled()
})
