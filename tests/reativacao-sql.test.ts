import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'

test('professor responsável e ADM da organização liberam uma retomada sem apagar respostas ou histórico', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { professor,colega,aluno,admin,org,queryAs,criarProva } = await prepararBancoExecucao(db)
  const { avaliacaoId,questaoId } = await criarProva()
  const iniciar = async () => (await queryAs<{ t: { id: string; ciclo: number; limite_em: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS t',[avaliacaoId,'2026-11-06-v2'])).rows[0].t
  const tentativa = await iniciar()
  const alternativa = (await db.query<{ alternativa_id: string }>('SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 LIMIT 1',[tentativa.id])).rows[0].alternativa_id
  await queryAs(aluno,'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)',[tentativa.id,questaoId,alternativa])
  const ordemAntes = (await db.query('SELECT * FROM public.tentativa_alternativas WHERE tentativa_id=$1 ORDER BY ordem',[tentativa.id])).rows
  await queryAs(aluno,"SELECT public.encerrar_tentativa($1,'SAIDA')",[tentativa.id])
  await assert.rejects(iniciar(),{code:'55000'})
  for (const user of [aluno,colega]) {
    await assert.rejects(queryAs(user,"SELECT public.reativar_tentativa($1,'Problema técnico confirmado',30)",[tentativa.id]),{code:'42501'})
    await assert.rejects(queryAs(user,'SELECT public.listar_tentativas_responsavel($1)',[avaliacaoId]),{code:'42501'})
  }
  await assert.rejects(queryAs(admin,"SELECT public.reativar_tentativa($1,'Problema técnico',30)",[tentativa.id],'aal1'),{code:'42501'})
  const outraOrg = randomUUID()
  await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES($1,'Outra escola','outra-escola-030')",[outraOrg])
  await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2',[outraOrg,admin])
  await assert.rejects(queryAs(admin,"SELECT public.reativar_tentativa($1,'Problema técnico',30)",[tentativa.id]),{code:'42501'})
  await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2',[org,admin])
  await assert.rejects(queryAs(professor,"SELECT public.reativar_tentativa($1,'curta',61)",[tentativa.id]),{code:'23514'})
  await queryAs(admin,"SELECT public.reativar_tentativa($1,'Problema técnico confirmado',30)",[tentativa.id])
  await assert.rejects(queryAs(professor,"SELECT public.reativar_tentativa($1,'Repetição indevida',30)",[tentativa.id]),{code:'55000'})
  const liberacao = (await db.query<{autorizado_por:string;utilizada_em:Date|null;encerramento_anterior:Date}>('SELECT * FROM public.liberacoes_tentativa')).rows[0]
  assert.equal(liberacao.autorizado_por,admin)
  assert.equal(liberacao.utilizada_em,null)
  assert.ok(liberacao.encerramento_anterior)
  const retomada = await iniciar()
  assert.equal(retomada.id,tentativa.id)
  assert.equal(retomada.ciclo,2)
  assert.ok(Date.parse(retomada.limite_em) <= Date.now()+30*60*1000+1000)
  const respostas = (await queryAs<{r:Array<{alternativa_id:string}>}>(aluno,'SELECT public.consultar_respostas_tentativa($1) AS r',[tentativa.id])).rows[0].r
  assert.equal(respostas[0].alternativa_id,alternativa)
  assert.deepEqual((await db.query('SELECT * FROM public.tentativa_alternativas WHERE tentativa_id=$1 ORDER BY ordem',[tentativa.id])).rows,ordemAntes)
  assert.equal((await db.query('SELECT id FROM public.tentativas WHERE avaliacao_id=$1',[avaliacaoId])).rows.length,1)
  assert.ok((await db.query<{utilizada_em:Date}>('SELECT utilizada_em FROM public.liberacoes_tentativa')).rows[0].utilizada_em)
  await assert.rejects(iniciar(),{code:'55000'})
  await queryAs(aluno,"SELECT public.encerrar_tentativa($1,'CAMERA')",[tentativa.id])
  await queryAs(professor,"SELECT public.reativar_tentativa($1,'Câmera restabelecida',15)",[tentativa.id])
  assert.equal((await db.query('SELECT id FROM public.liberacoes_tentativa')).rows.length,2)
  await iniciar()
  await queryAs(aluno,"SELECT public.encerrar_tentativa($1,'ENVIO')",[tentativa.id])
  await assert.rejects(queryAs(admin,"SELECT public.reativar_tentativa($1,'Não alterar envio final',15)",[tentativa.id]),{code:'55000'})
  await assert.rejects(queryAs(aluno,'SELECT public.iniciar_tentativa($1)',[avaliacaoId]),{code:'42501'})
  await assert.rejects(queryAs(admin,'UPDATE public.tentativas SET retomada_autorizada=TRUE WHERE id=$1',[tentativa.id]),{code:'42501'})
  assert.equal((await db.query("SELECT id FROM public.eventos_seguranca WHERE evento='REATIVACAO_AUTORIZADA'")).rows.length,2)
})
