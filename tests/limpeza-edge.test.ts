import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createEdgePhotoCleanup } from '../supabase/functions/examentech-limpar-fotos/index.ts'

const token = '1'.repeat(64)
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-private-service', EXAM_PHOTO_CLEANUP_TOKEN: token }
const id = randomUUID(), attempt = randomUUID(), path = `${attempt}/1/${id}.jpg`
function request(key = token, method = 'POST') {
  return new Request('https://example.supabase.co/functions/v1/examentech-limpar-fotos', { method, headers: { Authorization: `Bearer ${key}` } })
}

test('limpeza Edge só recebe token exclusivo e não usa a sessão de um aluno para apagar arquivos', async () => {
  let calls = 0
  const handler = createEdgePhotoCleanup(env, async () => { calls++; throw new Error('Não deveria conectar') })
  for (const value of ['aluno-jwt', 'sb_publishable_test', 'sb_secret_test', '2'.repeat(64)]) {
    assert.equal((await handler.fetch(request(value))).status, 401)
  }
  assert.equal((await handler.fetch(request(token, 'DELETE'))).status, 405)
  assert.equal(calls, 0)
})

test('limpeza Edge apaga objetos antes de confirmar metadados, sem retornar caminhos ou segredos', async () => {
  const calls: string[] = []
  let listed = false
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init), pathname = new URL(req.url).pathname
    calls.push(pathname)
    assert.equal(req.headers.get('apikey'), env.SUPABASE_SERVICE_ROLE_KEY)
    assert.equal(req.headers.get('authorization'), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`)
    if (pathname.endsWith('listar_fotos_para_limpeza')) {
      const batch = listed ? [] : [{ id, caminho: path }]
      listed = true
      return Response.json(batch)
    }
    if (pathname.startsWith('/storage/')) {
      assert.equal(req.method, 'DELETE')
      assert.deepEqual(await req.json(), { prefixes: [path] })
      return Response.json([{ name: path }])
    }
    assert.equal(pathname, '/rest/v1/rpc/confirmar_limpeza_fotos')
    assert.deepEqual(await req.json(), { p_ids: [id] })
    return Response.json(1)
  }
  const response = await createEdgePhotoCleanup(env, transport).fetch(request())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { removidas: 1 })
  assert.deepEqual(calls, ['/rest/v1/rpc/listar_fotos_para_limpeza', '/storage/v1/object/examentech-evidencias',
    '/rest/v1/rpc/confirmar_limpeza_fotos', '/rest/v1/rpc/listar_fotos_para_limpeza'])
})

test('falha de Storage ou caminho de outro recurso não marca a foto como excluída', async () => {
  for (const invalidPath of [false, true]) {
    let confirmed = false
    const transport: typeof fetch = async (input, init) => {
      const pathname = new URL(new Request(input, init).url).pathname
      if (pathname.endsWith('listar_fotos_para_limpeza')) return Response.json([{ id, caminho: invalidPath ? '../outro-bucket/foto.jpg' : path }])
      if (pathname.startsWith('/storage/')) return Response.json({ message: 'Detalhe privado do servidor' }, { status: 503 })
      confirmed = true
      return Response.json(1)
    }
    const response = await createEdgePhotoCleanup(env, transport).fetch(request())
    assert.equal(response.status, 503)
    assert.equal(confirmed, false)
    assert.ok(!(await response.text()).includes('Detalhe privado'))
  }
})

test('chave moderna injetada pelo Supabase funciona sem ser tratada como JWT', async () => {
  const modern = { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_private-test' }), EXAM_PHOTO_CLEANUP_TOKEN: token }
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    assert.equal(req.headers.get('apikey'), 'sb_secret_private-test')
    assert.equal(req.headers.get('authorization'), null)
    return Response.json([])
  }
  assert.equal((await createEdgePhotoCleanup(modern, transport).fetch(request())).status, 200)
})

test('preparação local conserva configuração, não ativa fotos e gera arquivos privados repetíveis', async t => {
  const taskDir = await mkdtemp(join(tmpdir(), 'examentech-fotos-config-'))
  t.after(async () => {
    if (dirname(taskDir) === tmpdir() && basename(taskDir).startsWith('examentech-fotos-config-')) await rm(taskDir, { recursive: true, force: true })
  })
  await mkdir(join(taskDir, 'docs'))
  const testRef = 'aaaaaaaaaaaaaaaaaaaa'
  await writeFile(join(taskDir, '.env.local'), `VITE_SUPABASE_URL=https://${testRef}.supabase.co\nSUPABASE_SECRET_KEY=preservar-configuracao\n`)
  await writeFile(join(taskDir, 'docs/agendar-limpeza-fotos.template.sql'), await readFile(new URL('../docs/agendar-limpeza-fotos.template.sql', import.meta.url)))
  const { prepararFotosLocal } = await import('../scripts/preparar-fotos-local.mjs')
  assert.deepEqual(await prepararFotosLocal(taskDir, testRef), { gerenciamento: true, fotos: false })
  const config = await readFile(join(taskDir, '.env.local'), 'utf8')
  assert.match(config, /SUPABASE_SECRET_KEY=preservar-configuracao/)
  assert.match(config, /^VITE_EXAM_PHOTOS_ENABLED=false$/m)
  const firstToken = await readFile(join(taskDir, 'docs/token-limpeza-fotos.local'), 'utf8')
  assert.match(firstToken, /^[a-f0-9]{64}\n$/)
  const sql = await readFile(join(taskDir, 'docs/agendar-limpeza-fotos.sql.local'), 'utf8')
  assert.ok(!sql.includes('__PROJECT_URL__'))
  assert.ok(!sql.includes('__CLEANUP_TOKEN__'))
  await prepararFotosLocal(taskDir, testRef)
  assert.equal(await readFile(join(taskDir, 'docs/token-limpeza-fotos.local'), 'utf8'), firstToken)
  await writeFile(join(taskDir, '.env.local'), 'VITE_SUPABASE_URL=https://outro-projeto.supabase.co\n')
  await assert.rejects(prepararFotosLocal(taskDir, testRef), /exclusiva do Supabase de testes/)
})
