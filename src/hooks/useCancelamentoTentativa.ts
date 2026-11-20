import { useEffect, useEffectEvent } from 'react'
import { supabase } from '../lib/supabase'

export const AVISO_CANCELAMENTO = 'O professor cancelou esta avaliação. As respostas recebidas pelo sistema ficam salvas.'

export function useCancelamentoTentativa(tentativaId: string | undefined, aoCancelar: () => void) {
  const avisar = useEffectEvent(aoCancelar)

  useEffect(() => {
    if (!tentativaId) return
    const controller = new AbortController()
    let conectado = false
    let inscricao = 0
    let consulta: number | null = null
    let sincronizado = false
    let cancelada = false

    function conferir(registro: { id?: unknown; situacao?: unknown } | null) {
      if (controller.signal.aborted || cancelada || !registro || registro.id !== tentativaId || registro.situacao !== 'CANCELADA') return
      cancelada = true
      avisar()
    }

    async function consultarSituacao() {
      const atual = inscricao
      if (controller.signal.aborted || consulta === atual || cancelada) return
      consulta = atual
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        const { data, error } = await supabase.from('tentativas').select('id,situacao').eq('id', tentativaId)
          .abortSignal(signal).maybeSingle()
        if (atual === inscricao && conectado && !error && data) sincronizado = true
        conferir(data)
      } finally {
        if (consulta === atual) consulta = null
      }
    }

    const canal = supabase.channel(`cancelamento-tentativa:${tentativaId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tentativas', filter: `id=eq.${tentativaId}` },
        evento => conferir(evento.new))
      .subscribe(situacao => {
        inscricao += 1
        conectado = situacao === 'SUBSCRIBED'
        sincronizado = false
        // Postgres Changes não reenvia eventos anteriores à inscrição.
        void consultarSituacao()
      })
    void consultarSituacao()
    const timer = window.setInterval(() => {
      if (!sincronizado) void consultarSituacao()
    }, 5000)

    return () => {
      controller.abort()
      window.clearInterval(timer)
      void supabase.removeChannel(canal)
    }
  }, [tentativaId])
}
