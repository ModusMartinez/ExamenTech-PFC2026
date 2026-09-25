import assert from 'node:assert/strict'
import test from 'node:test'
import { decideProfileAccess } from '../src/services/profileAccess.ts'

const activeStudent = {
  nome: 'Aluno de Teste',
  email: 'aluno@exemplo.com',
  perfil: 'ALUNO',
  situacao: 'ATIVO',
}

test('libera perfil ativo com nome e papel vindos do banco', () => {
  assert.deepEqual(decideProfileAccess(activeStudent), {
    kind: 'ready',
    user: {
      name: 'Aluno de Teste',
      email: 'aluno@exemplo.com',
      profile: 'Aluno',
    },
  })

  assert.equal(
    decideProfileAccess({ ...activeStudent, perfil: 'PROFESSOR' }).kind,
    'ready',
  )
  assert.equal(
    decideProfileAccess({ ...activeStudent, perfil: 'ADMIN' }).kind,
    'ready',
  )
})

test('bloqueia contas pendentes ou inativas', () => {
  assert.equal(
    decideProfileAccess({ ...activeStudent, situacao: 'PENDENTE' }).kind,
    'denied',
  )
  assert.equal(
    decideProfileAccess({ ...activeStudent, situacao: 'INATIVO' }).kind,
    'denied',
  )
})

test('bloqueia perfil desconhecido', () => {
  for (const profile of ['SUPERADMIN', '__proto__']) {
    assert.deepEqual(
      decideProfileAccess({ ...activeStudent, perfil: profile }),
      { kind: 'denied', message: 'Seu perfil de acesso é inválido.' },
    )
  }
})
