import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'

test('RF27 pagina todos os resultados publicados do aluno e preserva o isolamento e a consulta anterior', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, colega, admin, org, turmaId, sessions, queryAs } = await prepararBancoCamera(db)
  for (const nome of ['037_camera_sem_interrupcao', '038_tentativa_sessao', '039_correcao_tentativa', '040_finalizacao_e_resultados']) {
    await db.exec(await readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8'))
  }
  const migracao = await readFile(new URL('../database/060_paginacao_resultados_aluno.sql', import.meta.url), 'utf8')
  await db.exec(migracao)
  await db.query(`INSERT INTO public.avaliacoes(turma_id,professor_id,titulo,tipo,inicio_em,fim_em,duracao_minutos,situacao,publicada_em)
    SELECT $1,$2,'Resultado paginado '||numero,'ATIVIDADE',now()-interval '2 hours',now()-interval '1 hour',30,'PUBLICADA',now()-interval '3 hours'
    FROM generate_series(1,104) numero`, [turmaId, professor])
  await db.exec(`INSERT INTO public.questoes(avaliacao_id,tipo,enunciado,pontuacao,ordem)
    SELECT id,'DISSERTATIVA','Questão do resultado paginado',1,1
    FROM public.avaliacoes WHERE titulo LIKE 'Resultado paginado %'`)
  await db.query(`INSERT INTO public.tentativas(avaliacao_id,aluno_id,situacao,iniciada_em,limite_em,encerrada_em)
    SELECT id,$1,'FINALIZADA',now()-interval '2 hours',now()-interval '90 minutes',now()-interval '90 minutes'
    FROM public.avaliacoes WHERE titulo LIKE 'Resultado paginado %'`, [aluno])
  await db.query(`INSERT INTO examentech_private.resultados_publicados(avaliacao_id,publicado_por,publicado_em)
    SELECT id,$1,'2026-11-18T12:00:00Z' FROM public.avaliacoes
    WHERE titulo LIKE 'Resultado paginado %' AND titulo <> 'Resultado paginado 104'`, [professor])
  const esperado = (await db.query<{ tentativa_id: string }>(`SELECT te.id AS tentativa_id
    FROM public.tentativas te JOIN examentech_private.resultados_publicados rp ON rp.avaliacao_id=te.avaliacao_id
    WHERE te.aluno_id=$1 ORDER BY rp.publicado_em DESC,te.id`, [aluno])).rows
  type Resultado = { tentativa_id: string; titulo: string }
  const listar = async (pagina: number | null, usuario = aluno, aal = 'aal2') =>
    (await queryAs<{ resultados: Resultado[] }>(usuario,
      'SELECT public.listar_meus_resultados($1) AS resultados', [pagina], aal)).rows[0].resultados

  await t.test('alcança 103 resultados sem repetir ou omitir registros com a mesma data', async () => {
    const paginas = await Promise.all([listar(0), listar(1), listar(2)])
    assert.deepEqual(paginas.map(pagina => pagina.length), [51, 51, 3])
    assert.deepEqual(paginas.flatMap(pagina => pagina.slice(0, 50).map(item => ({ tentativa_id: item.tentativa_id }))), esperado)
    assert.ok(paginas.flat().every(item => item.titulo !== 'Resultado paginado 104'))
    assert.deepEqual(await listar(3), [])
    assert.deepEqual(await listar(2147483647), [])
    const antiga = (await queryAs<{ resultados: Resultado[] }>(aluno,
      'SELECT public.listar_meus_resultados() AS resultados')).rows[0].resultados
    assert.deepEqual(antiga.map(item => ({ tentativa_id: item.tentativa_id })), esperado.slice(0, 50))
  })

  await t.test('não expõe resultados a outros usuários, sem MFA, sem sessão ou fora da organização', async () => {
    for (const usuario of [professor, colega, admin]) assert.deepEqual(await listar(1, usuario), [])
    const outroAluno = randomUUID()
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)', [outroAluno,
      'outro-aluno-paginacao@example.test', JSON.stringify({ termos_aceitos: true,
        termos_versao: '2026-11-08-v9', privacidade_versao: '2026-11-08-v6' })])
    await db.query("UPDATE public.perfis SET organizacao_id=$1,situacao='ATIVO' WHERE id=$2", [org, outroAluno])
    const sessaoOutro = randomUUID()
    sessions.set(outroAluno, sessaoOutro)
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [sessaoOutro, outroAluno])
    assert.deepEqual(await listar(1, outroAluno), [])
    assert.deepEqual(await listar(1, aluno, 'aal1'), [])
    const sessao = sessions.get(aluno)!
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [sessao])
    assert.deepEqual(await listar(1), [])
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [sessao, aluno])
    await db.query("UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", [aluno])
    assert.deepEqual(await listar(1), [])
    await db.query("UPDATE public.perfis SET situacao='ATIVO' WHERE id=$1", [aluno])
    const outraOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES($1,'Outra escola','paginacao-resultados-outra')", [outraOrg])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [outraOrg, aluno])
    assert.deepEqual(await listar(1), [])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, aluno])
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE turma_id=$1 AND aluno_id=$2", [turmaId, aluno])
    assert.equal((await listar(1)).length, 51)
  })

  await t.test('valida a página, bloqueia anônimos e permite reaplicar a migração', async () => {
    for (const pagina of [-1, null]) await assert.rejects(listar(pagina), { code: '22023' })
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE anon')
      return tx.query('SELECT public.listar_meus_resultados(0)')
    }), { code: '42501' })
    await db.exec(migracao)
    assert.deepEqual((await listar(2)).map(item => ({ tentativa_id: item.tentativa_id })), esperado.slice(100))
  })
})
