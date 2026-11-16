import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { buscarUsuariosMfa, redefinirMfa } from '../services/adminMfa'
import type { UsuarioMfa } from '../services/adminMfa'
import '../styles/turmas.css'

export function AdminMfaPanel() {
  const [busca, setBusca] = useState('')
  const [usuarios, setUsuarios] = useState<UsuarioMfa[]>([])
  const [selecionado, setSelecionado] = useState<UsuarioMfa | null>(null)
  const [confirmado, setConfirmado] = useState(false)
  const [busy, setBusy] = useState(false)
  const [consultou, setConsultou] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const pending = useRef(false)

  async function buscar(event: FormEvent) {
    event.preventDefault()
    if (pending.current) return
    pending.current = true
    setBusy(true); setError(''); setSuccess(''); setSelecionado(null); setConfirmado(false)
    try { setUsuarios(await buscarUsuariosMfa(busca)); setConsultou(true) }
    catch (error) { setUsuarios([]); setError(error instanceof Error ? error.message : 'Não foi possível consultar os usuários.') }
    finally { pending.current = false; setBusy(false) }
  }

  async function confirmar(event: FormEvent) {
    event.preventDefault()
    if (!selecionado || !confirmado || pending.current) return
    pending.current = true
    setBusy(true); setError(''); setSuccess('')
    try {
      await redefinirMfa(selecionado.id)
      setSuccess(`Segundo fator de ${selecionado.nome} redefinido. As sessões anteriores foram encerradas. No próximo acesso será exigida nova configuração do Authenticator.`)
    } catch (error) { setError(error instanceof Error ? error.message : 'Não foi possível confirmar a redefinição. Confira a auditoria.') }
    finally { pending.current = false; setBusy(false); setSelecionado(null); setConfirmado(false) }
  }

  return <section className="turmas-panel" aria-labelledby="admin-mfa-title">
    <h1 id="admin-mfa-title">Redefinir autenticação em duas etapas</h1>
    <p>Use quando um aluno ou professor da sua organização perder o acesso ao aplicativo autenticador. Confirme a identidade do titular antes da redefinição.</p>
    <form onSubmit={(event) => void buscar(event)}>
      <label htmlFor="admin-mfa-busca">Nome ou e-mail do usuário</label>
      <input id="admin-mfa-busca" type="search" value={busca} maxLength={120} minLength={3} required disabled={busy}
        onChange={(event) => setBusca(event.target.value)} />
      <button type="submit" className="turmas-refresh" disabled={busy}>{busy ? 'Aguarde...' : 'Buscar usuário'}</button>
    </form>
    {error && <p className="alert error" role="alert">{error}</p>}
    {success && <p className="alert success" role="status">{success}</p>}
    {consultou && !busy && !error && usuarios.length === 0 && <p role="status">Nenhum aluno ou professor ativo encontrado na sua organização.</p>}
    {usuarios.length > 0 && <ul>{usuarios.map((usuario) => <li key={usuario.id}>
      <span>{usuario.nome} — {usuario.email} ({usuario.perfil === 'ALUNO' ? 'Aluno' : 'Professor'}) </span>
      <button type="button" className="turmas-refresh" disabled={busy} onClick={() => { setSelecionado(usuario); setConfirmado(false); setError(''); setSuccess('') }}>
        Redefinir 2FA de {usuario.nome}
      </button>
    </li>)}</ul>}
    {selecionado && <form onSubmit={(event) => void confirmar(event)} aria-labelledby="mfa-confirmacao-title">
      <h2 id="mfa-confirmacao-title">Confirmar redefinição de {selecionado.nome}</h2>
      <p>A ação remove os autenticadores cadastrados e encerra as sessões de {selecionado.email}. A senha permanece a mesma. Será registrada na auditoria.</p>
      <label><input type="checkbox" checked={confirmado} disabled={busy} onChange={(event) => setConfirmado(event.target.checked)} />
        Confirmei a identidade do titular e autorizo a redefinição do segundo fator.</label>
      <div className="turmas-actions">
        <button type="submit" className="turmas-refresh" disabled={busy || !confirmado} aria-busy={busy}>Confirmar redefinição</button>
        <button type="button" className="turmas-refresh" disabled={busy} onClick={() => { setSelecionado(null); setConfirmado(false) }}>Cancelar</button>
      </div>
    </form>}
  </section>
}
