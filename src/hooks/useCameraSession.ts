import { useCallback, useEffect, useRef, useState } from 'react'

export type CameraStatus = 'idle' | 'requesting' | 'ready' | 'interrupted' | 'error'

function cameraErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
    ? error.name
    : ''

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'O acesso à câmera foi negado. Permita o uso da câmera nas configurações do navegador e tente novamente.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Nenhuma câmera foi encontrada. Conecte uma câmera e tente novamente.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'A câmera está indisponível ou em uso por outro aplicativo. Feche o outro aplicativo e tente novamente.'
  }

  return 'Não foi possível mostrar a imagem da câmera. Verifique a câmera e tente novamente.'
}

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.onended = null
    track.onmute = null
    track.onunmute = null
    track.stop()
  }
}

// Mantém a mesma câmera entre as etapas de uma futura tentativa de prova.
// `ready` indica conexão, não comprovação de identidade nem qualidade da imagem.
export function useCameraSession() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const requestRef = useRef(0)
  const healthTimerRef = useRef<number | null>(null)
  const interruptedRef = useRef(false)
  const [status, setStatus] = useState<CameraStatus>('idle')
  const [message, setMessage] = useState('A câmera está desligada.')

  const releaseCamera = useCallback(() => {
    if (healthTimerRef.current !== null) {
      window.clearInterval(healthTimerRef.current)
      healthTimerRef.current = null
    }
    interruptedRef.current = false
    if (streamRef.current) {
      stopTracks(streamRef.current)
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  useEffect(() => () => {
    requestRef.current += 1
    releaseCamera()
  }, [releaseCamera])

  const stop = useCallback(() => {
    requestRef.current += 1
    releaseCamera()
    setStatus('idle')
    setMessage('A câmera está desligada.')
  }, [releaseCamera])

  const reportNoImage = useCallback(() => {
    requestRef.current += 1
    releaseCamera()
    setStatus('error')
    setMessage('A prévia foi desligada porque você não vê sua imagem. Verifique o acesso à câmera no dispositivo antes de testar novamente.')
  }, [releaseCamera])

  const start = useCallback(async () => {
    releaseCamera()
    const request = ++requestRef.current
    setStatus('requesting')
    setMessage('Aguardando a permissão do navegador...')

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setMessage('Este navegador ou endereço não permite usar a câmera. Abra o site em HTTPS ou localhost e tente novamente.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      })
      if (request !== requestRef.current) {
        stopTracks(stream)
        return
      }

      const video = videoRef.current
      const track = stream.getVideoTracks()[0]
      if (!video || !track) {
        stopTracks(stream)
        throw new Error('Prévia indisponível')
      }

      streamRef.current = stream
      const reportEnded = () => {
        if (request !== requestRef.current) return
        requestRef.current += 1
        releaseCamera()
        setStatus('error')
        setMessage('A câmera foi desconectada ou a permissão foi retirada. Verifique a conexão e as permissões antes de testar novamente.')
      }
      const reportMuted = () => {
        if (request !== requestRef.current || interruptedRef.current) return
        interruptedRef.current = true
        setStatus('interrupted')
        setMessage('O navegador informou que a câmera está temporariamente sem sinal. Verifique a câmera e as permissões do sistema.')
      }
      const reportUnmuted = () => {
        if (request !== requestRef.current || !interruptedRef.current) return
        interruptedRef.current = false
        setStatus('ready')
        setMessage('O sinal da câmera voltou. Confira se sua imagem aparece na prévia.')
      }
      track.onended = reportEnded
      track.onmute = reportMuted
      track.onunmute = reportUnmuted
      healthTimerRef.current = window.setInterval(() => {
        if (track.readyState === 'ended') reportEnded()
        else if (track.muted) reportMuted()
        else reportUnmuted()
      }, 1000)
      video.srcObject = stream
      await video.play()
      if (request !== requestRef.current) return

      if (track.readyState === 'ended') reportEnded()
      else if (track.muted) reportMuted()
      else {
        setStatus('ready')
        setMessage('Câmera conectada. Confirme se sua imagem aparece na prévia.')
      }
    } catch (error) {
      if (request !== requestRef.current) return
      releaseCamera()
      setStatus('error')
      setMessage(cameraErrorMessage(error))
    }
  }, [releaseCamera])

  return { videoRef, status, message, start, stop, reportNoImage }
}
