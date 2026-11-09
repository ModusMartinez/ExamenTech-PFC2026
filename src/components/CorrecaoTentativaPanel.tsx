import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { consultarCorrecaoTentativa, LIMITE_COMENTARIO_CORRECAO, pontosCorrecaoValidos, salvarCorrecaoDissertativa } from '../services/correcoesTentativa'
import type { CorrecaoTentativa, QuestaoCorrecao } from '../services/correcoesTentativa'

const formatarPontos = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })
const formatarNota = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function CorrecaoDissertativaForm({ questao, salvando, onSalvar }: {
  questao: QuestaoCorrecao
  salvando: boolean
  onSalvar: (questao: QuestaoCorrecao, pontos: number, comentario: string) => Promise<boolean>
}) {
  const prefixo = useId()
  const campoPontos = useRef<HTMLInputElement>(null)
  const [pontos, setPontos] = useState(questao.pontos === null ? '' : String(questao.pontos))
  const [comentario, setComentario] = useState(questao.comentario ?? '')
  const [erro, setErro] = useState('')
  const [salva, setSalva] = useState(false)

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const entrada = pontos.trim()
    const valor = Number(entrada.replace(',', '.'))
    setSalva(false)
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(entrada) || !pontosCorrecaoValidos(valor, questao.maximo)) {
      setErro(`Informe de 0 a ${formatarPontos.format(questao.maximo)} pontos, com até duas casas decimais.`)
      campoPontos.current?.focus()
      return
    }
    setErro('')
    if (await onSalvar(questao, valor, comentario)) setSalva(true)
  }

  return <form className="avaliacao-form correcao-form" aria-label={`Corrigir questão ${questao.ordem}`} noValidate onSubmit={enviar}>
    <fieldset disabled={salvando}>
      <label htmlFor={`${prefixo}-pontos`}>Pontos da questão {questao.ordem}</label>
      <input id={`${prefixo}-pontos`} ref={campoPontos} inputMode="decimal" required value={pontos}
        aria-invalid={Boolean(erro)} aria-describedby={`${prefixo}-limite`}
        onChange={event => { setPontos(event.target.value); setSalva(false) }} />
      <p className="turmas-note" id={`${prefixo}-limite`}>De 0 a {formatarPontos.format(questao.maximo)}.</p>
      <label htmlFor={`${prefixo}-comentario`}>Comentário da questão {questao.ordem} (opcional)</label>
      <textarea id={`${prefixo}-comentario`} rows={3} maxLength={LIMITE_COMENTARIO_CORRECAO} value={comentario}
        onChange={event => { setComentario(event.target.value); setSalva(false) }} />
      <div className="avaliacao-form-actions">
        <button type="submit" className="turmas-refresh">Salvar correção da questão {questao.ordem}</button>
      </div>
    </fieldset>
    {erro && <p className="alert error" role="alert">{erro}</p>}
    {salva && <p role="status">Correção da questão {questao.ordem} salva.</p>}
  </form>
}

export function CorrecaoTentativaPanel({ tentativaId, alunoNome, somenteConsulta = false, onCorrecaoSalva }: {
  tentativaId: string; alunoNome: string; somenteConsulta?: boolean; onCorrecaoSalva?: () => void
}) {
  const [correcao, setCorrecao] = useState<CorrecaoTentativa | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [atualizacao, setAtualizacao] = useState(0)
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const ativo = useRef(false)
  const enviando = useRef(false)

  useEffect(() => {
    ativo.current = true
    heading.current?.focus()
    return () => { ativo.current = false }
  }, [])
  useEffect(() => {
    let consultaAtiva = true
    async function carregar() {
      setCarregando(true)
      setErro('')
      try {
        const resultado = await consultarCorrecaoTentativa(tentativaId)
        if (consultaAtiva) setCorrecao(resultado)
      } catch (cause) {
        if (consultaAtiva) {
          setCorrecao(null)
          setErro(cause instanceof Error ? cause.message : 'Não foi possível carregar a correção.')
        }
      } finally {
        if (consultaAtiva) setCarregando(false)
      }
    }
    void carregar()
    return () => { consultaAtiva = false }
  }, [tentativaId, atualizacao])

  async function salvar(questao: QuestaoCorrecao, pontos: number, comentario: string) {
    if (enviando.current) return false
    enviando.current = true
    setSalvando(true)
    setErro('')
    try {
      const resultado = await salvarCorrecaoDissertativa(tentativaId, questao, pontos, comentario)
      if (ativo.current) {
        setCorrecao(resultado)
        onCorrecaoSalva?.()
      }
      return ativo.current
    } catch (cause) {
      if (ativo.current) setErro(cause instanceof Error ? cause.message : 'Não foi possível confirmar a correção.')
      return false
    } finally {
      enviando.current = false
      if (ativo.current) setSalvando(false)
    }
  }

  return <section className="correcao-tentativa" aria-labelledby={headingId}>
    <h6 ref={heading} tabIndex={-1} id={headingId}>Correção de {alunoNome}</h6>
    <button type="button" className="turmas-refresh" disabled={carregando || salvando}
      onClick={() => setAtualizacao(valor => valor + 1)}>Atualizar correção</button>
    {carregando && <p role="status">Carregando correção...</p>}
    {salvando && <p role="status">Salvando correção...</p>}
    {erro && <p className="alert error" role="alert">{erro}</p>}
    {!carregando && correcao && <>
      <div aria-live="polite">
        <p>{formatarPontos.format(correcao.pontos_obtidos)} de {formatarPontos.format(correcao.pontos_totais)} pontos</p>
        {correcao.nota === null
          ? <p>Nota pendente · {correcao.pendentes} {correcao.pendentes === 1 ? 'dissertativa para corrigir' : 'dissertativas para corrigir'}</p>
          : <p><strong>Nota final {formatarNota.format(correcao.nota)} de 10</strong></p>}
      </div>
      <ol className="questoes-lista" aria-label="Questões para correção">
        {correcao.questoes.map(questao => <li key={questao.id} value={questao.ordem}>
          <p><strong>Questão {questao.ordem}</strong> · {questao.tipo === 'OBJETIVA' ? 'Objetiva' : 'Dissertativa'} · {formatarPontos.format(questao.maximo)} pontos</p>
          <p className="questao-enunciado">{questao.enunciado}</p>
          <p className="questao-enunciado"><strong>Resposta do aluno</strong> {questao.resposta ?? 'Em branco'}</p>
          {questao.tipo === 'OBJETIVA' && <p className="questao-enunciado"><strong>Gabarito</strong> {questao.gabarito ?? 'Indisponível'}</p>}
          {questao.pontos !== null && <p>Pontuação registrada: {formatarPontos.format(questao.pontos)} de {formatarPontos.format(questao.maximo)}</p>}
          {(somenteConsulta || correcao.publicado_em) && questao.comentario &&
            <p className="questao-enunciado"><strong>Comentário</strong> {questao.comentario}</p>}
          {!somenteConsulta && !correcao.publicado_em && questao.tipo === 'DISSERTATIVA' && questao.resposta && <CorrecaoDissertativaForm
            questao={questao} salvando={salvando} onSalvar={salvar} />}
        </li>)}
      </ol>
    </>}
  </section>
}
