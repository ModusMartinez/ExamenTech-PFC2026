import { useEffect, useRef, useState } from 'react'
import { listarAvaliacoesRascunho } from '../services/avaliacoes'
import type { AvaliacaoRascunho } from '../services/avaliacaoValidation'
import { EditarAvaliacaoForm } from './EditarAvaliacaoForm'

export function RascunhosTurmaPanel({ turmaId, turmaNome, podeEditar }: { turmaId: string; turmaNome: string; podeEditar: boolean }) {
  const [avaliacoes, setAvaliacoes] = useState<AvaliacaoRascunho[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [editando, setEditando] = useState<AvaliacaoRascunho | null>(null)
  const [success, setSuccess] = useState('')
  const editButton = useRef<HTMLButtonElement | null>(null)
  const notice = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (!editando) (success ? notice.current : editButton.current)?.focus()
  }, [editando, success])

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const result = await listarAvaliacoesRascunho(turmaId)
        if (active) setAvaliacoes(result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Não foi possível carregar os rascunhos.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [turmaId, refresh])

  return (
    <section id={`rascunhos-${turmaId}`} className="rascunhos-turma" aria-label={`Rascunhos de ${turmaNome}`}>
      <div className="turmas-list-heading">
        <h4>Avaliações em rascunho</h4>
        <button type="button" className="turmas-refresh" disabled={loading || Boolean(editando)}
          onClick={() => { setSuccess(''); setRefresh((current) => current + 1) }}>Atualizar rascunhos</button>
      </div>
      <p className="turmas-note">Até 50 rascunhos mais recentes. Horários: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      {success && <p ref={notice} tabIndex={-1} className="alert success" role="status">{success}</p>}
      {loading && <p role="status">Carregando rascunhos...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && avaliacoes.length === 0 && <p role="status">Nenhum rascunho nesta turma.</p>}
      {!loading && !error && avaliacoes.length > 0 && (
        <div className="rascunhos-tabela" role="region" aria-label="Tabela de avaliações" tabIndex={0}>
          <table aria-label={`Avaliações em rascunho de ${turmaNome}`}>
            <thead><tr>
              <th scope="col">Título</th><th scope="col">Tipo</th><th scope="col">Início</th>
              <th scope="col">Fim</th><th scope="col">Duração</th><th scope="col">Situação</th>
              {podeEditar && <th scope="col">Ações</th>}
            </tr></thead>
            <tbody>
              {avaliacoes.map((avaliacao) => (
                <tr key={avaliacao.id}>
                  <th scope="row">{avaliacao.titulo}</th>
                  <td>{avaliacao.tipo === 'PROVA' ? 'Prova' : 'Atividade'}</td>
                  <td><time dateTime={avaliacao.inicio_em}>
                    {new Date(avaliacao.inicio_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  </time></td>
                  <td><time dateTime={avaliacao.fim_em}>
                    {new Date(avaliacao.fim_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  </time></td>
                  <td>{avaliacao.duracao_minutos} min</td>
                  <td>Rascunho</td>
                  {podeEditar && <td><button type="button" className="turmas-refresh" disabled={Boolean(editando)}
                    aria-label={`Editar ${avaliacao.titulo}`} onClick={(event) => {
                      editButton.current = event.currentTarget
                      setSuccess('')
                      setEditando(avaliacao)
                    }}>Editar</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {podeEditar && editando && <EditarAvaliacaoForm key={editando.id} avaliacao={editando}
        onCancelar={() => setEditando(null)} onSalvo={(atualizada) => {
          setAvaliacoes((current) => current.map((item) => item.id === atualizada.id ? atualizada : item))
          setEditando(null)
          setSuccess(`Avaliação “${atualizada.titulo}” salva.`)
        }} />}
    </section>
  )
}
