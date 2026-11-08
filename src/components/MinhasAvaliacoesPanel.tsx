import { useEffect, useRef, useState } from 'react'
import { listarMinhasAvaliacoes } from '../services/avaliacoes'
import type { AvaliacaoAluno } from '../services/avaliacaoValidation'
import { TentativaAlunoPanel } from './TentativaAlunoPanel'
import { TentativaMonitoradaPanel } from './TentativaMonitoradaPanel'
import { ProvaCameraDemo } from './ProvaCameraDemo'
import { examManagementEnabled } from '../services/examFeatures'
import '../styles/turmas.css'
import '../styles/provas.css'

export function MinhasAvaliacoesPanel({ onActiveChange, onLeave, layout = 'table', executionEnabled = true }: {
  onActiveChange?: (active: boolean) => void
  onLeave?: (message: string) => void
  layout?: 'table' | 'cards'
  executionEnabled?: boolean
} = {}) {
  const [avaliacoes, setAvaliacoes] = useState<AvaliacaoAluno[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selecionada, setSelecionada] = useState<AvaliacaoAluno | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (!selecionada) heading.current?.focus() }, [selecionada])

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

  if (selecionada && onActiveChange && onLeave) return <TentativaMonitoradaPanel
    key={selecionada.id} avaliacao={selecionada} onCancelar={() => setSelecionada(null)}
    onActiveChange={onActiveChange} onLeave={onLeave} />
  if (selecionada) return <TentativaAlunoPanel key={selecionada.id} avaliacao={selecionada} onCancelar={() => setSelecionada(null)} />

  if (layout === 'cards') return (
    <section className="provas-panel" aria-labelledby="minhas-provas-title">
      <header>
        <p className="overline">AVALIAÇÕES</p>
        <h1 id="minhas-provas-title" ref={heading} tabIndex={-1}>Minhas provas</h1>
        <p className="subtitle">Há uma tentativa por avaliação. Após sair ou perder a câmera, não há retorno automático.{examManagementEnabled() && ' Procure o professor responsável ou o ADM para analisar uma reativação.'}</p>
      </header>
      <ProvaCameraDemo />
      <button type="button" className="btn-outline" disabled={loading}
        onClick={() => setRefresh(current => current + 1)}>Atualizar provas</button>
      {!executionEnabled && <p className="provas-note">O início das avaliações ainda não está disponível neste ambiente. Você pode usar a simulação para testar a câmera.</p>}
      {loading && <p role="status">Carregando provas...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && avaliacoes.length === 0 && <p role="status">Não há avaliações publicadas para suas turmas ativas.</p>}
      {!loading && !error && avaliacoes.map(avaliacao => <article className="provas-card" key={avaliacao.id}>
        <h2>{avaliacao.titulo}</h2>
        <p>{avaliacao.turma_nome} · {avaliacao.tipo === 'PROVA' ? 'Prova' : 'Atividade'}</p>
        <p>Início: <time dateTime={avaliacao.inicio_em}>{new Date(avaliacao.inicio_em).toLocaleString('pt-BR')}</time> · Duração: {avaliacao.duracao_minutos} min</p>
        <p>Fim: <time dateTime={avaliacao.fim_em}>{new Date(avaliacao.fim_em).toLocaleString('pt-BR')}</time></p>
        <button type="button" className="btn-outline" disabled={!executionEnabled}
          aria-label={`Preparar ${avaliacao.tipo === 'PROVA' ? 'prova' : 'atividade'} ${avaliacao.titulo}`}
          onClick={() => setSelecionada(avaliacao)}>
          {avaliacao.tipo === 'PROVA' ? 'Preparar prova' : 'Preparar atividade'}
        </button>
      </article>)}
    </section>
  )

  return (
    <section className="turmas-panel minhas-avaliacoes" aria-labelledby="minhas-avaliacoes-title">
      <header className="turmas-list-heading">
        <h1 id="minhas-avaliacoes-title" ref={heading} tabIndex={-1}>Minhas avaliações</h1>
        <button type="button" className="turmas-refresh" disabled={loading}
          onClick={() => setRefresh((current) => current + 1)}>Atualizar</button>
      </header>
      <p className="turmas-note" role="note">Integração local: inicie somente uma avaliação de teste. O início consome a tentativa única.</p>
      <p className="turmas-note">Até 50 publicações mais recentes. Horários: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      {loading && <p role="status">Carregando avaliações...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && avaliacoes.length === 0 && <p role="status">Nenhuma avaliação publicada nas suas turmas ativas.</p>}
      {!loading && !error && avaliacoes.length > 0 && (
        <div className="rascunhos-tabela" role="region" aria-label="Tabela de minhas avaliações" tabIndex={0}>
          <table aria-label="Minhas avaliações">
            <thead><tr>
              <th scope="col">Título</th><th scope="col" className="rascunhos-coluna-acoes">Ações</th>
              <th scope="col">Turma</th><th scope="col">Tipo</th>
              <th scope="col">Início</th><th scope="col">Fim</th><th scope="col">Duração</th>
            </tr></thead>
            <tbody>{avaliacoes.map((avaliacao) => <tr key={avaliacao.id}>
              <th scope="row">{avaliacao.titulo}</th>
              <td><button type="button" className="turmas-refresh" aria-label={`Iniciar ${avaliacao.titulo}`}
                onClick={() => setSelecionada(avaliacao)}>Iniciar</button></td>
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
