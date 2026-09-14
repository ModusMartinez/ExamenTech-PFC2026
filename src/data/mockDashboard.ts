//Dados para testar visualmente

export type SituacaoUsuario = 'ativo' | 'pendente' | 'inativo'
export type PerfilUsuario = 'Administrador' | 'Professor' | 'Aluno'

export interface UsuarioRecente {
    id: string
    nome: string
    email: string
    perfil: PerfilUsuario
    situacao: SituacaoUsuario
    ultimoAcesso: string
}

// Dados mock de admin

export const dadosAdmin = {
    kpis: {
        totalUsuarios: 34,
        usuariosAtivos: 21,
        professores: 4,
        alunos: 17,
    },
    usuariosRecentes: [
        { id: '1', nome: 'Lucas Ferreira', email: 'lucas@sgpa.com', perfil: 'Aluno', situacao: 'ativo' },
        { id: '2', nome: 'Rafael Mendes', email: 'rafael@sgpa.com', perfil: 'Professor', situacao: 'ativo' },
        { id: '3', nome: 'Ana Souza', email: 'ana@sgpa.com', perfil: 'Aluno', situacao: 'pendente' },
        { id: '4', nome: 'Carlos Lima', email: 'carlos@sgpa.com', perfil: 'Aluno', situacao: 'inativo' },
    ] as UsuarioRecente[],
}

export const dadosProfessor = {
    kpis: {
        turmasAtivas: 3,
        avaliacoesCriadas: 14,
        alunos: 87,
        proximaProva: '20/09/2026',
    },
    avaliacoesRecentes: [
        { id: '1', titulo: 'Prova P1 — Sistema Nervoso', turma: 'Enfermagem-2026A', data: '20/09/2026', situacao: 'AGENDADA' },
        { id: '2', titulo: 'Trabalho — Intenficar Musculos da Parte frontal do Corpo', turma: 'Enfermagem-2026A', data: '15/09/2026', situacao: 'ENCERRADA' },
        { id: '3', titulo: 'Quiz — Os tendoes do Corpo-Humano', turma: 'Enfermagem-2026B', data: '10/09/2026', situacao: 'ENCERRADA' },
    ],
}

export const dadosAluno = {
    kpis: {
        provasPendentes: 2,
        notaMedia: 8.4,
        turmasMatriculado: 5,
        proximaProva: '20/09/2026',
    },
    avaliacoesDisponıveis: [
        { id: '1', titulo: 'Prova P1 — Sistema Nervoso', professor: 'Prof. Rafael Mendes', data: '20/09/2026', situacao: 'AGENDADA' },
        { id: '2', titulo: 'Quiz — Os tendoes do Corpo-Humano', professor: 'Prof. Ana Costa', data: '25/09/2026', situacao: 'AGENDADA' },
        { id: '3', titulo: 'Trabalho — Indentifiar partes do corpo humano', professor: 'Prof. Rafael Mendes', data: '15/09/2026', situacao: 'ENCERRADA' },
    ],
}
