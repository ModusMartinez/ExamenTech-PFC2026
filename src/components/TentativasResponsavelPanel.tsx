import { useCallback, useEffect, useRef, useState } from 'react'
import { listarTentativasResponsavel } from '../services/examManagement'
import type { ResponsibleAttempt } from '../services/examManagement'
import { consultarImagemFoto, listarFotosResponsavel } from '../services/examPhotos'
import type { ResponsiblePhoto } from '../services/examPhotos'
import { photosEnabled } from '../services/examFeatures'
import { CorrecaoTentativaPanel } from './CorrecaoTentativaPanel'
import { PublicacaoResultadosPanel } from './PublicacaoResultadosPanel'
import '../styles/provas.css'

const momentLabels = { INICIAL: 'Foto inicial', PROVA_1: 'Foto durante a prova 1', PROVA_2: 'Foto durante a prova 2', PROVA_3: 'Foto durante a prova 3' }

function FotoRestrita({ photo }: { photo: ResponsiblePhoto }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expired, setExpired] = useState(() => photo.expira_em !== null && Date.parse(photo.expira_em) <= Date.now())
  const abort = useRef<AbortController | null>(null)
  const imageUrl = useRef('')
  useEffect(() => {
    let timer: number | undefined
    function expire() {
      if (!photo.expira_em) return
      const delay = Date.parse(photo.expira_em) - Date.now()
      if (delay > 0) { timer = window.setTimeout(expire, Math.min(delay, 86400000)); return }
      abort.current?.abort()
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
      imageUrl.current = ''
      setUrl('')
      setExpired(true)
    }
    expire()
    return () => {
      window.clearTimeout(timer)
      abort.current?.abort()
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
    }
  }, [photo.expira_em])
  async function view() {
    if (busy || expired) return
    setBusy(true); setError('')
    abort.current = new AbortController()
    const signal = abort.current.signal
    try {
      const blob = await consultarImagemFoto(photo.id, signal)
      if (signal.aborted) return
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current)
      imageUrl.current = URL.createObjectURL(blob)
      setUrl(imageUrl.current)
    } catch { if (!signal.aborted) setError('Foto indisponível ou sem acesso.') }
    finally { if (!signal.aborted) setBusy(false) }
  }
  return <li className="provas-foto-responsavel">
    <h5>{momentLabels[photo.momento]} · ciclo {photo.ciclo}</h5>
    <p>{expired || photo.situacao === 'EXCLUIDA' ? 'Excluída ou prazo de acesso encerrado.'
      : photo.situacao === 'DISPONIVEL' ? 'Recebida pelo sistema.' : 'Sem confirmação de recebimento.'}</p>
    {photo.recebida_em && <p>Recebimento: {new Date(photo.recebida_em).toLocaleString('pt-BR')}</p>}
    {!expired && photo.situacao === 'DISPONIVEL' && !url && <button type="button" className="turmas-refresh" disabled={busy} onClick={() => void view()}>
      {busy ? 'Consultando...' : `Visualizar ${momentLabels[photo.momento].toLowerCase()}`}
    </button>}
    {url && <img src={url} alt={`${momentLabels[photo.momento]}, ciclo ${photo.ciclo}, para análise manual do responsável`} />}
    {error && <p role="alert">{error}</p>}
  </li>
}

function FotosResponsavel({ tentativaId }: { tentativaId: string }) {
  const [photos, setPhotos] = useState<ResponsiblePhoto[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    listarFotosResponsavel(tentativaId).then(result => { if (active) setPhotos(result) })
      .catch(() => { if (active) setError('Não foi possível consultar as fotos para seu acesso.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tentativaId])
  return <section aria-label="Fotos da tentativa">
    <p>Uso restrito à análise manual desta tentativa. As imagens não comprovam identidade nem fraude automaticamente. Evite cópias fora do sistema.</p>
    {loading && <p role="status">Carregando registros das fotos...</p>}
    {error && <p className="alert error" role="alert">{error}</p>}
    {!loading && !error && !photos.length && <p>Não há fotos registradas nesta tentativa.</p>}
    <ul className="provas-fotos-grid">{photos.map(photo => <FotoRestrita key={photo.id} photo={photo} />)}</ul>
  </section>
}

const situacoesTentativa: Record<ResponsibleAttempt['situacao'], string> = {
  EM_ANDAMENTO: 'Em andamento',
  FINALIZADA: 'Finalizada',
  INTERROMPIDA: 'Interrompida',
  CANCELADA: 'Cancelada',
}

export function TentativasResponsavelPanel({ avaliacaoId, podeCorrigir = false, avaliacaoCancelada = false }: {
  avaliacaoId: string; podeCorrigir?: boolean; avaliacaoCancelada?: boolean
}) {
  const [attempts, setAttempts] = useState<ResponsibleAttempt[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selecao, setSelecao] = useState<{ id: string; painel: 'fotos' | 'correcao' } | null>(null)
  const [resultadosPublicados, setResultadosPublicados] = useState(false)
  const [revisaoCorrecao, setRevisaoCorrecao] = useState(0)
  const marcarPublicados = useCallback(() => setResultadosPublicados(true), [])

  function alternarPainel(id: string, painel: 'fotos' | 'correcao') {
    setSelecao(atual => atual?.id === id && atual.painel === painel ? null : { id, painel })
  }
  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true); setLoadError('')
      return listarTentativasResponsavel(avaliacaoId)
    }
    load().then(result => { if (active) setAttempts(result) })
      .catch(cause => { if (active) setLoadError(cause instanceof Error ? cause.message : 'Não foi possível carregar as tentativas.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [avaliacaoId, refresh])
  return <section className="provas-gestao" aria-label="Tentativas dos alunos">
    <h4>Tentativas dos alunos</h4>
    <p>Tentativas encerradas ou interrompidas ficam no histórico da avaliação com as respostas recebidas.</p>
    {podeCorrigir && !avaliacaoCancelada && <PublicacaoResultadosPanel avaliacaoId={avaliacaoId} revisao={revisaoCorrecao + refresh}
      onPublicada={marcarPublicados} />}
    <button type="button" className="turmas-refresh" disabled={loading} onClick={() => { setSelecao(null); setRefresh(value => value + 1) }}>Atualizar tentativas</button>
    {loading && <p role="status">Carregando tentativas...</p>}
    {loadError && <p className="alert error" role="alert">{loadError}</p>}
    {!loading && !attempts.length && !loadError && <p>Nenhum aluno iniciou esta avaliação.</p>}
    {!loading && !loadError && <ul className="provas-tentativas-lista">{attempts.map(attempt => {
      const painel = selecao?.id === attempt.id ? selecao.painel : null
      return <li key={attempt.id}>
        <h5>{attempt.aluno_nome}</h5>
        <p>{situacoesTentativa[attempt.situacao]} · ciclo {attempt.ciclo}</p>
        <div className="avaliacao-form-actions">
          {photosEnabled() && <button type="button" className="turmas-refresh" aria-expanded={painel === 'fotos'}
            onClick={() => alternarPainel(attempt.id, 'fotos')}>{painel === 'fotos' ? 'Fechar fotos' : `Fotos de ${attempt.aluno_nome}`}</button>}
          {podeCorrigir && attempt.situacao === 'FINALIZADA' && <button type="button" className="turmas-refresh" aria-expanded={painel === 'correcao'}
            onClick={() => alternarPainel(attempt.id, 'correcao')}>{painel === 'correcao' ? 'Fechar correção'
              : `${resultadosPublicados ? 'Ver correção de' : 'Corrigir tentativa de'} ${attempt.aluno_nome}`}</button>}
        </div>
        {painel === 'fotos' && <FotosResponsavel tentativaId={attempt.id} />}
        {painel === 'correcao' && podeCorrigir && <CorrecaoTentativaPanel tentativaId={attempt.id} alunoNome={attempt.aluno_nome}
          somenteConsulta={resultadosPublicados} onCorrecaoSalva={() => setRevisaoCorrecao(valor => valor + 1)} />}
      </li>
    })}</ul>}
  </section>
}
