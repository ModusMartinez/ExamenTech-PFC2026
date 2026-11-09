import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listarTentativasResponsavel, reativarTentativa } from '../services/examManagement'
import type { ResponsibleAttempt } from '../services/examManagement'
import { consultarImagemFoto, listarFotosResponsavel } from '../services/examPhotos'
import type { ResponsiblePhoto } from '../services/examPhotos'
import { photosEnabled } from '../services/examFeatures'
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

export function TentativasResponsavelPanel({ avaliacaoId, duracao }: { avaliacaoId: string; duracao: number }) {
  const [attempts, setAttempts] = useState<ResponsibleAttempt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [photos, setPhotos] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [minutes, setMinutes] = useState(String(Math.min(duracao, 30)))
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true); setError(''); setLoadError('')
      return listarTentativasResponsavel(avaliacaoId)
    }
    load().then(result => { if (active) setAttempts(result) })
      .catch(cause => { if (active) setLoadError(cause instanceof Error ? cause.message : 'Não foi possível carregar as tentativas.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [avaliacaoId, refresh])
  async function authorize(event: FormEvent) {
    event.preventDefault()
    if (!selected || submitting.current) return
    submitting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const count = Number(minutes)
      if (count > duracao) throw new Error('O tempo autorizado não pode superar a duração original da avaliação.')
      await reativarTentativa(selected, reason, count)
      setSelected(null); setReason('')
      setNotice('Reativação autorizada. O aluno deve preparar a câmera e confirmar o início novamente, dentro da janela da avaliação. As respostas salvas serão recuperadas.')
      setRefresh(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar a reativação.') }
    finally { submitting.current = false; setBusy(false) }
  }
  return <section className="provas-gestao" aria-label="Tentativas e reativação">
    <h4>Tentativas dos alunos</h4>
    <p>Somente o professor responsável ou o ADM da mesma organização pode autorizar uma retomada. Respostas, ordem das questões e histórico são preservados. Uma prova já enviada ou finalizada por prazo não é reaberta aqui.</p>
    <button type="button" className="turmas-refresh" disabled={loading || busy} onClick={() => { setPhotos(null); setRefresh(value => value + 1) }}>Atualizar tentativas</button>
    {loading && <p role="status">Carregando tentativas...</p>}
    {error && <p className="alert error" role="alert">{error}</p>}
    {loadError && <p className="alert error" role="alert">{loadError}</p>}
    {notice && <p className="alert success" role="status">{notice}</p>}
    {!loading && !attempts.length && !loadError && <p>Nenhum aluno iniciou esta avaliação.</p>}
    {!loading && !loadError && <ul className="provas-tentativas-lista">{attempts.map(attempt => <li key={attempt.id}>
      <h5>{attempt.aluno_nome}</h5>
      <p>{attempt.situacao === 'INTERROMPIDA' ? 'Interrompida' : attempt.situacao === 'FINALIZADA' ? 'Finalizada' : 'Em andamento'} · ciclo {attempt.ciclo}
        {attempt.retomada_autorizada && ' · Reativação autorizada, aguardando o aluno.'}</p>
      <div className="provas-actions">
        {attempt.situacao === 'INTERROMPIDA' && !attempt.retomada_autorizada && <button type="button" className="turmas-refresh" disabled={busy}
          onClick={() => { setSelected(attempt.id); setReason(''); setError('') }}>Reativar tentativa de {attempt.aluno_nome}</button>}
        {photosEnabled() && <button type="button" className="turmas-refresh" aria-expanded={photos === attempt.id}
          onClick={() => setPhotos(value => value === attempt.id ? null : attempt.id)}>{photos === attempt.id ? 'Fechar fotos' : `Fotos de ${attempt.aluno_nome}`}</button>}
      </div>
      {selected === attempt.id && <form className="turma-form" onSubmit={event => void authorize(event)} aria-label={`Reativar tentativa de ${attempt.aluno_nome}`}>
        <label>Justificativa da reativação<textarea required minLength={5} maxLength={500} value={reason} disabled={busy}
          onChange={event => setReason(event.target.value)} /></label>
        <label>Minutos para continuar<input type="number" required min={1} max={Math.min(duracao, 1440)} value={minutes} disabled={busy}
          onChange={event => setMinutes(event.target.value)} /></label>
        <p>A contagem começa quando o aluno confirmar a retomada e termina, no máximo, no fim da janela da avaliação. A autorização é registrada com sua conta.</p>
        <div className="provas-actions">
          <button type="submit" className="turmas-refresh" disabled={busy}>{busy ? 'Autorizando...' : 'Confirmar reativação'}</button>
          <button type="button" className="turmas-refresh" disabled={busy} onClick={() => setSelected(null)}>Cancelar reativação</button>
        </div>
      </form>}
      {photos === attempt.id && <FotosResponsavel key={attempt.id} tentativaId={attempt.id} />}
    </li>)}</ul>}
  </section>
}
