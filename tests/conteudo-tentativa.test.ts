import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'

type ConteudoTentativa = {
  tentativa_id: string; avaliacao_id: string; titulo: string; tipo: string; iniciada_em: string; limite_em: string
  questoes: {
    id: string; tipo: string; enunciado: string; pontuacao: number; ordem: number
    alternativas: { id: string; texto: string; ordem: number }[]
  }[]
}

test('conteúdo da tentativa: ordem salva, campos permitidos e acesso durante a realização', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, colega, aluno, admin, sessions, queryAs, turmaId } = await prepararBancoAvaliacoes(db)
  async function aplicar(file: string) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  for (const file of ['023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql', '025_iniciar_tentativa.sql']) await aplicar(file)
  async function criarTentativa(tipo = 'PROVA') {
    const avaliacao = (await queryAs<{ avaliacao: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Avaliação de conteúdo',$2,now()-interval '5 minutes',now()+interval '2 hours',60
    ) AS avaliacao`, [turmaId, tipo])).rows[0].avaliacao
    for (const [i, tipoQuestao] of ['OBJETIVA', 'DISSERTATIVA', 'OBJETIVA'].entries()) {
      const questao = (await queryAs<{ questao: { id: string } }>(professor,
        'SELECT public.criar_questao_rascunho($1,$2,$3,1.5) AS questao', [avaliacao.id, tipoQuestao, `Enunciado fictício ${i + 1}\nSegunda linha.`])).rows[0].questao
      if (tipoQuestao === 'OBJETIVA') {
        const textos = Array.from({ length: i === 0 ? 2 : 5 }, (_, n) => `Opção ${n + 1}`)
        await queryAs(professor, 'SELECT public.criar_alternativas_rascunho($1,$2,2)', [questao.id, textos])
      }
    }
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [avaliacao.id])
    return (await queryAs<{ tentativa: { id: string; avaliacao_id: string; iniciada_em: string; limite_em: string } }>(aluno,
      'SELECT public.iniciar_tentativa($1) AS tentativa', [avaliacao.id])).rows[0].tentativa
  }
  async function registros() {
    return {
      tentativas: (await db.query('SELECT * FROM public.tentativas ORDER BY id')).rows,
      questoes: (await db.query('SELECT * FROM public.tentativa_questoes ORDER BY tentativa_id,ordem')).rows,
      alternativas: (await db.query('SELECT * FROM public.tentativa_alternativas ORDER BY tentativa_id,questao_id,ordem')).rows,
      eventos: (await db.query('SELECT * FROM public.eventos_seguranca ORDER BY id')).rows,
    }
  }
  const antiga = await criarTentativa()
  await aplicar('026_ordem_tentativa.sql')
  const tentativa = await criarTentativa()
  const anteriores = await registros()
  await aplicar('027_consultar_conteudo_tentativa.sql')
  const consultarSql = 'SELECT public.consultar_conteudo_tentativa($1) AS conteudo'
  async function consultar(id: string | null = tentativa.id, usuario = aluno, aal = 'aal2') {
    return (await queryAs<{ conteudo: ConteudoTentativa }>(usuario, consultarSql, [id], aal)).rows[0].conteudo
  }

  await t.test('migração e consulta preservam tentativas, prazos, ordens e auditoria', async () => {
    assert.deepEqual(await registros(), anteriores)
    const primeira = await consultar()
    assert.deepEqual(await consultar(), primeira)
    await aplicar('027_consultar_conteudo_tentativa.sql')
    assert.deepEqual(await consultar(), primeira)
    assert.deepEqual(await registros(), anteriores)
  })

  await t.test('retorna enunciados e alternativas na ordem salva, sem gabarito ou campos extras', async () => {
    const conteudo = await consultar()
    assert.deepEqual(Object.keys(conteudo).sort(), ['avaliacao_id', 'iniciada_em', 'limite_em', 'questoes', 'tentativa_id', 'tipo', 'titulo'])
    assert.equal(conteudo.tentativa_id, tentativa.id)
    assert.equal(conteudo.avaliacao_id, tentativa.avaliacao_id)
    assert.equal(conteudo.titulo, 'Avaliação de conteúdo')
    assert.equal(conteudo.tipo, 'PROVA')
    assert.equal(conteudo.iniciada_em, tentativa.iniciada_em)
    assert.equal(conteudo.limite_em, tentativa.limite_em)
    const salvas = (await db.query<{ questao_id: string; ordem: number }>(
      'SELECT questao_id,ordem FROM public.tentativa_questoes WHERE tentativa_id=$1 ORDER BY ordem', [tentativa.id])).rows
    assert.equal(salvas.length, 3)
    assert.deepEqual(conteudo.questoes.map(q => ({ questao_id: q.id, ordem: q.ordem })), salvas)
    for (const questao of conteudo.questoes) {
      assert.deepEqual(Object.keys(questao).sort(), ['alternativas', 'enunciado', 'id', 'ordem', 'pontuacao', 'tipo'])
      assert.equal(questao.pontuacao, 1.5)
      const original = (await db.query<{ enunciado: string; tipo: string }>('SELECT enunciado,tipo FROM public.questoes WHERE id=$1', [questao.id])).rows[0]
      assert.equal(questao.enunciado, original.enunciado)
      assert.equal(questao.tipo, original.tipo)
      if (questao.tipo === 'DISSERTATIVA') {
        assert.deepEqual(questao.alternativas, [])
        continue
      }
      const alternativas = (await db.query<{ alternativa_id: string; ordem: number }>(
        'SELECT alternativa_id,ordem FROM public.tentativa_alternativas WHERE tentativa_id=$1 AND questao_id=$2 ORDER BY ordem', [tentativa.id, questao.id])).rows
      assert.ok([2, 5].includes(alternativas.length))
      assert.deepEqual(questao.alternativas.map(a => ({ alternativa_id: a.id, ordem: a.ordem })), alternativas)
      for (const alternativa of questao.alternativas) {
        assert.deepEqual(Object.keys(alternativa).sort(), ['id', 'ordem', 'texto'])
        const original = (await db.query<{ texto: string }>('SELECT texto FROM public.alternativas WHERE id=$1 AND questao_id=$2', [alternativa.id, questao.id])).rows[0]
        assert.equal(alternativa.texto, original.texto)
      }
    }
    // Colunas internas adicionadas no futuro também não podem entrar na resposta.
    await db.exec("ALTER TABLE public.questoes ADD COLUMN comentario_privado TEXT DEFAULT 'restrito'; ALTER TABLE public.alternativas ADD COLUMN justificativa_privada TEXT DEFAULT 'restrito';")
    assert.deepEqual(await consultar(), conteudo)
  })

  await t.test('atividade usa o mesmo contrato e tentativa antiga sem ordem é recusada', async () => {
    const atividade = await criarTentativa('ATIVIDADE')
    assert.equal((await consultar(atividade.id)).tipo, 'ATIVIDADE')
    const antes = await registros()
    await assert.rejects(consultar(antiga.id), { code: '55000', message: /não possui conteúdo com ordem salva/ })
    assert.deepEqual(await registros(), antes)
  })

  await t.test('outro aluno, UUID inexistente e ausência de ID não revelam conteúdo', async () => {
    await db.query("UPDATE public.perfis SET perfil='ALUNO' WHERE id=$1", [colega])
    await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, colega])
    const outra = (await queryAs<{ tentativa: { id: string } }>(colega,
      'SELECT public.iniciar_tentativa($1) AS tentativa', [tentativa.avaliacao_id])).rows[0].tentativa
    for (const id of [randomUUID(), outra.id, null]) {
      await assert.rejects(consultar(id), { code: 'P0002', message: 'Tentativa não encontrada ou acesso não autorizado.' })
    }
    await assert.rejects(consultar(tentativa.id, colega), { code: 'P0002' })
    assert.equal((await consultar(outra.id, colega)).tentativa_id, outra.id)
  })

  await t.test('professor, admin, usuário sem MFA e sessão inválida não acessam a execução', async () => {
    for (const usuario of [professor, admin]) await assert.rejects(consultar(tentativa.id, usuario), { code: '42501' })
    await assert.rejects(consultar(tentativa.id, aluno, 'aal1'), { code: '42501' })
    const sessaoOriginal = sessions.get(aluno)!
    try {
      for (const sessao of [randomUUID(), sessions.get(professor)!]) {
        sessions.set(aluno, sessao)
        await assert.rejects(consultar(), { code: '42501' })
      }
      sessions.delete(aluno)
      await assert.rejects(consultar(), { code: '42501' })
    } finally {
      sessions.set(aluno, sessaoOriginal)
    }
    for (const schema of ['public', 'examentech_private']) {
      await assert.rejects(db.transaction(async tx => {
        await tx.exec('SET LOCAL ROLE anon')
        await tx.query(`SELECT ${schema}.consultar_conteudo_tentativa($1)`, [tentativa.id])
      }), { code: '42501' })
    }
  })

  await t.test('revalida situação, vínculo, organização e horário em cada consulta', async () => {
    const outraOrg = randomUUID()
    await db.query("INSERT INTO public.organizacoes(id,nome,token_login) VALUES ($1,'Outra escola','outra-escola')", [outraOrg])
    const casos = [
      { sql: "UPDATE public.perfis SET situacao='INATIVO' WHERE id=$1", params: [aluno], code: '42501' },
      { sql: "UPDATE public.organizacoes SET situacao='INATIVO' WHERE id=$1", params: [org], code: '42501' },
      { sql: 'DELETE FROM auth.sessions WHERE id=$1', params: [sessions.get(aluno)], code: '42501' },
      { sql: 'UPDATE public.perfis SET organizacao_id=$1 WHERE id=$2', params: [outraOrg, aluno], code: 'P0002' },
      { sql: 'UPDATE public.turmas SET organizacao_id=$1 WHERE id=$2', params: [outraOrg, turmaId], code: 'P0002' },
      { sql: "UPDATE public.turma_alunos SET situacao='INATIVA' WHERE aluno_id=$1", params: [aluno], code: 'P0002' },
      { sql: "UPDATE public.turma_alunos SET situacao='PENDENTE' WHERE aluno_id=$1", params: [aluno], code: 'P0002' },
      { sql: 'DELETE FROM public.turma_alunos WHERE aluno_id=$1', params: [aluno], code: 'P0002' },
      { sql: "UPDATE public.turmas SET situacao='INATIVA' WHERE id=$1", params: [turmaId], code: '55000' },
      { sql: "UPDATE public.avaliacoes SET situacao='RASCUNHO',publicada_em=NULL WHERE id=$1", params: [tentativa.avaliacao_id], code: '55000' },
      { sql: "UPDATE public.tentativas SET iniciada_em=now()-interval '1 hour',limite_em=now() WHERE id=$1", params: [tentativa.id], code: '55000' },
      { sql: 'UPDATE public.avaliacoes SET fim_em=now() WHERE id=$1', params: [tentativa.avaliacao_id], code: '55000' },
      { sql: "UPDATE public.avaliacoes SET inicio_em=now()+interval '1 hour' WHERE id=$1", params: [tentativa.avaliacao_id], code: '55000' },
      { sql: "UPDATE public.tentativas SET iniciada_em=now()+interval '10 minutes' WHERE id=$1", params: [tentativa.id], code: '55000' },
    ]
    for (const caso of casos) {
      // O erro desfaz a alteração fictícia junto com a transação.
      await assert.rejects(db.transaction(async tx => {
        await tx.query(caso.sql, caso.params)
        await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: aluno, aal: 'aal2', session_id: sessions.get(aluno) })])
        await tx.exec('SET LOCAL ROLE authenticated')
        await tx.query(consultarSql, [tentativa.id])
      }), { code: caso.code }, caso.sql)
    }
    assert.equal((await consultar()).tentativa_id, tentativa.id)
  })

  await t.test('recusa tentativa finalizada e usa o relógio atual, mesmo em transação antiga', async () => {
    for (const alteracao of ['finalizada', 'prazo']) {
      await assert.rejects(db.transaction(async tx => {
        if (alteracao === 'finalizada') {
          // Simula uma situação futura sem mudar o esquema permanente deste bloco.
          await tx.exec('ALTER TABLE public.tentativas DROP CONSTRAINT tentativas_situacao_check')
          await tx.query("UPDATE public.tentativas SET situacao='FINALIZADA' WHERE id=$1", [tentativa.id])
        } else {
          await tx.query("UPDATE public.tentativas SET limite_em=now()+interval '20 milliseconds' WHERE id=$1", [tentativa.id])
          await tx.exec('SELECT pg_sleep(0.05)')
        }
        await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: aluno, aal: 'aal2', session_id: sessions.get(aluno) })])
        await tx.exec('SET LOCAL ROLE authenticated')
        await tx.query(consultarSql, [tentativa.id])
      }), { code: '55000' })
    }
  })

  await t.test('função privada aplica a mesma autorização e tabelas continuam protegidas', async () => {
    const sql = 'SELECT examentech_private.consultar_conteudo_tentativa($1) AS conteudo'
    assert.deepEqual((await queryAs<{ conteudo: ConteudoTentativa }>(aluno, sql, [tentativa.id])).rows[0].conteudo, await consultar())
    await assert.rejects(queryAs(professor, sql, [tentativa.id]), { code: '42501' })
    await assert.rejects(queryAs(colega, sql, [tentativa.id]), { code: 'P0002' })
    for (const tabela of ['questoes', 'alternativas']) assert.deepEqual((await queryAs(aluno, `SELECT * FROM public.${tabela}`)).rows, [])
    for (const tabela of ['tentativa_questoes', 'tentativa_alternativas']) {
      for (const sql of [`SELECT * FROM public.${tabela}`, `UPDATE public.${tabela} SET ordem=1`, `DELETE FROM public.${tabela}`]) {
        await assert.rejects(queryAs(aluno, sql), { code: '42501' })
      }
    }
  })
})
