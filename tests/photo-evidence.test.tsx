import { afterEach, expect, test, vi } from 'vitest'
import { capturePhotoFrame, PHOTO_MAX_BYTES, planPhotoMoments } from '../src/services/photoEvidence'

afterEach(() => vi.restoreAllMocks())

test('as três fotos caem em janelas distintas da prova', () => {
  const values = [0, 0.5, 0.99]
  const offsets = planPhotoMoments(60000, () => values.shift()!)
  expect(offsets).toHaveLength(3)
  expect(offsets[0]).toBeGreaterThanOrEqual(6000)
  expect(offsets[0]).toBeLessThanOrEqual(15600)
  expect(offsets[1]).toBeGreaterThanOrEqual(22800)
  expect(offsets[1]).toBeLessThanOrEqual(33600)
  expect(offsets[2]).toBeGreaterThanOrEqual(40800)
  expect(offsets[2]).toBeLessThanOrEqual(51600)
  expect(offsets[0]).toBeLessThan(offsets[1])
  expect(offsets[1]).toBeLessThan(offsets[2])
})

test('não captura foto sem imagem e faixa de vídeo ativas', async () => {
  const track = { readyState: 'live', muted: true }
  const video = {
    srcObject: { getVideoTracks: () => [track] },
    readyState: 4, videoWidth: 1280, videoHeight: 720,
  } as unknown as HTMLVideoElement
  await expect(capturePhotoFrame(video, 'INICIAL')).rejects.toThrow('não está pronta')
  track.muted = false
  track.readyState = 'ended'
  await expect(capturePhotoFrame(video, 'INICIAL')).rejects.toThrow('não está pronta')
})

test('gera JPEG limitado a 1 MiB e reduz a resolução antes da captura', async () => {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['imagem de teste'], { type: 'image/jpeg' }))
  })
  const video = {
    srcObject: { getVideoTracks: () => [{ readyState: 'live', muted: false }] },
    readyState: 4, videoWidth: 1920, videoHeight: 1080,
  } as unknown as HTMLVideoElement

  const photo = await capturePhotoFrame(video, 'PROVA_2')
  expect(photo.moment).toBe('PROVA_2')
  expect(photo.width).toBe(960)
  expect(photo.height).toBe(540)
  expect(photo.blob.type).toBe('image/jpeg')
  expect(photo.blob.size).toBeLessThanOrEqual(PHOTO_MAX_BYTES)
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 960, 540)
  expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.78)
})

test('recusa foto que continua acima do limite após reduzir a qualidade', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob([new Uint8Array(PHOTO_MAX_BYTES + 1)], { type: 'image/jpeg' }))
  })
  const video = {
    srcObject: { getVideoTracks: () => [{ readyState: 'live', muted: false }] },
    readyState: 4, videoWidth: 640, videoHeight: 480,
  } as unknown as HTMLVideoElement

  await expect(capturePhotoFrame(video, 'PROVA_1')).rejects.toThrow('excedeu 1 MiB')
  expect(encode).toHaveBeenCalledTimes(3)
})
