import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TentativasResponsavelPanel } from '../src/components/TentativasResponsavelPanel'

const services=vi.hoisted(()=>({list:vi.fn(),authorize:vi.fn(),photos:vi.fn(),image:vi.fn()}))
vi.mock('../src/services/examManagement',()=>({listarTentativasResponsavel:services.list,reativarTentativa:services.authorize}))
vi.mock('../src/services/examPhotos',()=>({listarFotosResponsavel:services.photos,consultarImagemFoto:services.image}))
vi.mock('../src/services/examFeatures',()=>({photosEnabled:()=>true}))
const assessment='10000000-0000-0000-0000-000000000001',attempt='20000000-0000-0000-0000-000000000001'
const interrupted={id:attempt,avaliacao_id:assessment,aluno_id:'30000000-0000-0000-0000-000000000001',aluno_nome:'Aluno de teste',
  situacao:'INTERROMPIDA',iniciada_em:'2026-11-08T12:00:00Z',limite_em:'2026-11-08T13:00:00Z',encerrada_em:'2026-11-08T12:05:00Z',
  ciclo:1,retomada_autorizada:false}
beforeEach(()=>{
  vi.resetAllMocks()
  vi.stubEnv('VITE_EXAM_PHOTOS_ENABLED','true')
  services.list.mockResolvedValue([interrupted])
  services.authorize.mockResolvedValue(undefined)
  services.photos.mockResolvedValue([])
})
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.restoreAllMocks()})

test('responsável informa motivo e minutos e vê confirmação de liberação pendente',async()=>{
  services.list.mockResolvedValueOnce([interrupted]).mockResolvedValue([{...interrupted,retomada_autorizada:true}])
  render(<TentativasResponsavelPanel avaliacaoId={assessment} duracao={60}/> )
  fireEvent.click(await screen.findByRole('button',{name:'Reativar tentativa de Aluno de teste'}))
  fireEvent.change(screen.getByLabelText('Justificativa da reativação'),{target:{value:'Câmera recuperada após falha técnica'}})
  fireEvent.change(screen.getByLabelText('Minutos para continuar'),{target:{value:'20'}})
  fireEvent.submit(screen.getByRole('form',{name:'Reativar tentativa de Aluno de teste'}))
  await waitFor(()=>expect(services.authorize).toHaveBeenCalledExactlyOnceWith(attempt,'Câmera recuperada após falha técnica',20))
  await screen.findByText(/Reativação autorizada, aguardando/)
  expect(screen.queryByRole('button',{name:'Reativar tentativa de Aluno de teste'})).toBeNull()
})

test('prova finalizada não oferece reativação; falha de consulta não exibe dados antigos',async()=>{
  services.list.mockResolvedValue([{...interrupted,situacao:'FINALIZADA'}])
  render(<TentativasResponsavelPanel avaliacaoId={assessment} duracao={60}/> )
  await screen.findByText('Aluno de teste')
  expect(screen.queryByRole('button',{name:/Reativar tentativa de/})).toBeNull()
  services.list.mockRejectedValue(new Error('Sem acesso'))
  fireEvent.click(screen.getByRole('button',{name:'Atualizar tentativas'}))
  await screen.findByText('Sem acesso')
  expect(screen.queryByText('Aluno de teste')).toBeNull()
})

test('ver fotos pede lista restrita e libera objetos locais ao fechar a consulta',async()=>{
  const revoke=vi.fn(),create=vi.fn(()=> 'blob:test-photo')
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create})
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke})
  const photo={id:'40000000-0000-0000-0000-000000000001',momento:'INICIAL',ciclo:1,
    agendada_em:'2026-11-08T12:00:00Z',recebida_em:'2026-11-08T12:00:03Z',expira_em:'2099-01-01T00:00:00Z',situacao:'DISPONIVEL'}
  services.photos.mockResolvedValue([photo]);services.image.mockResolvedValue(new Blob(['photo'],{type:'image/jpeg'}))
  render(<TentativasResponsavelPanel avaliacaoId={assessment} duracao={60}/> )
  fireEvent.click(await screen.findByRole('button',{name:'Fotos de Aluno de teste'}))
  fireEvent.click(await screen.findByRole('button',{name:'Visualizar foto inicial'}))
  await screen.findByRole('img')
  expect(services.image).toHaveBeenCalledWith(photo.id,expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button',{name:'Fechar fotos'}))
  expect(revoke).toHaveBeenCalledWith('blob:test-photo')
})
