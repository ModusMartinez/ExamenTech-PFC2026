import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useCameraSession } from '../hooks/useCameraSession'
import { useOcorrenciasProva } from '../hooks/useOcorrenciasProva'
import { useEventosExecucao } from '../hooks/useEventosExecucao'
import { AVISO_CANCELAMENTO, useCancelamentoTentativa } from '../hooks/useCancelamentoTentativa'
import type { AvaliacaoAluno } from '../services/avaliacaoValidation'
import { consultarConteudoTentativa, encerrarTentativa, iniciarTentativa } from '../services/tentativas'
import { consultarRespostasTentativa, ErroSalvamentoResposta, salvarRespostaTentativa } from '../services/respostasTentativa'
import type { DadosRespostaTentativa, RespostaTentativa } from '../services/respostaValidation'
import { useExamPhotos } from '../hooks/useExamPhotos'
import { photosEnabled } from '../services/examFeatures'
import { PHOTO_NOTICE, PHOTO_NOTICE_VERSION } from '../services/examPhotos'
import { ErroAcessoTentativa, ErroConexaoTentativa } from '../services/tentativaValidation'
import type { ConteudoTentativa, MotivoSaidaTentativa, QuestaoTentativa, TentativaIniciada } from '../services/tentativaValidation'
import { EXAM_NOTICE_VERSION, PROVA_NOTICE_VERSION } from '../content/legalDocuments'
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
type BlockReason = MotivoSaidaTentativa | 'PRAZO' | 'CONEXAO' | 'ACESSO' | 'CANCELAMENTO'
type Confirmation = 'ENVIO' | 'SAIDA'
type EstadoResposta = {
  salva?: RespostaTentativa
  pendente?: DadosRespostaTentativa
  conflito?: boolean
  conferida?: boolean
  falha?: boolean
}

function valorResposta(resposta?: RespostaTentativa) {
  return resposta?.alternativa_id ?? resposta?.texto ?? ''
}

function conferirQuestao(resposta: RespostaTentativa, questoes: QuestaoTentativa[]) {
  const questao = questoes.find(item => item.id === resposta.questao_id)
  if (!questao || (questao.tipo === 'OBJETIVA' && resposta.texto !== null) ||
      (questao.tipo === 'DISSERTATIVA' && resposta.alternativa_id !== null) ||
      (resposta.alternativa_id && !questao.alternativas.some(item => item.id === resposta.alternativa_id))) {
    throw new Error('As respostas anteriores não correspondem às questões da tentativa.')
  }
}

const DEPARTURE_WARNING = 'Permaneça nesta página e nesta aba. Sair, atualizar a página, perder o foco ou ficar sem conexão interrompe sua única tentativa. A tentativa não pode ser retomada.'
const MONITORING_NOTICE = 'A prova exige tela cheia. Sair da tela cheia encerra a tentativa. Copiar, colar e recortar são bloqueados. O sistema registra o tipo e o horário dessas ocorrências, sem coletar o conteúdo da área de transferência.'
const BLOCK_MESSAGES: Record<BlockReason, string> = {
  SAIDA: 'Você saiu da avaliação. A tentativa não pode ser retomada. Procure seu professor ou responsável se precisar de orientação.',
  ABA_OU_FOCO: 'A aba ou janela da prova perdeu o foco. A tentativa não pode ser retomada. As respostas recebidas ficam salvas.',
  TELA_CHEIA: 'A tela cheia foi encerrada. A tentativa não pode ser retomada. As respostas recebidas ficam salvas.',
  CONEXAO: 'A conexão foi interrompida. A tentativa não pode ser retomada. As respostas recebidas pelo sistema ficam salvas.',
  ACESSO: 'A sessão desta tentativa ficou indisponível. A tentativa não pode ser retomada.',
  PRAZO: 'O prazo terminou. As respostas recebidas pelo sistema ficam salvas.',
  CANCELAMENTO: AVISO_CANCELAMENTO,
}

function relogio(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function ConfirmarEncerramento({ action, prova, onCancel, onConfirm }: {
  action: Confirmation; prova: boolean; onCancel: () => void; onConfirm: () => void
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
    <h2 id={titleId}>{action === 'ENVIO' ? `Enviar ${prova ? 'prova' : 'atividade'}?` : `Sair da ${prova ? 'prova' : 'atividade'}?`}</h2>
    <p>{action === 'ENVIO' ? 'Suas respostas serão enviadas e a tentativa será encerrada.' : 'Sair interrompe sua única tentativa. Ela não poderá ser retomada.'}</p>
    <div className="provas-actions">
      <button type="button" className="btn-outline" ref={cancelRef} onClick={onCancel}>Continuar na {prova ? 'prova' : 'atividade'}</button>
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
  const [saved, setSaved] = useState<Record<string, EstadoResposta>>({})
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
  const [chaveExecucao] = useState(() => crypto.randomUUID())
  const noticeId = useId()
  const activeRef = useRef(true)
  const preparandoTelaCheia = useRef(false)
  const telaCheiaDaProva = useRef(false)
  const startingRef = useRef(false)
  const closingRef = useRef(false)
  const closedRef = useRef(false)
  const blockReasonRef = useRef<BlockReason | null>(null)
  const blockedRef = useRef(false)
  const attemptRef = useRef<TentativaIniciada | null>(null)
  const answerRef = useRef(answers)
  const savedRef = useRef(saved)
  const savingRef = useRef(false)
  const saveAtRef = useRef<Record<string, number>>({})
  const cancelButton = useRef<HTMLButtonElement>(null)
  const blockHeading = useRef<HTMLHeadingElement>(null)
  const prova = avaliacao.tipo === 'PROVA'
  const withPhotos = prova && photosEnabled()
  const allAcknowledged = noticeAcknowledged && (!prova || photosAcknowledged)
  const podeIniciar = allAcknowledged && (!prova || (withPhotos && cameraStatus === 'ready'))
  const photos = useExamPhotos(videoRef, reportNoImage, handleExecutionFailure)
  const ocorrencias = useOcorrenciasProva(tentativa?.id ?? null, chaveExecucao, cameraStatus,
    prova && phase === 'em-andamento', handleExecutionFailure)
  const disposePhotos = photos.dispose

  const sairTelaCheia = useCallback(() => {
    if (!telaCheiaDaProva.current) return
    telaCheiaDaProva.current = false
    if (document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => undefined)
  }, [])
  useEffect(() => sairTelaCheia, [sairTelaCheia])

  useEffect(() => {
    activeRef.current = true
    cancelButton.current?.focus()
    return () => { activeRef.current = false }
  }, [])
  useEffect(() => { answerRef.current = answers }, [answers])
  useEffect(() => { savedRef.current = saved }, [saved])
  useEffect(() => {
    onActiveChange(phase === 'iniciando' || phase === 'em-andamento' ||
      (phase === 'bloqueada' && blockReason !== 'CANCELAMENTO'))
  }, [phase, blockReason, onActiveChange])
  useEffect(() => () => onActiveChange(false), [onActiveChange])
  useEffect(() => {
    if (phase === 'bloqueada') blockHeading.current?.focus()
  }, [phase, blockReason])
  useEffect(() => {
    if (!tentativa || phase !== 'em-andamento') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [tentativa, phase])

  async function loadContent(current: TentativaIniciada) {
    if (blockedRef.current || now >= Date.parse(current.limite_em)) return
    setLoadingContent(true)
    setError('')
    try {
      const result = await consultarConteudoTentativa(current.id, chaveExecucao)
      checkAvailable()
      if (result.avaliacao_id !== current.avaliacao_id || result.iniciada_em !== current.iniciada_em ||
          result.limite_em !== current.limite_em) throw new Error('O conteúdo não corresponde à tentativa iniciada.')
      const previous = await consultarRespostasTentativa(current.id, chaveExecucao)
      const values: Record<string, string> = {}
      const states: Record<string, EstadoResposta> = {}
      for (const answer of previous) {
        conferirQuestao(answer, result.questoes)
        values[answer.questao_id] = valorResposta(answer)
        states[answer.questao_id] = { salva: answer }
      }
      if (!activeRef.current || blockedRef.current) return
      answerRef.current = values
      savedRef.current = states
      setAnswers(values)
      setSaved(states)
      setConteudo(result)
    } catch (cause) {
      handleExecutionFailure(cause)
      if (activeRef.current && !blockedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as questões.')
    } finally {
      if (activeRef.current) setLoadingContent(false)
    }
  }

  const block = useCallback(async (reason: BlockReason) => {
    if (closedRef.current) return
    if (reason !== 'CANCELAMENTO') reason = blockReasonRef.current ?? reason
    if (!blockedRef.current || reason === 'CANCELAMENTO') {
      blockReasonRef.current = reason
      blockedRef.current = true
      disposePhotos()
      stop()
      sairTelaCheia()
      setBlockReason(reason)
      setPhase('bloqueada')
      setConteudo(null)
      setConfirmation(null)
      setLegalDocument(null)
      setAnswers({})
      setSaved({})
      setError('')
      setNotice('')
    }
    if (reason === 'CANCELAMENTO') {
      closedRef.current = true
      return
    }
    const current = attemptRef.current
    if (!current || reason === 'ACESSO' || closingRef.current || !navigator.onLine) return
    closingRef.current = true
    try {
      const encerramento = await encerrarTentativa(current.id, reason === 'CONEXAO' ? 'SAIDA' : reason, chaveExecucao)
      if (closedRef.current) return
      closedRef.current = true
      if (activeRef.current) onLeave(BLOCK_MESSAGES[encerramento.situacao === 'FINALIZADA' ? 'PRAZO' : reason])
    } catch (cause) {
      if (activeRef.current && !closedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível registrar o encerramento. Tente novamente.')
    } finally {
      closingRef.current = false
    }
  }, [onLeave, stop, disposePhotos, sairTelaCheia, chaveExecucao])

  useCancelamentoTentativa(blockReason === 'CANCELAMENTO' ? undefined : tentativa?.id, () => void block('CANCELAMENTO'))

  function handleExecutionFailure(cause: unknown) {
    if (!activeRef.current) return
    if (cause instanceof ErroConexaoTentativa) void block('CONEXAO')
    if (cause instanceof ErroAcessoTentativa) void block('ACESSO')
  }

  useEffect(() => {
    if (phase !== 'em-andamento' || !tentativa || now < Date.parse(tentativa.limite_em)) return
    void block('PRAZO')
  }, [phase, tentativa, now, block])

  useEventosExecucao(
    motivo => { if (startingRef.current && !blockedRef.current) void block(motivo) },
    () => { if (blockReasonRef.current) void block(blockReasonRef.current) },
    { saida: 'SAIDA', foco: prova ? 'ABA_OU_FOCO' : 'SAIDA', telaCheia: prova ? 'TELA_CHEIA' : undefined },
  )

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
    if (startingRef.current || preparandoTelaCheia.current || !podeIniciar) return
    if (!navigator.onLine) {
      setError('Conecte-se à internet para iniciar a prova.')
      return
    }
    setPhase('iniciando')
    setError('')
    if (prova) {
      preparandoTelaCheia.current = true
      try {
        if (!document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== 'function') {
          throw new Error('Tela cheia indisponível.')
        }
        await document.documentElement.requestFullscreen()
        if (document.fullscreenElement !== document.documentElement) throw new Error('Tela cheia indisponível.')
        telaCheiaDaProva.current = true
        if (!activeRef.current) {
          sairTelaCheia()
          return
        }
      } catch {
        if (activeRef.current) {
          setPhase('preparo')
          setError('Permita a tela cheia para iniciar. Se o navegador não oferecer essa opção, use outro navegador compatível. Nenhuma tentativa foi iniciada.')
        }
        return
      } finally {
        preparandoTelaCheia.current = false
      }
    }
    startingRef.current = true
    try {
      const started = await iniciarTentativa(avaliacao.id, chaveExecucao, withPhotos)
      attemptRef.current = started
      if (blockReasonRef.current) {
        void block(blockReasonRef.current)
        return
      }
      if (!activeRef.current) return
      setTentativa(started)
      setNow(() => Date.now())
      setPhase('em-andamento')
      if (withPhotos) {
        const ready = await photos.prepare(started.id, chaveExecucao)
        if (!activeRef.current || blockedRef.current || !ready) return
      }
      void loadContent(started)
    } catch (cause) {
      handleExecutionFailure(cause)
      if (activeRef.current && !blockedRef.current) {
        if (!attemptRef.current) {
          startingRef.current = false
          sairTelaCheia()
          stop()
        }
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
      const ready = await photos.prepare(current.id, chaveExecucao)
      if (ready && activeRef.current && !blockedRef.current && !conteudo) await loadContent(current)
    } catch (cause) {
      handleExecutionFailure(cause)
      if (activeRef.current && !blockedRef.current) setError('Não foi possível preparar o envio das fotos. Tente novamente nesta página.')
    }
  }

  function updateResponse(questionId: string, state: EstadoResposta) {
    savedRef.current = { ...savedRef.current, [questionId]: state }
    setSaved(savedRef.current)
  }

  function checkAvailable() {
    const current = attemptRef.current
    if (!activeRef.current || !current || blockedRef.current || closedRef.current ||
        Date.now() >= Date.parse(current.limite_em)) {
      throw new Error('A tentativa está indisponível ou fora do prazo.')
    }
  }

  async function sendResponse(payload: DadosRespostaTentativa) {
    checkAvailable()
    const previous = savedRef.current[payload.questao_id] ?? {}
    updateResponse(payload.questao_id, { ...previous, pendente: payload })
    let result: RespostaTentativa
    try {
      result = await salvarRespostaTentativa(payload, chaveExecucao)
    } catch (cause) {
      handleExecutionFailure(cause)
      if (activeRef.current && !blockedRef.current) {
        let failed: EstadoResposta = { ...previous, pendente: payload, falha: true }
        if (cause instanceof ErroSalvamentoResposta && cause.codigo === 'CONFLITO') {
          failed = { salva: previous.salva, conflito: true, falha: true }
        }
        // Uma recusa na repetição não esclarece o resultado do primeiro envio.
        if (cause instanceof ErroSalvamentoResposta && cause.codigo === 'RECUSADA') {
          failed = { ...previous, falha: true }
        }
        updateResponse(payload.questao_id, failed)
      }
      throw cause
    }
    if (activeRef.current && !blockedRef.current) updateResponse(payload.questao_id, { salva: result })
    checkAvailable()
  }

  async function saveAnswer(question: QuestaoTentativa) {
    checkAvailable()
    const current = attemptRef.current
    if (!current) throw new Error('Tentativa indisponível.')
    const previous = savedRef.current[question.id]
    if (previous?.conflito) throw new Error(`Confira a resposta salva da questão ${question.ordem} antes de enviar.`)
    // Confirma o envio anterior antes de usar a próxima versão, mesmo se o aluno editou o campo após a falha.
    if (previous?.pendente) await sendResponse(previous.pendente)
    const value = answerRef.current[question.id] ?? ''
    const confirmed = savedRef.current[question.id]?.salva
    if (value === valorResposta(confirmed)) return
    await sendResponse({
      tentativa_id: current.id, questao_id: question.id, versao: (confirmed?.versao ?? 0) + 1,
      alternativa_id: question.tipo === 'OBJETIVA' ? value || null : null,
      texto: question.tipo === 'DISSERTATIVA' ? value || null : null,
    })
  }

  async function reviewResponse(question: QuestaoTentativa) {
    const current = attemptRef.current
    if (!current || savingRef.current || blockedRef.current) return
    savingRef.current = true
    setBusyQuestion(question.id)
    setError('')
    setNotice('')
    try {
      const responses = await consultarRespostasTentativa(current.id, chaveExecucao)
      checkAvailable()
      const response = responses.find(item => item.questao_id === question.id)
      if (response) conferirQuestao(response, [question])
      updateResponse(question.id, { salva: response, conferida: true })
      setNotice(`Resposta da questão ${question.ordem} conferida. Sua resposta no formulário foi mantida.`)
    } catch (cause) {
      handleExecutionFailure(cause)
      if (activeRef.current && !blockedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível conferir a resposta.')
    } finally {
      savingRef.current = false
      if (activeRef.current) setBusyQuestion(null)
    }
  }

  async function saveQuestion(question: QuestaoTentativa, automatic = false) {
    if (savingRef.current || blockedRef.current) return
    savingRef.current = true
    setBusyQuestion(question.id)
    if (!automatic) {
      setError('')
      setNotice('')
    }
    try {
      await saveAnswer(question)
      checkAvailable()
      if (!automatic && (answerRef.current[question.id] ?? '') === valorResposta(savedRef.current[question.id]?.salva)) {
        setNotice(`Resposta da questão ${question.ordem} salva.`)
      }
    } catch (cause) {
      if (activeRef.current && !blockedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a resposta.')
    } finally {
      savingRef.current = false
      if (activeRef.current) setBusyQuestion(null)
    }
  }

  async function finish() {
    const current = attemptRef.current
    if (!current || !conteudo || savingRef.current || blockedRef.current) return
    savingRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      for (const question of conteudo.questoes) {
        await saveAnswer(question)
      }
      checkAvailable()
      const photosConfirmed = !withPhotos || await photos.flush()
      checkAvailable()
      const incidentsConfirmed = await ocorrencias.retry()
      checkAvailable()
      await encerrarTentativa(current.id, 'ENVIO', chaveExecucao)
      if (closedRef.current) return
      closedRef.current = true
      photos.dispose()
      stop()
      sairTelaCheia()
      if (activeRef.current) onLeave(`${prova ? 'Prova' : 'Atividade'} enviada. A tentativa foi encerrada.` +
        (!photosConfirmed ? ' Algumas fotos ficaram sem confirmação. Informe o professor.' : '') +
        (!incidentsConfirmed ? ' Há ocorrências sem confirmação de registro. Informe o professor.' : ''))
    } catch (cause) {
      handleExecutionFailure(cause)
      if (activeRef.current && !blockedRef.current) setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar o envio.')
    } finally {
      savingRef.current = false
      if (activeRef.current) setBusy(false)
    }
  }

  async function leave() {
    const current = attemptRef.current
    if (!current || blockedRef.current || savingRef.current) return
    await block('SAIDA')
  }

  const handleAnswerChange = useCallback((question: QuestaoTentativa, value: string) => {
    if (busy || blockedRef.current || closedRef.current) return
    const next = { ...answerRef.current, [question.id]: value }
    answerRef.current = next
    saveAtRef.current[question.id] = Date.now() + (question.tipo === 'DISSERTATIVA' ? 800 : 0)
    setAnswers(next)
    setNotice('')
  }, [busy])

  const saveAutomatically = useEffectEvent((question: QuestaoTentativa) => {
    void saveQuestion(question, true)
  })

  useEffect(() => {
    if (phase !== 'em-andamento' || !conteudo || busy || busyQuestion || confirmation) return
    let nextQuestion: QuestaoTentativa | undefined
    let nextTime = Infinity
    for (const question of conteudo.questoes) {
      const state = saved[question.id]
      if (state?.falha || state?.pendente || state?.conflito || state?.conferida ||
          (answers[question.id] ?? '') === valorResposta(state?.salva)) continue
      const time = saveAtRef.current[question.id] ?? Date.now()
      if (time < nextTime) { nextQuestion = question; nextTime = time }
    }
    if (!nextQuestion) return
    const question = nextQuestion
    // Um envio por vez. Editar outra questão não reinicia o prazo da primeira.
    const timer = window.setTimeout(() => saveAutomatically(question), Math.max(0, nextTime - Date.now()))
    return () => window.clearTimeout(timer)
  }, [answers, saved, conteudo, phase, busy, busyQuestion, confirmation])

  const remaining = tentativa ? Date.parse(tentativa.limite_em) - now : 0
  return <section className="provas-panel tentativa-aluno" aria-labelledby="tentativa-monitorada-title">
    <h1 id="tentativa-monitorada-title">{avaliacao.titulo}</h1>
    <p className="turmas-note">{avaliacao.turma_nome} · Tentativa única, sem retomada.</p>
    {withPhotos && phase !== 'bloqueada' && <>
      <p className="turmas-note">A câmera deve permanecer disponível. As fotos são enviadas para análise manual do responsável, com acesso restrito.</p>
      <div className="provas-camera provas-camera-small">
        <video ref={videoRef} autoPlay muted playsInline aria-label="Câmera durante a avaliação" />
      </div>
      <p role={cameraStatus === 'error' || cameraStatus === 'interrupted' ? 'alert' : 'status'}
        className={cameraStatus === 'error' || cameraStatus === 'interrupted' ? 'alert error' : 'turmas-note'}>{cameraMessage}</p>
    </>}
    {prova && phase === 'em-andamento' && <>
      {cameraStatus !== 'ready' && <div className="provas-aviso">
        <p>{withPhotos && !photos.initialReady
          ? 'Reconecte a câmera para obter a foto inicial. O prazo continua correndo.'
          : 'A câmera está indisponível. Você pode continuar respondendo e enviar a prova.'}</p>
        <button type="button" className="turmas-refresh" disabled={busy || cameraStatus === 'requesting'}
          onClick={() => void start()}>Reconectar câmera</button>
      </div>}
      {ocorrencias.message && <p role="status">{ocorrencias.message}</p>}
      {ocorrencias.pending > 0 && <button type="button" className="turmas-refresh"
        disabled={busy || ocorrencias.busy} onClick={() => void ocorrencias.retry()}>Reenviar ocorrência</button>}
    </>}

    {phase === 'preparo' && <form className="turma-form avaliacao-form" onSubmit={begin} aria-label="Preparar tentativa">
      <p>{prova && 'Ligue a câmera e confirme que sua imagem aparece antes de iniciar. '}O prazo começa após a confirmação do servidor.</p>
      <div className="provas-aviso">
        {prova && <p>{MONITORING_NOTICE}</p>}
        {withPhotos && <p>{PHOTO_NOTICE}</p>}
        <p className="provas-permanencia" id={`${noticeId}-permanencia`}>{DEPARTURE_WARNING}</p>
        <p>Leia os <a href="/termos" target="_blank" rel="noreferrer">Termos de Uso</a> e a <a href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</a>.</p>
        <label className="provas-aceite" htmlFor={noticeId}>
          <input id={noticeId} type="checkbox" checked={noticeAcknowledged} aria-describedby={`${noticeId}-permanencia`}
            onChange={event => setNoticeAcknowledged(event.target.checked)} />
          <span>{prova ? `Li o aviso da prova (${PROVA_NOTICE_VERSION}), os Termos e a Política e estou ciente do monitoramento e do uso das respostas.`
            : `Li o aviso da atividade (${EXAM_NOTICE_VERSION}), os Termos e a Política e estou ciente da tentativa única e do uso das respostas.`}</span>
        </label>
        {withPhotos && <label className="provas-aceite" htmlFor={`${noticeId}-fotos`}>
          <input id={`${noticeId}-fotos`} type="checkbox" checked={photosAcknowledged}
            onChange={event => setPhotosAcknowledged(event.target.checked)} />
          <span>Autorizo especificamente a captura e o envio de uma foto inicial e três durante esta demonstração voluntária, para análise manual pelo professor responsável ou ADM da minha organização, por até 90 dias por foto ({PHOTO_NOTICE_VERSION}). Posso cancelar antes de iniciar e solicitar revogação e exclusão pelo contato da Política.</span>
        </label>}
      </div>
      {withPhotos && <button type="button" className="turmas-refresh" onClick={() => void start()} disabled={cameraStatus === 'requesting'}>Testar câmera</button>}{' '}
      {withPhotos && cameraStatus === 'ready' && <button type="button" className="turmas-refresh" onClick={reportNoImage}>Minha imagem ficou preta</button>}
      <p id={`${noticeId}-preparo`} className="provas-note" aria-live="polite">
        {prova && !withPhotos ? 'A coleta de fotos está indisponível neste ambiente. A prova poderá ser iniciada quando o serviço estiver disponível.'
          : podeIniciar ? prova ? 'Ao confirmar, o navegador solicitará a tela cheia.' : 'Tudo pronto para iniciar a atividade.'
          : 'Confirme os avisos acima para iniciar.'}
      </p>
      <div className="avaliacao-form-actions">
        <button type="submit" className="btn-primary" aria-describedby={`${noticeId}-preparo`}
          disabled={!podeIniciar}>Confirmar início</button>
        <button type="button" className="turmas-refresh" ref={cancelButton} onClick={() => { stop(); onCancelar() }}>Cancelar</button>
      </div>
    </form>}
    {phase === 'iniciando' && <p role="status">Confirmando início da tentativa...</p>}
    {phase === 'falhou' && <button type="button" className="turmas-refresh" onClick={() => { stop(); onCancelar() }}>Voltar às avaliações</button>}
    {phase === 'em-andamento' && tentativa && <p className="tentativa-prazo" role="timer">Tempo restante: {relogio(remaining)}</p>}
    {phase !== 'bloqueada' && error && <p className="alert error" role="alert">{error}</p>}
    {notice && <p className="alert success" role="status">{notice}</p>}
    {withPhotos && phase === 'em-andamento' && <div className="provas-fotos-status">
      <p role="status">{photos.message || (photos.initialReady ? 'Foto inicial recebida. As próximas capturas acontecem durante a prova.' : 'Aguardando confirmação da foto inicial antes de mostrar as questões.')}</p>
      {(photos.pending > 0 || !photos.initialReady) && <button type="button" className="turmas-refresh"
        disabled={busy || photos.preparing || (photos.pending === 0 && cameraStatus !== 'ready')} onClick={() => void retryPhotos()}>
        {photos.pending > 0 ? `Reenviar fotos (${photos.pending})` : 'Preparar envio das fotos'}
      </button>}
    </div>}
    {withPhotos && photos.toast && phase === 'em-andamento' && <div className="provas-photo-toast" role="status">{photos.toast}</div>}

    {phase === 'bloqueada' && <div className="provas-cover" role="alert">
      <h2 ref={blockHeading} tabIndex={-1}>{blockReason === 'CANCELAMENTO' ? 'Avaliação cancelada' : `${prova ? 'Prova' : 'Atividade'} bloqueada`}</h2>
      <p>{blockReason && BLOCK_MESSAGES[blockReason]}</p>
      {error && <p>{error}</p>}
      <div className="provas-actions">
        {error && blockReason && <button type="button" className="turmas-refresh" onClick={() => void block(blockReason)}>Tentar registrar encerramento</button>}
        <button type="button" className="turmas-refresh" onClick={onCancelar}>Voltar às avaliações</button>
      </div>
    </div>}

    {phase === 'em-andamento' && (!withPhotos || photos.initialReady) && <>
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
                  checked={answers[question.id] === option.id} disabled={busy}
                  onChange={() => handleAnswerChange(question, option.id)} />
                {option.texto}
              </label>)}
            </fieldset> : <label className="provas-discursiva">Resposta da questão {question.ordem}
              <textarea value={answers[question.id] ?? ''} maxLength={10000} disabled={busy}
                onChange={event => handleAnswerChange(question, event.target.value)} />
            </label>}
            {saved[question.id]?.conflito && <p className="alert error" role="alert">O salvamento foi recusado. Confira a resposta salva antes de reenviar.</p>}
            {saved[question.id]?.pendente && !busyQuestion && !busy && <p role="status">Salvamento sem confirmação. O reenvio confirma a resposta anterior antes de salvar alterações.</p>}
            {saved[question.id]?.falha && !saved[question.id]?.pendente && !saved[question.id]?.conflito &&
              <p role="status">Salvamento automático pausado. Tente salvar novamente.</p>}
            {saved[question.id]?.conferida && <div className="provas-aviso">
              <strong>Resposta no servidor</strong>
              <p className="questao-enunciado">{question.tipo === 'OBJETIVA'
                ? question.alternativas.find(option => option.id === saved[question.id]?.salva?.alternativa_id)?.texto ?? 'Em branco'
                : saved[question.id]?.salva?.texto ?? 'Em branco'}</p>
            </div>}
            {saved[question.id]?.conflito && <button type="button" className="turmas-refresh"
              disabled={busy || Boolean(busyQuestion)} onClick={() => void reviewResponse(question)}>Conferir resposta salva</button>}
            <button type="button" className="turmas-refresh" aria-live="polite" disabled={busy || Boolean(busyQuestion) || saved[question.id]?.conflito ||
              (!saved[question.id]?.pendente && (answers[question.id] ?? '') === valorResposta(saved[question.id]?.salva))}
              onClick={() => void saveQuestion(question)}>
              {busyQuestion === question.id ? 'Aguarde...' : saved[question.id]?.pendente ? 'Reenviar resposta'
                : !saved[question.id]?.conflito && saved[question.id]?.salva && (answers[question.id] ?? '') === valorResposta(saved[question.id]?.salva)
                  ? 'Resposta salva' : 'Salvar resposta'}
            </button>
          </li>)}
        </ol>
        <div className="avaliacao-form-actions">
          <button type="button" className="btn-primary" disabled={busy || Boolean(busyQuestion)} onClick={() => setConfirmation('ENVIO')}>
            {busy ? 'Enviando...' : `Enviar ${prova ? 'prova' : 'atividade'}`}
          </button>
          <button type="button" className="turmas-refresh" disabled={busy || Boolean(busyQuestion)} onClick={() => setConfirmation('SAIDA')}>Sair e encerrar</button>
          {prova && <button type="button" className="turmas-refresh" disabled={busy || cameraStatus !== 'ready'} onClick={reportNoImage}>Minha imagem ficou preta</button>}
        </div>
      </>}
    </>}
    {legalDocument && <LegalModal documentType={legalDocument} onClose={() => setLegalDocument(null)} />}
    {confirmation && phase === 'em-andamento' && <ConfirmarEncerramento action={confirmation} prova={prova}
      onCancel={() => setConfirmation(null)} onConfirm={() => {
        setConfirmation(null)
        if (confirmation === 'ENVIO') void finish()
        else void leave()
      }} />}
  </section>
}
