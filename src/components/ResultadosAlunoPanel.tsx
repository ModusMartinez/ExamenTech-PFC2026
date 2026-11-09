import { useEffect, useRef, useState } from 'react'
import { consultarMeuResultado, listarMeusResultados } from '../services/resultadosAvaliacao'
import type { ResultadoAluno, ResultadoPublicado } from '../services/resultadosAvaliacao'

const formatarPontos = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })
const formatarNota = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function ResultadoDetalhe({ selecionado, onVoltar }: { selecionado: ResultadoPublicado; onVoltar: () => void }) {
  const [resultado, setResultado] = useState<ResultadoAluno | null>(null)
  const [erro, setErro] = useState('')
  const [revisao, setRevisao] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => {
    let ativo = true
    consultarMeuResultado(selecionado.tentativa_id).then(value => { if (ativo) setResultado(value) })
      .catch(cause => { if (ativo) setErro(cause instanceof Error ? cause.message : 'Não foi possível consultar o resultado.') })
    return () => { ativo = false }
  }, [selecionado.tentativa_id, revisao])

  return <section className="provas-panel resultado-aluno" aria-labelledby="resultado-aluno-title">
    <h1 id="resultado-aluno-title" ref={heading} tabIndex={-1}>{selecionado.titulo}</h1>
    <p>{selecionado.turma_nome}</p>
    <button type="button" className="btn-outline" onClick={onVoltar}>Voltar aos resultados</button>
    {erro && <>
      <p className="alert error" role="alert">{erro}</p>
      <button type="button" className="btn-outline" onClick={() => { setErro(''); setRevisao(valor => valor + 1) }}>Tentar novamente</button>
    </>}
    {!resultado && !erro && <p role="status">Carregando resultado...</p>}
    {resultado && <>
      <p><strong>Nota final {formatarNota.format(resultado.nota)} de 10</strong></p>
      <p>{formatarPontos.format(resultado.pontos_obtidos)} de {formatarPontos.format(resultado.pontos_totais)} pontos</p>
      <ol className="questoes-lista" aria-label="Questões corrigidas">
        {resultado.questoes.map(questao => <li key={questao.id} value={questao.ordem}>
          <h2>Questão {questao.ordem}</h2>
          <p className="questao-enunciado">{questao.enunciado}</p>
          <p className="questao-enunciado"><strong>Sua resposta</strong> {questao.resposta ?? 'Em branco'}</p>
          {questao.alternativas.length > 0 && <ol className="alternativas-lista" aria-label={`Alternativas da questão ${questao.ordem}`}>
            {questao.alternativas.map(alternativa => <li key={alternativa.id} className="questao-enunciado">
              {alternativa.texto}{alternativa.marcada && <strong> · Sua escolha</strong>}{alternativa.correta && <strong> · Correta</strong>}
            </li>)}
          </ol>}
          <p>Pontuação: {formatarPontos.format(questao.pontos)} de {formatarPontos.format(questao.maximo)}</p>
          {questao.comentario && <p className="questao-enunciado"><strong>Comentário do professor</strong> {questao.comentario}</p>}
        </li>)}
      </ol>
    </>}
  </section>
}

export function ResultadosAlunoPanel({ onVoltar }: { onVoltar: () => void }) {
  const [resultados, setResultados] = useState<ResultadoPublicado[] | null>(null)
  const [selecionado, setSelecionado] = useState<ResultadoPublicado | null>(null)
  const [erro, setErro] = useState('')
  const [revisao, setRevisao] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (!selecionado) heading.current?.focus() }, [selecionado])
  useEffect(() => {
    let ativo = true
    listarMeusResultados().then(value => { if (ativo) setResultados(value) })
      .catch(cause => { if (ativo) setErro(cause instanceof Error ? cause.message : 'Não foi possível consultar seus resultados.') })
    return () => { ativo = false }
  }, [revisao])

  if (selecionado) return <ResultadoDetalhe key={selecionado.tentativa_id} selecionado={selecionado} onVoltar={() => setSelecionado(null)} />
  return <section className="provas-panel resultado-aluno" aria-labelledby="resultados-aluno-title">
    <h1 id="resultados-aluno-title" ref={heading} tabIndex={-1}>Meus resultados</h1>
    <div className="avaliacao-form-actions">
      <button type="button" className="btn-outline" onClick={onVoltar}>Voltar às avaliações</button>
      <button type="button" className="btn-outline" disabled={!resultados && !erro}
        onClick={() => { setErro(''); setResultados(null); setRevisao(valor => valor + 1) }}>Atualizar resultados</button>
    </div>
    {!resultados && !erro && <p role="status">Carregando resultados...</p>}
    {erro && <p className="alert error" role="alert">{erro}</p>}
    {resultados?.length === 0 && <p role="status">Nenhum resultado foi publicado para você.</p>}
    {resultados?.map(resultado => <article className="provas-card" key={resultado.tentativa_id}>
      <h2>{resultado.titulo}</h2>
      <p>{resultado.turma_nome} · <time dateTime={resultado.publicado_em}>{new Date(resultado.publicado_em).toLocaleString('pt-BR')}</time></p>
      <button type="button" className="btn-outline" aria-label={`Ver resultado de ${resultado.titulo}`}
        onClick={() => setSelecionado(resultado)}>Ver resultado</button>
    </article>)}
  </section>
}
