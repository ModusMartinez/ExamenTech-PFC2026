import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'

test('fotos: aviso, quatro horários, acesso restrito, reenvio idempotente e exclusão pelo serviço', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno,professor,colega,admin,org,queryAs,criarProva } = await prepararBancoExecucao(db)
  await db.exec("CREATE SCHEMA storage; CREATE TABLE storage.objects(bucket_id TEXT,name TEXT)")
  await db.exec(`ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO authenticated;
    GRANT SELECT ON storage.objects TO authenticated;
    CREATE POLICY exemplo_permissiva_antiga ON storage.objects FOR SELECT TO authenticated USING(TRUE)`)
  await db.exec(await readFile(new URL('../database/031_fotos_tentativa.sql',import.meta.url),'utf8'))
  await db.exec(await readFile(new URL('../database/033_preparar_respostas_com_versao.sql',import.meta.url),'utf8'))
  await db.exec(await readFile(new URL('../database/034_salvar_resposta_com_versao.sql',import.meta.url),'utf8'))
  const { avaliacaoId } = await criarProva()
  const iniciar = () => queryAs<{t:{id:string}}>(aluno,'SELECT public.iniciar_tentativa_com_fotos($1,$2,$3) AS t',
    [avaliacaoId,'2026-11-06-v2','2026-11-08-fotos-v1'])
  await assert.rejects(iniciar(),{code:'23514'})
  await db.exec('UPDATE examentech_private.configuracao_fotos SET ativa=TRUE')
  await assert.rejects(queryAs(aluno,'SELECT public.iniciar_tentativa($1,$2)',[avaliacaoId,'2026-11-06-v2']),{code:'23514'})
  await assert.rejects(queryAs(aluno,'SELECT examentech_private.iniciar_tentativa_sem_fotos($1,$2)',[avaliacaoId,'2026-11-06-v2']),{code:'42501'})
  const tentativa = (await iniciar()).rows[0].t
  await assert.rejects(queryAs(aluno,'SELECT public.consultar_conteudo_tentativa($1)',[tentativa.id]),{code:'55000'})
  type Plan = {ciclo:number;capturas:Array<{id:string;momento:string;agendada_em:string}>}
  const plan = (await queryAs<{p:Plan}>(aluno,'SELECT public.consultar_plano_fotos($1) AS p',[tentativa.id])).rows[0].p
  assert.equal(plan.ciclo,1)
  assert.deepEqual(plan.capturas.map(f=>f.momento),['INICIAL','PROVA_1','PROVA_2','PROVA_3'])
  assert.ok(plan.capturas.every((f,i)=>i===0 || Date.parse(f.agendada_em)>Date.parse(plan.capturas[i-1].agendada_em)))
  const fotoId=plan.capturas[0].id, uploadId=randomUUID(), hash='a'.repeat(64)
  const reserve=(id=fotoId,op=uploadId,h=hash,user=aluno)=>queryAs<{r:{caminho:string;ja_recebida:boolean}}>(user,
    'SELECT public.reservar_envio_foto($1,$2,$3,1024,640,480) AS r',[id,op,h])
  await assert.rejects(reserve(plan.capturas[1].id),{code:'55000'})
  await assert.rejects(reserve(fotoId,uploadId,hash,professor),{code:'42501'})
  await assert.rejects(queryAs(aluno,'SELECT * FROM public.fotos_tentativa'),{code:'42501'})
  const reserved=(await reserve()).rows[0].r
  assert.equal(reserved.caminho,`${tentativa.id}/1/${fotoId}.jpg`)
  assert.equal(reserved.ja_recebida,false)
  assert.deepEqual((await reserve()).rows[0].r,reserved)
  await assert.rejects(reserve(fotoId,randomUUID()),{code:'55000'})
  await assert.rejects(reserve(fotoId,uploadId,'b'.repeat(64)),{code:'55000'})
  await assert.rejects(queryAs(aluno,'SELECT public.confirmar_envio_foto($1,$2)',[fotoId,uploadId]),{code:'42501'})
  await assert.rejects(db.query('SELECT public.confirmar_envio_foto($1,$2)',[fotoId,uploadId]),{code:'55000'})
  await db.query('INSERT INTO storage.objects VALUES($1,$2)',['examentech-evidencias',reserved.caminho])
  assert.equal((await queryAs(aluno,'SELECT * FROM storage.objects')).rows.length,0)
  await db.query('SELECT public.confirmar_envio_foto($1,$2)',[fotoId,uploadId])
  await queryAs(aluno,'SELECT public.consultar_conteudo_tentativa($1)',[tentativa.id])
  await db.query('SELECT public.confirmar_envio_foto($1,$2)',[fotoId,uploadId])
  assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='FOTO_RECEBIDA'")).rows.length,1)
  const expiry=(await db.query<{expira_em:Date}>('SELECT expira_em FROM public.fotos_tentativa WHERE id=$1',[fotoId])).rows[0].expira_em
  assert.equal(expiry.getTime(),Date.parse(plan.capturas[0].agendada_em)+90*86400000)
  for (const user of [aluno,colega]) {
    await assert.rejects(queryAs(user,'SELECT public.listar_fotos_responsavel($1)',[tentativa.id]),{code:'42501'})
    await assert.rejects(queryAs(user,'SELECT public.autorizar_leitura_foto($1)',[fotoId]),{code:'42501'})
  }
  for(const user of [professor,admin]) {
    const result=(await queryAs<{f:object}>(user,'SELECT public.autorizar_leitura_foto($1) AS f',[fotoId])).rows[0].f
    assert.ok('caminho' in result)
  }
  await assert.rejects(queryAs(admin,'SELECT public.autorizar_leitura_foto($1)',[fotoId],'aal1'),{code:'42501'})
  const outraOrg=randomUUID()
  await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES($1,'Outra organização','outra-031')",[outraOrg])
  await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2',[outraOrg,admin])
  await assert.rejects(queryAs(admin,'SELECT public.autorizar_leitura_foto($1)',[fotoId]),{code:'42501'})
  await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2',[org,admin])
  await queryAs(aluno,"SELECT public.encerrar_tentativa($1,'SAIDA')",[tentativa.id])
  await assert.rejects(reserve(),{code:'55000'})
  await queryAs(professor,"SELECT public.reativar_tentativa($1,'Falha técnica verificada',10)",[tentativa.id])
  const retomada=(await iniciar()).rows[0].t
  assert.equal(retomada.id,tentativa.id)
  assert.equal((await db.query('SELECT id FROM public.fotos_tentativa')).rows.length,8)
  await assert.rejects(reserve(),{code:'55000'})
  const cycle2=(await db.query<{id:string}>("SELECT id FROM public.fotos_tentativa WHERE tentativa_id=$1 AND ciclo=2 AND momento='INICIAL'",[tentativa.id])).rows[0].id
  await db.query('UPDATE public.avisos_fotos_tentativa SET revogado_em=clock_timestamp() WHERE tentativa_id=$1 AND ciclo=2',[tentativa.id])
  await assert.rejects(reserve(cycle2),{code:'55000'})
  await assert.rejects(queryAs(aluno,'SELECT public.consultar_conteudo_tentativa($1)',[tentativa.id]),{code:'55000'})
  await db.query("UPDATE public.fotos_tentativa SET expira_em=clock_timestamp()-interval '1 second' WHERE id=$1",[fotoId])
  await assert.rejects(queryAs(professor,'SELECT public.autorizar_leitura_foto($1)',[fotoId]),{code:'42501'})
  await assert.rejects(queryAs(admin,'SELECT public.listar_fotos_para_limpeza()'),{code:'42501'})
  const batch=(await db.query<{f:Array<{id:string}>}>('SELECT public.listar_fotos_para_limpeza() AS f')).rows[0].f
  assert.deepEqual(batch.map(f=>f.id),[fotoId])
  await db.query('DELETE FROM storage.objects WHERE name=$1',[reserved.caminho])
  assert.equal((await db.query<{n:number}>('SELECT public.confirmar_limpeza_fotos($1) AS n',[[fotoId]])).rows[0].n,1)
  const deleted=(await db.query<{situacao:string;caminho:null;sha256:null}>('SELECT * FROM public.fotos_tentativa WHERE id=$1',[fotoId])).rows[0]
  assert.equal(deleted.situacao,'EXCLUIDA');assert.equal(deleted.caminho,null);assert.equal(deleted.sha256,null)
  assert.equal((await db.query('SELECT * FROM public.eventos_seguranca WHERE evento=\'FOTO_EXCLUIDA\'')).rows.length,1)

  await t.test('documentos novos exigem aceite atual e preservam registros anteriores',async()=>{
    await db.exec(`CREATE TABLE public.aceites_termos(usuario_id UUID,termos_versao TEXT,privacidade_versao TEXT,aceito_em TIMESTAMPTZ);
      CREATE FUNCTION examentech_private.registrar_aceite_termos() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER examentech_registrar_aceite_termos AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION examentech_private.registrar_aceite_termos()`)
    await db.query("INSERT INTO public.aceites_termos VALUES($1,'anterior','anterior',now())",[aluno])
    await db.exec(await readFile(new URL('../database/032_documentos_fotos.sql',import.meta.url),'utf8'))
    const newId=randomUUID()
    await assert.rejects(db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',
      [newId,'documentos@example.test',{termos_aceitos:true,termos_versao:'2026-11-06-v5',privacidade_versao:'2026-11-06-v4'}]),{code:'22023'})
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',
      [newId,'documentos@example.test',{termos_aceitos:true,termos_versao:'2026-11-08-v6',privacidade_versao:'2026-11-08-v5'}])
    const versions=(await db.query<{termos_versao:string}>('SELECT termos_versao FROM public.aceites_termos ORDER BY aceito_em')).rows
    assert.deepEqual(versions.map(v=>v.termos_versao),['anterior','2026-11-08-v6'])
  })
})
