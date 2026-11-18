import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'

test('paginação das tentativas preserva ordenação, autorização, auditoria e consulta anterior', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, colega, aluno, admin, sessions, queryAs, criarProva } = await prepararBancoExecucao(db)
  const { avaliacaoId } = await criarProva()
  const migration = await readFile(new URL('../database/058_paginacao_tentativas_responsavel.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(`INSERT INTO auth.users(id,email)
    SELECT gen_random_uuid(), 'paginacao-'||numero||'@example.test' FROM generate_series(1,103) numero`)
  await db.query(`UPDATE public.perfis SET organizacao_id=$1,situacao='ATIVO'
    WHERE email LIKE 'paginacao-%@example.test'`, [org])
  await db.query(`INSERT INTO public.tentativas(avaliacao_id,aluno_id,iniciada_em,limite_em)
    SELECT $1,id,now()-interval '1 minute',now()+interval '1 hour'
    FROM public.perfis WHERE email LIKE 'paginacao-%@example.test'`, [avaliacaoId])
  const esperado = (await db.query<{ id: string }>(
    'SELECT id FROM public.tentativas WHERE avaliacao_id=$1 ORDER BY iniciada_em DESC,id', [avaliacaoId])).rows.map(row => row.id)
  const listar = async (pagina: number | null, usuario = professor, aal = 'aal2') =>
    (await queryAs<{ tentativas: { id: string; avaliacao_id: string }[] }>(usuario,
      'SELECT public.listar_tentativas_responsavel($1,$2) AS tentativas', [avaliacaoId, pagina], aal)).rows[0].tentativas

  await t.test('alcança todas as 103 tentativas em três páginas mesmo com horários empatados', async () => {
    const paginas = await Promise.all([listar(0), listar(1), listar(2)])
    assert.deepEqual(paginas.map(pagina => pagina.length), [51, 51, 3])
    assert.deepEqual(paginas.flatMap(pagina => pagina.slice(0, 50).map(row => row.id)), esperado)
    assert.ok(paginas.flat().every(row => row.avaliacao_id === avaliacaoId))
    assert.deepEqual(await listar(3), [])
    assert.deepEqual(await listar(2147483647), [])
    const antigo = (await queryAs<{ tentativas: { id: string }[] }>(professor,
      'SELECT public.listar_tentativas_responsavel($1) AS tentativas', [avaliacaoId])).rows[0].tentativas
    assert.deepEqual(antigo.map(row => row.id), esperado.slice(0, 50))
    const auditoria = await db.query<{ total: number }>(`SELECT count(*)::INT AS total
      FROM public.eventos_seguranca WHERE evento='TENTATIVAS_CONSULTADAS' AND recurso_id=$1`, [avaliacaoId])
    assert.equal(auditoria.rows[0].total, 6)
  })

  await t.test('páginas inválidas e acessos sem autorização são recusados', async () => {
    for (const pagina of [-1, null]) await assert.rejects(listar(pagina), { code: '22023' })
    for (const usuario of [aluno, colega]) {
      await assert.rejects(listar(1, usuario), { code: '42501' })
      await assert.rejects(queryAs(usuario, 'SELECT public.listar_tentativas_responsavel($1)', [avaliacaoId]), { code: '42501' })
    }
    await assert.rejects(listar(1, professor, 'aal1'), { code: '42501' })
    await assert.rejects(queryAs(professor, 'SELECT public.listar_tentativas_responsavel($1,$2)', [randomUUID(), 0]), { code: '42501' })
    assert.equal((await listar(1, admin)).length, 51)
    const sessao = sessions.get(professor)!
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [sessao])
    await assert.rejects(listar(1), { code: '42501' })
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [sessao, professor])
    const outraOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES($1,'Outra organização','paginacao-outra-org')", [outraOrg])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [outraOrg, admin])
    await assert.rejects(listar(1, admin), { code: '42501' })
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, admin])
  })

  await t.test('reaplicação mantém os dados e o usuário anônimo não executa a consulta', async () => {
    await db.exec(migration)
    assert.deepEqual((await listar(2)).map(row => row.id), esperado.slice(100))
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE anon')
      return tx.query('SELECT public.listar_tentativas_responsavel($1,0)', [avaliacaoId])
    }), { code: '42501' })
  })
})
