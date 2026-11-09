import { useEffect, useRef, useState } from 'react'
import { legalDocuments } from '../content/legalDocuments'
import type { LegalDocumentType } from '../content/legalDocuments'
import { LegalContent } from './LegalContent'
import '../styles/legal.css'

type LegalModalProps = {
  documentType: LegalDocumentType
  onClose: () => void
  onAccept?: () => void
}

export function LegalModal({ documentType, onClose, onAccept }: LegalModalProps) {
  const [currentDocument, setCurrentDocument] = useState(documentType)
  const [accepted, setAccepted] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const content = legalDocuments[currentDocument]

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    dialog?.showModal()
    document.body.style.overflow = 'hidden'

    return () => {
      dialog?.close()
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    titleRef.current?.focus()
  }, [currentDocument])

  return (
    <dialog
      ref={dialogRef}
      className="legal-modal"
      aria-labelledby="legal-modal-title"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className="legal-modal-header">
        <div>
          <p className="overline">EXAMENTECH · DOCUMENTOS DO PROJETO</p>
          <h2 id="legal-modal-title" ref={titleRef} tabIndex={-1}>{content.title}</h2>
          <p className="legal-version">Versão {content.version}</p>
        </div>
        <button type="button" className="legal-close" aria-label="Fechar documento" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="legal-modal-body" ref={bodyRef} tabIndex={0} aria-label={`Conteúdo: ${content.title}`}>
        <LegalContent documentType={currentDocument} />

        <button
          type="button"
          className="btn-link legal-document-link"
          onClick={() => setCurrentDocument(currentDocument === 'termos' ? 'privacidade' : 'termos')}
        >
          {currentDocument === 'termos' ? 'Consultar Política de Privacidade' : 'Voltar aos Termos de Uso'}
        </button>

        {onAccept && currentDocument === 'termos' && (
          <label className="legal-acceptance">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>Li e aceito os Termos de Uso.</span>
          </label>
        )}
      </div>

      <footer className="legal-modal-footer">
        <button type="button" className="legal-secondary" onClick={onClose}>
          {onAccept ? 'Cancelar' : 'Fechar'}
        </button>
        {onAccept && currentDocument === 'termos' && (
          <button
            type="button"
            className="btn-primary"
            disabled={!accepted}
            onClick={() => { if (accepted) onAccept() }}
          >
            Continuar para o cadastro
          </button>
        )}
        {onAccept && currentDocument === 'privacidade' && (
          <button type="button" className="btn-primary" onClick={() => setCurrentDocument('termos')}>
            Voltar aos termos
          </button>
        )}
      </footer>
    </dialog>
  )
}
