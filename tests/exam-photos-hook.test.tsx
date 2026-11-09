import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useExamPhotos } from '../src/hooks/useExamPhotos'

const services = vi.hoisted(() => ({ plan: vi.fn(), send: vi.fn(), capture: vi.fn(), cameraFailure: vi.fn(), executionFailure: vi.fn() }))
vi.mock('../src/services/examPhotos', () => ({ consultarPlanoFotos: services.plan, enviarFoto: services.send }))
vi.mock('../src/services/photoEvidence', () => ({ capturePhotoFrame: services.capture }))
const attempt = '10000000-0000-0000-0000-000000000001'
const chaveExecucao = '30000000-0000-4000-8000-000000000001'
let initialize: () => Promise<boolean>
let retry: () => Promise<boolean>
let flush: () => Promise<boolean>
let dispose: () => void
let prepare: () => Promise<boolean>
function Harness() {
  const video = useRef<HTMLVideoElement>(null)
  const photos = useExamPhotos(video, services.cameraFailure, services.executionFailure)
  initialize = () => photos.initialize(attempt, chaveExecucao)
  retry = photos.retry; flush = photos.flush; dispose = photos.dispose
  prepare = () => photos.prepare(attempt, chaveExecucao)
  return <><video ref={video} /><output aria-label="Pendentes">{photos.pending}</output>
    <output aria-label="Inicial pronta">{String(photos.initialReady)}</output>
    <p>{photos.message}</p>{photos.toast && <p role="status">{photos.toast}</p>}
    <button onClick={photos.dispose}>Limpar</button></>
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  const serverTime = new Date().toISOString()
  services.plan.mockResolvedValue({ tentativa_id: attempt, ciclo: 1, servidor_em: serverTime,
    capturas: ['INICIAL','PROVA_1','PROVA_2','PROVA_3'].map((momento, i) => ({
      id: `20000000-0000-0000-0000-00000000000${i+1}`, momento,
      agendada_em: new Date(Date.now()+i*10000).toISOString(), recebida_em: null,
    })) })
  services.capture.mockImplementation(async (_video, moment) => ({moment,blob:new Blob(['jpeg'],{type:'image/jpeg'}),
    capturedAt:new Date().toISOString(),width:640,height:480}))
  services.send.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

test('captura inicial e três horários do servidor, com aviso sem mudar o foco; não aguarda capturas futuras no envio', async () => {
  render(<StrictMode><Harness /></StrictMode>)
  await act(async () => { expect(await initialize()).toBe(true) })
  expect(screen.getByLabelText('Inicial pronta').textContent).toBe('true')
  expect(services.capture).toHaveBeenCalledTimes(1)
  let finished = false
  await act(async () => { finished = await flush() })
  expect(finished).toBe(true)
  expect(services.capture).toHaveBeenCalledTimes(1)
  screen.getByRole('button', {name:'Limpar'}).focus()
  for (let i=1; i<=3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(services.capture.mock.calls.map(call=>call[1])).toEqual(['INICIAL','PROVA_1','PROVA_2','PROVA_3'])
  expect(services.send).toHaveBeenCalledTimes(4)
  expect(document.activeElement).toBe(screen.getByRole('button', {name:'Limpar'}))
  expect(screen.getByText('Foto capturada durante a prova.')).toBeTruthy()
  expect(screen.getByLabelText('Pendentes').textContent).toBe('0')
  fireEvent.click(screen.getByRole('button', {name:'Limpar'}))
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(services.capture).toHaveBeenCalledTimes(4)
})

test('rede falha sem penalizar a câmera e repete o mesmo arquivo e identificador de envio', async () => {
  services.send.mockRejectedValueOnce(new Error('Rede')).mockRejectedValueOnce(new Error('Rede')).mockRejectedValueOnce(new Error('Rede'))
  render(<Harness />)
  let initialization: Promise<boolean>
  await act(async () => { initialization = initialize() })
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  await act(async () => { expect(await initialization!).toBe(false) })
  expect(services.cameraFailure).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Inicial pronta').textContent).toBe('false')
  expect(screen.getByLabelText('Pendentes').textContent).toBe('1')
  expect(screen.getByText(/Isso não é uma falha de câmera/)).toBeTruthy()
  await act(async () => { expect(await retry()).toBe(true) })
  const first = services.send.mock.calls[0]
  for (const call of services.send.mock.calls) {
    expect(call[0]).toBe(first[0]); expect(call[1]).toBe(first[1]); expect(call[2]).toBe(first[2])
  }
  expect(services.capture).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Inicial pronta').textContent).toBe('true')
})

test('falha de captura é comunicada e encerrar libera fila e cancela próximas fotos', async () => {
  services.capture.mockRejectedValue(new Error('Sem imagem'))
  render(<Harness />)
  await act(async () => { expect(await initialize()).toBe(false) })
  expect(services.cameraFailure).toHaveBeenCalledTimes(1)
  expect(services.send).not.toHaveBeenCalled()
  dispose()
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(services.capture).toHaveBeenCalledTimes(1)
})

test('resposta atrasada do plano após desmontar não abre capturas nem envia arquivos', async () => {
  const originalPlan = await services.plan()
  let resolvePlan: (value: unknown) => void = () => undefined
  services.plan.mockImplementation(() => new Promise(resolve => { resolvePlan = resolve }))
  const {unmount} = render(<Harness />)
  let initialization: Promise<boolean>
  await act(async () => { initialization = initialize() })
  unmount()
  await act(async () => { resolvePlan(originalPlan); expect(await initialization!).toBe(false) })
  expect(services.capture).not.toHaveBeenCalled()
  expect(services.send).not.toHaveBeenCalled()
})

test('recuperação da captura inicial não duplica plano, timers ou uma foto já confirmada', async () => {
  services.capture.mockRejectedValueOnce(new Error('Sem imagem'))
  render(<Harness />)
  await act(async () => { expect(await prepare()).toBe(false) })
  await act(async () => { expect(await prepare()).toBe(true) })
  await act(async () => { expect(await prepare()).toBe(true) })
  expect(services.plan).toHaveBeenCalledTimes(1)
  expect(services.capture).toHaveBeenCalledTimes(2)
  expect(services.send).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(services.capture.mock.calls.map(call=>call[1])).toEqual(['INICIAL','INICIAL','PROVA_1','PROVA_2','PROVA_3'])
  await act(async () => { expect(await flush()).toBe(true) })
})

test('captura posterior indisponível registra falha e mantém as próximas fotos agendadas', async () => {
  render(<Harness />)
  await act(async () => { await prepare() })
  services.capture.mockRejectedValueOnce(new Error('Sem imagem'))
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(services.cameraFailure).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
  expect(services.capture).toHaveBeenCalledTimes(4)
  expect(services.send).toHaveBeenCalledTimes(3)
  expect(screen.getByLabelText('Inicial pronta').textContent).toBe('true')
  await act(async () => { expect(await flush()).toBe(false) })
})

test('cliques durante a foto inicial compartilham a preparação e o mesmo envio', async () => {
  let confirmar!: () => void
  services.send.mockReturnValueOnce(new Promise<void>(resolve => { confirmar = resolve }))
  render(<Harness />)
  let first!: Promise<boolean>
  await act(async () => { first = prepare(); expect(prepare()).toBe(first) })
  expect(services.plan).toHaveBeenCalledTimes(1)
  expect(services.capture).toHaveBeenCalledTimes(1)
  await act(async () => { confirmar(); expect(await first).toBe(true) })
  expect(services.send).toHaveBeenCalledTimes(1)
})
