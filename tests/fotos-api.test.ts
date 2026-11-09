import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createFotosTentativaHandler } from '../api/fotos-tentativa.ts'
import { createLimpezaFotosHandler } from '../api/limpar-fotos-expiradas.ts'
import { createIniciarTentativaHandler } from '../api/iniciar-tentativa.ts'
import { jpegDimensions, readPhotoBody } from '../scripts/lib/photoStorage.ts'

const capture = randomUUID(), attempt = randomUUID(), upload = randomUUID(), student = randomUUID(), assessment = randomUUID()
const path = `${attempt}/1/${capture}.jpg`
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test-public',
  SUPABASE_SECRET_KEY: 'test-private', EXAM_PHOTOS_ENABLED: 'true', CRON_SECRET: 'test-exclusive-cron-secret' }
const jpeg = new Uint8Array([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,0xc0,0,11,8,1,0xe0,2,0x80,1,1,0x11,0,
  0xff,0xda,0,8,1,1,0,0,0x3f,0,1,0xff,0xd9])
const dates = { recebida_em: new Date().toISOString(), expira_em: new Date(Date.now()+90*86400000).toISOString() }

function uploadRequest(bytes: Uint8Array=jpeg) {
  return new Request(`http://localhost/api/fotos-tentativa?captura_id=${capture}&upload_id=${upload}`, {
    method:'POST',headers:{Authorization:'Bearer student-session','Content-Type':'image/jpeg'},body:new Uint8Array(bytes).buffer,
  })
}

function photoTransport(options: {denied?:boolean;duplicate?:boolean;different?:boolean;publicBucket?:boolean}={}) {
  const calls: string[]=[]
  const transport: typeof fetch = async (input,init) => {
    const request=new Request(input,init), url=new URL(request.url)
    calls.push(url.pathname)
    if(url.pathname==='/auth/v1/user') {
      assert.equal(request.headers.get('apikey'),env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(request.headers.get('authorization'),'Bearer student-session')
      return Response.json({id:student})
    }
    if(url.pathname.endsWith('/rpc/reservar_envio_foto') || url.pathname.endsWith('/rpc/autorizar_leitura_foto')) {
      assert.equal(request.headers.get('apikey'),env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(request.headers.get('authorization'),'Bearer student-session')
      if(options.denied)return Response.json({code:'42501',message:'Detalhes privados'},{status:403})
      if(url.pathname.endsWith('reservar_envio_foto')) {
        const params=await request.json()
        assert.equal(params.p_sha256,createHash('sha256').update(jpeg).digest('hex'))
        assert.equal(params.p_tamanho,jpeg.length); assert.equal(params.p_largura,640); assert.equal(params.p_altura,480)
        return Response.json({id:capture,caminho:path,ja_recebida:false})
      }
      return Response.json({id:capture,caminho:path,expira_em:dates.expira_em})
    }
    assert.equal(request.headers.get('apikey'),env.SUPABASE_SECRET_KEY)
    if(url.pathname==='/storage/v1/bucket/examentech-evidencias')return Response.json({id:'examentech-evidencias',
      public:Boolean(options.publicBucket),file_size_limit:1048576,allowed_mime_types:['image/jpeg']})
    if(url.pathname.endsWith('/rpc/confirmar_envio_foto'))return Response.json({id:capture,...dates})
    if(url.pathname.startsWith('/storage/v1/object/')) {
      if(request.method==='GET')return new Response(options.different?new Uint8Array([1,2,3]):jpeg,{headers:{'Content-Type':'image/jpeg'}})
      assert.equal(request.headers.get('x-upsert'),'false')
      if(options.duplicate)return Response.json({statusCode:'400',error:'Duplicate',message:'The resource already exists'},{status:400})
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()),jpeg)
      return Response.json({Key:`examentech-evidencias/${path}`})
    }
    throw new Error(`Unexpected transport path ${url.pathname}`)
  }
  return {calls,transport}
}

test('upload autoriza com sessão do aluno, usa Storage privado e retorna somente confirmação',async()=>{
  const {transport,calls}=photoTransport()
  const response=await createFotosTentativaHandler(env,transport).fetch(uploadRequest())
  assert.equal(response.status,200)
  assert.deepEqual(await response.json(),{id:capture,...dates})
  assert.equal(response.headers.get('cache-control'),'private, no-store')
  assert.equal(calls.length,5)
})

test('acesso negado e bucket público impedem o envio, sem usar privilégio para contornar autorização',async()=>{
  for(const option of [{denied:true},{publicBucket:true}]) {
    const {transport,calls}=photoTransport(option)
    const response=await createFotosTentativaHandler(env,transport).fetch(uploadRequest())
    assert.equal(response.status,option.denied?403:503)
    assert.ok(!calls.some(path=>path.startsWith('/storage/v1/object/')))
    assert.ok(!(await response.text()).includes('Detalhes privados'))
  }
})

test('reenvio aceita arquivo existente apenas quando o hash coincide; não sobrescreve',async()=>{
  for(const different of [false,true]) {
    const {transport}=photoTransport({duplicate:true,different})
    const response=await createFotosTentativaHandler(env,transport).fetch(uploadRequest())
    assert.equal(response.status,different?409:200)
  }
})

test('consulta entrega JPEG sem cache e só após autorização do professor/ADM',async()=>{
  const {transport}=photoTransport()
  const response=await createFotosTentativaHandler(env,transport).fetch(new Request(
    `http://localhost/api/fotos-tentativa?captura_id=${capture}`,{headers:{Authorization:'Bearer student-session'}}))
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg')
  assert.equal(response.headers.get('cache-control'),'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'),'nosniff')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),jpeg)
  const denied=await createFotosTentativaHandler(env,photoTransport({denied:true}).transport).fetch(new Request(
    `http://localhost/api/fotos-tentativa?captura_id=${capture}`,{headers:{Authorization:'Bearer student-session'}}))
  assert.equal(denied.status,403)
})

test('limite, conteúdo inválido, EXIF e flag desligada são recusados',async()=>{
  assert.deepEqual(jpegDimensions(jpeg),{width:640,height:480})
  const exif=jpeg.slice();exif[3]=0xe1
  assert.throws(()=>jpegDimensions(exif))
  const tooWide=jpeg.slice();tooWide[15]=0x10
  assert.throws(()=>jpegDimensions(tooWide))
  await assert.rejects(readPhotoBody(uploadRequest(new Uint8Array(1048577))),/TOO_LARGE/)
  const {transport}=photoTransport()
  assert.equal((await createFotosTentativaHandler(env,transport).fetch(uploadRequest(exif))).status,400)
  assert.equal((await createFotosTentativaHandler({...env,EXAM_PHOTOS_ENABLED:'false'},transport).fetch(uploadRequest())).status,503)
  assert.equal((await createFotosTentativaHandler(env,transport).fetch(new Request('http://localhost/api/fotos-tentativa'))).status,401)
})

test('início com fotos exige aviso específico e usa a RPC que registra as capturas',async()=>{
  const transport:typeof fetch=async(input,init)=>{
    const req=new Request(input,init),url=new URL(req.url)
    if(url.pathname==='/auth/v1/user')return Response.json({id:student})
    assert.equal(url.pathname,'/rest/v1/rpc/iniciar_tentativa_com_fotos')
    assert.deepEqual(await req.json(),{p_avaliacao_id:assessment,p_aviso_versao:'2026-11-08-v3',p_fotos_aviso_versao:'2026-11-08-fotos-v1'})
    return Response.json({id:attempt,avaliacao_id:assessment,aluno_id:student,situacao:'EM_ANDAMENTO',
      iniciada_em:'2026-11-08T19:00:00Z',limite_em:'2026-11-08T20:00:00Z'})
  }
  const request=(photoNotice?:string)=>new Request('http://localhost/api/iniciar-tentativa', {method:'POST',
    headers:{Authorization:'Bearer student-session','Content-Type':'application/json'},
    body:JSON.stringify({avaliacao_id:assessment,aviso_versao:'2026-11-08-v3',...(photoNotice?{fotos_aviso_versao:photoNotice}:{})})})
  assert.equal((await createIniciarTentativaHandler(env,transport).fetch(request())).status,400)
  assert.equal((await createIniciarTentativaHandler(env,transport).fetch(request('2026-11-08-fotos-v1'))).status,201)
})

test('limpeza só confirma exclusão depois de remover os arquivos; falha mantém metadados para repetição',async()=>{
  for(const fail of [false,true]) {
    let confirmed=false, batches=0
    const transport:typeof fetch=async(input,init)=>{
      const req=new Request(input,init),url=new URL(req.url)
      assert.equal(req.headers.get('apikey'),env.SUPABASE_SECRET_KEY)
      if(url.pathname.endsWith('/rpc/listar_fotos_para_limpeza'))return Response.json(batches++===0?[{id:capture,caminho:path}]:[])
      if(url.pathname==='/storage/v1/object/examentech-evidencias') {
        assert.equal(req.method,'DELETE')
        assert.deepEqual(await req.json(),{prefixes:[path]})
        return fail?Response.json({message:'Storage failed'},{status:400}):Response.json([{name:path}])
      }
      assert.equal(url.pathname,'/rest/v1/rpc/confirmar_limpeza_fotos')
      confirmed=true;return Response.json(1)
    }
    const handler=createLimpezaFotosHandler(env,transport)
    assert.equal((await handler.fetch(new Request('http://localhost/api/limpar-fotos-expiradas'))).status,401)
    const response=await handler.fetch(new Request('http://localhost/api/limpar-fotos-expiradas',{headers:{Authorization:`Bearer ${env.CRON_SECRET}`}}))
    assert.equal(response.status,fail?503:200);assert.equal(confirmed,!fail)
  }
})
