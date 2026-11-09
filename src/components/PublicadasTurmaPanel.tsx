import { useEffect, useRef, useState } from 'react'
import { cancelarAvaliacao, listarAvaliacoesPublicadas } from '../services/avaliacoes'
import type { AvaliacaoPublicada } from '../services/avaliacaoValidation'
import { examManagementEnabled } from '../services/examFeatures'
import { TentativasResponsavelPanel } from './TentativasResponsavelPanel'

export function PublicadasTurmaPanel({ turmaId, turmaNome, atualizacao, podeCorrigir }: {
  turmaId: string; turmaNome: string; atualizacao: number; podeCorrigir: boolean
}) {
  const [avaliacoes, setAvaliacoes] = useState<AvaliacaoPublicada[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmando, setConfirmando] = useState(false)
  const [cancelando, setCancelando] = useState(false)
  const [erroCancelamento, setErroCancelamento] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const abrirConfirmacao = useRef<HTMLButtonElement>(null)
  const manterAvaliacao = useRef<HTMLButtonElement>(null)
  const avisoCancelamento = useRef<HTMLParagraphElement>(null)
  const gestaoAtiva = examManagementEnabled()
  const selected = avaliacoes.find(avaliacao => avaliacao.id === selectedId)
  const canceladaEm = selected?.situacao === 'CANCELADA' ? selected.cancelada_em : null
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => { if (confirmando) manterAvaliacao.current?.focus() }, [confirmando])
  useEffect(() => { if (canceladaEm) avisoCancelamento.current?.focus() }, [canceladaEm])
  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const result = await listarAvaliacoesPublicadas(turmaId)
        if (active) setAvaliacoes(result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Não foi possível carregar as publicadas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [turmaId, refresh, atualizacao])

  async function confirmarCancelamento() {
    if (!selected || selected.situacao !== 'PUBLICADA' || cancelando) return
    setCancelando(true)
    setErroCancelamento('')
    try {
      const canceladaEm = await cancelarAvaliacao(selected.id)
      setAvaliacoes(atuais => atuais.map(avaliacao => avaliacao.id === selected.id
        ? { ...avaliacao, situacao: 'CANCELADA', cancelada_em: canceladaEm }
        : avaliacao))
      setConfirmando(false)
    } catch (cause) {
      setErroCancelamento(cause instanceof Error ? cause.message : 'Não foi possível confirmar o cancelamento.')
    } finally {
      setCancelando(false)
    }
  }

  return (
    <section id={`publicadas-${turmaId}`} className="publicadas-turma" aria-label={`Publicadas de ${turmaNome}`}>
      <div className="turmas-list-heading">
        <h4 ref={heading} tabIndex={-1}>Avaliações publicadas</h4>
        <button type="button" className="turmas-refresh" disabled={loading || cancelando}
          onClick={() => setRefresh((current) => current + 1)}>Atualizar publicadas</button>
      </div>
      <p className="turmas-note">Até 50 publicações mais recentes. Horários: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      {loading && <p role="status">Carregando publicadas...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && avaliacoes.length === 0 && <p role="status">Nenhuma avaliação publicada nesta turma.</p>}
      {!loading && !error && avaliacoes.length > 0 && (
        <div className="rascunhos-tabela" role="region" aria-label="Tabela de avaliações publicadas" tabIndex={0}>
          <table aria-label={`Avaliações publicadas de ${turmaNome}`}>
            <thead><tr>
              <th scope="col">Título</th>
              {gestaoAtiva && <th scope="col" className="rascunhos-coluna-acoes">Gestão</th>}
              <th scope="col">Tipo</th><th scope="col">Início</th>
              <th scope="col">Fim</th><th scope="col">Duração</th><th scope="col">Publicada em</th>
            </tr></thead>
            <tbody>{avaliacoes.map((avaliacao) => <tr key={avaliacao.id}>
              <th scope="row">{avaliacao.titulo}</th>
              {gestaoAtiva && <td><button type="button" className="turmas-refresh" disabled={cancelando}
                aria-label={`Gerenciar ${avaliacao.titulo}`} aria-expanded={selectedId === avaliacao.id} onClick={() => {
                  setSelectedId(value => value === avaliacao.id ? null : avaliacao.id)
                  setConfirmando(false)
                  setErroCancelamento('')
                }}>Gerenciar</button></td>}
              <td>{avaliacao.tipo === 'PROVA' ? 'Prova' : 'Atividade'}</td>
              {[avaliacao.inicio_em, avaliacao.fim_em].map((data) => <td key={data}><time dateTime={data}>
                {new Date(data).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </time></td>)}
              <td>{avaliacao.duracao_minutos} min</td>
              <td><time dateTime={avaliacao.publicada_em}>
                {new Date(avaliacao.publicada_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </time>{avaliacao.situacao === 'CANCELADA' && <div>Cancelada</div>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      {gestaoAtiva && selected && <>
        <div className="provas-gestao" aria-label={selected.titulo}>
          <h4>{selected.titulo}</h4>
          {canceladaEm && <p ref={avisoCancelamento} tabIndex={-1} role="status">Avaliação cancelada em{' '}
            <time dateTime={canceladaEm}>{new Date(canceladaEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</time>.
          </p>}
          {podeCorrigir && selected.situacao === 'PUBLICADA' && <>
            <button type="button" className="turmas-refresh" ref={abrirConfirmacao} aria-expanded={confirmando}
              disabled={confirmando} onClick={() => setConfirmando(true)}>Cancelar avaliação</button>
            {confirmando && <div className="provas-aviso" role="group" aria-label="Confirmar cancelamento da avaliação">
              <p>As tentativas em andamento serão encerradas e novas tentativas ficarão bloqueadas. As respostas já salvas serão preservadas.</p>
              {erroCancelamento && <p className="alert error" role="alert">{erroCancelamento}</p>}
              <div className="avaliacao-form-actions">
                <button type="button" className="turmas-refresh" ref={manterAvaliacao} disabled={cancelando} onClick={() => {
                  setConfirmando(false)
                  setErroCancelamento('')
                  requestAnimationFrame(() => abrirConfirmacao.current?.focus())
                }}>Manter avaliação</button>
                <button type="button" className="turmas-refresh" disabled={cancelando}
                  onClick={() => void confirmarCancelamento()}>{cancelando ? 'Cancelando...' : 'Confirmar cancelamento'}</button>
              </div>
            </div>}
          </>}
        </div>
        <TentativasResponsavelPanel key={`${selected.id}-${selected.situacao}`} avaliacaoId={selected.id}
          podeCorrigir={podeCorrigir} avaliacaoCancelada={selected.situacao === 'CANCELADA'} />
      </>}
    </section>
  )
}
