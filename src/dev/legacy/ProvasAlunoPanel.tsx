import { useCallback, useEffect, useRef, useState } from 'react'
// Protótipo anterior, sem ligação com a navegação atual de provas.
import { useCameraSession } from '../../hooks/useCameraSession'
import { ProvaCameraDemo } from '../../components/ProvaCameraDemo'
import { EXAM_NOTICE_SUMMARY, EXAM_NOTICE_VERSION } from '../../content/legalDocuments'
import {
  finalizarTentativa, iniciarTentativa, interromperTentativa,
  listarProvasAluno, reportarFalhaCamera, salvarResposta,
} from './provas'
import type { ProvaAluno, QuestaoProva, TentativaProva } from './provas'
import '../../styles/provas.css'

type Props = {
  onLeave: (message: string) => void
  onActiveChange: (active: boolean) => void
}

function formatarTempo(segundos: number) {
  const horas = Math.floor(segundos / 3600)
  const minutos = Math.floor((segundos % 3600) / 60)
  const resto = segundos % 60
  return `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:${String(resto).padStart(2, '0')}`
}

export function ProvasAlunoPanel({ onLeave, onActiveChange }: Props) {
  const { videoRef, status: cameraStatus, message: cameraMessage, start, stop, reportNoImage } = useCameraSession()
  const [provas, setProvas] = useState<ProvaAluno[]>([])
  const [selected, setSelected] = useState<ProvaAluno | null>(null)
  const [tentativa, setTentativa] = useState<TentativaProva | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [deadline, setDeadline] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [savingQuestion, setSavingQuestion] = useState<string | null>(null)
  const [interruptionPending, setInterruptionPending] = useState(false)
  const [pauseError, setPauseError] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(false)
  const reportingRef = useRef(false)
  const attemptRef = useRef<TentativaProva | null>(null)
  const answersRef = useRef(answers)
  const savedRef = useRef(saved)

  useEffect(() => { attemptRef.current = tentativa }, [tentativa])
  useEffect(() => { answersRef.current = answers }, [answers])
  useEffect(() => { savedRef.current = saved }, [saved])
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      try {
        const result = await listarProvasAluno()
        if (active) setProvas(result)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível listar as provas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [refresh])

  useEffect(() => {
    onActiveChange(tentativa?.situacao === 'EM_ANDAMENTO')
    return () => onActiveChange(false)
  }, [tentativa?.situacao, onActiveChange])

  useEffect(() => {
    const update = () => setCurrentTime(Date.now())
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  const flushDirty = useCallback(async (active: TentativaProva) => {
    for (const questao of active.questoes) {
      const value = answersRef.current[questao.id] ?? ''
      if (value === (savedRef.current[questao.id] ?? '')) continue
      if (!value.trim()) throw new Error(`A resposta da questão ${questao.ordem} não foi salva.`)
      const stored = await salvarResposta(active.id, questao, value)
      const confirmed = stored.alternativa_id ?? stored.texto ?? ''
      savedRef.current = { ...savedRef.current, [questao.id]: confirmed }
      setSaved(savedRef.current)
    }
  }, [])

  const reportFailure = useCallback(async () => {
    const active = attemptRef.current
    if (!active || active.situacao !== 'EM_ANDAMENTO' || reportingRef.current) return
    reportingRef.current = true
    setInterruptionPending(true)
    setPauseError('')
    let unsaved = false
    try {
      await flushDirty(active)
    } catch {
      unsaved = true
    }
    try {
      await reportarFalhaCamera(active.id)
      stop()
      const message = 'A câmera falhou e a tentativa foi interrompida. Não é possível voltar a esta prova.'
      onLeave(unsaved ? `${message} Uma resposta recente não pôde ser salva.` : message)
    } catch (cause) {
      setPauseError(cause instanceof Error ? cause.message : 'Não foi possível registrar a interrupção. Confira a conexão e tente novamente.')
      reportingRef.current = false
    }
  }, [flushDirty, onLeave, stop])

  useEffect(() => {
    if (tentativa?.situacao !== 'EM_ANDAMENTO' || cameraStatus === 'ready') return
    if (cameraStatus === 'error') {
      const timer = window.setTimeout(() => void reportFailure(), 0)
      return () => window.clearTimeout(timer)
    }
    if (cameraStatus === 'interrupted' || cameraStatus === 'idle' || cameraStatus === 'requesting') {
      const timer = window.setTimeout(() => void reportFailure(), 3000)
      return () => window.clearTimeout(timer)
    }
  }, [cameraStatus, tentativa?.situacao, reportFailure])

  function selectProva(prova: ProvaAluno) {
    if (tentativa?.situacao === 'EM_ANDAMENTO') return
    stop()
    setSelected(prova)
    setTentativa(null)
    setAnswers({})
    setSaved({})
    setPauseError('')
    setError('')
    setSuccess('')
    setNoticeAcknowledged(false)
  }

  async function begin() {
    if (!selected || selected.tentativa_id || cameraStatus !== 'ready' || working || !noticeAcknowledged) return
    setWorking(true)
    setError('')
    try {
      const loaded = await iniciarTentativa(selected.id)
      if (loaded.situacao !== 'EM_ANDAMENTO' || loaded.questoes.length === 0) {
        throw new Error('Não foi possível abrir as questões desta tentativa. A equipe deve verificar a prova.')
      }
      const previous: Record<string, string> = {}
      for (const answer of loaded.respostas) previous[answer.questao_id] = answer.alternativa_id ?? answer.texto ?? ''
      setAnswers(previous)
      setSaved(previous)
      setDeadline(Date.now() + loaded.tempo_restante_segundos * 1000)
      setTentativa(loaded)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível iniciar a prova.')
      stop()
      setSelected(null)
      setRefresh((current) => current + 1)
    } finally {
      setWorking(false)
    }
  }

  async function leave() {
    if (!tentativa || working || savingQuestion || interruptionPending) return
    if (!window.confirm('Encerrar esta tentativa? Você não poderá voltar à prova.')) return
    setWorking(true)
    setError('')
    try {
      await flushDirty(tentativa)
      await interromperTentativa(tentativa.id)
      stop()
      onLeave('Você encerrou a única tentativa desta prova. Não é possível voltar.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível encerrar a tentativa.')
    } finally {
      setWorking(false)
    }
  }

  async function save(questao: QuestaoProva) {
    if (!tentativa || savingQuestion || working || interruptionPending || cameraStatus !== 'ready') return
    const value = answers[questao.id] ?? ''
    setSavingQuestion(questao.id)
    setError('')
    try {
      const result = await salvarResposta(tentativa.id, questao, value)
      const next = { ...savedRef.current, [questao.id]: result.alternativa_id ?? result.texto ?? '' }
      savedRef.current = next
      setSaved(next)
      setSuccess(`Resposta da questão ${questao.ordem} salva.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a resposta.')
    } finally {
      setSavingQuestion(null)
    }
  }

  async function finish() {
    if (!tentativa || working || savingQuestion || interruptionPending || cameraStatus !== 'ready') return
    setWorking(true)
    setError('')
    try {
      await flushDirty(tentativa)
      await finalizarTentativa(tentativa.id)
      stop()
      setTentativa(null)
      setSelected(null)
      setSuccess('Prova enviada. As respostas foram salvas.')
      setRefresh((current) => current + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar o envio da prova.')
    } finally {
      setWorking(false)
    }
  }

  const active = tentativa?.situacao === 'EM_ANDAMENTO'
  const remaining = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - currentTime) / 1000))
  const cameraUnavailable = active && cameraStatus !== 'ready'
  const canBegin = Boolean(selected && (active || (!selected.tentativa_id &&
    currentTime >= Date.parse(selected.inicio_em) && currentTime < Date.parse(selected.fim_em))))

  return <section className="provas-panel" aria-labelledby="provas-titulo">
    <header>
      <p className="overline">AVALIAÇÕES</p>
      <h1 id="provas-titulo">Minhas provas</h1>
      <p className="subtitle">Há uma tentativa por prova. Após sair ou perder a câmera, não é possível voltar.</p>
    </header>

    {error && <p className="alert error" role="alert">{error}</p>}
    {!selected && !active && <ProvaCameraDemo />}
    {!active && <button type="button" className="btn-outline" disabled={loading || working}
      onClick={() => { setError(''); setRefresh((current) => current + 1) }}>Atualizar provas</button>}
    {loading && <p role="status">Carregando provas...</p>}
    {success && <p className="alert success" role="status">{success}</p>}
    {!selected && !loading && !error && provas.length === 0 && <p>Não há provas publicadas para suas turmas ativas.</p>}
    {!selected && !loading && provas.map((prova) => <article className="provas-card" key={prova.id}>
      <h2>{prova.titulo}</h2>
      <p>Início: {new Date(prova.inicio_em).toLocaleString('pt-BR')} · Duração: {prova.duracao_minutos} min</p>
      <p>Situação: {prova.situacao ?? 'Não iniciada'}</p>
      <button type="button" className="btn-outline" onClick={() => selectProva(prova)}>
        {prova.tentativa_id ? 'Ver situação' : 'Preparar prova'}
      </button>
    </article>)}

    {selected && <div className="provas-card">
      <h2>{selected.titulo}</h2>
      {!active && <button type="button" className="btn-back" disabled={working}
        onClick={() => { stop(); setSelected(null); setError('') }}>← Voltar à lista</button>}
      {selected.tentativa_id && selected.situacao !== 'FINALIZADA' && <p className="alert error" role="alert">
        Esta prova já foi iniciada. A tentativa é única e não pode ser reaberta.
      </p>}
      {selected.situacao === 'FINALIZADA' && <p className="alert success" role="status">Esta prova já foi enviada.</p>}
      {!selected.tentativa_id &&
        currentTime < Date.parse(selected.inicio_em) && <p role="status">
          Esta prova poderá ser iniciada em {new Date(selected.inicio_em).toLocaleString('pt-BR')}.
        </p>}
      {!selected.tentativa_id &&
        currentTime >= Date.parse(selected.fim_em) && <p role="status">
          O período para iniciar esta prova terminou.
        </p>}

      {canBegin && <>
        {!active && <p>Confira sua imagem antes de começar. Depois de iniciar, sair ou perder a câmera encerra seu acesso a esta prova.</p>}
        {!active && <div className="provas-aviso">
          <p>{EXAM_NOTICE_SUMMARY}</p>
          <p>Leia os <a href="/termos" target="_blank" rel="noreferrer">Termos de Uso</a> e a <a href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</a> antes de iniciar.</p>
          <label><input type="checkbox" checked={noticeAcknowledged}
            onChange={(event) => setNoticeAcknowledged(event.target.checked)} /> Li o aviso da prova ({EXAM_NOTICE_VERSION}), os Termos e a Política atualizados e entendi como a câmera e as respostas são usadas.</label>
        </div>}
        <div className={active ? 'provas-camera provas-camera-small' : 'provas-camera'}>
          <video ref={videoRef} autoPlay muted playsInline aria-label="Prévia da câmera durante a prova" />
        </div>
        <p className={cameraUnavailable ? 'alert error' : 'provas-note'} role={cameraUnavailable ? 'alert' : 'status'}>
          {cameraMessage}
        </p>
        {!active && <div className="provas-actions">
          <button type="button" className="btn-outline" disabled={working || cameraStatus === 'requesting'}
            onClick={() => void start()}>{cameraStatus === 'ready' ? 'Testar novamente' : 'Ligar câmera'}</button>
          <button type="button" className="btn-primary" disabled={working || cameraStatus !== 'ready' || !noticeAcknowledged}
            onClick={() => void begin()}>{working ? 'Preparando...' : 'Iniciar prova'}</button>
        </div>}
        {active && cameraStatus === 'ready' && <button type="button" className="btn-outline"
          onClick={reportNoImage}>Minha imagem ficou preta</button>}
      </>}

      {active && <>
        <div className="provas-timer" role="status">Tempo restante: {formatarTempo(remaining)}</div>
        <button type="button" className="btn-outline" disabled={working || Boolean(savingQuestion) || interruptionPending}
          onClick={() => void leave()}>Encerrar tentativa</button>
        {cameraUnavailable || interruptionPending ? <div className="provas-cover" role="alert">
          <h3>Prova interrompida</h3>
          <p>As questões estão ocultas enquanto a câmera não estiver disponível.</p>
          {pauseError ? <>
            <p>{pauseError}</p>
            <button type="button" className="btn-primary" onClick={() => void reportFailure()}>Tentar registrar a interrupção</button>
          </> : <p>{interruptionPending ? 'Registrando a interrupção no servidor...' : 'Aguardando a câmera voltar por alguns segundos. Se a falha continuar, a tentativa será encerrada.'}</p>}
        </div> : <>
          <p className="provas-note">Cada resposta é salva no banco ao clicar em “Salvar resposta”. Respostas ainda não salvas serão enviadas antes de finalizar.</p>
          <ol className="provas-questoes">
            {tentativa.questoes.map((questao) => <li key={questao.id} value={questao.ordem}>
              <h3>Questão {questao.ordem}</h3>
              <p>{questao.enunciado}</p>
              {questao.tipo === 'OBJETIVA' ? <fieldset>
                <legend>Escolha uma alternativa</legend>
                {questao.alternativas.map((alt) => <label key={alt.id}>
                  <input type="radio" name={`questao-${questao.id}`} value={alt.id}
                    checked={answers[questao.id] === alt.id}
                    onChange={() => setAnswers((current) => ({ ...current, [questao.id]: alt.id }))} />
                  {alt.texto}
                </label>)}
              </fieldset> : <label className="provas-discursiva">
                Resposta
                <textarea value={answers[questao.id] ?? ''} maxLength={10000}
                  onChange={(event) => setAnswers((current) => ({ ...current, [questao.id]: event.target.value }))} />
              </label>}
              <div className="provas-actions">
                <button type="button" className="btn-outline" disabled={Boolean(savingQuestion) || working ||
                  !answers[questao.id]?.trim() || answers[questao.id] === saved[questao.id]}
                  onClick={() => void save(questao)}>
                  {savingQuestion === questao.id ? 'Salvando...' : 'Salvar resposta'}
                </button>
                <span>{answers[questao.id] === saved[questao.id] && saved[questao.id] ? 'Salva' : 'Ainda não salva'}</span>
              </div>
            </li>)}
          </ol>
          <button type="button" className="btn-primary" disabled={working || Boolean(savingQuestion)}
            onClick={() => void finish()}>{working ? 'Enviando...' : 'Enviar prova'}</button>
        </>}
      </>}
    </div>}
  </section>
}
