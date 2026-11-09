import { useState } from 'react'
import { useCameraSession } from '../hooks/useCameraSession'
import '../styles/provas.css'

export function ProvaCameraDemo() {
  const { videoRef, status, message, start, stop, reportNoImage } = useCameraSession()
  const [started, setStarted] = useState(false)
  const [answer, setAnswer] = useState('')
  const [finished, setFinished] = useState(false)

  function reset() {
    stop()
    setStarted(false)
    setAnswer('')
    setFinished(false)
  }

  return <section className="provas-card provas-demo" aria-labelledby="provas-demo-titulo">
    <h2 id="provas-demo-titulo">Teste local da câmera durante a prova</h2>
    <p>Simulação local com uma questão de exemplo. Não inicia tentativa, salva respostas ou envia fotos.</p>

    <div className="provas-camera provas-camera-small">
      <video ref={videoRef} autoPlay muted playsInline aria-label="Câmera na simulação da prova" />
    </div>
    <p className={status === 'error' || status === 'interrupted' ? 'alert error' : 'provas-note'}
      role={status === 'error' || status === 'interrupted' ? 'alert' : 'status'}>{message}</p>

    <div className="provas-actions">
      <button type="button" className="btn-outline" disabled={status === 'requesting'}
        onClick={() => void start()}>{started ? 'Reconectar câmera' : 'Ligar câmera para simulação'}</button>
      {!started && status === 'ready' && <button type="button" className="btn-primary"
        onClick={() => { setStarted(true); setFinished(false) }}>Iniciar teste local</button>}
      {(started || status !== 'idle' || finished) && <button type="button" className="btn-outline"
        onClick={reset}>Encerrar simulação</button>}
    </div>

    {started && status !== 'ready' && <div className="provas-aviso" role="status">
      <p>A câmera está indisponível. A questão continua disponível. Na prova real, a falha gera uma ocorrência.</p>
    </div>}

    {started && <div className="provas-demo-question">
      <h3>Questão de exemplo</h3>
      <fieldset>
        <legend>Quanto é 2 + 2?</legend>
        {['3', '4', '5'].map((option) => <label key={option}>
          <input type="radio" name="demo-resposta" value={option} checked={answer === option}
            onChange={() => setAnswer(option)} /> {option}
        </label>)}
      </fieldset>
      <div className="provas-actions">
        <button type="button" className="btn-outline" onClick={reportNoImage}>Minha imagem ficou preta</button>
        <button type="button" className="btn-primary" disabled={!answer}
          onClick={() => { stop(); setStarted(false); setFinished(true) }}>Concluir teste</button>
      </div>
    </div>}
    {finished && <p className="alert success" role="status">Teste concluído. Nenhuma tentativa ou resposta foi registrada.</p>}
  </section>
}
