import { FaChalkboardTeacher, FaUsers, FaClipboardList, FaClock } from 'react-icons/fa'
import StatCard from './StatCard'
import { dadosProfessor } from '../../data/mockDashboard'

export function DashboardProf() {
    const { kpis } = dadosProfessor

    return (
        <div className="sgpa-dashboard-content">
            <div className="sgpa-stats-grid">
                <StatCard icone={<FaChalkboardTeacher />} title="Turmas Ativas"        value={kpis.turmasAtivas}       />
                <StatCard icone={<FaClipboardList />}     title="Avaliações Criadas"   value={kpis.avaliacoesCriadas}  />
                <StatCard icone={<FaUsers />}             title="Alunos"               value={kpis.alunos}             />
                <StatCard icone={<FaClock />}             title="Próxima Prova"        value={kpis.proximaProva}       />
            </div>
        </div>
    )
}
