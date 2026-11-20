import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { InvitationPanel } from '../src/components/InvitationPanel'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc, auth: { getUser: mocks.getUser }, from: mocks.from },
}))

const organizationId = 'organizacao-teste'
const invitationCode = 'a'.repeat(64)

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede não permitida neste teste.') }))
  mocks.rpc.mockImplementation(async (name, args) => name === 'listar_organizacoes_ativas'
    ? { data: [
      { id: organizationId, nome: 'Escola A', situacao: 'ATIVO' },
      { id: 'outra-organizacao', nome: 'Escola B', situacao: 'ATIVO' },
    ], error: null }
    : { data: {
      codigo: invitationCode, expira_em: '2026-10-04T15:00:00Z',
      email: args.p_email, organizacao_id: args.p_organizacao_id,
      perfil_destino: name === 'emitir_convite_professor' ? 'PROFESSOR' : 'ALUNO',
    }, error: null })
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'professor-teste' } }, error: null })
  mocks.from.mockReturnValue({ select: mocks.select })
  mocks.select.mockReturnValue({ eq: mocks.eq })
  mocks.eq.mockReturnValue({ single: mocks.single })
  mocks.single.mockResolvedValue({ data: { organizacao_id: organizationId }, error: null })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function ready(profile: 'Administrador' | 'Professor') {
  render(<InvitationPanel profile={profile} />)
  await waitFor(() => expect(screen.queryByText('Carregando informações...')).toBeNull())
}

for (const profile of ['ALUNO', 'PROFESSOR']) {
  test(`administrador pode emitir convite de ${profile} na organização selecionada`, async () => {
    await ready('Administrador')
    fireEvent.change(screen.getByLabelText('Tipo de conta'), { target: { value: profile } })
    const label = profile === 'PROFESSOR' ? 'professor' : 'aluno'
    fireEvent.change(screen.getByLabelText(`E-mail do ${label}`), { target: { value: 'Pessoa@exemplo.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar convite' }))
    await screen.findByText(`Convite de ${label} para pessoa@exemplo.com`)
    expect(mocks.rpc).toHaveBeenCalledWith(profile === 'PROFESSOR' ? 'emitir_convite_professor' : 'emitir_convite_aluno', {
      p_email: 'pessoa@exemplo.com', p_organizacao_id: organizationId,
    })
    expect(screen.getByText(invitationCode)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Tipo de conta'), { target: { value: profile === 'ALUNO' ? 'PROFESSOR' : 'ALUNO' } })
    expect(screen.queryByText(invitationCode)).toBeNull()
  })
}

test('professor emite somente convite de aluno, vinculado ao seu perfil', async () => {
  await ready('Professor')
  expect(screen.queryByLabelText('Tipo de conta')).toBeNull()
  expect(screen.queryByLabelText('Organização existente')).toBeNull()
  expect(mocks.eq).toHaveBeenCalledWith('id', 'professor-teste')
  fireEvent.change(screen.getByLabelText('E-mail do aluno'), { target: { value: 'aluno@exemplo.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Gerar convite' }))
  await screen.findByText('Convite de aluno para aluno@exemplo.com')
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('emitir_convite_aluno', {
    p_email: 'aluno@exemplo.com', p_organizacao_id: organizationId,
  })
})

test('professor sem organização não pode emitir convite', async () => {
  mocks.single.mockResolvedValue({ data: { organizacao_id: null }, error: null })
  await ready('Professor')
  expect(screen.getByRole('alert').textContent).toContain('não está vinculado')
  expect(screen.getByRole('button', { name: 'Gerar convite' }).hasAttribute('disabled')).toBe(true)
  expect(mocks.rpc).not.toHaveBeenCalled()
})

test('trocar de organização remove o código do convite anterior', async () => {
  await ready('Administrador')
  fireEvent.change(screen.getByLabelText('E-mail do aluno'), { target: { value: 'aluno@exemplo.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Gerar convite' }))
  await screen.findByText(invitationCode)
  fireEvent.change(screen.getByLabelText('Organização existente'), { target: { value: 'outra-organizacao' } })
  expect(screen.queryByText(invitationCode)).toBeNull()
})

test('erro ao emitir professor não apresenta código nem muda para convite de aluno', async () => {
  await ready('Administrador')
  mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } })
  fireEvent.change(screen.getByLabelText('Tipo de conta'), { target: { value: 'PROFESSOR' } })
  fireEvent.change(screen.getByLabelText('E-mail do professor'), { target: { value: 'professor@exemplo.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Gerar convite' }))
  await screen.findByRole('alert')
  expect(screen.queryByText(invitationCode)).toBeNull()
  expect(screen.getByRole('heading', { name: 'Convite para professor' })).toBeTruthy()
})
