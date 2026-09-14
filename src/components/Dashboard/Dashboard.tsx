import { DashboardAdmin } from "./DashboardAdmin";
import { DashboardProf } from "./DashboardProf";
import { DashboardAlunos } from "./DashboardAlunos"; 

type Profile = 'Administrador' | 'Professor'| 'Aluno'

type DashboardProps = {
    user: {name: string; email: string; profile: Profile }
    onLogout: () => void
}

export function Dashboard({user, onLogout}: DashboardProps) {
    const initials = user.name.split(' ').slice(0, 2).map(n => n[0]).join('')
    
    function renderConteudo() {
        if (user.profile === 'Administrador') return <DashboardAdmin />
        if (user.profile === 'Professor') return <DashboardProf />
        return <DashboardAlunos />
    }
    return (
    <main className="sgpa-dashboard">
        <header className="sgpa-dashboard-header">
            <div className="sgpa-brand">
                <span className="sgpa-brand-mark">SG</span>
                <span>SGPA</span>
            </div>
            <div className="sgpa-head-user">
                <div className="sgpa-avatar">{initials}</div>
                <div>
                    <strong>{user.name}</strong>
                    <span>{user.profile}</span>
                </div>
            </div>
            <button className="sgpa-logout-button" onClick={onLogout}>Sair</button>
        </header>
         <div className="sgpa-dash-wrapper">
        <p className="sgpa-eyebrow">Painel Inicial</p>
        <h1>Olá, {user.name.split(' ')[0]}.</h1>
        <div className="sgpa-subtitle">{renderConteudo()}</div>
        </div>
    </main>
    )
}