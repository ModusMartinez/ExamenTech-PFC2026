import { useEffect, useRef, useState } from 'react'
import { listarAlternativasRascunho } from '../services/alternativas'
import type { AlternativaRascunho } from '../services/alternativaValidation'
import type { QuestaoRascunho } from '../services/questaoValidation'
import { AlternativasForm } from './AlternativasForm'

export function AlternativasQuestaoPanel({ questao, podeCadastrar, onCancelar }: {
  questao: QuestaoRascunho; podeCadastrar: boolean; onCancelar: () => void
}) {
  const [alternativas, setAlternativas] = useState<AlternativaRascunho[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [refresh, setRefresh] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  const formularioAberto = !loading && !error && alternativas.length === 0 && podeCadastrar

  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => { if (success) notice.current?.focus() }, [success])
  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const result = await listarAlternativasRascunho(questao.id)
        if (active) setAlternativas(result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Não foi possível consultar as alternativas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [questao.id, refresh])

  return (
    <section id={`alternativas-${questao.id}`} className="alternativas-questao" aria-label={`Alternativas da questão ${questao.ordem}`}>
      <div className="turmas-list-heading">
        <h6 ref={heading} tabIndex={-1}>Alternativas da questão {questao.ordem}</h6>
        <button type="button" className="turmas-refresh" disabled={loading || formularioAberto}
          onClick={() => { setSuccess(''); setRefresh((current) => current + 1) }}>Atualizar alternativas</button>
      </div>
      {loading && <p role="status">Carregando alternativas...</p>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {success && <p ref={notice} tabIndex={-1} className="alert success" role="status">{success}</p>}
      {formularioAberto && <AlternativasForm questaoId={questao.id} onCancelar={onCancelar} onSalvo={(result) => {
        setAlternativas(result)
        setSuccess(`Alternativas da questão ${questao.ordem} cadastradas.`)
      }} />}
      {!loading && !error && alternativas.length === 0 && !podeCadastrar && <p role="status">Nenhuma alternativa nesta questão.</p>}
      {!loading && !error && alternativas.length > 0 && (
        <ol className="alternativas-lista" type="A" aria-label={`Alternativas da questão ${questao.ordem}`}>
          {alternativas.map((item) => <li key={item.id}>
            <p className="questao-enunciado">{item.texto}</p>
            {item.correta && <strong className="alternativa-gabarito">Correta</strong>}
          </li>)}
        </ol>
      )}
    </section>
  )
}
