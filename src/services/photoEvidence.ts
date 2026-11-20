export type PhotoMoment = 'INICIAL' | 'PROVA_1' | 'PROVA_2' | 'PROVA_3'

export type CapturedPhoto = {
  moment: PhotoMoment
  blob: Blob
  capturedAt: string
  width: number
  height: number
}

export const PHOTO_MAX_BYTES = 1024 * 1024
const MAX_WIDTH = 960
const MAX_HEIGHT = 720
const JPEG_QUALITIES = [0.78, 0.6, 0.45]

function secureRandom(): number {
  const value = new Uint32Array(1)
  globalThis.crypto.getRandomValues(value)
  return value[0] / 0x100000000
}

// Uma captura em cada parte da prova. Os horários reais deverão ser guardados no servidor.
export function planPhotoMoments(durationMs: number, random: () => number = secureRandom): number[] {
  if (!Number.isSafeInteger(durationMs) || durationMs < 15000) {
    throw new Error('A duração da simulação deve ser de pelo menos 15 segundos.')
  }
  const windows = [[0.10, 0.26], [0.38, 0.56], [0.68, 0.86]] as const
  return windows.map(([start, end]) => {
    const value = random()
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error('Não foi possível sortear os momentos das fotos.')
    }
    return Math.round(durationMs * (start + (end - start) * value))
  })
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('A câmera não conseguiu gerar a foto.'))
    }, 'image/jpeg', quality)
  })
}

export async function capturePhotoFrame(video: HTMLVideoElement, moment: PhotoMoment): Promise<CapturedPhoto> {
  const stream = video.srcObject as MediaStream | null
  const track = stream?.getVideoTracks?.()[0]
  if (!track || track.readyState !== 'live' || track.muted || video.readyState < 2 ||
      !video.videoWidth || !video.videoHeight) {
    throw new Error('A imagem da câmera não está pronta. Confira a prévia e tente novamente.')
  }

  const scale = Math.min(1, MAX_WIDTH / video.videoWidth, MAX_HEIGHT / video.videoHeight)
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Este navegador não conseguiu preparar a captura da câmera.')

  const capturedAt = new Date().toISOString()
  try {
    context.drawImage(video, 0, 0, width, height)
    for (const quality of JPEG_QUALITIES) {
      const blob = await encodeJpeg(canvas, quality)
      if (blob.type !== 'image/jpeg') throw new Error('Este navegador não gerou uma foto JPEG.')
      if (blob.size === 0) throw new Error('A câmera gerou uma foto vazia.')
      if (blob.size <= PHOTO_MAX_BYTES) {
        return { moment, blob, capturedAt, width, height }
      }
    }
    throw new Error('A foto excedeu 1 MiB. Reduza a resolução da câmera e tente novamente.')
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
