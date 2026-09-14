import { FaUserCheck, FaChalkboardTeacher, FaUsers, FaUserGraduate } from 'react-icons/fa';
import StatCard from './StatCard';
import { dadosAdmin } from '../../data/mockDashboard'

export function DashboardAdmin() {
    const { kpis, usuariosRecentes } = dadosAdmin;
    return (
        <div className="sgpa-dashboard-content">
            <div className="sgpa-stats-grid">
                <StatCard icone={<FaUsers/>} title= "Usuários Logados" value={kpis.totalUsuarios} />
                <StatCard icone={<FaUserCheck/>} title= "Usuarios Ativos" value={kpis.usuariosAtivos} />
                <StatCard icone={<FaChalkboardTeacher/>} title= "Professores" value={kpis.professores} />
                <StatCard icone={<FaUserGraduate/>} title= "Alunos" value={kpis.alunos} />
            </div>
            {/** usuarios recentes */}
            <section className="sgpa-dashboard-section">
                <h2>Usuarios logados Recentes</h2>
                <table  className="sgpa-table">
                    <thead>
                        <tr>
                            <th>Nome</th>
                            <th>Email</th>
                            <th>Perfil</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {usuariosRecentes.map(u =>(
                            <tr key={u.id}>
                                <td>{u.nome}</td>
                                <td>{u.email}</td>
                                <td><span className="sgpa-bagde">{u.perfil}</span></td>
                                <td><span className={`sgpa-bagde sgpa-bagde-${u.situacao.toLowerCase()}`}>{u.situacao}</span></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
            

        </div>
    )
}