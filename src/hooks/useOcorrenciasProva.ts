import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { CameraStatus } from './useCameraSession'
import { registrarBloqueioClipboard, registrarFalhaCamera, registrarPausaProva } from '../services/tentativas'
import { OPERACOES_CLIPBOARD } from '../services/tentativaValidation'
import type { MotivoPausaProva, OperacaoClipboard } from '../services/tentativaValidation'

type Ocorrencia =
  | { tipo: 'camera' }
  | { tipo: 'clipboard'; operacao: OperacaoClipboard }
  | { tipo: 'pausa'; motivo: MotivoPausaProva }

const confirmacoes: Record<Ocorrencia['tipo'], string> = {
  camera: 'Ocorrência da câmera registrada.',
  clipboard: 'Operação bloqueada e registrada.',
  pausa: 'Pausa registrada.',
}

// Mantém o identificador de cada ocorrência até sua confirmação.
export function useOcorrenciasProva(
  tentativaId: string | null,
  chaveExecucao: string,
  status: CameraStatus,
  active: boolean,
  onExecutionFailure: (cause: unknown) => void,
) {
  const queue = useRef<Array<Ocorrencia & { tentativaId: string; solicitacaoId: string }>>([])
  const sending = useRef<Promise<boolean> | null>(null)
  const episode = useRef(false)
  const mounted = useRef(true)
  const reportFailure = useRef(onExecutionFailure)
  const [pending, setPending] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { reportFailure.current = onExecutionFailure }, [onExecutionFailure])

  const retry = useCallback((): Promise<boolean> => {
    if (sending.current) return sending.current
    if (!queue.current.length) return Promise.resolve(true)
    setBusy(true)
    const request = (async () => {
      while (mounted.current && queue.current.length) {
        const item = queue.current[0]
        setMessage('Registrando ocorrência...')
        try {
          const { tentativaId, solicitacaoId } = item
          switch (item.tipo) {
            case 'camera':
              await registrarFalhaCamera(tentativaId, solicitacaoId, chaveExecucao)
              break
            case 'clipboard':
              await registrarBloqueioClipboard(tentativaId, solicitacaoId, chaveExecucao, item.operacao)
              break
            case 'pausa':
              await registrarPausaProva(tentativaId, solicitacaoId, chaveExecucao, item.motivo)
              break
          }
        } catch (cause) {
          if (mounted.current) {
            reportFailure.current(cause)
            setMessage(cause instanceof Error ? cause.message : 'Ocorrência sem confirmação. Tente reenviar.')
          }
          return false
        }
        queue.current.shift()
        if (mounted.current) {
          setPending(queue.current.length)
          setMessage(confirmacoes[item.tipo])
        }
      }
      return queue.current.length === 0
    })()
    sending.current = request.finally(() => {
      sending.current = null
      if (mounted.current) setBusy(false)
    })
    return sending.current
  }, [chaveExecucao])

  const enfileirar = useCallback((id: string, ocorrencia: Ocorrencia) => {
    queue.current.push({ ...ocorrencia, tentativaId: id, solicitacaoId: crypto.randomUUID() })
    setPending(queue.current.length)
    void retry()
  }, [retry])

  const registrarPausa = useCallback((id: string, motivo: MotivoPausaProva) => {
    enfileirar(id, { tipo: 'pausa', motivo })
  }, [enfileirar])

  const registrarClipboard = useEffectEvent((operacao: OperacaoClipboard) => {
    if (active && tentativaId) enfileirar(tentativaId, { tipo: 'clipboard', operacao })
  })
  const observe = useEffectEvent(() => {
    if (!active || !tentativaId) return
    if (status === 'ready') { episode.current = false; return }
    if ((status !== 'error' && status !== 'interrupted') || episode.current) return
    episode.current = true
    enfileirar(tentativaId, { tipo: 'camera' })
  })
  useEffect(() => { observe() }, [tentativaId, status, active])
  useEffect(() => {
    if (!active) return
    function bloquear(event: ClipboardEvent) {
      if (!event.cancelable) return
      const operacao = OPERACOES_CLIPBOARD.find(tipo => tipo === event.type)
      if (!operacao) return
      event.preventDefault()
      registrarClipboard(operacao)
    }
    for (const operacao of OPERACOES_CLIPBOARD) document.addEventListener(operacao, bloquear, true)
    return () => {
      for (const operacao of OPERACOES_CLIPBOARD) document.removeEventListener(operacao, bloquear, true)
    }
  }, [active])

  return { pending, busy, message, retry, registrarPausa }
}
