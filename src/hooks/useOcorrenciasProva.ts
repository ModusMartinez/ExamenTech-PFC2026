import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { CameraStatus } from './useCameraSession'
import { registrarBloqueioClipboard, registrarFalhaCamera } from '../services/tentativas'
import { OPERACOES_CLIPBOARD } from '../services/tentativaValidation'
import type { OperacaoClipboard } from '../services/tentativaValidation'

// Mantém o identificador de cada ocorrência até sua confirmação.
export function useOcorrenciasProva(
  tentativaId: string | null,
  chaveExecucao: string,
  status: CameraStatus,
  active: boolean,
  onExecutionFailure: (cause: unknown) => void,
) {
  const queue = useRef<Array<{ tentativaId: string; solicitacaoId: string; operacao?: OperacaoClipboard }>>([])
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
        setMessage(item.operacao ? 'Registrando bloqueio da área de transferência...' : 'Registrando ocorrência da câmera...')
        try {
          if (item.operacao) await registrarBloqueioClipboard(item.tentativaId, item.solicitacaoId, chaveExecucao, item.operacao)
          else await registrarFalhaCamera(item.tentativaId, item.solicitacaoId, chaveExecucao)
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
          setMessage(item.operacao ? 'Operação bloqueada e registrada.' : 'Ocorrência da câmera registrada.')
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

  const enfileirar = useEffectEvent((operacao?: OperacaoClipboard) => {
    if (!active || !tentativaId) return
    queue.current.push({ tentativaId, solicitacaoId: crypto.randomUUID(), operacao })
    setPending(queue.current.length)
    void retry()
  })
  const observe = useEffectEvent(() => {
    if (!active) return
    if (status === 'ready') { episode.current = false; return }
    if ((status !== 'error' && status !== 'interrupted') || episode.current) return
    episode.current = true
    enfileirar()
  })
  useEffect(() => { observe() }, [tentativaId, status, active])
  useEffect(() => {
    if (!active) return
    function bloquear(event: ClipboardEvent) {
      if (!event.cancelable) return
      const operacao = OPERACOES_CLIPBOARD.find(tipo => tipo === event.type)
      if (!operacao) return
      event.preventDefault()
      enfileirar(operacao)
    }
    for (const operacao of OPERACOES_CLIPBOARD) document.addEventListener(operacao, bloquear, true)
    return () => {
      for (const operacao of OPERACOES_CLIPBOARD) document.removeEventListener(operacao, bloquear, true)
    }
  }, [active])

  return { pending, busy, message, retry }
}
