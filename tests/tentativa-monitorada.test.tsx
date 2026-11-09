import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TentativaMonitoradaPanel } from '../src/components/TentativaMonitoradaPanel'
import { LegalFooter } from '../src/components/LegalFooter'
import type { AvaliacaoAluno } from '../src/services/avaliacaoValidation'

const services = vi.hoisted(() => ({
  iniciarTentativa: vi.fn(), consultarConteudoTentativa: vi.fn(),
  salvarRespostaTentativa: vi.fn(), encerrarTentativa: vi.fn(),
}))
vi.mock('../src/services/tentativas', () => services)

const avaliacao: AvaliacaoAluno = {
  id: '10000000-0000-0000-0000-000000000001', turma_id: '20000000-0000-0000-0000-000000000001',
  turma_nome: 'Turma de teste', titulo: 'Prova de teste', tipo: 'PROVA', situacao: 'PUBLICADA',
  inicio_em: '2026-01-01T00:00:00Z', fim_em: '2099-01-01T00:00:00Z',
  publicada_em: '2026-01-01T00:00:00Z', duracao_minutos: 60,
}
const tentativa = {
  id: '30000000-0000-0000-0000-000000000001', avaliacao_id: avaliacao.id,
  aluno_id: '40000000-0000-0000-0000-000000000001', situacao: 'EM_ANDAMENTO',
  iniciada_em: '2026-01-01T00:00:00.000Z', limite_em: '2099-01-01T00:00:00.000Z',
}
const questao = { id: '50000000-0000-0000-0000-000000000001', tipo: 'OBJETIVA',
  ordem: 1, enunciado: 'Quanto é 2 + 2?', pontuacao: 1,
  alternativas: [{ id: '60000000-0000-0000-0000-000000000001', ordem: 1, texto: '4' },
    { id: '60000000-0000-0000-0000-000000000002', ordem: 2, texto: '5' }],
} as const
const conteudo = { tentativa_id: tentativa.id, avaliacao_id: avaliacao.id,
  titulo: avaliacao.titulo, tipo: 'PROVA', iniciada_em: tentativa.iniciada_em,
  limite_em: tentativa.limite_em, questoes: [questao] }
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
const getUserMedia = vi.fn()

function cameraStream() {
  const track = { stop: vi.fn(), onended: null as null | (() => void),
    onmute: null as null | (() => void), onunmute: null as null | (() => void), muted: false, readyState: 'live' }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
  return { stream, track }
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', '') } },
    close: { configurable: true, value() { this.removeAttribute('open') } },
  })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  services.iniciarTentativa.mockResolvedValue(tentativa)
  services.consultarConteudoTentativa.mockResolvedValue(conteudo)
  services.salvarRespostaTentativa.mockResolvedValue({ questao_id: questao.id,
    alternativa_id: questao.alternativas[0].id, texto: null, salva_em: '2026-11-08T12:00:00Z' })
  services.encerrarTentativa.mockImplementation(async (_id: string, reason: string) => ({
    id: tentativa.id, situacao: reason === 'ENVIO' || reason === 'PRAZO' ? 'FINALIZADA' : 'INTERROMPIDA',
    falhas_camera: reason === 'CAMERA' ? 1 : 0, encerrada_em: '2026-11-08T12:00:00Z',
  }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
})

test('início exige câmera, permite salvar e enviar sem gerar fotos', async () => {
  const { stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  const onLeave = vi.fn()
  render(<TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={onLeave} onActiveChange={vi.fn()} />)
  const startButton = screen.getByRole('button', { name: 'Confirmar início' }) as HTMLButtonElement
  expect(startButton.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  expect(startButton.disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /Li o aviso da prova/ }))
  expect(startButton.disabled).toBe(false)
  fireEvent.click(startButton)
  await screen.findByText('Quanto é 2 + 2?')
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await waitFor(() => expect(services.salvarRespostaTentativa).toHaveBeenCalledWith(
    tentativa.id, expect.objectContaining({ id: questao.id }), questao.alternativas[0].id))
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  expect(screen.getByRole('dialog', { name: 'Enviar prova?' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Enviar e encerrar' }))
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'ENVIO'))
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('Prova enviada')))
})

test('perda da câmera oculta as questões e interrompe sem retomada', async () => {
  const { stream, track } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  const onLeave = vi.fn()
  render(<TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={onLeave} onActiveChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('checkbox', { name: /Li o aviso da prova/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar início' }))
  await screen.findByText('Quanto é 2 + 2?')
  await act(async () => { track.onended?.() })
  expect(screen.queryByText('Quanto é 2 + 2?')).toBeNull()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'CAMERA'))
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('não pode ser retomada')))
  expect(track.stop).toHaveBeenCalled()
})

test('perda breve de sinal oculta as questões e permite continuar quando o sinal volta', async () => {
  const { stream, track } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={vi.fn()} onActiveChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('checkbox', { name: /Li o aviso da prova/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar início' }))
  await screen.findByText('Quanto é 2 + 2?')
  await act(async () => { track.onmute?.() })
  expect(screen.queryByText('Quanto é 2 + 2?')).toBeNull()
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
  await act(async () => { track.onunmute?.() })
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
})

test('aceite pode ser marcado antes da câmera e o início funciona em StrictMode', async () => {
  const { stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<StrictMode><TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={vi.fn()} onActiveChange={vi.fn()} /></StrictMode>)
  const aceite = screen.getByRole('checkbox', { name: /Li o aviso da prova/ }) as HTMLInputElement
  const inicio = screen.getByRole('button', { name: 'Confirmar início' }) as HTMLButtonElement
  fireEvent.click(screen.getByText(/Li o aviso da prova/))
  expect(aceite.checked).toBe(true)
  expect(inicio.disabled).toBe(true)
  fireEvent.click(screen.getByText(/Li o aviso da prova/))
  expect(aceite.checked).toBe(false)
  fireEvent.click(screen.getByText(/Li o aviso da prova/))
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  expect(inicio.disabled).toBe(false)
  fireEvent.click(inicio)
  await screen.findByText('Quanto é 2 + 2?')
  expect(services.iniciarTentativa).toHaveBeenCalledExactlyOnceWith(avaliacao.id)
  expect(services.consultarConteudoTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id)
})

async function iniciarProva(onLeave = vi.fn()) {
  const { stream, track } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<><TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={onLeave} onActiveChange={vi.fn()} /><LegalFooter openInNewTab /></>)
  fireEvent.click(screen.getByRole('checkbox', { name: /Li o aviso da prova/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar início' }))
  await screen.findByText('Quanto é 2 + 2?')
  return { track, onLeave }
}

test('aviso de permanência aparece antes do aceite e sair durante o preparo não interrompe tentativa', async () => {
  render(<TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={vi.fn()} onActiveChange={vi.fn()} />)
  expect(screen.getByText(/Não troque de aba, de janela ou de área de trabalho/)).toBeTruthy()
  fireEvent(window, new Event('blur'))
  fireEvent(window, new Event('pagehide'))
  expect(screen.getByRole('button', { name: 'Confirmar início' })).toBeTruthy()
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
})

test('trocar de aba oculta questões e encerra a tentativa sem retorno ao tornar a aba visível', async () => {
  const { onLeave } = await iniciarProva()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange'))
  expect(screen.queryByText('Quanto é 2 + 2?')).toBeNull()
  visibility.mockReturnValue('visible')
  fireEvent(document, new Event('visibilitychange'))
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'SAIDA'))
  expect(screen.queryByText('Quanto é 2 + 2?')).toBeNull()
  expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('Procure seu professor ou responsável'))
})

test.each(['blur', 'pagehide'])('%s da janela interrompe definitivamente uma prova iniciada', async event => {
  await iniciarProva()
  fireEvent(window, new Event(event))
  expect(screen.queryByText('Quanto é 2 + 2?')).toBeNull()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'SAIDA'))
})

test('perda de foco enquanto o início está pendente encerra a tentativa criada sem abrir questões', async () => {
  let concluirInicio!: (value: typeof tentativa) => void
  services.iniciarTentativa.mockReturnValueOnce(new Promise(resolve => { concluirInicio = resolve }))
  const { stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={vi.fn()} onActiveChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar início' }))
  fireEvent(window, new Event('blur'))
  await act(async () => concluirInicio(tentativa))
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'SAIDA'))
  expect(services.consultarConteudoTentativa).not.toHaveBeenCalled()
})

test('falha no registro da saída mantém questões ocultas e permite repetir somente o encerramento', async () => {
  await iniciarProva()
  services.encerrarTentativa.mockRejectedValueOnce(new Error('Sem conexão.'))
  fireEvent(window, new Event('blur'))
  await screen.findByText('Sem conexão.')
  fireEvent(window, new Event('focus'))
  expect(screen.queryByText('Quanto é 2 + 2?')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Tentar registrar encerramento' }))
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledTimes(2))
  expect(services.encerrarTentativa.mock.calls.every(([, motivo]) => motivo === 'SAIDA')).toBe(true)
  expect(services.iniciarTentativa).toHaveBeenCalledTimes(1)
})

test('eventos seguidos de foco, aba e câmera não duplicam o encerramento', async () => {
  const { track } = await iniciarProva()
  fireEvent(window, new Event('blur'))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => { track.onended?.() })
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'SAIDA'))
})

test('cancelar a confirmação do próprio site não conta como saída de janela', async () => {
  await iniciarProva()
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  expect(screen.getByRole('dialog', { name: 'Enviar prova?' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Continuar na prova' }))
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Sair e encerrar' }))
  expect(screen.getByRole('dialog', { name: 'Sair da prova?' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Continuar na prova' }))
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
})

test('confirmar saída no diálogo encerra a tentativa', async () => {
  await iniciarProva()
  fireEvent.click(screen.getByRole('button', { name: 'Sair e encerrar' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar saída' }))
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'SAIDA'))
})

test('documentos do rodapé abrem dentro da prova, sem interromper a tentativa', async () => {
  await iniciarProva()
  fireEvent.click(screen.getByRole('link', { name: 'Termos de Uso (abre em nova aba)' }))
  expect(screen.getByRole('dialog', { name: 'Termos de Uso' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Consultar Política de Privacidade' }))
  expect(screen.getByRole('dialog', { name: 'Política de Privacidade' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Fechar documento' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
})
