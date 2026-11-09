import { PHOTO_BUCKET, PHOTO_MAX_BYTES, storageClients } from './lib/photoStorage.ts'

// Executado manualmente pelo responsável, após conferir o projeto do .env.local.
// Importar o arquivo ou executar sem o argumento não acessa o Supabase.
if (process.argv.includes('--criar-bucket-privado')) {
  const { admin } = storageClients(process.env, '', fetch)
  const { data: bucket, error } = await admin.storage.getBucket(PHOTO_BUCKET)
  if (bucket) {
    if (bucket.public || Number(bucket.file_size_limit) !== PHOTO_MAX_BYTES ||
        bucket.allowed_mime_types?.length !== 1 || bucket.allowed_mime_types[0] !== 'image/jpeg') {
      throw new Error('O bucket já existe com configuração diferente. Revise no painel; nenhuma configuração foi alterada.')
    }
    console.log('O bucket privado já está configurado.')
  } else {
    if (error && !('statusCode' in error && ['400', '404'].includes(String(error.statusCode)))) {
      throw new Error('Não foi possível conferir o bucket. Revise a configuração do servidor.')
    }
    const { error: creationError } = await admin.storage.createBucket(PHOTO_BUCKET, {
      public: false, fileSizeLimit: PHOTO_MAX_BYTES, allowedMimeTypes: ['image/jpeg'],
    })
    if (creationError) throw new Error('Não foi possível criar o bucket privado. Confira o projeto e a configuração no painel.')
    console.log('Bucket privado criado. O envio de fotografias continua dependendo da ativação manual.')
  }
} else {
  console.log('Para configurar o bucket no projeto conferido, use --criar-bucket-privado. Nenhuma conexão foi feita.')
}
