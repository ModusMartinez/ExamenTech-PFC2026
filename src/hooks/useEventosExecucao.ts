import { useEffect, useEffectEvent } from 'react'
import type { MotivoSaidaTentativa } from '../services/tentativaValidation'

export function useEventosExecucao<Motivo extends MotivoSaidaTentativa>(
  onInterrupcao: (motivo: Motivo | 'CONEXAO') => void,
  onReconexao: () => void,
  motivos: { saida: Motivo; foco: Motivo; telaCheia?: Motivo },
) {
  const interromper = useEffectEvent(onInterrupcao)
  const reconectar = useEffectEvent(onReconexao)
  const { saida, foco, telaCheia } = motivos

  useEffect(() => {
    const sair = () => interromper(saida)
    const perderFoco = () => interromper(foco)
    const desconectar = () => interromper('CONEXAO')
    const conectar = () => reconectar()
    function abaOculta() {
      if (document.visibilityState === 'hidden') perderFoco()
    }
    function mudouTelaCheia() {
      if (telaCheia && document.fullscreenElement !== document.documentElement) interromper(telaCheia)
    }
    function paginaRestaurada(event: PageTransitionEvent) {
      if (event.persisted) sair()
    }

    window.addEventListener('blur', perderFoco)
    window.addEventListener('pagehide', sair)
    window.addEventListener('pageshow', paginaRestaurada)
    window.addEventListener('offline', desconectar)
    window.addEventListener('online', conectar)
    document.addEventListener('visibilitychange', abaOculta)
    if (telaCheia) document.addEventListener('fullscreenchange', mudouTelaCheia)
    return () => {
      window.removeEventListener('blur', perderFoco)
      window.removeEventListener('pagehide', sair)
      window.removeEventListener('pageshow', paginaRestaurada)
      window.removeEventListener('offline', desconectar)
      window.removeEventListener('online', conectar)
      document.removeEventListener('visibilitychange', abaOculta)
      if (telaCheia) document.removeEventListener('fullscreenchange', mudouTelaCheia)
    }
  }, [saida, foco, telaCheia])
}
