import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TentativasResponsavelPanel } from '../src/components/TentativasResponsavelPanel'
import type { CorrecaoTentativa } from '../src/services/correcoesTentativa'

const services=vi.hoisted(()=>({list:vi.fn(),photos:vi.fn(),image:vi.fn(),timeline:vi.fn()}))
const correcoes = vi.hoisted(() => ({ consultar: vi.fn(), salvar: vi.fn() }))
const publicacoes = vi.hoisted(() => ({ consultar: vi.fn(), publicar: vi.fn() }))
vi.mock('../src/services/examManagement',()=>({listarTentativasResponsavel:services.list,listarLinhaTempoTentativa:services.timeline}))
vi.mock('../src/services/correcoesTentativa', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/correcoesTentativa')>(),
  consultarCorrecaoTentativa: correcoes.consultar, salvarCorrecaoDissertativa: correcoes.salvar,
}))
vi.mock('../src/services/examPhotos',()=>({listarFotosResponsavel:services.photos,consultarImagemFoto:services.image}))
vi.mock('../src/services/examFeatures',()=>({photosEnabled:()=>true}))
vi.mock('../src/services/resultadosAvaliacao', () => ({
  consultarPublicacaoResultados: publicacoes.consultar, publicarResultadosAvaliacao: publicacoes.publicar,
}))
const assessment='10000000-0000-0000-0000-000000000001',attempt='20000000-0000-0000-0000-000000000001'
const interrupted={id:attempt,avaliacao_id:assessment,aluno_id:'30000000-0000-0000-0000-000000000001',aluno_nome:'Aluno de teste',
  situacao:'INTERROMPIDA',iniciada_em:'2026-11-08T12:00:00Z',limite_em:'2026-11-08T13:00:00Z',encerrada_em:'2026-11-08T12:05:00Z',
  ciclo:1,retomada_autorizada:false}
beforeEach(()=>{
  vi.resetAllMocks()
  vi.stubEnv('VITE_EXAM_PHOTOS_ENABLED','true')
  services.list.mockResolvedValue([interrupted])
  services.photos.mockResolvedValue([])
  services.timeline.mockResolvedValue([])
  publicacoes.consultar.mockResolvedValue({ estado: 'CORRECAO_PENDENTE', publicado_em: null })
})
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.restoreAllMocks()})

const tentativas = Array.from({ length: 51 }, (_, index) => ({ ...interrupted, situacao: 'FINALIZADA',
  id: `20000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`, aluno_nome: `Aluno ${index + 1}` }))

test('navega além das 50 tentativas e permite consultar, corrigir e publicar a partir da segunda página', async () => {
  services.list.mockImplementation(async (_id: string, pagina: number) => pagina === 0 ? tentativas : tentativas.slice(50))
  const ultima = tentativas[50]
  const questao = { id: '40000000-0000-0000-0000-000000000001', tipo: 'DISSERTATIVA' as const,
    ordem: 1, enunciado: 'Explique o resultado.', maximo: 2, resposta: 'Minha resposta.', gabarito: null,
    pontos: null, comentario: null, versao: 0 }
  correcoes.consultar.mockResolvedValue({ tentativa_id: ultima.id, pontos_obtidos: 0, pontos_totais: 2,
    pendentes: 1, nota: null, questoes: [questao] })
  correcoes.salvar.mockResolvedValue({ tentativa_id: ultima.id, pontos_obtidos: 2, pontos_totais: 2,
    pendentes: 0, nota: 10, questoes: [{ ...questao, pontos: 2, versao: 1 }] })
  publicacoes.publicar.mockResolvedValue({ estado: 'PUBLICADO', publicado_em: '2026-11-18T12:00:00Z' })
  render(<TentativasResponsavelPanel avaliacaoId={assessment} podeCorrigir />)
  await screen.findByText('Aluno 1')
  expect(screen.getAllByRole('listitem')).toHaveLength(50)
  expect(screen.queryByText('Aluno 51')).toBeNull()
  const nav = within(screen.getByRole('navigation', { name: 'Paginação das tentativas' }))
  expect(nav.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(nav.getByRole('button', { name: 'Próxima' }))
  await screen.findByText('Aluno 51')
  expect(services.list).toHaveBeenLastCalledWith(assessment, 1)
  expect(screen.getByText('Página 2')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Tentativas dos alunos' })).toBe(document.activeElement)
  expect(nav.getByRole('button', { name: 'Próxima' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Fotos de Aluno 51' }))
  await waitFor(() => expect(services.photos).toHaveBeenCalledExactlyOnceWith(ultima.id))
  fireEvent.click(screen.getByRole('button', { name: 'Linha do tempo' }))
  await waitFor(() => expect(services.timeline).toHaveBeenCalledExactlyOnceWith(ultima.id))
  fireEvent.click(screen.getByRole('button', { name: 'Corrigir tentativa de Aluno 51' }))
  fireEvent.change(await screen.findByLabelText('Pontos da questão 1'), { target: { value: '2' } })
  publicacoes.consultar.mockResolvedValue({ estado: 'PRONTO', publicado_em: null })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar correção da questão 1' }))
  await screen.findByText('Nota final 10,00 de 10')
  expect(correcoes.salvar).toHaveBeenCalledExactlyOnceWith(ultima.id, questao, 2, '')
  fireEvent.click(await screen.findByRole('button', { name: 'Publicar resultados' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar publicação' }))
  await screen.findByText(/Resultados publicados\. Cada aluno/)
  expect(publicacoes.publicar).toHaveBeenCalledExactlyOnceWith(assessment)
  expect(screen.queryByRole('button', { name: 'Salvar correção da questão 1' })).toBeNull()
  fireEvent.click(nav.getByRole('button', { name: 'Anterior' }))
  await screen.findByText('Aluno 1')
  expect(screen.queryByRole('heading', { name: 'Correção de Aluno 51' })).toBeNull()
  fireEvent.click(nav.getByRole('button', { name: 'Próxima' }))
  await screen.findByText('Aluno 51')
  expect(screen.getByRole('button', { name: 'Ver correção de Aluno 51' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar tentativas' }))
  await screen.findByText('Aluno 1')
  expect(screen.getByText('Página 1')).toBeTruthy()
  expect(services.list).toHaveBeenLastCalledWith(assessment, 0)
})

test('carregamento e falha de página ocultam a lista anterior e permitem voltar', async () => {
  services.list.mockResolvedValueOnce(tentativas)
  let falhar!: (error: Error) => void
  services.list.mockReturnValueOnce(new Promise((_resolve, reject) => { falhar = reject }))
  services.list.mockResolvedValue(tentativas)
  render(<TentativasResponsavelPanel avaliacaoId={assessment} />)
  await screen.findByText('Aluno 1')
  const nav = within(screen.getByRole('navigation', { name: 'Paginação das tentativas' }))
  fireEvent.click(nav.getByRole('button', { name: 'Próxima' }))
  expect(screen.queryByText('Aluno 1')).toBeNull()
  expect(nav.getByRole('button', { name: 'Anterior' }).hasAttribute('disabled')).toBe(true)
  expect(nav.getByRole('button', { name: 'Próxima' }).hasAttribute('disabled')).toBe(true)
  await act(async () => falhar(new Error('Falha temporária.')))
  expect(screen.getByRole('alert').textContent).toBe('Falha temporária.')
  expect(screen.queryByText('Aluno 1')).toBeNull()
  fireEvent.click(nav.getByRole('button', { name: 'Anterior' }))
  await screen.findByText('Aluno 1')
})

test('segunda página vazia permite voltar e a troca de avaliação descarta consultas atrasadas', async () => {
  services.list.mockResolvedValueOnce(tentativas).mockResolvedValueOnce([])
  const { rerender } = render(<TentativasResponsavelPanel key={assessment} avaliacaoId={assessment} />)
  await screen.findByText('Aluno 1')
  fireEvent.click(screen.getByRole('button', { name: 'Próxima' }))
  await screen.findByText('Nenhuma tentativa nesta página.')
  expect(screen.getByRole('button', { name: 'Próxima' }).hasAttribute('disabled')).toBe(true)
  let terminar!: (value: typeof tentativas) => void
  services.list.mockReturnValueOnce(new Promise(resolve => { terminar = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Anterior' }))
  const outraAvaliacao = '10000000-0000-0000-0000-000000000002'
  services.list.mockResolvedValueOnce([])
  rerender(<TentativasResponsavelPanel key={outraAvaliacao} avaliacaoId={outraAvaliacao} />)
  await screen.findByText('Nenhum aluno iniciou esta avaliação.')
  expect(services.list).toHaveBeenLastCalledWith(outraAvaliacao, 0)
  await act(async () => terminar(tentativas))
  expect(screen.queryByText('Aluno 1')).toBeNull()
  expect(screen.getByText('Página 1')).toBeTruthy()
})

test('responsável consulta tentativa interrompida sem poder reativá-la',async()=>{
  services.list.mockResolvedValue([{...interrupted,retomada_autorizada:true}])
  render(<TentativasResponsavelPanel avaliacaoId={assessment}/>)
  await screen.findByText('Interrompida · ciclo 1')
  expect(screen.queryByRole('button',{name:/Reativar tentativa de/})).toBeNull()
  expect(screen.queryByText(/Reativação autorizada/)).toBeNull()
})

test('prova finalizada não oferece reativação; falha de consulta não exibe dados antigos',async()=>{
  services.list.mockResolvedValue([{...interrupted,situacao:'FINALIZADA'}])
  render(<TentativasResponsavelPanel avaliacaoId={assessment}/> )
  await screen.findByText('Aluno de teste')
  expect(screen.queryByRole('button', { name: /Corrigir tentativa de/ })).toBeNull()
  expect(screen.queryByRole('button',{name:/Reativar tentativa de/})).toBeNull()
  services.list.mockRejectedValue(new Error('Sem acesso'))
  fireEvent.click(screen.getByRole('button',{name:'Atualizar tentativas'}))
  await screen.findByText('Sem acesso')
  expect(screen.queryByText('Aluno de teste')).toBeNull()
})

test('professor abre a correção, valida o limite da dissertativa e vê a nota confirmada pelo banco', async () => {
  services.list.mockResolvedValue([{ ...interrupted, situacao: 'FINALIZADA' }])
  const pendente: CorrecaoTentativa = { tentativa_id: attempt, pontos_obtidos: 2, pontos_totais: 6, pendentes: 1, nota: null,
    questoes: [
      { id: '40000000-0000-0000-0000-000000000001', tipo: 'OBJETIVA', ordem: 1, enunciado: 'Qual a alternativa?',
        maximo: 2, resposta: 'Resposta A', gabarito: 'Resposta A', pontos: 2, comentario: null, versao: 0 },
      { id: '40000000-0000-0000-0000-000000000002', tipo: 'DISSERTATIVA', ordem: 2, enunciado: 'Explique a escolha.',
        maximo: 4, resposta: 'Minha justificativa.', gabarito: null, pontos: null, comentario: null, versao: 0 },
    ] }
  correcoes.consultar.mockResolvedValue(pendente)
  correcoes.salvar.mockResolvedValue({ ...pendente, pontos_obtidos: 4.5, pendentes: 0, nota: 7.5,
    questoes: [pendente.questoes[0], { ...pendente.questoes[1], pontos: 2.5, comentario: 'Boa justificativa.', versao: 1 }] })
  render(<TentativasResponsavelPanel avaliacaoId={assessment} podeCorrigir />)
  fireEvent.click(await screen.findByRole('button', { name: 'Corrigir tentativa de Aluno de teste' }))
  await screen.findByText('Nota pendente · 1 dissertativa para corrigir')
  expect(screen.getByRole('heading', { name: 'Correção de Aluno de teste' })).toBe(document.activeElement)
  const pontos = screen.getByLabelText('Pontos da questão 2')
  const salvar = screen.getByRole('button', { name: 'Salvar correção da questão 2' })
  fireEvent.change(pontos, { target: { value: '4,01' } })
  fireEvent.click(salvar)
  expect((await screen.findByRole('alert')).textContent).toContain('Informe de 0 a 4 pontos')
  expect(correcoes.salvar).not.toHaveBeenCalled()
  expect(pontos).toBe(document.activeElement)
  fireEvent.change(pontos, { target: { value: '2,5' } })
  fireEvent.change(screen.getByLabelText('Comentário da questão 2 (opcional)'), { target: { value: 'Boa justificativa.' } })
  fireEvent.click(salvar)
  await screen.findByText('Nota final 7,50 de 10')
  expect(correcoes.salvar).toHaveBeenCalledExactlyOnceWith(attempt, pendente.questoes[1], 2.5, 'Boa justificativa.')
})

test('publicar resultados exige confirmação do professor e muda a correção para consulta', async () => {
  services.list.mockResolvedValue([{ ...interrupted, situacao: 'FINALIZADA' }])
  publicacoes.consultar.mockResolvedValue({ estado: 'PRONTO', publicado_em: null })
  publicacoes.publicar.mockResolvedValue({ estado: 'PUBLICADO', publicado_em: '2026-11-09T12:00:00Z' })
  render(<TentativasResponsavelPanel avaliacaoId={assessment} podeCorrigir />)
  fireEvent.click(await screen.findByRole('button', { name: 'Publicar resultados' }))
  expect(publicacoes.publicar).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar publicação' }))
  await screen.findByText(/Resultados publicados\. Cada aluno/)
  expect(publicacoes.publicar).toHaveBeenCalledExactlyOnceWith(assessment)
  expect(screen.getByRole('button', { name: 'Ver correção de Aluno de teste' })).toBeTruthy()
})

test('ver fotos pede lista restrita e libera objetos locais ao fechar a consulta',async()=>{
  const revoke=vi.fn(),create=vi.fn(()=> 'blob:test-photo')
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create})
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke})
  const photo={id:'40000000-0000-0000-0000-000000000001',momento:'INICIAL',ciclo:1,
    agendada_em:'2026-11-08T12:00:00Z',recebida_em:'2026-11-08T12:00:03Z',expira_em:'2099-01-01T00:00:00Z',situacao:'DISPONIVEL'}
  services.photos.mockResolvedValue([photo]);services.image.mockResolvedValue(new Blob(['photo'],{type:'image/jpeg'}))
  render(<TentativasResponsavelPanel avaliacaoId={assessment}/> )
  fireEvent.click(await screen.findByRole('button',{name:'Fotos de Aluno de teste'}))
  fireEvent.click(await screen.findByRole('button',{name:'Visualizar foto inicial'}))
  await screen.findByRole('img')
  expect(services.image).toHaveBeenCalledWith(photo.id,expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button',{name:'Fechar fotos'}))
  expect(revoke).toHaveBeenCalledWith('blob:test-photo')
})
