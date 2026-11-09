import { useState } from 'react'
import { useCameraSession } from '../hooks/useCameraSession'
import '../styles/preProva.css'

export function PreProvaPanel() {
  const { videoRef, status, message, start, stop, reportNoImage } = useCameraSession()
  const [practiceAnswer, setPracticeAnswer] = useState('')
  const [practiceChecked, setPracticeChecked] = useState(false)

  return (
    <section className="pre-prova" aria-labelledby="pre-prova-title">
      <header>
        <p className="overline">PREPARAÇÃO</p>
        <h1 id="pre-prova-title">Pré-prova</h1>
        <p className="subtitle">
          Treine com uma questão de exemplo e confira sua câmera antes de realizar uma avaliação.
          Estas atividades não iniciam uma prova e não registram respostas ou imagens.
        </p>
      </header>

      <div className="pre-prova-card">
        <h2>Treino rápido</h2>
        <p>Marque uma alternativa para conhecer a interação básica. Este exercício não vale nota.</p>
        <fieldset className="pre-prova-question">
          <legend>Questão de exemplo: quanto é 2 + 3?</legend>
          {['4', '5', '6'].map((answer) => (
            <label key={answer}>
              <input
                type="radio"
                name="practice-answer"
                value={answer}
                checked={practiceAnswer === answer}
                onChange={() => { setPracticeAnswer(answer); setPracticeChecked(false) }}
              />
              {answer}
            </label>
          ))}
        </fieldset>
        <button type="button" className="pre-prova-secondary" disabled={!practiceAnswer} onClick={() => setPracticeChecked(true)}>
          Verificar resposta
        </button>
        {practiceChecked && (
          <p className={practiceAnswer === '5' ? 'pre-prova-status' : 'pre-prova-feedback'} role="status">
            {practiceAnswer === '5' ? 'Correto! Você marcou uma alternativa.' : 'A resposta do exemplo é 5. Você pode escolher outra alternativa e tentar de novo.'}
          </p>
        )}
      </div>

      <div className="pre-prova-card">
        <h2>Teste opcional da câmera</h2>
        <p>A câmera não é necessária para o treino acima. Confira se ela funciona antes de uma prova real.</p>
        <ol>
          <li>Feche outros aplicativos que possam estar usando a câmera.</li>
          <li>Clique em “Testar câmera” e permita o acesso quando o navegador pedir.</li>
          <li>Confira se sua imagem aparece abaixo. Depois, desligue a câmera.</li>
        </ol>
        <p className="pre-prova-privacy">
          A imagem é mostrada somente neste navegador. Este teste não tira fotos, não grava vídeo,
          não usa o microfone e não envia imagens ao sistema. Consulte a{' '}
          <a href="/privacidade" target="_blank" rel="noopener noreferrer">Política de Privacidade</a>.
        </p>

        <div className="pre-prova-preview">
          <video ref={videoRef} autoPlay muted playsInline aria-label="Imagem ao vivo da sua câmera" />
          {status !== 'ready' && <p aria-hidden="true">{status === 'interrupted' ? 'Câmera sem sinal' : 'Prévia da câmera'}</p>}
        </div>

        <div className="pre-prova-actions">
          <button type="button" className="btn-primary" onClick={() => void start()} disabled={status === 'requesting'}>
            {status === 'ready' || status === 'interrupted' ? 'Testar novamente' : 'Testar câmera'}
          </button>
          <button type="button" className="pre-prova-secondary" onClick={stop} disabled={status === 'idle' || status === 'error'}>
            {status === 'requesting' ? 'Cancelar' : 'Desligar câmera'}
          </button>
          {status === 'ready' && (
            <button type="button" className="pre-prova-secondary" onClick={reportNoImage}>
              Minha imagem ficou preta
            </button>
          )}
        </div>
        <p className={status === 'error' || status === 'interrupted' ? 'alert error' : 'pre-prova-status'} role={status === 'error' || status === 'interrupted' ? 'alert' : 'status'}>
          {message}
        </p>
      </div>

      <p className="pre-prova-note">
        Para testar a câmera enquanto uma questão aparece, abra Minhas provas e use o teste local da câmera.
        As fotos de verificação ainda não estão disponíveis nesta versão.
      </p>
    </section>
  )
}
