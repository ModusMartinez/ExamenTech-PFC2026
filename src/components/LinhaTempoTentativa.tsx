import { useEffect, useState } from 'react'
import { listarLinhaTempoTentativa } from '../services/examManagement'
import type { AttemptTimelineItem } from '../services/examManagement'

const situacaoLabel: Record<string, string> = {
  EM_ANDAMENTO: 'Em andamento', FINALIZADA: 'Finalizada', INTERROMPIDA: 'Interrompida',
  DISPONIVEL: 'Disponível', PENDENTE: 'Pendente', ENVIANDO: 'Enviando', EXCLUIDA: 'Excluída',
}
const eventoLabel: Record<string, string> = {
  TENTATIVA_INICIADA: 'Tentativa iniciada', TENTATIVA_FINALIZADA: 'Tentativa finalizada',
  TENTATIVA_INTERROMPIDA: 'Tentativa interrompida', TENTATIVA_RETOMADA: 'Tentativa retomada',
  PROVA_PAUSADA: 'Prova pausada',
  CAMERA_FALHA: 'Falha de câmera registrada', CLIPBOARD_BLOQUEADO: 'Ação da área de transferência bloqueada',
  FOTO_RECEBIDA: 'Foto recebida', FOTO_CONSULTADA: 'Foto consultada', FOTO_EXCLUIDA: 'Foto excluída',
  TENTATIVA_DESBLOQUEADA: 'Tentativa desbloqueada', REATIVACAO_AUTORIZADA: 'Retomada autorizada',
}
const motivoPausaLabel: Record<string, string> = {
  perda_aba_ou_foco: 'Troca de aba ou perda de foco',
  saida_tela_cheia: 'Saída da tela cheia',
}

export function LinhaTempoTentativa({ tentativaId }: { tentativaId: string }) {
  const [items, setItems] = useState<AttemptTimelineItem[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let active = true
    listarLinhaTempoTentativa(tentativaId)
      .then(result => { if (active) setItems(result) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível consultar a linha do tempo.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tentativaId, refresh])

  function atualizar() {
    setLoading(true)
    setError('')
    setRefresh(value => value + 1)
  }

  return <section aria-label="Linha do tempo da tentativa" className="provas-linha-tempo">
    <div className="avaliacao-form-actions">
      <h5>Ocorrências e fotos</h5>
      <button type="button" className="turmas-refresh" disabled={loading} onClick={atualizar}>Atualizar linha do tempo</button>
    </div>
    {loading && <p role="status">Carregando linha do tempo...</p>}
    {error && <p className="alert error" role="alert">{error}</p>}
    {!loading && !error && !items.length && <p>Nenhuma ocorrência ou foto registrada nesta tentativa.</p>}
    {!loading && !error && items.length > 0 && <ol>
      {items.map(item => <li key={`${item.tipo}-${item.id}`}>
        <time dateTime={item.ocorrido_em}>{new Date(item.ocorrido_em).toLocaleString('pt-BR')}</time>
        <strong>{item.tipo === 'FOTO' ? `${item.detalhe} · ${situacaoLabel[item.situacao ?? ''] ?? item.situacao}` : eventoLabel[item.titulo] ?? item.titulo.replaceAll('_', ' ')}</strong>
        {item.tipo === 'EVENTO' && <span>{(item.titulo === 'PROVA_PAUSADA' && motivoPausaLabel[item.detalhe]) ||
          item.detalhe.replaceAll('_', ' ')}</span>}
        {item.tipo === 'FOTO' && item.expira_em && <span>Disponível até {new Date(item.expira_em).toLocaleString('pt-BR')}</span>}
      </li>)}
    </ol>}
  </section>
}
