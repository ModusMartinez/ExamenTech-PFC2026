import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { AvaliacaoAluno } from '../services/avaliacaoValidation'
import type { ConteudoTentativa, TentativaIniciada } from '../services/tentativaValidation'
import { consultarConteudoTentativa, iniciarTentativa } from '../services/tentativas'
import '../styles/turmas.css'

export function TentativaAlunoPanel({ avaliacao, onCancelar }: { avaliacao: AvaliacaoAluno; onCancelar: () => void }) {
  const [inicio, setInicio] = useState<'confirmacao' | 'enviando' | 'iniciada' | 'falhou'>('confirmacao')
  const [tentativa, setTentativa] = useState<TentativaIniciada | null>(null)
  const [conteudo, setConteudo] = useState<ConteudoTentativa | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [error, setError] = useState('')
  const [agora, setAgora] = useState(() => Date.now())
  const active = useRef(false)
  const inicioSolicitado = useRef(false)
  const consultando = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  const contentHeading = useRef<HTMLHeadingElement>(null)
  const expirada = tentativa !== null && agora >= Date.parse(tentativa.limite_em)

  useEffect(() => {
    active.current = true
    cancel.current?.focus()
    return () => { active.current = false }
  }, [])
  useEffect(() => { if (error || expirada) notice.current?.focus() }, [error, expirada])
  useEffect(() => { if (conteudo && !expirada) contentHeading.current?.focus() }, [conteudo, expirada])
  useEffect(() => {
    if (!tentativa) return
    const timer = window.setInterval(() => setAgora(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [tentativa])

  async function carregarConteudo(atual: TentativaIniciada) {
    if (consultando.current || Date.now() >= Date.parse(atual.limite_em)) return
    consultando.current = true
    setCarregando(true)
    setError('')
    setConteudo(null)
    try {
      const result = await consultarConteudoTentativa(atual.id)
      if (result.avaliacao_id !== atual.avaliacao_id || result.iniciada_em !== atual.iniciada_em || result.limite_em !== atual.limite_em) {
        throw new Error('Não foi possível conferir o conteúdo da tentativa.')
      }
      if (active.current) {
        setAgora(Date.now())
        setConteudo(result)
      }
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : 'Não foi possível carregar o conteúdo da tentativa.')
    } finally {
      consultando.current = false
      if (active.current) setCarregando(false)
    }
  }

  async function confirmarInicio(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inicioSolicitado.current) return
    inicioSolicitado.current = true
    setInicio('enviando')
    setError('')
    try {
      const result = await iniciarTentativa(avaliacao.id)
      if (!active.current) return
      setAgora(Date.now())
      setTentativa(result)
      setInicio('iniciada')
      void carregarConteudo(result)
    } catch (error) {
      if (active.current) {
        setInicio('falhou')
        setError(error instanceof Error ? error.message : 'Não foi possível confirmar o início da tentativa.')
      }
    }
  }

  return (
    <section className="turmas-panel tentativa-aluno" aria-labelledby="tentativa-title">
      <h1 id="tentativa-title">{avaliacao.titulo}</h1>
      <p className="turmas-note">{avaliacao.turma_nome} · {avaliacao.tipo === 'PROVA' ? 'Prova' : 'Atividade'}</p>
      <p className="turmas-note">Respostas e envio ainda indisponíveis.</p>
      {(inicio === 'confirmacao' || inicio === 'enviando') && (
        <form className="turma-form avaliacao-form" aria-label="Iniciar avaliação" onSubmit={confirmarInicio}>
          <fieldset disabled={inicio === 'enviando'}>
            <legend>Iniciar avaliação</legend>
            <p className="turmas-note">Tentativa única, sem retomada. O tempo começa ao confirmar.</p>
            <p className="turmas-note">Duração: {avaliacao.duracao_minutos} min. Encerramento: <time dateTime={avaliacao.fim_em}>
              {new Date(avaliacao.fim_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
            </time>.</p>
            <div className="avaliacao-form-actions">
              <button type="submit" className="btn-primary" aria-busy={inicio === 'enviando'}>
                {inicio === 'enviando' ? 'Iniciando...' : 'Confirmar início'}
              </button>
              <button type="button" className="turmas-refresh" ref={cancel} onClick={onCancelar}>Cancelar</button>
            </div>
          </fieldset>
        </form>
      )}
      {tentativa && <p className="tentativa-prazo">Prazo: <time dateTime={tentativa.limite_em}>
        {new Date(tentativa.limite_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
      </time></p>}
      {expirada ? <p ref={notice} tabIndex={-1} role="status">Prazo da tentativa encerrado.</p> : <>
        {carregando && <p role="status">Carregando questões...</p>}
        {error && <p ref={notice} tabIndex={-1} className="alert error" role="alert">{error}</p>}
        {inicio === 'falhou' && <button type="button" className="turmas-refresh" onClick={onCancelar}>Voltar às avaliações</button>}
        {tentativa && error && !carregando && <button type="button" className="turmas-refresh"
          onClick={() => void carregarConteudo(tentativa)}>Tentar carregar questões</button>}
        {conteudo && !carregando && !error && <>
          <h2 ref={contentHeading} tabIndex={-1}>Questões</h2>
          <ol className="questoes-lista" aria-label="Questões da tentativa">
            {conteudo.questoes.map(questao => <li key={questao.id} value={questao.ordem}>
              <h3>Questão {questao.ordem}</h3>
              <p className="turmas-note">{questao.tipo === 'OBJETIVA' ? 'Objetiva' : 'Dissertativa'} · Pontuação: {questao.pontuacao.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</p>
              <p className="questao-enunciado">{questao.enunciado}</p>
              {questao.tipo === 'OBJETIVA' && <ol className="alternativas-lista" aria-label={`Alternativas da questão ${questao.ordem}`}>
                {questao.alternativas.map(alternativa => <li key={alternativa.id} value={alternativa.ordem}>
                  <p className="questao-enunciado">{alternativa.texto}</p>
                </li>)}
              </ol>}
            </li>)}
          </ol>
        </>}
      </>}
    </section>
  )
}
