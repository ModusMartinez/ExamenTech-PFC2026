import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
export async function prepararFotosLocal(projectRoot, expectedProjectRef) {
  if (typeof expectedProjectRef !== 'string' || !/^[a-z0-9]{20}$/.test(expectedProjectRef)) {
    throw new Error('Informe explicitamente a referência do projeto de testes com --projeto-teste. Nenhum arquivo foi alterado.')
  }
  const envFile = join(projectRoot, '.env.local')
  let contents = await readFile(envFile, 'utf8')
  function value(name) {
    const raw = contents.match(new RegExp(`^${name}[ \\t]*=(.*)$`, 'm'))?.[1].trim() ?? ''
    return raw.replace(/^(['"])(.*)\1$/, '$2')
  }
  const projectUrl = value('VITE_SUPABASE_URL').replace(/\/$/, '')
  if (projectUrl !== `https://${expectedProjectRef}.supabase.co`) {
    throw new Error('A preparação é exclusiva do Supabase de testes conferido. Nenhum arquivo foi alterado.')
  }
  const existing = value('EXAM_PHOTO_CLEANUP_TOKEN')
  if (existing && !/^[a-f0-9]{64}$/.test(existing)) throw new Error('O token local já existe em outro formato. Confira antes de substituir.')
  const token = existing || randomBytes(32).toString('hex')
  function set(name, newValue) {
    const pattern = new RegExp(`^${name}[ \\t]*=.*$`, 'm')
    if (pattern.test(contents)) contents = contents.replace(pattern, `${name}=${newValue}`)
    else contents = `${contents.trimEnd()}\n${name}=${newValue}\n`
  }
  set('VITE_EXAM_MANAGEMENT_ENABLED', 'true')
  set('VITE_EXAM_PHOTOS_ENABLED', 'false')
  set('EXAM_PHOTOS_ENABLED', 'false')
  set('EXAM_PHOTO_CLEANUP_TOKEN', token)
  const template = await readFile(join(projectRoot, 'docs/agendar-limpeza-fotos.template.sql'), 'utf8')
  const sql = template.replaceAll('__PROJECT_URL__', projectUrl).replaceAll('__CLEANUP_TOKEN__', token)
  await writeFile(envFile, contents, { mode: 0o600 })
  await writeFile(join(projectRoot, 'docs/token-limpeza-fotos.local'), `${token}\n`, { mode: 0o600 })
  await writeFile(join(projectRoot, 'docs/agendar-limpeza-fotos.sql.local'), sql, { mode: 0o600 })
  return { gerenciamento: true, fotos: false }
}

if (process.argv.includes('--preparar')) {
  const flag = process.argv.indexOf('--projeto-teste')
  await prepararFotosLocal(root, flag >= 0 ? process.argv[flag + 1] : undefined)
  console.log('Gerenciamento habilitado localmente; fotografias continuam desligadas. Token e SQL privados preparados em docs/*.local. Nenhuma conexão foi feita ao Supabase.')
}
