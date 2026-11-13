export function validateTurmaName(nome: unknown): string | null {
  if (typeof nome !== 'string' || nome.trim().length < 3 || nome.trim().length > 100) {
    return 'Informe um nome de turma entre 3 e 100 caracteres.'
  }
  return null
}
