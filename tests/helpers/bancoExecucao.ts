import { readFile } from 'node:fs/promises'
import type { PGlite } from '@electric-sql/pglite'
import { prepararBancoAvaliacoes } from './bancoAvaliacoes.ts'

export async function prepararBancoExecucao(db: PGlite) {
  const base = await prepararBancoAvaliacoes(db)
  for (const file of ['023_publicar_avaliacao.sql','024_listar_minhas_avaliacoes.sql',
    '025_iniciar_tentativa.sql','026_ordem_tentativa.sql','027_consultar_conteudo_tentativa.sql',
    '028_respostas_e_encerramento.sql','030_reativacao_autorizada.sql']) {
    await db.exec(await readFile(new URL(`../../database/${file}`, import.meta.url), 'utf8'))
  }
  async function criarProva() {
    const avaliacaoId = (await base.queryAs<{ avaliacao: { id: string } }>(base.professor,
      `SELECT public.criar_avaliacao_rascunho($1,'Prova de integração','PROVA',
        now()-interval '5 minutes',now()+interval '2 hours',60) AS avaliacao`, [base.turmaId])).rows[0].avaliacao.id
    const questaoId = (await base.queryAs<{ questao: { id: string } }>(base.professor,
      "SELECT public.criar_questao_rascunho($1,'OBJETIVA','Quanto é dois mais dois?',1) AS questao",
      [avaliacaoId])).rows[0].questao.id
    await base.queryAs(base.professor,'SELECT public.criar_alternativas_rascunho($1,$2,2)',[questaoId,['3','4','5']])
    await base.queryAs(base.professor,'SELECT public.publicar_avaliacao($1)',[avaliacaoId])
    return { avaliacaoId, questaoId }
  }
  return { ...base, criarProva }
}
