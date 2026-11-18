import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { EXAM_NOTICE_VERSION, PROVA_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { prepararBancoCamera } from './helpers/bancoCamera.ts'

test('RF30–RF36 exigem a foto da prova e registram bloqueios sem classificar o aluno', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const { aluno, professor, colega, admin, turmaId, sessions, queryAs, criarProva } = await prepararBancoCamera(db)
  for (const nome of ['037_camera_sem_interrupcao', '038_tentativa_sessao', '039_correcao_tentativa',
    '040_finalizacao_e_resultados', '042_cancelamento_avaliacao', '043_execucao_segura_prova',
    '049_linha_tempo_tentativa', '052_pausa_prova']) {
    await db.exec(await readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8'))
  }
  const prova = await criarProva()
  const chave = randomUUID()
  const iniciar = (id: string) => queryAs<{ id: string }>(aluno,
    "SELECT public.iniciar_tentativa($1,$2,$3)->>'id' AS id", [id, EXAM_NOTICE_VERSION, chave])
  const iniciarComFotos = (id: string, aviso = PROVA_NOTICE_VERSION) => queryAs<{ id: string }>(aluno,
    "SELECT public.iniciar_tentativa_com_fotos($1,$2,'2026-11-08-fotos-v1',$3)->>'id' AS id", [id, aviso, chave])
  const encerrar = (id: string, motivo: string) => queryAs<{ situacao: string }>(aluno,
    "SELECT public.encerrar_tentativa($1,$2,$3)->>'situacao' AS situacao", [id, motivo, chave])
  const clipboard = (id: string, op: string, solicitacao = randomUUID(), execucao = chave, usuario = aluno) =>
    queryAs(usuario, 'SELECT public.registrar_bloqueio_clipboard($1,$2,$3,$4) AS ocorrencia', [id, solicitacao, execucao, op])
  const pausar = (id: string, motivo: string, solicitacao = randomUUID(), execucao = chave, usuario = aluno) =>
    queryAs(usuario, 'SELECT public.registrar_pausa_prova($1,$2,$3,$4) AS ocorrencia', [id, solicitacao, execucao, motivo])

  await t.test('prova sem coleta ou com aviso antigo é recusada sem consumir a tentativa', async () => {
    await assert.rejects(iniciar(prova.avaliacaoId), { code: '55000' })
    await assert.rejects(iniciarComFotos(prova.avaliacaoId), { code: '23514' })
    await db.exec('UPDATE examentech_private.configuracao_fotos SET ativa=TRUE')
    await assert.rejects(iniciarComFotos(prova.avaliacaoId, EXAM_NOTICE_VERSION), { code: '23514' })
    assert.deepEqual((await db.query('SELECT id FROM public.tentativas WHERE avaliacao_id=$1', [prova.avaliacaoId])).rows, [])
  })
  const id = (await iniciarComFotos(prova.avaliacaoId)).rows[0].id
  const salvar = () => queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,1,$3,NULL,$4)',
    [id, prova.questaoId, alternativa, chave])
  const alternativa = (await db.query<{ id: string }>('SELECT id FROM public.alternativas WHERE questao_id=$1 AND correta', [prova.questaoId])).rows[0].id

  await t.test('planeja foto inicial e três capturas aleatórias; exige a inicial para conteúdo, resposta e envio', async () => {
    const slots = await db.query('SELECT momento FROM public.fotos_tentativa WHERE tentativa_id=$1 ORDER BY agendada_em', [id])
    assert.deepEqual(slots.rows, ['INICIAL', 'PROVA_1', 'PROVA_2', 'PROVA_3'].map(momento => ({ momento })))
    await assert.rejects(queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [id, chave]), { code: '55000' })
    await assert.rejects(salvar(), { code: '55000' })
    await assert.rejects(encerrar(id, 'ENVIO'), { code: '55000' })
    await db.query(`UPDATE public.fotos_tentativa SET situacao='DISPONIVEL',recebida_em=clock_timestamp(),
      expira_em=agendada_em+interval '90 days',caminho=tentativa_id::text||'/'||ciclo::text||'/'||id::text||'.jpg'
      WHERE tentativa_id=$1 AND momento='INICIAL'`, [id])
    await queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [id, chave])
    await salvar()
  })

  await t.test('clipboard confirma os três tipos, repete a mesma ocorrência e recusa outra sessão de execução', async () => {
    const solicitacao = randomUUID()
    const primeira = await clipboard(id, 'copy', solicitacao)
    assert.deepEqual((await clipboard(id, 'copy', solicitacao)).rows, primeira.rows)
    await assert.rejects(clipboard(id, 'paste', solicitacao), { code: '23514' })
    await assert.rejects(clipboard(id, 'outro'), { code: '23514' })
    await assert.rejects(clipboard(id, 'copy', randomUUID(), randomUUID()), { code: '42501' })
    await assert.rejects(clipboard(id, 'copy', randomUUID(), chave, admin), { code: '42501' })
    await clipboard(id, 'paste')
    await clipboard(id, 'cut')
    await queryAs(aluno, 'SELECT public.registrar_falha_camera($1,$2,$3)', [id, randomUUID(), chave])
    assert.deepEqual((await db.query(`SELECT acao FROM public.eventos_seguranca
      WHERE recurso_id=$1 AND evento IN ('CLIPBOARD_BLOQUEADO','CAMERA_FALHA') ORDER BY acao`, [id])).rows,
    ['colar_bloqueado', 'copiar_bloqueado', 'falha_camera', 'recortar_bloqueado'].map(acao => ({ acao })))
    assert.deepEqual((await db.query('SELECT situacao FROM public.tentativas WHERE id=$1', [id])).rows, [{ situacao: 'EM_ANDAMENTO' }])
  })

  await t.test('RF32 registra os motivos na linha do tempo sem mudar a situação, as respostas ou o prazo', async () => {
    const antes = await db.query('SELECT situacao, limite_em, encerrada_em FROM public.tentativas WHERE id=$1', [id])
    const solicitacao = randomUUID()
    const primeira = await pausar(id, 'ABA_OU_FOCO', solicitacao)
    assert.deepEqual((await pausar(id, 'ABA_OU_FOCO', solicitacao)).rows, primeira.rows)
    await assert.rejects(pausar(id, 'TELA_CHEIA', solicitacao), { code: '23514' })
    await assert.rejects(pausar(id, 'SAIDA'), { code: '23514' })
    await assert.rejects(pausar(id, 'TELA_CHEIA', randomUUID(), randomUUID()), { code: '42501' })
    await assert.rejects(pausar(id, 'TELA_CHEIA', randomUUID(), chave, professor), { code: '42501' })
    await pausar(id, 'TELA_CHEIA')
    const linhaDoTempo = 'SELECT public.listar_linha_tempo_tentativa($1) AS itens'
    const [{ itens }] = (await queryAs<{ itens: { titulo: string; detalhe: string }[] }>(professor, linhaDoTempo, [id])).rows
    assert.deepEqual(itens.filter(item => item.titulo === 'PROVA_PAUSADA').map(item => item.detalhe),
      ['perda_aba_ou_foco', 'saida_tela_cheia'])
    await assert.rejects(queryAs(colega, linhaDoTempo, [id]), { code: '42501' })
    assert.deepEqual((await db.query('SELECT situacao, limite_em, encerrada_em FROM public.tentativas WHERE id=$1', [id])).rows, antes.rows)
    await queryAs(aluno, 'SELECT public.consultar_conteudo_tentativa($1,$2)', [id, chave])
    assert.equal((await db.query('SELECT versao FROM public.respostas_tentativa WHERE tentativa_id=$1', [id])).rows.length, 1)
  })

  await t.test('o encerramento por versões anteriores continua aceito e preserva a resposta', async () => {
    assert.equal((await encerrar(id, 'TELA_CHEIA')).rows[0].situacao, 'INTERROMPIDA')
    await encerrar(id, 'TELA_CHEIA')
    await assert.rejects(pausar(id, 'TELA_CHEIA'), { code: '55000' })
    await assert.rejects(salvar(), { code: '55000' })
    assert.deepEqual((await db.query('SELECT alternativa_id,versao FROM public.respostas_tentativa WHERE tentativa_id=$1', [id])).rows,
      [{ alternativa_id: alternativa, versao: 1 }])
    const segundaProva = await criarProva()
    const segunda = (await iniciarComFotos(segundaProva.avaliacaoId, '2026-11-09-v5')).rows[0].id
    assert.equal((await encerrar(segunda, 'ABA_OU_FOCO')).rows[0].situacao, 'INTERROMPIDA')
    assert.deepEqual((await db.query(`SELECT acao FROM public.eventos_seguranca
      WHERE recurso_id IN ($1,$2) AND evento='TENTATIVA_INTERROMPIDA' ORDER BY acao`, [id, segunda])).rows,
    [{ acao: 'perda_aba_ou_foco' }, { acao: 'saida_tela_cheia' }])
  })

  await t.test('atividades começam sem coleta mesmo com o Storage habilitado e não aceitam ocorrências exclusivas de prova', async () => {
    const atividade = (await queryAs<{ id: string }>(professor, `SELECT public.criar_avaliacao_rascunho(
      $1,'Atividade sem monitoramento','ATIVIDADE',now()-interval '1 minute',now()+interval '1 hour',30
    )->>'id' AS id`, [turmaId])).rows[0].id
    await queryAs(professor, "SELECT public.criar_questao_rascunho($1,'DISSERTATIVA','Questão da atividade',1)", [atividade])
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [atividade])
    await assert.rejects(iniciarComFotos(atividade), { code: '55000' })
    const tentativa = (await iniciar(atividade)).rows[0].id
    assert.deepEqual((await db.query('SELECT id FROM public.fotos_tentativa WHERE tentativa_id=$1', [tentativa])).rows, [])
    await assert.rejects(clipboard(tentativa, 'copy'), { code: '23514' })
    await assert.rejects(pausar(tentativa, 'TELA_CHEIA'), { code: '23514' })
    await assert.rejects(queryAs(aluno, 'SELECT public.registrar_falha_camera($1,$2,$3)', [tentativa, randomUUID(), chave]), { code: '23514' })
    await assert.rejects(encerrar(tentativa, 'TELA_CHEIA'), { code: '23514' })
    assert.equal((await encerrar(tentativa, 'ENVIO')).rows[0].situacao, 'FINALIZADA')
  })

  await t.test('RF39 soma as pausas nos totais por perfil e no gráfico do professor', async () => {
    for (const nome of ['050_dashboard_periodo', '051_dashboard_ocorrencias_e_agenda', '053_dashboard_correcoes_professor']) {
      await db.exec(await readFile(new URL(`../database/${nome}.sql`, import.meta.url), 'utf8'))
    }
    type Indicador = { rotulo: string; valor: number | null }
    type Dashboard = { indicadores: Indicador[]; grafico_ocorrencias?: Indicador[]; indicadores_correcoes?: Indicador[] }
    const dashboard = async (usuario = professor, inicio: string | null = null, fim: string | null = null, aal = 'aal2') =>
      (await queryAs<{ resultado: Dashboard }>(usuario,
        'SELECT public.consultar_indicadores_dashboard_periodo($1,$2) AS resultado', [inicio, fim], aal)).rows[0].resultado
    const ocorrencias = (resultado: Dashboard) => resultado.indicadores.find(item => item.rotulo === 'Ocorrências registradas')?.valor
    const anterior = await dashboard()
    assert.equal(ocorrencias(anterior), 6)

    const migracao = await readFile(new URL('../database/059_dashboard_ocorrencias_pausas.sql', import.meta.url), 'utf8')
    await db.exec(migracao)
    const atualizado = await dashboard()
    assert.equal(ocorrencias(atualizado), 8)
    assert.deepEqual(atualizado.grafico_ocorrencias, [
      { rotulo: 'Falha de câmera', valor: 1 },
      { rotulo: 'Área de transferência bloqueada', valor: 3 },
      { rotulo: 'Tentativa interrompida', valor: 2 },
      { rotulo: 'Prova pausada', valor: 2 },
    ])
    assert.deepEqual(atualizado.indicadores_correcoes, anterior.indicadores_correcoes)
    for (const usuario of [aluno, admin]) assert.equal(ocorrencias(await dashboard(usuario)), 8)
    assert.equal(ocorrencias(await dashboard(colega)), 0)
    assert.deepEqual((await dashboard(colega)).grafico_ocorrencias, [])

    const { hoje } = (await db.query<{ hoje: string }>(
      "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS hoje")).rows[0]
    await db.query(`UPDATE public.eventos_seguranca SET criado_em=$1::date::timestamp AT TIME ZONE 'America/Sao_Paulo'
      WHERE recurso_id=$2 AND evento='PROVA_PAUSADA' AND acao='perda_aba_ou_foco'`, [hoje, id])
    for (const horario of ['23:59:59.999999', '00:00:00']) {
      await db.query(`INSERT INTO public.eventos_seguranca
        (solicitacao_id,evento,provedor,acao,sucesso,usuario_id,recurso_id,criado_em)
        VALUES($1,'PROVA_PAUSADA','EXAMENTECH','saida_tela_cheia',TRUE,$2,$3,
          (($4::date + CASE WHEN $5='00:00:00' THEN 1 ELSE -1 END) + $5::time) AT TIME ZONE 'America/Sao_Paulo')`,
      [randomUUID(), aluno, id, hoje, horario])
    }
    for (const usuario of [professor, aluno, admin]) {
      assert.equal(ocorrencias(await dashboard(usuario)), 10)
      assert.equal(ocorrencias(await dashboard(usuario, hoje, hoje)), 8)
      assert.equal(ocorrencias(await dashboard(usuario, null, hoje)), 9)
      assert.equal(ocorrencias(await dashboard(usuario, hoje, null)), 9)
      assert.equal(ocorrencias(await dashboard(usuario, null, '2000-01-01')), 0)
    }
    assert.deepEqual((await dashboard(professor, hoje, hoje)).grafico_ocorrencias, atualizado.grafico_ocorrencias)
    assert.deepEqual((await dashboard(professor, null, '2000-01-01')).grafico_ocorrencias, [])
    await assert.rejects(dashboard(professor, '2026-11-19', '2026-11-18'), { code: '22023' })
    await assert.rejects(dashboard(professor, null, null, 'aal1'), { code: '42501' })
    const sessao = sessions.get(professor)!
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [sessao])
    await assert.rejects(dashboard(), { code: '42501' })
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [sessao, professor])
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE anon')
      return tx.query('SELECT public.consultar_indicadores_dashboard_periodo()')
    }), { code: '42501' })
    for (const funcao of ['consultar_indicadores_dashboard_periodo', 'dashboard_complemento_rf47']) {
      await assert.rejects(queryAs(professor, `SELECT examentech_private.${funcao}(NULL,NULL)`), { code: '42501' })
    }
    const antesDeReaplicar = await dashboard()
    await db.exec(migracao)
    assert.deepEqual(await dashboard(), antesDeReaplicar)
  })
})
