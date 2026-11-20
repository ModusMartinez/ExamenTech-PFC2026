export function Paginacao({ pagina, temProxima, desabilitada, rotulo, onMudarPagina }: {
  pagina: number; temProxima: boolean; desabilitada: boolean; rotulo: string; onMudarPagina: (pagina: number) => void
}) {
  return <nav className="avaliacao-form-actions" aria-label={rotulo}>
    <button type="button" className="turmas-refresh" disabled={desabilitada || pagina === 0}
      onClick={() => onMudarPagina(pagina - 1)}>Anterior</button>
    <span aria-live="polite">Página {pagina + 1}</span>
    <button type="button" className="turmas-refresh" disabled={desabilitada || !temProxima}
      onClick={() => onMudarPagina(pagina + 1)}>Próxima</button>
  </nav>
}
