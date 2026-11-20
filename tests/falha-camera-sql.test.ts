import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoExecucao } from './helpers/bancoExecucao.ts'

const migration = await readFile(new URL('../database/036_registrar_falha_camera.sql', import.meta.url), 'utf8')
type Ocorrencia = { solicitacao_id: string; tentativa_id: string; registrado_em: string }

test('036 registra falha de câmera sem interromper a tentativa nem alterar respostas', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, admin, org, turmaId, sessions, queryAs, criarProva } = await prepararBancoExecucao(db)
  for (const file of ['033_preparar_respostas_com_versao.sql', '034_salvar_resposta_com_versao.sql', '035_bloquear_resposta_sem_versao.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  async function iniciar() {
    const prova = await criarProva()
    const id = (await queryAs<{ t: { id: string } }>(aluno,
      'SELECT public.iniciar_tentativa($1,$2) AS t', [prova.avaliacaoId, '2026-11-06-v2'])).rows[0].t.id
    return { ...prova, id }
  }
  const tentativa = await iniciar()
  const alternativa = (await db.query<{ alternativa_id: string }>(
    'SELECT alternativa_id FROM public.tentativa_alternativas WHERE tentativa_id=$1 LIMIT 1', [tentativa.id])).rows[0].alternativa_id
  const salvar = (versao: number) => queryAs(aluno,
    'SELECT public.salvar_resposta_tentativa($1,$2,$3,$4,NULL)', [tentativa.id, tentativa.questaoId, versao, alternativa])
  await salvar(1)
  const sql = 'SELECT public.registrar_falha_camera($1,$2) AS ocorrencia'
  const registrar = async (solicitacao: string = randomUUID(), id = tentativa.id) =>
    (await queryAs<{ ocorrencia: Ocorrencia }>(aluno, sql, [id, solicitacao])).rows[0].ocorrencia
  async function registros() {
    return {
      tentativas: (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows,
      respostas: (await db.query('SELECT * FROM public.respostas_tentativa ORDER BY id')).rows,
      ordem: (await db.query('SELECT * FROM public.tentativa_questoes ORDER BY tentativa_id, ordem')).rows,
      eventos: (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows,
    }
  }

  await t.test('aplicar e reaplicar preserva todos os registros e restringe execução', async () => {
    const antes = await registros()
    for (let vez = 0; vez < 2; vez++) {
      await db.exec(migration)
      assert.deepEqual(await registros(), antes)
    }
    for (const schema of ['public', 'examentech_private']) {
      const assinatura = `${schema}.registrar_falha_camera(uuid,uuid)`
      assert.deepEqual((await db.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,
        has_function_privilege('authenticated',$1,'EXECUTE') AS autenticado`, [assinatura])).rows,
      [{ anon: false, autenticado: true }])
    }
  })

  await t.test('registra identidade e horário do banco e mantém tentativa, respostas e ordem', async () => {
    const antes = await registros()
    const solicitacao = randomUUID()
    const ocorrencia = await registrar(solicitacao)
    assert.deepEqual(Object.keys(ocorrencia).sort(), ['registrado_em', 'solicitacao_id', 'tentativa_id'])
    assert.equal(ocorrencia.solicitacao_id, solicitacao)
    assert.equal(ocorrencia.tentativa_id, tentativa.id)
    assert.ok(Number.isFinite(Date.parse(ocorrencia.registrado_em)))
    const depois = await registros()
    assert.deepEqual(depois.tentativas, antes.tentativas)
    assert.deepEqual(depois.respostas, antes.respostas)
    assert.deepEqual(depois.ordem, antes.ordem)
    assert.equal(depois.eventos.length, antes.eventos.length + 1)
    assert.deepEqual((await db.query(`SELECT evento,provedor,acao,sucesso,usuario_id,recurso_id
      FROM public.eventos_seguranca WHERE solicitacao_id=$1`, [solicitacao])).rows,
    [{ evento: 'CAMERA_FALHA', provedor: 'EXAMENTECH', acao: 'falha_camera', sucesso: false, usuario_id: aluno, recurso_id: tentativa.id }])
    assert.deepEqual(await registrar(solicitacao), ocorrencia)
    assert.deepEqual(await registros(), depois)
    await registrar()
    assert.equal((await registros()).eventos.length, depois.eventos.length + 1)
  })

  await t.test('recusa identificador reutilizado em outra tentativa ou outro evento', async () => {
    const outra = await iniciar()
    const solicitacao = randomUUID()
    await registrar(solicitacao)
    const eventoAnterior = (await db.query<{ solicitacao_id: string }>(
      "SELECT solicitacao_id FROM public.eventos_seguranca WHERE evento='RESPOSTA_SALVA' LIMIT 1")).rows[0].solicitacao_id
    const antes = await registros()
    await assert.rejects(registrar(solicitacao, outra.id), { code: '23514' })
    await assert.rejects(registrar(eventoAnterior), { code: '23514' })
    await assert.rejects(queryAs(aluno, sql, [tentativa.id, null]), { code: '23514' })
    for (const id of [null, randomUUID()]) await assert.rejects(queryAs(aluno, sql, [id, randomUUID()]), { code: 'P0002' })
    assert.deepEqual(await registros(), antes)
  })

  await t.test('exige aluno dono, sessão válida e MFA inclusive na função privada', async () => {
    const outroAluno = randomUUID()
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [outroAluno, 'outro@example.test'])
    await db.query("UPDATE public.perfis SET organizacao_id=$1,situacao='ATIVO' WHERE id=$2", [org, outroAluno])
    sessions.set(outroAluno, randomUUID())
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [sessions.get(outroAluno), outroAluno])
    const antes = await registros()
    for (const schema of ['public', 'examentech_private']) {
      const chamada = `SELECT ${schema}.registrar_falha_camera($1,$2)`
      for (const usuario of [professor, admin, randomUUID()]) {
        await assert.rejects(queryAs(usuario, chamada, [tentativa.id, randomUUID()]), { code: '42501' })
      }
      await assert.rejects(queryAs(aluno, chamada, [tentativa.id, randomUUID()], 'aal1'), { code: '42501' })
      await assert.rejects(db.transaction(async tx => {
        await tx.exec('SET LOCAL ROLE anon')
        await tx.query(chamada, [tentativa.id, randomUUID()])
      }), { code: '42501' })
    }
    const sessao = sessions.get(aluno)!
    for (const invalida of [undefined, randomUUID(), sessions.get(professor)!]) {
      if (invalida) sessions.set(aluno, invalida)
      else sessions.delete(aluno)
      await assert.rejects(registrar(), { code: '42501' })
    }
    sessions.set(aluno, sessao)
    await assert.rejects(queryAs(outroAluno, sql, [tentativa.id, randomUUID()]), { code: 'P0002' })
    assert.deepEqual(await registros(), antes)
  })

  await t.test('recusa organização, perfil, turma ou matrícula inativos e organização diferente', async () => {
    const antes = await registros()
    for (const [tabela, id] of [['perfis', aluno], ['organizacoes', org]]) {
      await db.query(`UPDATE public.${tabela} SET situacao='INATIVO' WHERE id=$1`, [id])
      await assert.rejects(registrar(), { code: '42501' })
      await db.query(`UPDATE public.${tabela} SET situacao='ATIVO' WHERE id=$1`, [id])
    }
    await db.query("UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", [turmaId])
    await assert.rejects(registrar(), { code: 'P0002' })
    await db.query("UPDATE public.turmas SET situacao='ATIVA' WHERE id=$1", [turmaId])
    await db.query("UPDATE public.turma_alunos SET situacao='INATIVA' WHERE aluno_id=$1", [aluno])
    await assert.rejects(registrar(), { code: 'P0002' })
    await db.query("UPDATE public.turma_alunos SET situacao='ATIVA' WHERE aluno_id=$1", [aluno])
    const outraOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Outra escola','outra-escola-teste')", [outraOrg])
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [outraOrg, aluno])
    await assert.rejects(registrar(), { code: 'P0002' })
    await db.query('UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', [org, aluno])
    assert.deepEqual(await registros(), antes)
  })

  await t.test('falha da auditoria não confirma a ocorrência nem modifica a prova', async () => {
    const antes = await registros()
    const solicitacao = randomUUID()
    await db.exec(`CREATE FUNCTION public.falhar_camera() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.evento='CAMERA_FALHA' THEN RAISE EXCEPTION 'Falha simulada'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER falhar_camera BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_camera();`)
    await assert.rejects(registrar(solicitacao), /Falha simulada/)
    assert.deepEqual(await registros(), antes)
    await db.exec('DROP TRIGGER falhar_camera ON public.eventos_seguranca; DROP FUNCTION public.falhar_camera()')
    assert.equal((await registrar(solicitacao)).solicitacao_id, solicitacao)
    await assert.rejects(queryAs(aluno, `INSERT INTO public.eventos_seguranca(solicitacao_id,evento,sucesso)
      VALUES ($1,'CAMERA_FALHA',false)`, [randomUUID()]), { code: '42501' })
  })

  await t.test('salvamento e envio continuam; ocorrências após encerramento ou prazo são recusadas', async () => {
    const confirmada = await registrar()
    await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,2,NULL,NULL)', [tentativa.id, tentativa.questaoId])
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'ENVIO')", [tentativa.id])
    await assert.rejects(registrar(), { code: '55000' })
    await assert.rejects(registrar(confirmada.solicitacao_id), { code: '55000' })
    const outra = await iniciar()
    await queryAs(aluno, "SELECT public.encerrar_tentativa($1,'SAIDA')", [outra.id])
    await assert.rejects(registrar(randomUUID(), outra.id), { code: '55000' })
    const vencida = await iniciar()
    await db.query("UPDATE public.tentativas SET iniciada_em=now()-interval '2 hours',limite_em=now()-interval '1 second' WHERE id=$1", [vencida.id])
    const antes = await registros()
    await assert.rejects(registrar(randomUUID(), vencida.id), { code: '55000' })
    await db.exec(migration)
    assert.deepEqual(await registros(), antes)
  })
})
