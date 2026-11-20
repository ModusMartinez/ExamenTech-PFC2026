import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateInvitationFields,
  validateLoginFields,
  validateRegistrationFields,
  validateRgm,
  normalizeRgm,
} from '../src/services/authValidation.ts'

const email = 'aluno@exemplo.com'
const organizationCode = 'AbCdEfGhIjKlMnOpQrS_1'
const invitationCode = 'a'.repeat(64)

test('RGM preserva zeros iniciais e normaliza caixa e espaços externos', () => {
  assert.equal(normalizeRgm('  00ab-12.3/4_5  '), '00AB-12.3/4_5')
  assert.equal(validateRgm('  00ab-12.3/4_5  '), null)
  assert.equal(validateRgm(''), null) // O convite decide se o RGM é obrigatório.
})

for (const invalid of ['12 34', '<script>', '1\n2', 'A'.repeat(51), 'á123']) {
  test(`RGM rejeita entrada inválida ${JSON.stringify(invalid)}`, () => {
    assert.ok(validateRgm(invalid))
    assert.ok(validateRegistrationFields('Aluno', email, 'senha123', 'senha123', invalid))
  })
}

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

  assert.equal(result, 'O código da organização precisa ter 21 caracteres. Foram informados 20.')
})

test('convite rejeita código individual com caracteres não hexadecimais', () => {
  const invalidInvitationCode = 'g'.repeat(64)

  const result = validateInvitationFields(organizationCode, invalidInvitationCode)

  assert.equal(result, 'O convite individual contém caracteres inválidos. Copie somente o código gerado para o seu e-mail, sem aspas ou espaços no meio.')
})

test('convite informa o campo e o tamanho de um código incompleto, sem expor o valor', () => {
  assert.equal(validateInvitationFields(organizationCode, invitationCode.slice(0, -1)),
    'O convite individual precisa ter 64 caracteres. Foram informados 63.')
  assert.equal(validateInvitationFields(invitationCode, organizationCode),
    'O código da organização precisa ter 21 caracteres. Foram informados 64.')
})

test('organização rejeita caractere inválido mesmo com tamanho correto e aceita espaços externos', () => {
  assert.equal(validateInvitationFields('@' + 'A'.repeat(20), invitationCode),
    'O código da organização contém caracteres inválidos. Copie somente o código, sem aspas ou espaços no meio.')
  assert.equal(validateInvitationFields(`  ${organizationCode}  `, `  ${invitationCode}  `), null)
})
