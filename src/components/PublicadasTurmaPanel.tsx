import { useEffect, useRef, useState } from 'react'
import { listarAvaliacoesPublicadas } from '../services/avaliacoes'
import type { AvaliacaoPublicada } from '../services/avaliacaoValidation'

export function PublicadasTurmaPanel({ turmaId, turmaNome, atualizacao }: { turmaId: string; turmaNome: string; atualizacao: number }) {
  const [avaliacoes, setAvaliacoes] = useState<AvaliacaoPublicada[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
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

  return (
    <section id={`publicadas-${turmaId}`} className="publicadas-turma" aria-label={`Publicadas de ${turmaNome}`}>
      <div className="turmas-list-heading">
        <h4 ref={heading} tabIndex={-1}>Avaliações publicadas</h4>
        <button type="button" className="turmas-refresh" disabled={loading}
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
              <th scope="col">Título</th><th scope="col">Tipo</th><th scope="col">Início</th>
              <th scope="col">Fim</th><th scope="col">Duração</th><th scope="col">Publicada em</th>
            </tr></thead>
            <tbody>{avaliacoes.map((avaliacao) => <tr key={avaliacao.id}>
              <th scope="row">{avaliacao.titulo}</th>
              <td>{avaliacao.tipo === 'PROVA' ? 'Prova' : 'Atividade'}</td>
              {[avaliacao.inicio_em, avaliacao.fim_em].map((data) => <td key={data}><time dateTime={data}>
                {new Date(data).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </time></td>)}
              <td>{avaliacao.duracao_minutos} min</td>
              <td><time dateTime={avaliacao.publicada_em}>
                {new Date(avaliacao.publicada_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </time></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}
