import { useEffect, useRef, useState } from 'react'
import { consultarPublicacaoResultados, publicarResultadosAvaliacao } from '../services/resultadosAvaliacao'
import type { EstadoPublicacao } from '../services/resultadosAvaliacao'

const mensagens: Record<EstadoPublicacao['estado'], string> = {
  JANELA_ABERTA: 'Os resultados podem ser publicados após o fim da avaliação.',
  ENCERRAMENTO_PENDENTE: 'Aguarde o servidor finalizar as tentativas vencidas.',
  SEM_TENTATIVAS: 'Ainda não há tentativas finalizadas para publicar.',
  CORRECAO_PENDENTE: 'Conclua a correção das dissertativas antes de publicar.',
  PRONTO: 'Resultados prontos para publicar.',
  PUBLICADO: 'Resultados publicados. Cada aluno pode consultar o próprio resultado.',
}

export function PublicacaoResultadosPanel({ avaliacaoId, revisao, onPublicada }: {
  avaliacaoId: string; revisao: number; onPublicada: () => void
}) {
  const [publicacao, setPublicacao] = useState<EstadoPublicacao | null>(null)
  const [atualizacao, setAtualizacao] = useState(0)
  const [carregando, setCarregando] = useState(true)
  const [publicando, setPublicando] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  const [erro, setErro] = useState('')
  const ativo = useRef(false)
  const enviando = useRef(false)
  const confirmar = useRef<HTMLButtonElement>(null)

  useEffect(() => { ativo.current = true; return () => { ativo.current = false } }, [])
  useEffect(() => { if (confirmando) confirmar.current?.focus() }, [confirmando])
  useEffect(() => {
    let consultaAtiva = true
    async function carregar() {
      setCarregando(true)
      setErro('')
      try {
        const estado = await consultarPublicacaoResultados(avaliacaoId)
        if (consultaAtiva) {
          setPublicacao(estado)
          if (estado.estado === 'PUBLICADO') onPublicada()
        }
      } catch (cause) {
        if (consultaAtiva) {
          setPublicacao(null)
          setErro(cause instanceof Error ? cause.message : 'Não foi possível consultar a publicação.')
        }
      } finally {
        if (consultaAtiva) setCarregando(false)
      }
    }
    void carregar()
    return () => { consultaAtiva = false }
  }, [avaliacaoId, atualizacao, revisao, onPublicada])

  async function publicar() {
    if (enviando.current) return
    enviando.current = true
    setPublicando(true)
    setErro('')
    try {
      const estado = await publicarResultadosAvaliacao(avaliacaoId)
      if (ativo.current) {
        setPublicacao(estado)
        setConfirmando(false)
        onPublicada()
      }
    } catch (cause) {
      if (ativo.current) setErro(cause instanceof Error ? cause.message : 'Não foi possível confirmar a publicação.')
    } finally {
      enviando.current = false
      if (ativo.current) setPublicando(false)
    }
  }

  return <section className="resultados-publicacao" aria-label="Publicação dos resultados">
    {carregando && <p role="status">Consultando publicação dos resultados...</p>}
    {!carregando && publicacao && <p role="status">{mensagens[publicacao.estado]} {publicacao.publicado_em &&
      <time dateTime={publicacao.publicado_em}>{new Date(publicacao.publicado_em).toLocaleString('pt-BR')}</time>}</p>}
    {erro && <p role="alert" className="alert error">{erro}</p>}
    {!carregando && publicacao?.estado !== 'PUBLICADO' && <div className="avaliacao-form-actions">
      <button type="button" className="turmas-refresh" disabled={publicando}
        onClick={() => { setConfirmando(false); setAtualizacao(valor => valor + 1) }}>Atualizar publicação</button>
      {publicacao?.estado === 'PRONTO' && !confirmando && <button type="button" className="turmas-refresh"
        onClick={() => setConfirmando(true)}>Publicar resultados</button>}
    </div>}
    {!carregando && confirmando && publicacao?.estado === 'PRONTO' && <div className="provas-aviso" role="group" aria-label="Confirmar publicação dos resultados">
      <p>A publicação libera as notas e correções da avaliação para os alunos. As notas ficam bloqueadas para edição.</p>
      <div className="avaliacao-form-actions">
        <button type="button" className="turmas-refresh" ref={confirmar} disabled={publicando}
          onClick={() => void publicar()}>{publicando ? 'Publicando...' : 'Confirmar publicação'}</button>
        <button type="button" className="turmas-refresh" disabled={publicando} onClick={() => setConfirmando(false)}>Cancelar publicação</button>
      </div>
    </div>}
  </section>
}
