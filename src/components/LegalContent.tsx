import { LEGAL_CONTACT_EMAIL, LEGAL_RESPONSIBLE, LEGAL_REVIEW_NOTICE, legalDocuments } from '../content/legalDocuments'
import type { LegalDocumentType } from '../content/legalDocuments'

type LegalContentProps = { documentType: LegalDocumentType; onPage?: boolean }

export function LegalContent({ documentType, onPage = false }: LegalContentProps) {
  const Heading = onPage ? 'h2' : 'h3'

  return (
    <article className="legal-document-content">
      <p className="legal-review-note">{LEGAL_REVIEW_NOTICE}</p>
      {legalDocuments[documentType].sections.map((section) => (
        <section key={section.title}>
          <Heading>{section.title}</Heading>
          {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </section>
      ))}
      <section>
        <Heading>Responsáveis e contato</Heading>
        <p>{LEGAL_RESPONSIBLE}</p>
        <p><a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a></p>
      </section>
    </article>
  )
}
