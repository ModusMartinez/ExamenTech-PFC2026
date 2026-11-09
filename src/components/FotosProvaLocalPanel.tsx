import { useCallback, useEffect, useRef, useState } from 'react'
import { useCameraSession } from '../hooks/useCameraSession'
import { capturePhotoFrame, planPhotoMoments } from '../services/photoEvidence'
import type { CapturedPhoto, PhotoMoment } from '../services/photoEvidence'
import '../styles/fotos-prova-local.css'

type Phase = 'idle' | 'initial' | 'running' | 'finished' | 'interrupted'
type LocalPhoto = Omit<CapturedPhoto, 'blob'> & { previewUrl: string; bytes: number }
const DEMO_DURATION_MS = 30000

const labels: Record<PhotoMoment, string> = {
  INICIAL: 'Foto inicial',
  PROVA_1: 'Foto durante a prova 1',
  PROVA_2: 'Foto durante a prova 2',
  PROVA_3: 'Foto durante a prova 3',
}

export function FotosProvaLocalPanel() {
  const { videoRef, status, message, start, stop, reportNoImage } = useCameraSession()
  const [phase, setPhase] = useState<Phase>('idle')
  const [photos, setPhotos] = useState<LocalPhoto[]>([])
  const [feedback, setFeedback] = useState('')
  const [toast, setToast] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [remaining, setRemaining] = useState(DEMO_DURATION_MS / 1000)
  const sessionRef = useRef(0)
  const timersRef = useRef<number[]>([])
  const urlsRef = useRef<string[]>([])
  const capturedRef = useRef(0)
  const capturePendingRef = useRef<number | null>(null)
  const nextCaptureRef = useRef(0)
  const deadlineRef = useRef(0)

  useEffect(() => () => {
    sessionRef.current += 1
    for (const timer of timersRef.current) window.clearTimeout(timer)
    for (const url of urlsRef.current) URL.revokeObjectURL(url)
  }, [])

  const cancelTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
    timersRef.current = []
  }, [])

  const endSession = useCallback((next: Phase, text: string) => {
    sessionRef.current += 1
    cancelTimers()
    stop()
    setPhase(next)
    setFeedback(text)
    setToast('')
  }, [cancelTimers, stop])

  function reset() {
    endSession('idle', '')
    for (const url of urlsRef.current) URL.revokeObjectURL(url)
    urlsRef.current = []
    capturedRef.current = 0
    capturePendingRef.current = null
    setCapturing(false)
    setPhotos([])
    setRemaining(DEMO_DURATION_MS / 1000)
  }

  async function takePhoto(moment: PhotoMoment, session: number) {
    if (capturePendingRef.current !== null) throw new Error('A captura anterior ainda está em andamento.')
    const operation = ++nextCaptureRef.current
    capturePendingRef.current = operation
    setCapturing(true)
    try {
      const video = videoRef.current
      if (!video) throw new Error('A prévia da câmera não está disponível.')
      const photo = await capturePhotoFrame(video, moment)
      if (session !== sessionRef.current) return
      const previewUrl = URL.createObjectURL(photo.blob)
      urlsRef.current.push(previewUrl)
      capturedRef.current += 1
      setPhotos((current) => [...current, {
        moment: photo.moment, capturedAt: photo.capturedAt,
        width: photo.width, height: photo.height,
        bytes: photo.blob.size, previewUrl,
      }])
      setToast(`${labels[moment]} capturada localmente. Nada foi enviado.`)
      const timer = window.setTimeout(() => setToast(''), 3500)
      timersRef.current.push(timer)
    } finally {
      if (capturePendingRef.current === operation) {
        capturePendingRef.current = null
        if (session === sessionRef.current) setCapturing(false)
      }
    }
  }

  async function takeInitialPhoto() {
    if (phase !== 'idle' || status !== 'ready' || capturePendingRef.current !== null) return
    setFeedback('')
    const session = sessionRef.current
    try {
      await takePhoto('INICIAL', session)
      if (session === sessionRef.current) setPhase('initial')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Não foi possível capturar a foto inicial.')
    }
  }

  function startExamDemo() {
    if (phase !== 'initial' || status !== 'ready' || capturePendingRef.current !== null) return
    setFeedback('')
    const session = sessionRef.current
    let offsets: number[]
    try {
      offsets = planPhotoMoments(DEMO_DURATION_MS)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Não foi possível sortear as fotos.')
      return
    }
    deadlineRef.current = Date.now() + DEMO_DURATION_MS
    setPhase('running')
    offsets.forEach((offset, index) => {
      const timer = window.setTimeout(() => {
        if (session !== sessionRef.current) return
        const moment = `PROVA_${index + 1}` as PhotoMoment
        void takePhoto(moment, session).catch((error: unknown) => {
          if (session === sessionRef.current) endSession('interrupted',
            error instanceof Error ? error.message : 'A captura falhou; a simulação foi encerrada.')
        })
      }, offset)
      timersRef.current.push(timer)
    })
    const clock = window.setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)))
    }, 250)
    timersRef.current.push(clock)
    const finish = window.setTimeout(() => {
      if (session !== sessionRef.current) return
      endSession(capturedRef.current === 4 ? 'finished' : 'interrupted',
        capturedRef.current === 4
          ? 'Simulação concluída: uma foto inicial e três durante a prova. Nada foi enviado.'
          : 'Uma das fotos não foi capturada. A simulação foi encerrada.')
    }, DEMO_DURATION_MS)
    timersRef.current.push(finish)
  }

  useEffect(() => {
    if ((phase !== 'initial' && phase !== 'running') || status === 'ready') return
    const timer = window.setTimeout(() => {
      endSession('interrupted', 'A câmera ficou indisponível. A simulação foi interrompida e nenhuma outra foto será tirada.')
    }, status === 'interrupted' ? 3000 : 0)
    return () => window.clearTimeout(timer)
  }, [phase, status, endSession])

  return <section className="fotos-local" aria-labelledby="fotos-local-titulo">
    <h1 id="fotos-local-titulo">Simulação local das fotos da prova</h1>
    <p>Teste técnico separado da prova real. Esta página não envia nem salva fotos no aplicativo. As prévias locais são liberadas ao limpar ou sair.</p>
    <p>Use somente sua própria câmera ou uma imagem fictícia autorizada para o teste.</p>

    <div className="fotos-local-preview">
      <video ref={videoRef} autoPlay muted playsInline aria-label="Prévia da câmera" />
    </div>
    <p role="status">{message}</p>
    {feedback && <p className={phase === 'finished' ? 'alert success' : 'alert error'} role="alert">{feedback}</p>}

    <div className="fotos-local-actions">
      {phase === 'idle' && <>
        <button type="button" className="btn-outline" disabled={status === 'requesting'} onClick={() => void start()}>Ligar câmera</button>
        <button type="button" className="btn-primary" disabled={status !== 'ready' || capturing} onClick={() => void takeInitialPhoto()}>{capturing ? 'Capturando...' : 'Tirar foto inicial'}</button>
      </>}
      {phase === 'initial' && <button type="button" className="btn-primary" disabled={status !== 'ready' || capturing} onClick={startExamDemo}>Iniciar simulação de 30 segundos</button>}
      {(phase === 'initial' || phase === 'running') && <button type="button" className="btn-outline" onClick={() => {
        reportNoImage()
        endSession('interrupted', 'A imagem ficou preta. A simulação foi interrompida.')
      }}>Minha imagem ficou preta</button>}
      {phase !== 'idle' && <button type="button" className="btn-outline" onClick={reset}>Limpar fotos e recomeçar</button>}
    </div>

    {phase === 'running' && <p className="fotos-local-clock" role="status">Tempo da simulação: {remaining}s</p>}
    <p className="fotos-local-count" role="status">Fotos nesta página: {photos.length}/4</p>
    {photos.length > 0 && <ul className="fotos-local-gallery">
      {photos.map((photo) => <li key={photo.moment}>
        <img src={photo.previewUrl} alt={`Prévia local: ${labels[photo.moment]}`} />
        <strong>{labels[photo.moment]}</strong>
        <small>{new Date(photo.capturedAt).toLocaleTimeString('pt-BR')} · {photo.width} × {photo.height} · {Math.ceil(photo.bytes / 1024)} KiB</small>
      </li>)}
    </ul>}
    {toast && <div className="fotos-local-toast" role="status">{toast}</div>}
  </section>
}
