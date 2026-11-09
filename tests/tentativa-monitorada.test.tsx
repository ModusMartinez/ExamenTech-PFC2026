import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TentativaMonitoradaPanel } from '../src/components/TentativaMonitoradaPanel'
import { LegalFooter } from '../src/components/LegalFooter'
import { ErroSalvamentoResposta } from '../src/services/respostasTentativa'
import type { DadosRespostaTentativa, RespostaTentativa } from '../src/services/respostaValidation'
import type { AvaliacaoAluno } from '../src/services/avaliacaoValidation'

const services = vi.hoisted(() => ({
  iniciarTentativa: vi.fn(), consultarConteudoTentativa: vi.fn(), registrarFalhaCamera: vi.fn(),
  salvarRespostaTentativa: vi.fn(), consultarRespostasTentativa: vi.fn(), encerrarTentativa: vi.fn(),
}))
vi.mock('../src/lib/supabase', () => ({ supabase: {} }))
vi.mock('../src/services/tentativas', () => services)
vi.mock('../src/services/examFeatures', () => ({ photosEnabled: () => false, examManagementEnabled: () => false }))
vi.mock('../src/services/respostasTentativa', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/respostasTentativa')>(),
  consultarRespostasTentativa: services.consultarRespostasTentativa,
  salvarRespostaTentativa: services.salvarRespostaTentativa,
}))

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

function respostaSalva(dados: Partial<DadosRespostaTentativa> = {}): RespostaTentativa {
  return { id: '70000000-0000-0000-0000-000000000001', tentativa_id: tentativa.id,
    questao_id: questao.id, versao: 1, alternativa_id: questao.alternativas[0].id, texto: null,
    criado_em: '2026-11-08T12:00:00.000Z', atualizado_em: '2026-11-08T12:00:00.000Z', ...dados }
}

function enviarProva() {
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  fireEvent.click(screen.getByRole('button', { name: 'Enviar e encerrar' }))
}

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
  services.registrarFalhaCamera.mockResolvedValue(undefined)
  services.iniciarTentativa.mockResolvedValue(tentativa)
  services.consultarConteudoTentativa.mockResolvedValue(conteudo)
  services.consultarRespostasTentativa.mockResolvedValue([])
  services.salvarRespostaTentativa.mockImplementation(async (dados: DadosRespostaTentativa) => respostaSalva(dados))
  services.encerrarTentativa.mockImplementation(async (_id: string, reason: string) => ({
    id: tentativa.id, situacao: reason === 'ENVIO' || reason === 'PRAZO' ? 'FINALIZADA' : 'INTERROMPIDA',
    falhas_camera: reason === 'CAMERA' ? 1 : 0, encerrada_em: '2026-11-08T12:00:00Z',
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
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
    { tentativa_id: tentativa.id, questao_id: questao.id, versao: 1, alternativa_id: questao.alternativas[0].id, texto: null }))
  await screen.findByText('Resposta salva')
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  expect(screen.getByRole('dialog', { name: 'Enviar prova?' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Enviar e encerrar' }))
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'ENVIO'))
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('Prova enviada')))
})

test('perda da câmera registra ocorrência e permite salvar e enviar sem reconectar', async () => {
  const onLeave = vi.fn()
  const { track } = await iniciarProva(onLeave)
  await act(async () => { track.onended?.() })
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  await screen.findByText('Ocorrência da câmera registrada.')
  expect(services.registrarFalhaCamera).toHaveBeenCalledExactlyOnceWith(tentativa.id, expect.any(String))
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  await screen.findByText('Resposta salva')
  enviarProva()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'ENVIO'))
  expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('Prova enviada'))
})

test('perda breve registra uma vez por episódio e não oculta nem altera a resposta', async () => {
  const { track } = await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  await screen.findByText('Resposta salva')
  await act(async () => { track.onmute?.() })
  expect(screen.getByText('Quanto é 2 + 2?')).toBeTruthy()
  expect((screen.getByRole('radio', { name: '4' }) as HTMLInputElement).checked).toBe(true)
  await act(async () => { track.onmute?.() })
  expect(services.registrarFalhaCamera).toHaveBeenCalledTimes(1)
  await act(async () => { track.onunmute?.() })
  await act(async () => { track.onmute?.() })
  expect(services.registrarFalhaCamera).toHaveBeenCalledTimes(2)
  expect(services.registrarFalhaCamera.mock.calls[0][1]).not.toBe(services.registrarFalhaCamera.mock.calls[1][1])
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
  const rendered = render(<><TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()}
    onLeave={onLeave} onActiveChange={vi.fn()} /><LegalFooter openInNewTab /></>)
  fireEvent.click(screen.getByRole('checkbox', { name: /Li o aviso da prova/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar início' }))
  await screen.findByText('Quanto é 2 + 2?')
  return { track, onLeave, unmount: rendered.unmount }
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

test('consulta versões sem gestão habilitada e usa a próxima no salvar e no envio final', async () => {
  services.consultarRespostasTentativa.mockResolvedValue([respostaSalva({ versao: 4 })])
  await iniciarProva()
  expect(services.consultarRespostasTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id)
  expect((screen.getByRole('radio', { name: '4' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await screen.findByText('Resposta salva')
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ versao: 5, alternativa_id: questao.alternativas[1].id }))
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  enviarProva()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'ENVIO'))
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ versao: 6, alternativa_id: questao.alternativas[0].id }))
})

test('confirma o mesmo envio após falha de rede antes de gravar a alteração seguinte', async () => {
  services.salvarRespostaTentativa.mockRejectedValueOnce(new ErroSalvamentoResposta('Sem confirmação.', 'NAO_CONFIRMADA'))
  await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await screen.findByText('Sem confirmação.')
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  expect(screen.queryByText('Resposta salva')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar resposta' }))
  await screen.findByText('Resposta salva')
  const calls = services.salvarRespostaTentativa.mock.calls.map(([dados]) => dados)
  expect(calls).toEqual([
    { tentativa_id: tentativa.id, questao_id: questao.id, versao: 1, alternativa_id: questao.alternativas[0].id, texto: null },
    { tentativa_id: tentativa.id, questao_id: questao.id, versao: 1, alternativa_id: questao.alternativas[0].id, texto: null },
    { tentativa_id: tentativa.id, questao_id: questao.id, versao: 2, alternativa_id: questao.alternativas[1].id, texto: null },
  ])
  expect((screen.getByRole('radio', { name: '5' }) as HTMLInputElement).checked).toBe(true)
})

test('envio final resolve pendência mesmo quando o campo voltou ao último valor confirmado', async () => {
  services.consultarRespostasTentativa.mockResolvedValue([respostaSalva()])
  services.salvarRespostaTentativa.mockRejectedValueOnce(new ErroSalvamentoResposta('Sem confirmação.', 'NAO_CONFIRMADA'))
  await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await screen.findByText('Sem confirmação.')
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  enviarProva()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'ENVIO'))
  expect(services.salvarRespostaTentativa.mock.calls.map(([dados]) => dados.versao)).toEqual([2, 2, 3])
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ alternativa_id: questao.alternativas[0].id }))
})

test('conflito exige consulta explícita, preserva o campo e não envia a prova', async () => {
  services.salvarRespostaTentativa.mockRejectedValueOnce(new ErroSalvamentoResposta('Versão desatualizada.', 'CONFLITO'))
  await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  enviarProva()
  await screen.findByText('Versão desatualizada.')
  enviarProva()
  await screen.findByText('Confira a resposta salva da questão 1 antes de enviar.')
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
  expect(services.consultarRespostasTentativa).toHaveBeenCalledTimes(1)
  services.consultarRespostasTentativa.mockRejectedValueOnce(new Error('Consulta indisponível.'))
  fireEvent.click(screen.getByRole('button', { name: 'Conferir resposta salva' }))
  await screen.findByText('Consulta indisponível.')
  expect((screen.getByRole('button', { name: 'Salvar resposta' }) as HTMLButtonElement).disabled).toBe(true)
  services.consultarRespostasTentativa.mockResolvedValue([respostaSalva({ versao: 7 })])
  fireEvent.click(screen.getByRole('button', { name: 'Conferir resposta salva' }))
  await screen.findByText('Resposta no servidor')
  expect((screen.getByRole('radio', { name: '5' }) as HTMLInputElement).checked).toBe(true)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await screen.findByText('Resposta salva')
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ versao: 8, alternativa_id: questao.alternativas[1].id }))
})

test.each(['RECUSADA', 'NAO_CONFIRMADA'] as const)('falha %s no envio final mantém campos e impede encerramento', async codigo => {
  services.salvarRespostaTentativa.mockRejectedValueOnce(new ErroSalvamentoResposta('Falha no salvamento.', codigo))
  await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  enviarProva()
  await screen.findByText('Falha no salvamento.')
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
  expect((screen.getByRole('radio', { name: '5' }) as HTMLInputElement).checked).toBe(true)
  enviarProva()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'ENVIO'))
  expect(services.salvarRespostaTentativa.mock.calls[1][0]).toEqual(services.salvarRespostaTentativa.mock.calls[0][0])
})

test('envio final salva dissertativa com espaços e permite limpar resposta anterior', async () => {
  const dissertativa = { ...questao, tipo: 'DISSERTATIVA', alternativas: [] }
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [dissertativa] })
  await iniciarProva()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Minha resposta\ncom espaços  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await screen.findByText('Resposta salva')
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ versao: 1, texto: '  Minha resposta\ncom espaços  ', alternativa_id: null }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
  enviarProva()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledWith(tentativa.id, 'ENVIO'))
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ versao: 2, texto: null, alternativa_id: null }))
})

test.each(['consulta', 'questão', 'tipo', 'alternativa'])('falha de %s impede edição sem versão conhecida e permite repetir a consulta', async falha => {
  if (falha === 'consulta') services.consultarRespostasTentativa.mockRejectedValueOnce(new Error('Consulta indisponível.'))
  else services.consultarRespostasTentativa.mockResolvedValueOnce([respostaSalva(
    falha === 'questão' ? { questao_id: '50000000-0000-0000-0000-000000000002' }
      : falha === 'tipo' ? { alternativa_id: null, texto: 'Texto em objetiva' }
        : { alternativa_id: '60000000-0000-0000-0000-000000000003' })])
  const { stream } = cameraStream()
  getUserMedia.mockResolvedValue(stream)
  render(<TentativaMonitoradaPanel avaliacao={avaliacao} onCancelar={vi.fn()} onLeave={vi.fn()} onActiveChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Testar câmera' }))
  await screen.findByText(/Câmera conectada/)
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar início' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Tentar carregar questões' }))
  await screen.findByText(questao.enunciado)
  expect(services.consultarRespostasTentativa).toHaveBeenCalledTimes(2)
  expect(services.iniciarTentativa).toHaveBeenCalledTimes(1)
  expect(services.salvarRespostaTentativa).not.toHaveBeenCalled()
})

test.each(['saída', 'desmontagem'])('confirmação tardia após %s não finaliza a prova por envio', async motivo => {
  let confirm!: (resposta: RespostaTentativa) => void
  services.salvarRespostaTentativa.mockReturnValueOnce(new Promise(resolve => { confirm = resolve }))
  const { unmount } = await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  enviarProva()
  await waitFor(() => expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1))
  if (motivo === 'saída') fireEvent(window, new Event('blur'))
  else unmount()
  await act(async () => confirm(respostaSalva()))
  expect(services.encerrarTentativa).not.toHaveBeenCalledWith(tentativa.id, 'ENVIO')
})

test('cliques repetidos não duplicam o salvamento e bloqueiam envio até a confirmação', async () => {
  let confirm!: (resposta: RespostaTentativa) => void
  services.salvarRespostaTentativa.mockReturnValueOnce(new Promise(resolve => { confirm = resolve }))
  await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  const salvar = screen.getByRole('button', { name: 'Salvar resposta' })
  fireEvent.click(salvar)
  fireEvent.click(salvar)
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => confirm(respostaSalva()))
  await screen.findByText('Resposta salva')
})

test('recusa ao repetir uma resposta incerta não descarta seu conteúdo e versão', async () => {
  services.salvarRespostaTentativa
    .mockRejectedValueOnce(new ErroSalvamentoResposta('Sem confirmação.', 'NAO_CONFIRMADA'))
    .mockRejectedValueOnce(new ErroSalvamentoResposta('Sessão indisponível.', 'RECUSADA'))
  await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  fireEvent.click(screen.getByRole('button', { name: 'Salvar resposta' }))
  await screen.findByText('Sem confirmação.')
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar resposta' }))
  await screen.findByText('Sessão indisponível.')
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar resposta' }))
  await screen.findByText('Resposta salva')
  expect(services.salvarRespostaTentativa.mock.calls[2][0]).toEqual(services.salvarRespostaTentativa.mock.calls[0][0])
  expect(services.salvarRespostaTentativa.mock.calls[3][0]).toMatchObject({ versao: 2, alternativa_id: questao.alternativas[1].id })
})

test('falha na segunda questão preserva texto e não regrava a primeira ao repetir o envio final', async () => {
  const segunda = { ...questao, id: '50000000-0000-0000-0000-000000000002', tipo: 'DISSERTATIVA', ordem: 2, enunciado: 'Explique o resultado.', alternativas: [] }
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [questao, segunda] })
  services.salvarRespostaTentativa.mockImplementationOnce(async (dados: DadosRespostaTentativa) => respostaSalva(dados))
    .mockRejectedValueOnce(new ErroSalvamentoResposta('Sem confirmação.', 'NAO_CONFIRMADA'))
  await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Resposta da segunda questão\n' } })
  enviarProva()
  await screen.findByText('Sem confirmação.')
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('  Resposta da segunda questão\n')
  enviarProva()
  await waitFor(() => expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'ENVIO'))
  expect(services.salvarRespostaTentativa.mock.calls.map(([dados]) => dados.questao_id)).toEqual([questao.id, segunda.id, segunda.id])
  expect(services.salvarRespostaTentativa.mock.calls[2][0]).toEqual(services.salvarRespostaTentativa.mock.calls[1][0])
})

async function avancar(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

function simularTempo() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

test('selecionar alternativa salva automaticamente na próxima versão; carregamento não regrava respostas', async () => {
  services.consultarRespostasTentativa.mockResolvedValue([respostaSalva({ versao: 4 })])
  await iniciarProva()
  simularTempo()
  await avancar(1000)
  expect(services.salvarRespostaTentativa).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  await avancar(0)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledExactlyOnceWith({
    tentativa_id: tentativa.id, questao_id: questao.id, versao: 5, alternativa_id: questao.alternativas[1].id, texto: null,
  })
  expect(screen.getByRole('button', { name: 'Resposta salva' })).toBeTruthy()
  await avancar(5000)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
})

test('dissertativa espera 800 ms sem digitar, preserva espaços e salva a limpeza do campo', async () => {
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [{ ...questao, tipo: 'DISSERTATIVA', alternativas: [] }] })
  await iniciarProva()
  simularTempo()
  const campo = screen.getByRole('textbox')
  fireEvent.change(campo, { target: { value: 'Primeira parte' } })
  await avancar(799)
  expect(services.salvarRespostaTentativa).not.toHaveBeenCalled()
  fireEvent.change(campo, { target: { value: '  Resposta completa\n' } })
  await avancar(799)
  expect(services.salvarRespostaTentativa).not.toHaveBeenCalled()
  await avancar(1)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ versao: 1, texto: '  Resposta completa\n', alternativa_id: null }))
  fireEvent.change(campo, { target: { value: '' } })
  await avancar(800)
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ versao: 2, texto: null }))
})

test('digitação continua durante a requisição e a confirmação antiga não substitui o texto mais recente', async () => {
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [{ ...questao, tipo: 'DISSERTATIVA', alternativas: [] }] })
  let confirmar!: (resposta: RespostaTentativa) => void
  services.salvarRespostaTentativa.mockReturnValueOnce(new Promise(resolve => { confirmar = resolve }))
  await iniciarProva()
  simularTempo()
  const campo = screen.getByRole('textbox') as HTMLTextAreaElement
  campo.focus()
  fireEvent.change(campo, { target: { value: 'Primeiro texto' } })
  await avancar(800)
  expect(campo.disabled).toBe(false)
  expect(document.activeElement).toBe(campo)
  fireEvent.change(campo, { target: { value: 'Texto mais recente' } })
  await avancar(800)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
  await act(async () => confirmar(respostaSalva({ alternativa_id: null, texto: 'Primeiro texto' })))
  expect(campo.value).toBe('Texto mais recente')
  expect(screen.queryByText('Resposta salva')).toBeNull()
  await avancar(0)
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ versao: 2, texto: 'Texto mais recente' }))
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(2)
  expect(document.activeElement).toBe(campo)
})

test('editar outra questão não adia o salvamento da primeira', async () => {
  const primeira = { ...questao, tipo: 'DISSERTATIVA', alternativas: [] }
  const segunda = { ...primeira, id: '50000000-0000-0000-0000-000000000002', ordem: 2, enunciado: 'Explique o resultado.' }
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [primeira, segunda] })
  await iniciarProva()
  simularTempo()
  fireEvent.change(screen.getByRole('textbox', { name: 'Resposta da questão 1' }), { target: { value: 'Primeira' } })
  await avancar(700)
  fireEvent.change(screen.getByRole('textbox', { name: 'Resposta da questão 2' }), { target: { value: 'Segunda' } })
  await avancar(100)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ questao_id: primeira.id, texto: 'Primeira' }))
  await avancar(700)
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ questao_id: segunda.id, texto: 'Segunda', versao: 1 }))
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(2)
})

test.each(['NAO_CONFIRMADA', 'RECUSADA', 'CONFLITO'] as const)('falha automática %s pausa os envios da questão até ação explícita', async codigo => {
  services.salvarRespostaTentativa.mockRejectedValueOnce(new ErroSalvamentoResposta('Falha simulada.', codigo))
  await iniciarProva()
  simularTempo()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  await avancar(0)
  expect(screen.getByText('Falha simulada.')).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  await avancar(5000)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
  if (codigo === 'CONFLITO') {
    services.consultarRespostasTentativa.mockResolvedValue([respostaSalva({ versao: 7 })])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Conferir resposta salva' })) })
    await avancar(5000)
    expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
  }
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: codigo === 'NAO_CONFIRMADA' ? 'Reenviar resposta' : 'Salvar resposta' })) })
  if (codigo === 'NAO_CONFIRMADA') expect(services.salvarRespostaTentativa.mock.calls[1][0]).toEqual(services.salvarRespostaTentativa.mock.calls[0][0])
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({
    alternativa_id: questao.alternativas[1].id, versao: codigo === 'CONFLITO' ? 8 : codigo === 'NAO_CONFIRMADA' ? 2 : 1,
  }))
  expect((screen.getByRole('radio', { name: '5' }) as HTMLInputElement).checked).toBe(true)
})

test('envio final salva imediatamente o texto que ainda aguardava o temporizador', async () => {
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [{ ...questao, tipo: 'DISSERTATIVA', alternativas: [] }] })
  await iniciarProva()
  simularTempo()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Texto para enviar' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enviar e encerrar' })) })
  expect(services.salvarRespostaTentativa).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ versao: 1, texto: 'Texto para enviar' }))
  expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'ENVIO')
  await avancar(5000)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledTimes(1)
})

test('envio aguarda a requisição automática em andamento e depois inclui a alteração mais recente', async () => {
  let confirmar!: (resposta: RespostaTentativa) => void
  services.salvarRespostaTentativa.mockReturnValueOnce(new Promise(resolve => { confirmar = resolve }))
  await iniciarProva()
  simularTempo()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  await avancar(0)
  expect((screen.getByRole('button', { name: 'Enviar prova' }) as HTMLButtonElement).disabled).toBe(true)
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: '5' }))
  await act(async () => confirmar(respostaSalva()))
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enviar e encerrar' })) })
  expect(services.salvarRespostaTentativa.mock.calls.map(([dados]) => dados.versao)).toEqual([1, 2])
  expect(services.salvarRespostaTentativa).toHaveBeenLastCalledWith(expect.objectContaining({ alternativa_id: questao.alternativas[1].id }))
  expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'ENVIO')
})

test.each(['saída', 'desmontagem', 'prazo'])('%s impede o salvamento automático agendado', async motivo => {
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [{ ...questao, tipo: 'DISSERTATIVA', alternativas: [] }] })
  const { unmount } = await iniciarProva()
  simularTempo()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ainda não enviada' } })
  if (motivo === 'saída') fireEvent(window, new Event('blur'))
  if (motivo === 'desmontagem') unmount()
  if (motivo === 'prazo') vi.setSystemTime(new Date(tentativa.limite_em))
  await avancar(1000)
  expect(services.salvarRespostaTentativa).not.toHaveBeenCalled()
})

test('confirmação de encerramento pausa o temporizador e cancelar permite salvar a resposta', async () => {
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [{ ...questao, tipo: 'DISSERTATIVA', alternativas: [] }] })
  await iniciarProva()
  simularTempo()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Texto ainda não enviado' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar prova' }))
  await avancar(1000)
  expect(services.salvarRespostaTentativa).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continuar na prova' }))
  await avancar(0)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ texto: 'Texto ainda não enviado' }))
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
})

test('falha em uma questão não impede outra de salvar e não apaga o aviso de erro', async () => {
  const segunda = { ...questao, id: '50000000-0000-0000-0000-000000000002', tipo: 'DISSERTATIVA', ordem: 2, enunciado: 'Explique o resultado.', alternativas: [] }
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [questao, segunda] })
  services.salvarRespostaTentativa.mockRejectedValueOnce(new ErroSalvamentoResposta('Falha na primeira questão.', 'NAO_CONFIRMADA'))
  await iniciarProva()
  simularTempo()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  await avancar(0)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Resposta da segunda' } })
  await avancar(800)
  expect(services.salvarRespostaTentativa.mock.calls.map(([dados]) => dados.questao_id)).toEqual([questao.id, segunda.id])
  expect(screen.getByText('Falha na primeira questão.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Reenviar resposta' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Resposta salva' })).toBeTruthy()
})

test('ocorrência sem confirmação mantém o mesmo UUID no reenvio; reconectar preserva a resposta', async () => {
  services.registrarFalhaCamera.mockRejectedValueOnce(new Error('Ocorrência sem confirmação.'))
  const { track } = await iniciarProva()
  fireEvent.click(screen.getByRole('radio', { name: '4' }))
  await screen.findByText('Resposta salva')
  await act(async () => { track.onended?.() })
  await screen.findByText('Ocorrência sem confirmação.')
  const first = services.registrarFalhaCamera.mock.calls[0]
  const restored = cameraStream()
  getUserMedia.mockResolvedValueOnce(restored.stream)
  fireEvent.click(screen.getByRole('button', { name: 'Reconectar câmera' }))
  await screen.findByText(/Câmera conectada/)
  expect((screen.getByRole('radio', { name: '4' }) as HTMLInputElement).checked).toBe(true)
  expect(services.iniciarTentativa).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar ocorrência' }))
  await screen.findByText('Ocorrência da câmera registrada.')
  expect(services.registrarFalhaCamera.mock.calls[1]).toEqual(first)
  fireEvent.click(screen.getByRole('button', { name: 'Minha imagem ficou preta' }))
  await waitFor(() => expect(services.registrarFalhaCamera).toHaveBeenCalledTimes(3))
  expect(services.registrarFalhaCamera.mock.calls[2][1]).not.toBe(first[1])
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
})

test('falha contínua e reconexão negada não duplicam a ocorrência nem bloqueiam dissertativa', async () => {
  services.consultarConteudoTentativa.mockResolvedValue({ ...conteudo, questoes: [{ ...questao, tipo: 'DISSERTATIVA', alternativas: [] }] })
  const { track } = await iniciarProva()
  simularTempo()
  const campo = screen.getByRole('textbox')
  fireEvent.change(campo, { target: { value: 'Continua salvando sem câmera' } })
  await act(async () => { track.onmute?.() })
  await act(async () => { track.onended?.() })
  await avancar(4000)
  expect(screen.getByRole('textbox')).toBe(campo)
  expect(services.salvarRespostaTentativa).toHaveBeenCalledWith(expect.objectContaining({ texto: 'Continua salvando sem câmera' }))
  getUserMedia.mockRejectedValueOnce(new DOMException('Negado', 'NotAllowedError'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconectar câmera' })) })
  expect(services.registrarFalhaCamera).toHaveBeenCalledTimes(1)
  expect(services.encerrarTentativa).not.toHaveBeenCalled()
})

test('falha de registro não impede envio e informa a pendência após encerrar', async () => {
  services.registrarFalhaCamera.mockRejectedValue(new Error('Registro indisponível.'))
  const onLeave = vi.fn()
  const { track } = await iniciarProva(onLeave)
  await act(async () => { track.onended?.() })
  await screen.findByText('Registro indisponível.')
  enviarProva()
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith(expect.stringContaining('ocorrências da câmera sem confirmação')))
  expect(services.encerrarTentativa).toHaveBeenCalledExactlyOnceWith(tentativa.id, 'ENVIO')
  expect(services.registrarFalhaCamera).toHaveBeenCalledTimes(2)
  expect(services.registrarFalhaCamera.mock.calls[1]).toEqual(services.registrarFalhaCamera.mock.calls[0])
})

test('eventos durante registro lento entram na fila e reenviar não duplica requisições', async () => {
  let confirmar!: () => void
  services.registrarFalhaCamera.mockReturnValueOnce(new Promise<void>(resolve => { confirmar = resolve }))
  const { track } = await iniciarProva()
  await act(async () => { track.onmute?.() })
  expect((screen.getByRole('button', { name: 'Reenviar ocorrência' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { track.onunmute?.() })
  await act(async () => { track.onmute?.() })
  expect(services.registrarFalhaCamera).toHaveBeenCalledTimes(1)
  await act(async () => confirmar())
  expect(services.registrarFalhaCamera).toHaveBeenCalledTimes(2)
  expect(services.registrarFalhaCamera.mock.calls[1][1]).not.toBe(services.registrarFalhaCamera.mock.calls[0][1])
})
