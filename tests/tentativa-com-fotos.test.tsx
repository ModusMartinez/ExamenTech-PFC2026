import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TentativaMonitoradaPanel } from '../src/components/TentativaMonitoradaPanel'
import type { AvaliacaoAluno } from '../src/services/avaliacaoValidation'

const services=vi.hoisted(()=>({start:vi.fn(),content:vi.fn(),answers:vi.fn(),save:vi.fn(),end:vi.fn(),plan:vi.fn(),send:vi.fn(),capture:vi.fn(),stop:vi.fn(),incident:vi.fn()}))
vi.mock('../src/lib/supabase', () => ({ supabase: {} }))
vi.mock('../src/services/tentativas',()=>({iniciarTentativa:services.start,consultarConteudoTentativa:services.content,
  encerrarTentativa:services.end,registrarFalhaCamera:services.incident}))
vi.mock('../src/services/respostasTentativa',async importOriginal=>({...await importOriginal<typeof import('../src/services/respostasTentativa')>(),
  consultarRespostasTentativa:services.answers,salvarRespostaTentativa:services.save}))
vi.mock('../src/services/examFeatures',()=>({photosEnabled:()=>true,examManagementEnabled:()=>true}))
vi.mock('../src/services/examPhotos',()=>({PHOTO_NOTICE:'Uma foto inicial e três durante a prova. Prazo máximo de 90 dias.',
  PHOTO_NOTICE_VERSION:'2026-11-08-fotos-v1',consultarPlanoFotos:services.plan,enviarFoto:services.send}))
vi.mock('../src/services/photoEvidence',()=>({capturePhotoFrame:services.capture}))
vi.mock('../src/hooks/useCameraSession',()=>({useCameraSession:()=>{
  const [status,setStatus]=useState('ready')
  return {videoRef:useRef<HTMLVideoElement>(null),status,message:status==='ready'?'Câmera pronta':'Câmera indisponível',
    start:async()=>setStatus('ready'),stop:services.stop,reportNoImage:()=>setStatus('error')}
}}))
const assessment: AvaliacaoAluno={id:'10000000-0000-0000-0000-000000000001',turma_id:'20000000-0000-0000-0000-000000000001',
  titulo:'Prova com fotos',turma_nome:'Turma teste',tipo:'PROVA',situacao:'PUBLICADA',duracao_minutos:60,
  inicio_em:'2026-01-01T00:00:00Z',fim_em:'2099-01-01T00:00:00Z',publicada_em:'2026-01-01T00:00:00Z'}
const attempt={id:'30000000-0000-0000-0000-000000000001',avaliacao_id:assessment.id,aluno_id:'40000000-0000-0000-0000-000000000001',
  situacao:'EM_ANDAMENTO',iniciada_em:'2026-01-01T00:00:00.000Z',limite_em:'2099-01-01T00:00:00.000Z'}
const question={id:'50000000-0000-0000-0000-000000000001',tipo:'OBJETIVA',enunciado:'Qual resposta foi salva?',ordem:1,pontuacao:1,
  alternativas:[{id:'60000000-0000-0000-0000-000000000001',ordem:1,texto:'Resposta A'},
    {id:'60000000-0000-0000-0000-000000000002',ordem:2,texto:'Resposta B'}]}
beforeEach(()=>{
  vi.resetAllMocks()
  Object.defineProperties(HTMLDialogElement.prototype,{
    showModal:{configurable:true,value(){this.setAttribute('open','')}},close:{configurable:true,value(){this.removeAttribute('open')}},
  })
  services.incident.mockResolvedValue(undefined)
  services.start.mockResolvedValue(attempt)
  services.content.mockResolvedValue({tentativa_id:attempt.id,avaliacao_id:assessment.id,titulo:assessment.titulo,tipo:'PROVA',
    iniciada_em:attempt.iniciada_em,limite_em:attempt.limite_em,questoes:[question]})
  services.answers.mockResolvedValue([{id:'80000000-0000-0000-0000-000000000001',tentativa_id:attempt.id,
    questao_id:question.id,alternativa_id:question.alternativas[1].id,texto:null,versao:2,
    criado_em:'2026-11-08T12:00:00Z',atualizado_em:'2026-11-08T12:00:00Z'}])
  services.plan.mockImplementation(async()=>({tentativa_id:attempt.id,ciclo:2,servidor_em:new Date().toISOString(),
    capturas:['INICIAL','PROVA_1','PROVA_2','PROVA_3'].map((momento,i)=>({id:`70000000-0000-0000-0000-00000000000${i+1}`,
      momento,agendada_em:new Date(Date.now()+i*600000).toISOString(),recebida_em:null}))}))
  services.capture.mockResolvedValue({moment:'INICIAL',blob:new Blob(['photo'],{type:'image/jpeg'}),width:640,height:480,capturedAt:new Date().toISOString()})
  services.send.mockResolvedValue(undefined)
  services.end.mockResolvedValue({id:attempt.id,situacao:'FINALIZADA',encerrada_em:'2026-11-08T12:00:00Z',falhas_camera:0})
})
afterEach(()=>{cleanup();vi.restoreAllMocks()})

test('foto inicial é confirmada antes das questões e a retomada recupera a resposta salva',async()=>{
  let confirmUpload:()=>void=()=>undefined
  services.send.mockImplementation(()=>new Promise<void>(resolve=>{confirmUpload=resolve}))
  const onLeave=vi.fn()
  render(<TentativaMonitoradaPanel avaliacao={assessment} onCancelar={vi.fn()} onLeave={onLeave} onActiveChange={vi.fn()}/> )
  fireEvent.click(screen.getByRole('checkbox',{name:/Li o aviso da prova/}))
  expect((screen.getByRole('button',{name:'Confirmar início'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox',{name:/Autorizo especificamente/}))
  fireEvent.click(screen.getByRole('button',{name:'Confirmar início'}))
  await waitFor(()=>expect(services.send).toHaveBeenCalledTimes(1))
  expect(services.content).not.toHaveBeenCalled()
  expect(screen.queryByText(question.enunciado)).toBeNull()
  await act(async()=>{confirmUpload()})
  await screen.findByText(question.enunciado)
  expect(services.answers).toHaveBeenCalledExactlyOnceWith(attempt.id)
  expect((screen.getByRole('radio',{name:'Resposta B'}) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText('Resposta salva')).toBeTruthy()
  expect(services.start).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button',{name:'Enviar prova'}))
  fireEvent.click(screen.getByRole('button',{name:'Enviar e encerrar'}))
  await waitFor(()=>expect(services.end).toHaveBeenCalledExactlyOnceWith(attempt.id,'ENVIO'))
  expect(services.capture).toHaveBeenCalledTimes(1)
  expect(services.save).not.toHaveBeenCalled()
})

test('falha ao consultar o plano mantém o aluno na mesma tentativa para tentar preparar as fotos novamente',async()=>{
  services.plan.mockRejectedValueOnce(new Error('Plano temporariamente indisponível'))
  render(<TentativaMonitoradaPanel avaliacao={assessment} onCancelar={vi.fn()} onLeave={vi.fn()} onActiveChange={vi.fn()}/> )
  fireEvent.click(screen.getByRole('checkbox',{name:/Li o aviso da prova/}))
  fireEvent.click(screen.getByRole('checkbox',{name:/Autorizo especificamente/}))
  fireEvent.click(screen.getByRole('button',{name:'Confirmar início'}))
  await screen.findByText('Plano temporariamente indisponível')
  fireEvent.click(screen.getByRole('button',{name:'Preparar envio das fotos'}))
  await screen.findByText(question.enunciado)
  expect(services.start).toHaveBeenCalledTimes(1)
})

test('falha na foto inicial registra ocorrência e reconectar permite repetir a captura no mesmo plano',async()=>{
  services.capture.mockRejectedValueOnce(new Error('Câmera desconectada'))
  render(<TentativaMonitoradaPanel avaliacao={assessment} onCancelar={vi.fn()} onLeave={vi.fn()} onActiveChange={vi.fn()}/> )
  fireEvent.click(screen.getByRole('checkbox',{name:/Li o aviso da prova/}))
  fireEvent.click(screen.getByRole('checkbox',{name:/Autorizo especificamente/}))
  fireEvent.click(screen.getByRole('button',{name:'Confirmar início'}))
  await screen.findByText('Ocorrência da câmera registrada.')
  expect(services.content).not.toHaveBeenCalled()
  expect(services.end).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'Reconectar câmera'}))
  await screen.findByText('Câmera pronta')
  fireEvent.click(screen.getByRole('button',{name:'Preparar envio das fotos'}))
  await screen.findByText(question.enunciado)
  expect(services.start).toHaveBeenCalledTimes(1)
  expect(services.plan).toHaveBeenCalledTimes(1)
  expect(services.capture).toHaveBeenCalledTimes(2)
  expect(services.send).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button',{name:'Minha imagem ficou preta'}))
  await waitFor(()=>expect(services.incident).toHaveBeenCalledTimes(2))
  expect(screen.getByText(question.enunciado)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'Enviar prova'}))
  fireEvent.click(screen.getByRole('button',{name:'Enviar e encerrar'}))
  await waitFor(()=>expect(services.end).toHaveBeenCalledWith(attempt.id,'ENVIO'))
})
