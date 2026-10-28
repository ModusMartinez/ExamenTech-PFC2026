import { useEffect, useState } from 'react'
import { listarAvaliacoesRascunho } from '../services/avaliacoes'
import type { AvaliacaoRascunho } from '../services/avaliacaoValidation'

export function RascunhosTurmaPanel({ turmaId, turmaNome }: { turmaId: string; turmaNome: string }) {
  const [avaliacoes, setAvaliacoes] = useState<AvaliacaoRascunho[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

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
        <button type="button" className="turmas-refresh" disabled={loading}
          onClick={() => setRefresh((current) => current + 1)}>Atualizar rascunhos</button>
      </div>
      <p className="turmas-note">Até 50 rascunhos mais recentes. Horários: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      {loading && <p role="status">Carregando rascunhos...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && avaliacoes.length === 0 && <p role="status">Nenhum rascunho nesta turma.</p>}
      {!loading && !error && avaliacoes.length > 0 && (
        <div className="rascunhos-tabela" role="region" aria-label="Tabela de avaliações" tabIndex={0}>
          <table aria-label={`Avaliações em rascunho de ${turmaNome}`}>
            <thead><tr>
              <th scope="col">Título</th><th scope="col">Tipo</th><th scope="col">Início</th>
              <th scope="col">Fim</th><th scope="col">Duração</th><th scope="col">Situação</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
