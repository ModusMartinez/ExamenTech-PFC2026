import type { ReactNode} from "react"

type StatCardProps = {
    icone: ReactNode
    title: string
    value: string | number
}


export default function StatCard ({icone, title, value}: StatCardProps) {
    return (
        <div className="sgpa-stat-card">
            <span className="sgpa-stat-icone">{icone}</span>
            <strong className="sgpa-stat-value">{value}</strong>
            <span className="sgpa-stat-title">{title}</span>
        </div>
    )
}