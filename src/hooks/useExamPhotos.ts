import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { capturePhotoFrame } from '../services/photoEvidence'
import { consultarPlanoFotos, enviarFoto } from '../services/examPhotos'
import type { PhotoPlan, PhotoSlot } from '../services/examPhotos'

type Pending = { slot: PhotoSlot; blob: Blob | null; uploadId: string; sending?: Promise<boolean> }
type Session = { active: boolean; plan: PhotoPlan; offset: number; captured: Set<string>; pending: Map<string, Pending>;
  timers: number[]; abort: AbortController }

export function useExamPhotos(video: RefObject<HTMLVideoElement | null>, onCaptureFailure: () => void) {
  const session = useRef<Session | null>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const callback = useRef(onCaptureFailure)
  const [pending, setPending] = useState(0)
  const [initialReady, setInitialReady] = useState(false)
  const [message, setMessage] = useState('')
  const [toast, setToast] = useState('')
  useEffect(() => { callback.current = onCaptureFailure }, [onCaptureFailure])

  const dispose = useCallback(() => {
    generation.current++
    const current = session.current
    if (!current) return
    current.active = false
    current.abort.abort()
    for (const timer of current.timers) window.clearTimeout(timer)
    for (const item of current.pending.values()) item.blob = null
    current.pending.clear()
    session.current = null
  }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; dispose() } }, [dispose])

  async function send(current: Session, item: Pending): Promise<boolean> {
    if (item.sending) return item.sending
    item.sending = (async () => {
      for (let attempt = 0; attempt < 3 && current.active; attempt++) {
        try {
          if (!item.blob) return false
          // Cada requisição tem tempo limitado. O mesmo arquivo e uploadId são
          // reutilizados: perder a resposta não cria uma segunda fotografia.
          const signal = AbortSignal.any([current.abort.signal, AbortSignal.timeout(12000)])
          await enviarFoto(item.slot.id, item.uploadId, item.blob, signal)
          if (!current.active) return false
          item.blob = null
          current.pending.delete(item.slot.id)
          setPending(current.pending.size)
          if (item.slot.momento === 'INICIAL') setInitialReady(true)
          if (current.pending.size === 0) setMessage('')
          return true
        } catch {
          if (!current.active) return false
          if (attempt < 2) await new Promise<void>(resolve => {
            const timer = window.setTimeout(done, (attempt + 1) * 1000)
            function done() { window.clearTimeout(timer); current.abort.signal.removeEventListener('abort', done); resolve() }
            current.abort.signal.addEventListener('abort', done, { once: true })
          })
        }
      }
      if (current.active) setMessage('Há fotos sem confirmação de envio. Confira sua conexão e use Reenviar fotos. Isso não é uma falha de câmera.')
      return false
    })()
    const result = await item.sending
    item.sending = undefined
    return result
  }

  async function capture(current: Session, slot: PhotoSlot): Promise<boolean> {
    if (!current.active || current.captured.has(slot.id)) return !current.pending.has(slot.id)
    current.captured.add(slot.id)
    try {
      if (!video.current) throw new Error('NO_VIDEO')
      const photo = await capturePhotoFrame(video.current, slot.momento)
      if (!current.active) return false
      const item = { slot, blob: photo.blob, uploadId: crypto.randomUUID() }
      current.pending.set(slot.id, item)
      setPending(current.pending.size)
      setToast(slot.momento === 'INICIAL' ? 'Foto inicial capturada.' : 'Foto capturada durante a prova.')
      current.timers.push(window.setTimeout(() => { if (current.active) setToast('') }, 5000))
      return await send(current, item)
    } catch {
      if (current.active) {
        setMessage('Não foi possível obter uma imagem da câmera.')
        callback.current()
      }
      return false
    }
  }

  async function initialize(tentativaId: string) {
    dispose()
    const currentGeneration = generation.current
    setInitialReady(false)
    setPending(0)
    setToast('')
    setMessage('Preparando a foto inicial...')
    const plan = await consultarPlanoFotos(tentativaId)
    if (!mounted.current || generation.current !== currentGeneration) return false
    const current: Session = { active: true, plan, offset: Date.parse(plan.servidor_em) - Date.now(),
      captured: new Set(), pending: new Map(), timers: [], abort: new AbortController() }
    session.current = current
    for (const slot of plan.capturas.slice(1)) {
      current.timers.push(window.setTimeout(() => { void capture(current, slot) },
        Math.max(0, Date.parse(slot.agendada_em) - (Date.now() + current.offset))))
    }
    return capture(current, plan.capturas[0])
  }

  async function retry() {
    const current = session.current
    if (!current?.active) return false
    const results = await Promise.all([...current.pending.values()].map(item => send(current, item)))
    return results.every(Boolean)
  }

  async function flush() {
    const current = session.current
    if (!current?.active) return true
    // A prova pode terminar antes dos horários sorteados; não aguarda fotos futuras.
    return Promise.race([retry(), new Promise<boolean>(resolve => {
      const timer = window.setTimeout(() => { current.abort.signal.removeEventListener('abort', done); resolve(false) }, 8000)
      function done() { window.clearTimeout(timer); resolve(false) }
      current.abort.signal.addEventListener('abort', done, { once: true })
    })])
  }
  return { initialize, retry, flush, dispose, pending, initialReady, message, toast }
}
