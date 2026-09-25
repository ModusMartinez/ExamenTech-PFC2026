import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateInvitationFields,
  validateLoginFields,
  validateRegistrationFields,
} from '../src/services/authValidation.ts'

test('login exige e-mail e senha', () => {
  assert.equal(validateLoginFields('', '12345678'), 'Preencha o e-mail e a senha.')
  assert.equal(validateLoginFields('aluno@exemplo.com', ''), 'Preencha o e-mail e a senha.')
})

test('cadastro exige os dois códigos de acesso', () => {
  const organizationCode = 'AbCdEfGhIjKlMnOpQrS_1'
  const studentCode = 'a'.repeat(64)

  assert.equal(
    validateInvitationFields('', studentCode),
    'Informe o código da organização e o convite individual.',
  )
  assert.equal(
    validateInvitationFields(organizationCode, ' '),
    'Informe o código da organização e o convite individual.',
  )
  assert.equal(validateInvitationFields(organizationCode, studentCode), null)
  assert.equal(
    validateInvitationFields('curto', studentCode),
    'Um dos códigos informados é inválido.',
  )
  assert.equal(
    validateInvitationFields(organizationCode, 'g'.repeat(64)),
    'Um dos códigos informados é inválido.',
  )
})

test('login rejeita e-mail malformado e aceita formato básico', () => {
  assert.equal(validateLoginFields('email-invalido', '12345678'), 'Digite um e-mail válido.')
  assert.equal(validateLoginFields(' aluno@exemplo.com ', '12345678'), null)
})

test('cadastro valida preenchimento, e-mail, tamanho e confirmação da senha', () => {
  assert.equal(
    validateRegistrationFields('', 'aluno@exemplo.com', 'senha123', 'senha123'),
    'Preencha todos os campos.',
  )
  assert.equal(
    validateRegistrationFields('Aluno', 'email-invalido', 'senha123', 'senha123'),
    'Digite um e-mail válido.',
  )
  assert.equal(
    validateRegistrationFields('Aluno', 'aluno@exemplo.com', '1234567', '1234567'),
    'A senha precisa ter pelo menos 8 caracteres.',
  )
  assert.equal(
    validateRegistrationFields('Aluno', 'aluno@exemplo.com', 'senha123', 'diferente'),
    'As senhas não são iguais.',
  )
  assert.equal(
    validateRegistrationFields(' Aluno ', 'aluno@exemplo.com', 'senha123', 'senha123'),
    null,
  )
})
