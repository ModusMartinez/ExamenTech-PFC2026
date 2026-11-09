import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'

type Resposta = {
  id: string; tentativa_id: string; questao_id: string; alternativa_id: string | null
  texto: string | null; versao: number; criado_em: string; atualizado_em: string
}

test('respostas da tentativa: persistência, autorização, versões e auditoria', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { org, professor, colega, aluno, admin, sessions, queryAs, turmaId } = await prepararBancoAvaliacoes(db)
  async function aplicar(file: string) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }
  for (const file of ['023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql', '025_iniciar_tentativa.sql']) await aplicar(file)
  async function criarTentativa(tipo = 'PROVA') {
    const avaliacao = (await queryAs<{ avaliacao: { id: string } }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Avaliação de respostas',$2,now()-interval '5 minutes',now()+interval '2 hours',60
    ) AS avaliacao`, [turmaId, tipo])).rows[0].avaliacao.id
    async function criarQuestao(tipo: string) {
      return (await queryAs<{ questao: { id: string } }>(professor,
        'SELECT public.criar_questao_rascunho($1,$2,$3,2) AS questao', [avaliacao, tipo, 'Enunciado de teste'])).rows[0].questao.id
    }
    const objetiva = await criarQuestao('OBJETIVA'), dissertativa = await criarQuestao('DISSERTATIVA')
    const alternativas = (await queryAs<{ alternativas: { id: string }[] }>(professor,
      'SELECT public.criar_alternativas_rascunho($1,$2,1) AS alternativas', [objetiva, ['Opção A', 'Opção B']])).rows[0].alternativas.map(a => a.id)
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [avaliacao])
    const tentativa = (await queryAs<{ tentativa: { id: string } }>(aluno,
      'SELECT public.iniciar_tentativa($1) AS tentativa', [avaliacao])).rows[0].tentativa.id
    return { avaliacao, tentativa, objetiva, dissertativa, alternativas }
  }
  const antiga = await criarTentativa()
  await aplicar('026_ordem_tentativa.sql')
  await aplicar('027_consultar_conteudo_tentativa.sql')
  const atual = await criarTentativa(), outra = await criarTentativa('ATIVIDADE')
  async function historico() {
    const registros = []
    for (const tabela of ['tentativas', 'tentativa_questoes', 'tentativa_alternativas', 'eventos_seguranca']) {
      registros.push((await db.query(`SELECT * FROM public.${tabela} ORDER BY 1,2`)).rows)
    }
    return registros
  }
  const anteriores = await historico()
  await aplicar('028_salvar_resposta_tentativa.sql')
  const sql = 'SELECT public.salvar_resposta_tentativa($1,$2,$3,$4,$5) AS resposta'
  async function salvar({ questao = atual.objetiva, versao = 1, alternativa = null, texto = null,
    usuario = aluno, tentativa = atual.tentativa, aal = 'aal2' }: {
      questao?: string | null; versao?: number | null; alternativa?: string | null; texto?: string | null
      usuario?: string; tentativa?: string | null; aal?: string
    } = {}) {
    return (await queryAs<{ resposta: Resposta }>(usuario, sql, [tentativa, questao, versao, alternativa, texto], aal)).rows[0].resposta
  }
  async function respostas() { return (await db.query<Resposta>('SELECT * FROM public.respostas ORDER BY id')).rows }
  async function eventos() { return (await db.query<Record<string, unknown>>("SELECT * FROM public.eventos_seguranca WHERE evento='RESPOSTA_SALVA' ORDER BY id")).rows }

  await t.test('aplicação preserva tentativas, ordem e eventos anteriores', async () => {
    assert.deepEqual(await historico(), anteriores)
    assert.deepEqual(await respostas(), [])
  })

  await t.test('objetiva salva, confirma repetição, troca e limpa a seleção sem duplicar a resposta', async () => {
    const primeira = await salvar({ alternativa: atual.alternativas[0] })
    assert.deepEqual(Object.keys(primeira).sort(), ['id', 'tentativa_id', 'questao_id', 'alternativa_id', 'texto', 'versao', 'criado_em', 'atualizado_em'].sort())
    assert.equal(primeira.tentativa_id, atual.tentativa)
    assert.equal(primeira.questao_id, atual.objetiva)
    assert.equal(primeira.alternativa_id, atual.alternativas[0])
    assert.equal(primeira.texto, null)
    assert.equal(primeira.versao, 1)
    assert.deepEqual(await salvar({ alternativa: atual.alternativas[0] }), primeira)
    assert.equal((await eventos()).length, 1)
    const segunda = await salvar({ alternativa: atual.alternativas[1], versao: 2 })
    assert.equal(segunda.id, primeira.id)
    assert.equal(segunda.criado_em, primeira.criado_em)
    assert.ok(Date.parse(segunda.atualizado_em) >= Date.parse(primeira.atualizado_em))
    const limpa = await salvar({ versao: 3 })
    assert.equal(limpa.id, primeira.id)
    assert.equal(limpa.alternativa_id, null)
    assert.equal(limpa.texto, null)
    assert.equal((await respostas()).length, 1)
    const logs = await eventos()
    assert.equal(logs.length, 3)
    for (const log of logs) {
      assert.equal(log.usuario_id, aluno)
      assert.equal(log.recurso_id, primeira.id)
      assert.equal(log.acao, 'salvar_resposta_tentativa')
      assert.equal(log.sucesso, true)
      assert.equal(log.sessao_id, null)
      assert.deepEqual(log.codigos_erro, [])
    }
    assert.ok(!JSON.stringify(logs).includes(atual.alternativas[0]))
    assert.deepEqual((await historico()).slice(0, 3), anteriores.slice(0, 3))
  })

  await t.test('dissertativa preserva espaços e quebras de linha, aceita limpeza e limita o texto', async () => {
    const texto = '  Resposta em português.\nSegunda linha com <b>texto</b>.  '
    const primeira = await salvar({ questao: atual.dissertativa, texto })
    assert.equal(primeira.texto, texto)
    assert.equal(primeira.alternativa_id, null)
    assert.equal((await salvar({ questao: atual.dissertativa, versao: 2, texto: '' })).texto, null)
    assert.equal((await salvar({ questao: atual.dissertativa, versao: 3, texto: 'á'.repeat(10000) })).texto?.length, 10000)
    const antes = await respostas(), logs = await eventos()
    await assert.rejects(salvar({ questao: atual.dissertativa, versao: 4, texto: 'á'.repeat(10001) }), { code: '23514' })
    assert.deepEqual(await respostas(), antes)
    assert.deepEqual(await eventos(), logs)
    assert.ok(!(JSON.stringify(logs)).includes('Segunda linha'))
  })

  await t.test('tipos, questão e alternativa precisam corresponder ao conteúdo sorteado', async () => {
    const antes = await respostas(), logs = await eventos()
    for (const entrada of [
      { questao: outra.objetiva }, { questao: randomUUID() }, { questao: null },
      { tentativa: antiga.tentativa, questao: antiga.objetiva },
    ]) await assert.rejects(salvar({ ...entrada, versao: 4 }), { code: 'P0002' })
    for (const entrada of [
      { alternativa: outra.alternativas[0] }, { alternativa: randomUUID() },
      { texto: 'Texto em objetiva' }, { texto: '' },
      { alternativa: atual.alternativas[0], texto: 'Dois tipos' },
      { questao: atual.dissertativa, alternativa: atual.alternativas[0] },
    ]) await assert.rejects(salvar({ ...entrada, versao: 4 }), { code: '23514' })
    assert.deepEqual(await respostas(), antes)
    assert.deepEqual(await eventos(), logs)
  })

  await t.test('versões antigas, fora de sequência ou repetidas com outro conteúdo são recusadas', async () => {
    const antes = await respostas(), logs = await eventos()
    for (const versao of [null, 0, -1]) await assert.rejects(salvar({ versao }), { code: '23514' })
    for (const versao of [1, 2, 3, 5]) {
      await assert.rejects(salvar({ versao, alternativa: atual.alternativas[0] }), { code: '55000' })
    }
    await assert.rejects(salvar({ tentativa: outra.tentativa, questao: outra.objetiva, versao: 2 }), { code: '55000' })
    assert.deepEqual(await respostas(), antes)
    assert.deepEqual(await eventos(), logs)
  })

  await t.test('envios disputando a mesma versão não sobrescrevem o primeiro confirmado', async () => {
    const antes = (await eventos()).length
    // PGlite enfileira transações: cobre a disputa de versão, não conexões simultâneas reais.
    const resultados = await Promise.allSettled(atual.alternativas.map(alternativa => salvar({ versao: 4, alternativa })))
    assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1)
    const recusado = resultados.find(r => r.status === 'rejected')
    assert.ok(recusado?.status === 'rejected')
    assert.equal(recusado.reason.code, '55000')
    const confirmada = resultados.find(r => r.status === 'fulfilled')
    assert.ok(confirmada?.status === 'fulfilled')
    assert.deepEqual(await salvar({ versao: 4, alternativa: confirmada.value.alternativa_id }), confirmada.value)
    await assert.rejects(salvar({ versao: 3 }), { code: '55000' })
    assert.equal((await eventos()).length, antes + 1)
  })

  await t.test('outro aluno, professor, admin, MFA insuficiente e sessões inválidas são recusados', async () => {
    await db.query("UPDATE public.perfis SET perfil='ALUNO' WHERE id=$1", [colega])
    await db.query("INSERT INTO public.turma_alunos(turma_id,aluno_id,situacao) VALUES ($1,$2,'ATIVA')", [turmaId, colega])
    const tentativaColega = (await queryAs<{ tentativa: { id: string } }>(colega,
      'SELECT public.iniciar_tentativa($1) AS tentativa', [atual.avaliacao])).rows[0].tentativa.id
    const antes = await respostas(), logs = await eventos()
    for (const usuario of [professor, admin]) await assert.rejects(salvar({ usuario }), { code: '42501' })
    await assert.rejects(salvar({ usuario: colega }), { code: 'P0002' })
    for (const tentativa of [null, randomUUID(), tentativaColega]) await assert.rejects(salvar({ tentativa }), { code: 'P0002' })
    await assert.rejects(salvar({ aal: 'aal1' }), { code: '42501' })
    const original = sessions.get(aluno)!
    try {
      for (const sessao of [randomUUID(), sessions.get(professor)!]) {
        sessions.set(aluno, sessao)
        await assert.rejects(salvar(), { code: '42501' })
      }
      sessions.delete(aluno)
      await assert.rejects(salvar(), { code: '42501' })
    } finally { sessions.set(aluno, original) }
    await assert.rejects(queryAs(professor, sql.replace('public.', 'examentech_private.'),
      [atual.tentativa, atual.objetiva, 5, null, null]), { code: '42501' })
    assert.deepEqual(await respostas(), antes)
    assert.deepEqual(await eventos(), logs)
    assert.equal((await salvar({ usuario: colega, tentativa: tentativaColega, alternativa: atual.alternativas[0] })).versao, 1)
    assert.equal((await salvar({ tentativa: outra.tentativa, questao: outra.objetiva, alternativa: outra.alternativas[0] })).versao, 1)
  })

  await t.test('revalida vínculos, situação e horário a cada salvamento, sem apagar respostas anteriores', async () => {
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
      { sql: "UPDATE public.avaliacoes SET situacao='RASCUNHO',publicada_em=NULL WHERE id=$1", params: [atual.avaliacao], code: '55000' },
      { sql: "UPDATE public.tentativas SET iniciada_em=now()-interval '1 hour',limite_em=now() WHERE id=$1", params: [atual.tentativa], code: '55000' },
      { sql: 'UPDATE public.avaliacoes SET fim_em=now() WHERE id=$1', params: [atual.avaliacao], code: '55000' },
      { sql: "UPDATE public.avaliacoes SET inicio_em=now()+interval '1 hour' WHERE id=$1", params: [atual.avaliacao], code: '55000' },
      { sql: "UPDATE public.tentativas SET iniciada_em=now()+interval '10 minutes' WHERE id=$1", params: [atual.tentativa], code: '55000' },
    ]
    const antes = await respostas(), logs = await eventos()
    for (const caso of casos) {
      await assert.rejects(db.transaction(async tx => {
        await tx.query(caso.sql, caso.params)
        await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: aluno, aal: 'aal2', session_id: sessions.get(aluno) })])
        await tx.exec('SET LOCAL ROLE authenticated')
        await tx.query(sql, [atual.tentativa, atual.objetiva, 5, null, null])
      }), { code: caso.code }, caso.sql)
    }
    for (const situacao of ['FINALIZADA', 'CANCELADA', 'prazo']) {
      await assert.rejects(db.transaction(async tx => {
        if (situacao === 'prazo') {
          await tx.query("UPDATE public.tentativas SET limite_em=now()+interval '20 milliseconds' WHERE id=$1", [atual.tentativa])
          await tx.exec('SELECT pg_sleep(0.05)')
        } else {
          await tx.exec('ALTER TABLE public.tentativas DROP CONSTRAINT tentativas_situacao_check')
          await tx.query('UPDATE public.tentativas SET situacao=$1 WHERE id=$2', [situacao, atual.tentativa])
        }
        await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: aluno, aal: 'aal2', session_id: sessions.get(aluno) })])
        await tx.exec('SET LOCAL ROLE authenticated')
        await tx.query(sql, [atual.tentativa, atual.objetiva, 5, null, null])
      }), { code: '55000' })
    }
    assert.deepEqual(await respostas(), antes)
    assert.deepEqual(await eventos(), logs)
  })

  await t.test('sem acesso direto à tabela e sem execução anônima das funções', async () => {
    const operacoes = ['SELECT * FROM public.respostas', 'DELETE FROM public.respostas',
      'UPDATE public.respostas SET texto=NULL', 'TRUNCATE public.respostas',
      `INSERT INTO public.respostas(tentativa_id,questao_id,versao) VALUES ('${atual.tentativa}','${atual.objetiva}',1)`]
    for (const usuario of [aluno, professor, admin]) {
      for (const operacao of operacoes) await assert.rejects(queryAs(usuario, operacao), { code: '42501' })
    }
    for (const operacao of [...operacoes, sql, sql.replace('public.', 'examentech_private.')]) {
      await assert.rejects(db.transaction(async tx => {
        await tx.exec('SET LOCAL ROLE anon')
        await tx.query(operacao, operacao.includes('$1') ? [atual.tentativa, atual.objetiva, 5, null, null] : [])
      }), { code: '42501' })
    }
    assert.equal((await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid='public.respostas'::regclass")).rows[0].relrowsecurity, true)
  })

  await t.test('FKs impedem resposta fora da ordem salva, alternativa de outra questão e exclusão do vínculo', async () => {
    await assert.rejects(db.query('INSERT INTO public.respostas(tentativa_id,questao_id,versao) VALUES ($1,$2,1)',
      [atual.tentativa, outra.objetiva]), { code: '23503' })
    await assert.rejects(db.query('INSERT INTO public.respostas(tentativa_id,questao_id,alternativa_id,versao) VALUES ($1,$2,$3,1)',
      [outra.tentativa, outra.dissertativa, outra.alternativas[0]]), { code: '23503' })
    await assert.rejects(db.query('INSERT INTO public.respostas(tentativa_id,questao_id,versao) VALUES ($1,$2,1)',
      [atual.tentativa, atual.objetiva]), { code: '23505' })
    await assert.rejects(db.query('DELETE FROM public.tentativa_questoes WHERE tentativa_id=$1 AND questao_id=$2',
      [atual.tentativa, atual.dissertativa]), { code: '23001' })
  })

  await t.test('falha de auditoria desfaz inserção e atualização; reaplicação preserva tudo', async () => {
    const antes = await respostas(), logs = await eventos()
    await db.exec(`CREATE FUNCTION public.falhar_resposta() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.evento='RESPOSTA_SALVA' THEN RAISE EXCEPTION 'Falha simulada'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER falhar_resposta BEFORE INSERT ON public.eventos_seguranca
      FOR EACH ROW EXECUTE FUNCTION public.falhar_resposta();`)
    try {
      await assert.rejects(salvar({ versao: 5 }), /Falha simulada/)
      await assert.rejects(salvar({ tentativa: outra.tentativa, questao: outra.dissertativa, texto: 'Nova resposta' }), /Falha simulada/)
    } finally {
      await db.exec('DROP TRIGGER falhar_resposta ON public.eventos_seguranca; DROP FUNCTION public.falhar_resposta();')
    }
    assert.deepEqual(await respostas(), antes)
    assert.deepEqual(await eventos(), logs)
    const todos = await historico()
    await aplicar('028_salvar_resposta_tentativa.sql')
    assert.deepEqual(await respostas(), antes)
    assert.deepEqual(await historico(), todos)
    assert.equal((await salvar({ versao: 5 })).versao, 5)
  })
})
