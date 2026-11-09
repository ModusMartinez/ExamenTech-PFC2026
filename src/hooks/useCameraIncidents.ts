import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { CameraStatus } from './useCameraSession'
import { registrarFalhaCamera } from '../services/tentativas'

// A fila mantém o identificador de cada falha até sua confirmação, sem bloquear respostas.
export function useCameraIncidents(tentativaId: string | null, status: CameraStatus, active: boolean) {
  const queue = useRef<Array<{ tentativaId: string; solicitacaoId: string }>>([])
  const sending = useRef<Promise<boolean> | null>(null)
  const episode = useRef(false)
  const mounted = useRef(true)
  const [pending, setPending] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const retry = useCallback((): Promise<boolean> => {
    if (sending.current) return sending.current
    if (!queue.current.length) return Promise.resolve(true)
    setBusy(true)
    setMessage('Registrando ocorrência da câmera...')
    const request = (async () => {
      while (mounted.current && queue.current.length) {
        const item = queue.current[0]
        try {
          await registrarFalhaCamera(item.tentativaId, item.solicitacaoId)
        } catch (cause) {
          if (mounted.current) setMessage(cause instanceof Error ? cause.message : 'Ocorrência sem confirmação. Tente reenviar.')
          return false
        }
        queue.current.shift()
        if (mounted.current) setPending(queue.current.length)
      }
      if (mounted.current) setMessage('Ocorrência da câmera registrada.')
      return queue.current.length === 0
    })()
    sending.current = request.finally(() => {
      sending.current = null
      if (mounted.current) setBusy(false)
    })
    return sending.current
  }, [])

  const observe = useEffectEvent(() => {
    if (!active || !tentativaId) return
    if (status === 'ready') { episode.current = false; return }
    if ((status !== 'error' && status !== 'interrupted') || episode.current) return
    episode.current = true
    queue.current.push({ tentativaId, solicitacaoId: crypto.randomUUID() })
    setPending(queue.current.length)
    void retry()
  })
  useEffect(() => { observe() }, [tentativaId, status, active])

  return { pending, busy, message, retry }
}
