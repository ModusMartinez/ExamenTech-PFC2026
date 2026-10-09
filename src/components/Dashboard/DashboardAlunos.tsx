import { FaFileAlt, FaStar, FaLayerGroup, FaClock } from 'react-icons/fa'
import StatCard from './StatCard'
import { dadosAluno } from '../../data/mockDashboard'

export function DashboardAlunos() {
    const { kpis } = dadosAluno

    return (
        <div className="sgpa-dashboard-content">
            <div className="sgpa-stats-grid">
                <StatCard icone={<FaFileAlt />} title="Provas Pendentes" value={kpis.provasPendentes} />
                <StatCard icone={<FaStar />} title="Nota Média" value={kpis.notaMedia} />
                <StatCard icone={<FaLayerGroup />} title="Turmas Matriculado" value={kpis.turmasMatriculado} />
                <StatCard icone={<FaClock />} title="Próxima Prova" value={kpis.proximaProva} />
            </div>
        </div>
    )
}
