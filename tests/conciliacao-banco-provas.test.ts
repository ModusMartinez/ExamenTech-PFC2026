import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { EXAM_NOTICE_VERSION } from '../src/content/legalDocuments.ts'
import { prepararBancoAvaliacoes } from './helpers/bancoAvaliacoes.ts'

test('a ponte preserva histórico do protótipo e habilita a tentativa única nova', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const { professor, aluno, turmaId, queryAs } = await prepararBancoAvaliacoes(db)

  for (const file of ['023_publicar_avaliacao.sql', '024_listar_minhas_avaliacoes.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }

  // Estrutura mínima que existia no protótipo de provas do Supabase de testes.
  await db.exec(`
    CREATE TABLE public.tentativas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      avaliacao_id UUID NOT NULL REFERENCES public.avaliacoes(id) ON DELETE RESTRICT,
      aluno_id UUID NOT NULL REFERENCES public.perfis(id) ON DELETE RESTRICT,
      situacao TEXT NOT NULL DEFAULT 'PAUSADA'
        CHECK (situacao IN ('PAUSADA', 'EM_ANDAMENTO', 'BLOQUEADA', 'FINALIZADA')),
      falhas_camera INTEGER NOT NULL DEFAULT 0 CHECK (falhas_camera BETWEEN 0 AND 3),
      aviso_versao TEXT NOT NULL,
      ciencia_registrada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      tempo_restante_segundos BIGINT NOT NULL CHECK (tempo_restante_segundos >= 0),
      iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      ultimo_inicio_em TIMESTAMPTZ,
      finalizada_em TIMESTAMPTZ,
      CONSTRAINT tentativas_unica_por_aluno UNIQUE (avaliacao_id, aluno_id),
      CONSTRAINT tentativas_estado_valido CHECK (
        (situacao = 'EM_ANDAMENTO' AND ultimo_inicio_em IS NOT NULL AND finalizada_em IS NULL)
        OR (situacao IN ('PAUSADA', 'BLOQUEADA') AND ultimo_inicio_em IS NULL AND finalizada_em IS NULL)
        OR (situacao = 'FINALIZADA' AND ultimo_inicio_em IS NULL AND finalizada_em IS NOT NULL)
      )
    );
    CREATE TABLE public.respostas_prova (
      tentativa_id UUID NOT NULL REFERENCES public.tentativas(id) ON DELETE RESTRICT,
      questao_id UUID NOT NULL REFERENCES public.questoes(id) ON DELETE RESTRICT,
      alternativa_id UUID REFERENCES public.alternativas(id) ON DELETE RESTRICT,
      texto TEXT,
      salvo_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tentativa_id, questao_id)
    );
  `)

  for (const file of ['025_iniciar_tentativa.sql', '026_ordem_tentativa.sql', '027_consultar_conteudo_tentativa.sql']) {
    await db.exec(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'))
  }

  async function criarProva(titulo: string) {
    const avaliacaoId = (await queryAs<{ avaliacao: { id: string } }>(professor,
      `SELECT public.criar_avaliacao_rascunho($1,$2,'PROVA',
        now()-interval '5 minutes',now()+interval '2 hours',60) AS avaliacao`,
      [turmaId, titulo])).rows[0].avaliacao.id
    const questaoId = (await queryAs<{ questao: { id: string } }>(professor,
      "SELECT public.criar_questao_rascunho($1,'OBJETIVA','Questão de teste',1) AS questao",
      [avaliacaoId])).rows[0].questao.id
    await queryAs(professor, 'SELECT public.criar_alternativas_rascunho($1,$2,2)',
      [questaoId, ['A', 'B', 'C']])
    await queryAs(professor, 'SELECT public.publicar_avaliacao($1)', [avaliacaoId])
    return { avaliacaoId, questaoId }
  }

  const antiga = await criarProva('Prova já finalizada')
  const alternativaAntiga = (await db.query<{ id: string }>(
    'SELECT id FROM public.alternativas WHERE questao_id=$1 ORDER BY id LIMIT 1',
    [antiga.questaoId])).rows[0].id
  const tentativaAntiga = (await db.query<{ id: string }>(`
    INSERT INTO public.tentativas (
      avaliacao_id, aluno_id, situacao, falhas_camera, aviso_versao,
      tempo_restante_segundos, iniciada_em, finalizada_em
    ) VALUES ($1,$2,'FINALIZADA',2,'2026-11-05-v1',0,
      now()-interval '30 minutes',now()-interval '20 minutes') RETURNING id`,
    [antiga.avaliacaoId, aluno])).rows[0].id
  await db.query('INSERT INTO public.respostas_prova(tentativa_id,questao_id,alternativa_id) VALUES($1,$2,$3)',
    [tentativaAntiga, antiga.questaoId, alternativaAntiga])

  await db.exec(await readFile(new URL('../docs/conciliar-banco-provas-teste.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../database/028_respostas_e_encerramento.sql', import.meta.url), 'utf8'))

  const historico = (await db.query<{
    situacao: string; falhas_camera: number; falhas_camera_historico: number; encerrada_em: Date
  }>('SELECT situacao,falhas_camera,falhas_camera_historico,encerrada_em FROM public.tentativas WHERE id=$1',
    [tentativaAntiga])).rows[0]
  assert.equal(historico.situacao, 'FINALIZADA')
  assert.equal(historico.falhas_camera, 1)
  assert.equal(historico.falhas_camera_historico, 2)
  assert.ok(historico.encerrada_em)
  assert.equal((await db.query('SELECT * FROM public.respostas_prova WHERE tentativa_id=$1', [tentativaAntiga])).rows.length, 1)

  const nova = await criarProva('Prova no fluxo novo')
  const tentativaNova = (await queryAs<{ tentativa: { id: string; situacao: string } }>(aluno,
    'SELECT public.iniciar_tentativa($1,$2) AS tentativa',
    [nova.avaliacaoId, EXAM_NOTICE_VERSION])).rows[0].tentativa
  assert.equal(tentativaNova.situacao, 'EM_ANDAMENTO')

  const conteudo = (await queryAs<{ conteudo: { questoes: Array<{ id: string; alternativas: Array<{ id: string }> }> } }>(aluno,
    'SELECT public.consultar_conteudo_tentativa($1) AS conteudo', [tentativaNova.id])).rows[0].conteudo
  await queryAs(aluno, 'SELECT public.salvar_resposta_tentativa($1,$2,$3,NULL)',
    [tentativaNova.id, conteudo.questoes[0].id, conteudo.questoes[0].alternativas[0].id])
  const encerrada = (await queryAs<{ resultado: { situacao: string } }>(aluno,
    "SELECT public.encerrar_tentativa($1,'ENVIO') AS resultado", [tentativaNova.id])).rows[0].resultado
  assert.equal(encerrada.situacao, 'FINALIZADA')
})
