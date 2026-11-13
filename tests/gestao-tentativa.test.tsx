import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TentativasResponsavelPanel } from '../src/components/TentativasResponsavelPanel'
import type { CorrecaoTentativa } from '../src/services/correcoesTentativa'

const services=vi.hoisted(()=>({list:vi.fn(),photos:vi.fn(),image:vi.fn()}))
const correcoes = vi.hoisted(() => ({ consultar: vi.fn(), salvar: vi.fn() }))
const publicacoes = vi.hoisted(() => ({ consultar: vi.fn(), publicar: vi.fn() }))
vi.mock('../src/services/examManagement',()=>({listarTentativasResponsavel:services.list}))
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
  publicacoes.consultar.mockResolvedValue({ estado: 'CORRECAO_PENDENTE', publicado_em: null })
})
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.restoreAllMocks()})

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
