import { useEffect, useRef, useState } from 'react'
import { listarQuestoesRascunho } from '../services/questoes'
import type { QuestaoRascunho } from '../services/questaoValidation'

export function QuestoesAvaliacaoPanel({ avaliacaoId, avaliacaoTitulo }: { avaliacaoId: string; avaliacaoTitulo: string }) {
  const [questoes, setQuestoes] = useState<QuestaoRascunho[]>([])
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
        const result = await listarQuestoesRascunho(avaliacaoId)
        if (active) setQuestoes(result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Não foi possível carregar as questões.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [avaliacaoId, refresh])

  return (
    <section id={`questoes-${avaliacaoId}`} className="questoes-avaliacao" aria-label={`Questões de ${avaliacaoTitulo}`}>
      <div className="turmas-list-heading">
        <h5 ref={heading} tabIndex={-1}>Questões em rascunho</h5>
        <button type="button" className="turmas-refresh" disabled={loading}
          onClick={() => setRefresh((current) => current + 1)}>Atualizar questões</button>
      </div>
      <p className="questao-avaliacao">{avaliacaoTitulo}</p>
      <p className="turmas-note">Primeiras 50 questões, em ordem de cadastro.</p>
      {loading && <p role="status">Carregando questões...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {!loading && !error && questoes.length === 0 && <p role="status">Nenhuma questão nesta avaliação.</p>}
      {!loading && !error && questoes.length > 0 && (
        <ol className="questoes-lista" aria-label={`Questões de ${avaliacaoTitulo}`}>
          {questoes.map((questao) => (
            <li key={questao.id} value={questao.ordem}>
              <h6>Questão {questao.ordem}</h6>
              <p className="turmas-note">
                {questao.tipo === 'OBJETIVA' ? 'Objetiva' : 'Dissertativa'} · Pontuação: {questao.pontuacao.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
              </p>
              <p className="questao-enunciado">{questao.enunciado}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
