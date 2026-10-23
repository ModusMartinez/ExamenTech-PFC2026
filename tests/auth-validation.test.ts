import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateInvitationFields,
  validateLoginFields,
  validateRegistrationFields,
} from '../src/services/authValidation.ts'

const email = 'aluno@exemplo.com'
const organizationCode = 'AbCdEfGhIjKlMnOpQrS_1'
const invitationCode = 'a'.repeat(64)

test('login aceita e-mail válido com espaços externos e senha preenchida', () => {
  const result = validateLoginFields(` ${email} `, 'senha123')

  assert.equal(result, null)
})

test('login rejeita e-mail vazio', () => {
  const result = validateLoginFields('', 'senha123')

  assert.equal(result, 'Preencha o e-mail e a senha.')
})

test('login rejeita senha vazia', () => {
  const result = validateLoginFields(email, '')

  assert.equal(result, 'Preencha o e-mail e a senha.')
})

test('login rejeita e-mail malformado', () => {
  const result = validateLoginFields('email-invalido', 'senha123')

  assert.equal(result, 'Digite um e-mail válido.')
})

test('cadastro rejeita nome vazio', () => {
  const result = validateRegistrationFields('', email, 'senha123', 'senha123')

  assert.equal(result, 'Preencha todos os campos.')
})

test('cadastro rejeita e-mail malformado', () => {
  const result = validateRegistrationFields('Aluno', 'email-invalido', 'senha123', 'senha123')

  assert.equal(result, 'Digite um e-mail válido.')
})

test('cadastro rejeita confirmação diferente da senha', () => {
  const result = validateRegistrationFields('Aluno', email, 'senha123', 'diferente')

  assert.equal(result, 'As senhas não são iguais.')
})

for (const scenario of [
  {
    name: 'cadastro rejeita senha com 7 caracteres, abaixo do mínimo',
    length: 7,
    expectedMessage: 'A senha precisa ter pelo menos 8 caracteres.',
  },
  {
    name: 'cadastro aceita senha com exatamente 8 caracteres',
    length: 8,
    expectedMessage: null,
  },
  {
    name: 'cadastro aceita senha com 9 caracteres, acima do mínimo',
    length: 9,
    expectedMessage: null,
  },
]) {
  test(scenario.name, () => {
    const password = 'a'.repeat(scenario.length)

    const result = validateRegistrationFields(' Aluno ', email, password, password)

    assert.equal(result, scenario.expectedMessage)
  })
}

test('convite aceita os códigos válidos da organização e do convite individual', () => {
  const result = validateInvitationFields(organizationCode, invitationCode)

  assert.equal(result, null)
})

test('convite rejeita código da organização vazio', () => {
  const result = validateInvitationFields('', invitationCode)

  assert.equal(result, 'Informe o código da organização e o convite individual.')
})

test('convite rejeita código individual contendo somente espaços', () => {
  const result = validateInvitationFields(organizationCode, ' ')

  assert.equal(result, 'Informe o código da organização e o convite individual.')
})

test('convite rejeita código da organização com 20 caracteres em vez de 21', () => {
  const shortOrganizationCode = organizationCode.slice(0, -1)

  const result = validateInvitationFields(shortOrganizationCode, invitationCode)

  assert.equal(result, 'Um dos códigos informados é inválido.')
})

test('convite rejeita código individual com caracteres não hexadecimais', () => {
  const invalidInvitationCode = 'g'.repeat(64)

  const result = validateInvitationFields(organizationCode, invalidInvitationCode)

  assert.equal(result, 'Um dos códigos informados é inválido.')
})
