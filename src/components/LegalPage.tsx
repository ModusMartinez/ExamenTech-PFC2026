import { useEffect } from 'react'
import { legalDocuments } from '../content/legalDocuments'
import type { LegalDocumentType } from '../content/legalDocuments'
import { LegalContent } from './LegalContent'
import '../styles/legal.css'

export function LegalPage({ documentType }: { documentType: LegalDocumentType }) {
  const content = legalDocuments[documentType]

  useEffect(() => {
    const previousTitle = document.title
    document.title = `${content.title} | ExamenTech`
    return () => { document.title = previousTitle }
  }, [content.title])

  return (
    <main className="legal-page">
      <a className="legal-home-link" href="/">← Ir ao ExamenTech</a>
      <header>
        <p className="overline">EXAMENTECH · DEMONSTRAÇÃO DO PFC</p>
        <h1>{content.title}</h1>
        <p className="legal-version">Versão {content.version}</p>
      </header>
      <LegalContent documentType={documentType} onPage />
    </main>
  )
}
