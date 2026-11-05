import { useEffect, useRef, useState } from 'react'
import { listarMinhasAvaliacoes } from '../services/avaliacoes'
import type { AvaliacaoAluno } from '../services/avaliacaoValidation'
import '../styles/turmas.css'

export function MinhasAvaliacoesPanel() {
  const [avaliacoes, setAvaliacoes] = useState<AvaliacaoAluno[]>([])
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
        const result = await listarMinhasAvaliacoes()
        if (active) setAvaliacoes(result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Não foi possível carregar suas avaliações.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [refresh])

  return (
    <section className="turmas-panel minhas-avaliacoes" aria-labelledby="minhas-avaliacoes-title">
      <header className="turmas-list-heading">
        <h1 id="minhas-avaliacoes-title" ref={heading} tabIndex={-1}>Minhas avaliações</h1>
        <button type="button" className="turmas-refresh" disabled={loading}
          onClick={() => setRefresh((current) => current + 1)}>Atualizar</button>
      </header>
      <p className="turmas-note">Até 50 publicações mais recentes. Horários: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      {loading && <p role="status">Carregando avaliações...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && avaliacoes.length === 0 && <p role="status">Nenhuma avaliação publicada nas suas turmas ativas.</p>}
      {!loading && !error && avaliacoes.length > 0 && (
        <div className="rascunhos-tabela" role="region" aria-label="Tabela de minhas avaliações" tabIndex={0}>
          <table aria-label="Minhas avaliações">
            <thead><tr>
              <th scope="col">Título</th><th scope="col">Turma</th><th scope="col">Tipo</th>
              <th scope="col">Início</th><th scope="col">Fim</th><th scope="col">Duração</th>
            </tr></thead>
            <tbody>{avaliacoes.map((avaliacao) => <tr key={avaliacao.id}>
              <th scope="row">{avaliacao.titulo}</th>
              <td>{avaliacao.turma_nome}</td>
              <td>{avaliacao.tipo === 'PROVA' ? 'Prova' : 'Atividade'}</td>
              {[avaliacao.inicio_em, avaliacao.fim_em].map((data) => <td key={data}><time dateTime={data}>
                {new Date(data).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </time></td>)}
              <td>{avaliacao.duracao_minutos} min</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}
