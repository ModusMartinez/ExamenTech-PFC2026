import assert from 'node:assert/strict'
import test from 'node:test'
import { decideProfileAccess } from '../src/services/profileAccess.ts'

const activeStudent = {
  nome: 'Aluno de Teste',
  email: 'aluno@exemplo.com',
  perfil: 'ALUNO',
  situacao: 'ATIVO',
}

for (const [profileCode, expectedProfile] of [
  ['ALUNO', 'Aluno'],
  ['PROFESSOR', 'Professor'],
  ['ADMIN', 'Administrador'],
]) {
  test(`perfil ${profileCode} ativo libera acesso como ${expectedProfile}`, () => {
    const record = { ...activeStudent, perfil: profileCode }

    const result = decideProfileAccess(record)

    assert.deepEqual(result, {
      kind: 'ready',
      user: {
        name: activeStudent.nome,
        email: activeStudent.email,
        profile: expectedProfile,
      },
    })
  })
}

for (const status of ['INATIVO', 'DESCONHECIDO']) {
  test(`perfil com situação ${status} não libera acesso`, () => {
    const record = { ...activeStudent, situacao: status }

    const result = decideProfileAccess(record)

    assert.deepEqual(result, {
      kind: 'denied', message: 'Sua conta não está ativa. Procure o administrador.',
    })
  })
}

test('aluno pendente recebe orientação para confirmar o e-mail', () => {
  assert.deepEqual(decideProfileAccess({ ...activeStudent, situacao: 'PENDENTE' }), {
    kind: 'denied', message: 'Confirme seu e-mail para liberar o acesso.',
  })
})

for (const profileCode of ['SUPERADMIN', '__proto__']) {
  test(`perfil desconhecido ${profileCode} não libera acesso`, () => {
    const record = { ...activeStudent, perfil: profileCode }

    const result = decideProfileAccess(record)

    assert.deepEqual(result, {
      kind: 'denied', message: 'Seu perfil de acesso é inválido.',
    })
  })
}

test('perfil ativo com código de perfil vazio não libera acesso', () => {
  const record = { ...activeStudent, perfil: '' }

  const result = decideProfileAccess(record)

  assert.deepEqual(result, {
    kind: 'denied', message: 'Seu perfil de acesso é inválido.',
  })
})
