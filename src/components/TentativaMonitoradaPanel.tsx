import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useCameraSession } from '../hooks/useCameraSession'
import type { AvaliacaoAluno } from '../services/avaliacaoValidation'
import { consultarConteudoTentativa, consultarRespostasTentativa, encerrarTentativa, iniciarTentativa, salvarRespostaTentativa } from '../services/tentativas'
import { useExamPhotos } from '../hooks/useExamPhotos'
import { photosEnabled, examManagementEnabled } from '../services/examFeatures'
import { PHOTO_NOTICE, PHOTO_NOTICE_VERSION } from '../services/examPhotos'
import type { ConteudoTentativa, QuestaoTentativa, TentativaIniciada } from '../services/tentativaValidation'
import { EXAM_NOTICE_SUMMARY, EXAM_NOTICE_VERSION } from '../content/legalDocuments'
import type { LegalDocumentType } from '../content/legalDocuments'
import { LegalModal } from './LegalModal'
import '../styles/turmas.css'
import '../styles/provas.css'

type Props = {
  avaliacao: AvaliacaoAluno
  onCancelar: () => void
  onLeave: (message: string) => void
  onActiveChange: (active: boolean) => void
}

type Phase = 'preparo' | 'iniciando' | 'em-andamento' | 'bloqueada' | 'falhou'
type BlockReason = 'CAMERA' | 'PRAZO' | 'SAIDA'
type Confirmation = 'ENVIO' | 'SAIDA'

const DEPARTURE_WARNING = 'Durante a prova, permaneça nesta página e nesta aba. Não troque de aba, de janela ou de área de trabalho, nem minimize a janela. Sair, atualizar a página ou tirar o foco da janela da prova interrompe sua única tentativa, sem retorno automático. Se isso acontecer, procure seu professor ou responsável para analisar o caso.'

function relogio(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function ConfirmarEncerramento({ action, onCancel, onConfirm }: {
  action: Confirmation; onCancel: () => void; onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    cancelRef.current?.focus()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  return <dialog ref={dialogRef} className="provas-confirmacao" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onCancel() }}>
    <h2 id={titleId}>{action === 'ENVIO' ? 'Enviar prova?' : 'Sair da prova?'}</h2>
    <p>{action === 'ENVIO' ? 'Suas respostas serão enviadas e a tentativa será encerrada.' : 'Sair interrompe sua única tentativa.'} Não há retorno automático. Uma interrupção exige análise do professor ou responsável.</p>
    <div className="provas-actions">
      <button type="button" className="btn-outline" ref={cancelRef} onClick={onCancel}>Continuar na prova</button>
      <button type="button" className="btn-primary" onClick={onConfirm}>
        {action === 'ENVIO' ? 'Enviar e encerrar' : 'Confirmar saída'}
      </button>
    </div>
  </dialog>
}

export function TentativaMonitoradaPanel({ avaliacao, onCancelar, onLeave, onActiveChange }: Props) {
  const { videoRef, status: cameraStatus, message: cameraMessage, start, stop, reportNoImage } = useCameraSession()
  const [phase, setPhase] = useState<Phase>('preparo')
  const [tentativa, setTentativa] = useState<TentativaIniciada | null>(null)
  const [conteudo, setConteudo] = useState<ConteudoTentativa | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [busyQuestion, setBusyQuestion] = useState<string | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [blockReason, setBlockReason] = useState<BlockReason | null>(null)
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(false)
  const [photosAcknowledged, setPhotosAcknowledged] = useState(false)
  const [legalDocument, setLegalDocument] = useState<LegalDocumentType | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const noticeId = useId()
  const activeRef = useRef(true)
  const startingRef = useRef(false)
  const closingRef = useRef(false)
  const closedRef = useRef(false)
  const leftDuringStartRef = useRef(false)
  const blockReasonRef = useRef<BlockReason | null>(null)
  const blockedRef = useRef(false)
  const attemptRef = useRef<TentativaIniciada | null>(null)
  const answerRef = useRef(answers)
  const savedRef = useRef(saved)
  const cameraRef = useRef(cameraStatus)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const withPhotos = photosEnabled()
  const withManagement = examManagementEnabled()
  const allAcknowledged = noticeAcknowledged && (!withPhotos || photosAcknowledged)
  const photos = useExamPhotos(videoRef, reportNoImage)
  const disposePhotos = photos.dispose

  useEffect(() => {
    activeRef.current = true
    cancelButton.current?.focus()
    return () => { activeRef.current = false }
  }, [])
  useEffect(() => { attemptRef.current = tentativa }, [tentativa])
  useEffect(() => { answerRef.current = answers }, [answers])
  useEffect(() => { savedRef.current = saved }, [saved])
  useEffect(() => { cameraRef.current = cameraStatus }, [cameraStatus])
  useEffect(() => {
    onActiveChange(phase === 'iniciando' || phase === 'em-andamento' || phase === 'bloqueada')
  }, [phase, onActiveChange])
  useEffect(() => () => onActiveChange(false), [onActiveChange])
  useEffect(() => {
    if (!tentativa) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [tentativa])

  async function loadContent(current: TentativaIniciada) {
    if (blockedRef.current || Date.now() >= Date.parse(current.limite_em)) return
    setLoadingContent(true)
    setError('')
    try {
      const result = await consultarConteudoTentativa(current.id)
      if (result.avaliacao_id !== current.avaliacao_id || result.iniciada_em !== current.iniciada_em ||
          result.limite_em !== current.limite_em) throw new Error('O conteúdo não corresponde à tentativa iniciada.')
      if (withManagement) {
        const previous = await consultarRespostasTentativa(current.id)
        const values: Record<string, string> = {}
        for (const answer of previous) {
          const question = result.questoes.find(item => item.id === answer.questao_id)
          if (!question || (answer.alternativa_id && !question.alternativas.some(item => item.id === answer.alternativa_id))) {
            throw new Error('As respostas anteriores não correspondem às questões da tentativa.')
          }
          values[answer.questao_id] = answer.alternativa_id ?? answer.texto ?? ''
        }
        if (!activeRef.current || blockedRef.current) return
        answerRef.current = values
        savedRef.current = values
        setAnswers(values)
        setSaved(values)
      }
      if (activeRef.current && !blockedRef.current) setConteudo(result)
    } catch (cause) {
      if (activeRef.current && !blockedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as questões.')
    } finally {
      if (activeRef.current) setLoadingContent(false)
    }
  }

  const block = useCallback(async (reason: BlockReason) => {
    const current = attemptRef.current
    if (!current || closingRef.current || closedRef.current) return
    reason = blockReasonRef.current ?? reason
    blockReasonRef.current = reason
    blockedRef.current = true
    disposePhotos()
    setBlockReason(reason)
    setPhase('bloqueada')
    setConteudo(null)
    setError('')
    closingRef.current = true
    try {
      await encerrarTentativa(current.id, reason)
      closedRef.current = true
      stop()
      if (activeRef.current) onLeave(reason === 'CAMERA'
        ? 'A câmera ficou indisponível. A tentativa foi interrompida e não pode ser retomada automaticamente. Procure o professor ou o ADM para analisar o caso.'
        : reason === 'SAIDA'
          ? 'Você saiu da aba ou da janela da prova. A tentativa foi interrompida, sem retorno automático. Procure seu professor ou responsável para analisar o caso.'
          : 'O prazo terminou. A tentativa foi encerrada.')
    } catch (cause) {
      if (activeRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível registrar o encerramento. Tente novamente.')
    } finally {
      closingRef.current = false
    }
  }, [onLeave, stop, disposePhotos])

  useEffect(() => {
    if (phase !== 'em-andamento' || cameraStatus === 'ready') return
    if (cameraStatus === 'interrupted') {
      const timeout = window.setTimeout(() => {
        if (cameraRef.current === 'interrupted') void block('CAMERA')
      }, 3000)
      return () => window.clearTimeout(timeout)
    }
    void block('CAMERA')
  }, [phase, cameraStatus, block])
  useEffect(() => {
    if (phase !== 'em-andamento' || !tentativa || now < Date.parse(tentativa.limite_em)) return
    void block('PRAZO')
  }, [phase, tentativa, now, block])

  useEffect(() => {
    if (phase !== 'iniciando' && phase !== 'em-andamento') return
    function leavePage() {
      if (closedRef.current) return
      if (!attemptRef.current) {
        leftDuringStartRef.current = true
        return
      }
      void block('SAIDA')
    }
    function visibilityChanged() {
      if (document.visibilityState === 'hidden') leavePage()
    }
    window.addEventListener('blur', leavePage)
    window.addEventListener('pagehide', leavePage)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      window.removeEventListener('blur', leavePage)
      window.removeEventListener('pagehide', leavePage)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [phase, block])

  useEffect(() => {
    // Mantém os documentos do rodapé acessíveis durante a tentativa,
    // sem exigir que o aluno saia da aba para consultá-los.
    function openLegalDocument(event: MouseEvent) {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(anchor instanceof HTMLAnchorElement)) return
      const url = new URL(anchor.href, window.location.href)
      const path = url.pathname.replace(/\/$/, '')
      if (url.origin !== window.location.origin || (path !== '/termos' && path !== '/privacidade')) return
      event.preventDefault()
      setLegalDocument(path === '/termos' ? 'termos' : 'privacidade')
    }
    document.addEventListener('click', openLegalDocument, true)
    return () => document.removeEventListener('click', openLegalDocument, true)
  }, [])

  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (startingRef.current || cameraStatus !== 'ready' || !allAcknowledged) return
    startingRef.current = true
    setPhase('iniciando')
    setError('')
    try {
      const started = await iniciarTentativa(avaliacao.id)
      if (!activeRef.current) return
      attemptRef.current = started
      setTentativa(started)
      setNow(Date.now())
      if (leftDuringStartRef.current) {
        void block('SAIDA')
        return
      }
      setPhase('em-andamento')
      if (withPhotos) {
        const ready = await photos.initialize(started.id)
        if (!activeRef.current || blockedRef.current || !ready) return
      }
      void loadContent(started)
    } catch (cause) {
      if (activeRef.current) {
        setPhase(attemptRef.current ? 'em-andamento' : 'falhou')
        setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar o início.')
      }
    }
  }

  async function retryPhotos() {
    const current = attemptRef.current
    if (!current || blockedRef.current) return
    setError('')
    try {
      const ready = photos.pending ? await photos.retry() : await photos.initialize(current.id)
      if (ready && activeRef.current && !blockedRef.current && !conteudo) await loadContent(current)
    } catch {
      if (activeRef.current && !blockedRef.current) setError('Não foi possível preparar o envio das fotos. Tente novamente nesta página.')
    }
  }

  async function saveQuestion(question: QuestaoTentativa) {
    const current = attemptRef.current
    if (!current || blockedRef.current || cameraRef.current !== 'ready' || busyQuestion || busy) return
    setBusyQuestion(question.id)
    setError('')
    try {
      const result = await salvarRespostaTentativa(current.id, question, answerRef.current[question.id] ?? '')
      if (!activeRef.current || blockedRef.current) return
      const value = result.alternativa_id ?? result.texto ?? ''
      const next = { ...savedRef.current, [question.id]: value }
      savedRef.current = next
      setSaved(next)
      setNotice(`Resposta da questão ${question.ordem} salva.`)
    } catch (cause) {
      if (activeRef.current && !blockedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a resposta.')
    } finally {
      if (activeRef.current) setBusyQuestion(null)
    }
  }

  async function finish() {
    const current = attemptRef.current
    if (!current || !conteudo || busy || busyQuestion || blockedRef.current || cameraRef.current !== 'ready') return
    setBusy(true)
    setError('')
    try {
      for (const question of conteudo.questoes) {
        if (blockedRef.current || cameraRef.current !== 'ready') throw new Error('A câmera ficou indisponível. A prova foi bloqueada.')
        const value = answerRef.current[question.id] ?? ''
        if (!value.trim() || value === (savedRef.current[question.id] ?? '')) continue
        const result = await salvarRespostaTentativa(current.id, question, value)
        savedRef.current = { ...savedRef.current, [question.id]: result.alternativa_id ?? result.texto ?? '' }
        setSaved(savedRef.current)
      }
      if (blockedRef.current || cameraRef.current !== 'ready') throw new Error('A câmera ficou indisponível. A prova foi bloqueada.')
      const photosConfirmed = !withPhotos || await photos.flush()
      if (blockedRef.current || cameraRef.current !== 'ready') return
      closingRef.current = true
      await encerrarTentativa(current.id, 'ENVIO')
      closedRef.current = true
      photos.dispose()
      stop()
      if (activeRef.current && !blockedRef.current) onLeave(photosConfirmed
        ? 'Prova enviada. A tentativa foi encerrada.'
        : 'Prova enviada. Algumas fotos ficaram sem confirmação de envio. Informe o professor para análise; isso não foi contado como falha de câmera.')
    } catch (cause) {
      if (activeRef.current && !blockedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar o envio.')
    } finally {
      closingRef.current = false
      if (activeRef.current) setBusy(false)
    }
  }

  async function leave() {
    const current = attemptRef.current
    if (!current || blockedRef.current || busy || busyQuestion) return
    await block('SAIDA')
  }

  const remaining = tentativa ? Date.parse(tentativa.limite_em) - now : 0
  return <section className="provas-panel tentativa-aluno" aria-labelledby="tentativa-monitorada-title">
    <h1 id="tentativa-monitorada-title">{avaliacao.titulo}</h1>
    <p className="turmas-note">{avaliacao.turma_nome} · Tentativa única, sem retorno automático.{withManagement && ' A reativação depende do professor responsável ou do ADM da sua organização.'}</p>
    <p className="turmas-note">{withPhotos ? 'A câmera deve permanecer disponível. As fotos são enviadas para análise manual do responsável, com acesso restrito.'
      : 'A câmera deve permanecer disponível. As fotos continuam apenas no teste local e não são enviadas nesta versão.'}</p>

    <div className="provas-camera provas-camera-small">
      <video ref={videoRef} autoPlay muted playsInline aria-label="Câmera durante a avaliação" />
    </div>
    <p role={cameraStatus === 'error' || cameraStatus === 'interrupted' ? 'alert' : 'status'}
      className={cameraStatus === 'error' || cameraStatus === 'interrupted' ? 'alert error' : 'turmas-note'}>{cameraMessage}</p>

    {phase === 'preparo' && <form className="turma-form avaliacao-form" onSubmit={begin} aria-label="Preparar tentativa">
      <p>Ligue a câmera e confirme que sua imagem aparece antes de iniciar. O prazo começa após a confirmação do servidor.</p>
      <div className="provas-aviso">
        <p>{withPhotos ? PHOTO_NOTICE : EXAM_NOTICE_SUMMARY}</p>
        <p className="provas-permanencia" id={`${noticeId}-permanencia`}>{DEPARTURE_WARNING}</p>
        <p>Leia os <a href="/termos" target="_blank" rel="noreferrer">Termos de Uso</a> e a <a href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</a>.</p>
        <label className="provas-aceite" htmlFor={noticeId}>
          <input id={noticeId} type="checkbox" checked={noticeAcknowledged} aria-describedby={`${noticeId}-permanencia`}
            onChange={event => setNoticeAcknowledged(event.target.checked)} />
          <span>Li o aviso da prova ({EXAM_NOTICE_VERSION}), os Termos e a Política atualizados e entendi como a câmera e as respostas são usadas.</span>
        </label>
        {withPhotos && <label className="provas-aceite" htmlFor={`${noticeId}-fotos`}>
          <input id={`${noticeId}-fotos`} type="checkbox" checked={photosAcknowledged}
            onChange={event => setPhotosAcknowledged(event.target.checked)} />
          <span>Autorizo especificamente a captura e o envio de uma foto inicial e três durante esta demonstração voluntária, para análise manual pelo professor responsável ou ADM da minha organização, por até 90 dias por foto ({PHOTO_NOTICE_VERSION}). Posso cancelar antes de iniciar e solicitar revogação e exclusão pelo contato da Política.</span>
        </label>}
      </div>
      <button type="button" className="turmas-refresh" onClick={() => void start()} disabled={cameraStatus === 'requesting'}>Testar câmera</button>{' '}
      {cameraStatus === 'ready' && <button type="button" className="turmas-refresh" onClick={reportNoImage}>Minha imagem ficou preta</button>}
      <p id={`${noticeId}-preparo`} className="provas-note" aria-live="polite">
        {cameraStatus === 'ready'
          ? allAcknowledged ? 'Tudo pronto para iniciar a prova.' : 'Câmera pronta. Confirme os avisos acima para habilitar o início.'
          : allAcknowledged ? 'Aceite confirmado. Ligue a câmera para habilitar o início.' : 'Para iniciar, ligue a câmera e marque o aceite acima.'}
      </p>
      <div className="avaliacao-form-actions">
        <button type="submit" className="btn-primary" aria-describedby={`${noticeId}-preparo`}
          disabled={cameraStatus !== 'ready' || !allAcknowledged}>Confirmar início</button>
        <button type="button" className="turmas-refresh" ref={cancelButton} onClick={() => { stop(); onCancelar() }}>Cancelar</button>
      </div>
    </form>}
    {phase === 'iniciando' && <p role="status">Confirmando início da tentativa...</p>}
    {phase === 'falhou' && <button type="button" className="turmas-refresh" onClick={() => { stop(); onCancelar() }}>Voltar às avaliações</button>}
    {tentativa && <p className="tentativa-prazo" role="timer">Tempo restante: {relogio(remaining)}</p>}
    {error && <p className="alert error" role="alert">{error}</p>}
    {notice && <p className="alert success" role="status">{notice}</p>}
    {withPhotos && phase === 'em-andamento' && <div className="provas-fotos-status">
      <p role="status">{photos.message || (photos.initialReady ? 'Foto inicial recebida. As próximas capturas acontecem durante a prova.' : 'Aguardando confirmação da foto inicial antes de mostrar as questões.')}</p>
      {(photos.pending > 0 || !photos.initialReady) && <button type="button" className="turmas-refresh" onClick={() => void retryPhotos()}>
        {photos.pending > 0 ? `Reenviar fotos (${photos.pending})` : 'Preparar envio das fotos'}
      </button>}
    </div>}
    {withPhotos && photos.toast && phase === 'em-andamento' && <div className="provas-photo-toast" role="status">{photos.toast}</div>}

    {phase === 'bloqueada' && <div className="provas-cover" role="alert">
      <h2>Prova bloqueada</h2>
      <p>{blockReason === 'PRAZO' ? 'O tempo terminou.' : blockReason === 'SAIDA'
        ? 'Você saiu da aba ou da janela da prova. A tentativa foi interrompida, sem retorno automático. Procure seu professor ou responsável para analisar o caso.'
        : 'A câmera ou a tentativa ficou indisponível.'} As questões não estão mais visíveis.</p>
      {error && blockReason && <button type="button" className="turmas-refresh" onClick={() => void block(blockReason)}>Tentar registrar encerramento</button>}
    </div>}

    {phase === 'em-andamento' && cameraStatus !== 'ready' && <div className="provas-cover" role="alert">
      <p>O sinal da câmera foi interrompido. As questões estão ocultas. Se não voltar em três segundos, a tentativa será encerrada.</p>
    </div>}
    {phase === 'em-andamento' && cameraStatus === 'ready' && (!withPhotos || photos.initialReady) && <>
      {loadingContent && <p role="status">Carregando questões...</p>}
      {!loadingContent && !conteudo && error && tentativa && <button type="button" className="turmas-refresh"
        onClick={() => void loadContent(tentativa)}>Tentar carregar questões</button>}
      {conteudo && <>
        <h2>Questões</h2>
        <ol className="questoes-lista" aria-label="Questões da tentativa">
          {conteudo.questoes.map(question => <li key={question.id} value={question.ordem}>
            <h3>Questão {question.ordem}</h3>
            <p className="turmas-note">{question.tipo === 'OBJETIVA' ? 'Objetiva' : 'Dissertativa'} · {question.pontuacao} ponto(s)</p>
            <p className="questao-enunciado">{question.enunciado}</p>
            {question.tipo === 'OBJETIVA' ? <fieldset className="tentativa-resposta-opcoes">
              <legend>Resposta da questão {question.ordem}</legend>
              {question.alternativas.map(option => <label key={option.id} className="provas-alternative">
                <input type="radio" name={`questao-${question.id}`} value={option.id}
                  checked={answers[question.id] === option.id} disabled={busy || Boolean(busyQuestion)}
                  onChange={() => { setAnswers(current => ({ ...current, [question.id]: option.id })); setNotice('') }} />
                {option.texto}
              </label>)}
            </fieldset> : <label className="provas-discursiva">Resposta da questão {question.ordem}
              <textarea value={answers[question.id] ?? ''} maxLength={10000} disabled={busy || Boolean(busyQuestion)}
                onChange={event => { setAnswers(current => ({ ...current, [question.id]: event.target.value })); setNotice('') }} />
            </label>}
            <button type="button" className="turmas-refresh" disabled={busy || Boolean(busyQuestion) ||
              !answers[question.id]?.trim() || answers[question.id] === saved[question.id]}
              onClick={() => void saveQuestion(question)}>
              {busyQuestion === question.id ? 'Salvando...' : saved[question.id] === answers[question.id] ? 'Resposta salva' : 'Salvar resposta'}
            </button>
          </li>)}
        </ol>
        <div className="avaliacao-form-actions">
          <button type="button" className="btn-primary" disabled={busy || Boolean(busyQuestion)} onClick={() => setConfirmation('ENVIO')}>
            {busy ? 'Enviando...' : 'Enviar prova'}
          </button>
          <button type="button" className="turmas-refresh" disabled={busy || Boolean(busyQuestion)} onClick={() => setConfirmation('SAIDA')}>Sair e encerrar</button>
          <button type="button" className="turmas-refresh" onClick={reportNoImage}>Minha imagem ficou preta</button>
        </div>
      </>}
    </>}
    {legalDocument && <LegalModal documentType={legalDocument} onClose={() => setLegalDocument(null)} />}
    {confirmation && phase === 'em-andamento' && <ConfirmarEncerramento action={confirmation}
      onCancel={() => setConfirmation(null)} onConfirm={() => {
        setConfirmation(null)
        if (confirmation === 'ENVIO') void finish()
        else void leave()
      }} />}
  </section>
}
