import '../styles/legal.css'

type LegalFooterProps = { openInNewTab?: boolean }

export function LegalFooter({ openInNewTab = false }: LegalFooterProps) {
  return (
    <footer className="legal-footer">
      <nav className="legal-links" aria-label="Documentos do projeto">
        <a
          href="/termos"
          target={openInNewTab ? '_blank' : undefined}
          rel={openInNewTab ? 'noopener noreferrer' : undefined}
          aria-label={openInNewTab ? 'Termos de Uso (abre em nova aba)' : undefined}
        >
          Termos de Uso
        </a>
        <a
          href="/privacidade"
          target={openInNewTab ? '_blank' : undefined}
          rel={openInNewTab ? 'noopener noreferrer' : undefined}
          aria-label={openInNewTab ? 'Política de Privacidade (abre em nova aba)' : undefined}
        >
          Política de Privacidade
        </a>
      </nav>
    </footer>
  )
}
