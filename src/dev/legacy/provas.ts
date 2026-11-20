// Contrato antigo do protótipo. O fluxo atual usa services/tentativas.ts.
import { supabase } from '../../lib/supabase'
import { EXAM_NOTICE_VERSION } from '../../content/legalDocuments'
import { UUID_PATTERN, lerDataComFuso } from '../../services/avaliacaoValidation'

export type SituacaoTentativa = 'EM_ANDAMENTO' | 'INTERROMPIDA' | 'FINALIZADA'

export type ProvaAluno = {
  id: string
  titulo: string
  inicio_em: string
  fim_em: string
  duracao_minutos: number
  tentativa_id: string | null
  situacao: SituacaoTentativa | null
  falhas_camera: number | null
}

export type AlternativaProva = { id: string; ordem: number; texto: string }
export type QuestaoProva = {
  id: string
  ordem: number
  tipo: 'OBJETIVA' | 'DISSERTATIVA'
  enunciado: string
  pontuacao: number
  alternativas: AlternativaProva[]
}
export type RespostaProva = {
  questao_id: string
  alternativa_id: string | null
  texto: string | null
  salvo_em: string
}
export type TentativaProva = {
  id: string
  avaliacao_id: string
  situacao: SituacaoTentativa
  falhas_camera: number
  tempo_restante_segundos: number
  questoes: QuestaoProva[]
  respostas: RespostaProva[]
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function situacao(value: unknown): value is SituacaoTentativa {
  return value === 'EM_ANDAMENTO' || value === 'INTERROMPIDA' || value === 'FINALIZADA'
}

function id(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function chamada(nome: string, params?: Record<string, unknown>): Promise<unknown> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError || !sessionData.session) throw new Error('Sua sessão terminou. Entre novamente.')
  const { data, error } = await supabase.rpc(nome, params)
  if (error) {
    if (error.code === '42501') throw new Error('Seu perfil, matrícula ou sessão não permite esta operação.')
    if (error.code === 'P0002') throw new Error('Prova ou tentativa não encontrada.')
    if (error.code === '55000') throw new Error('A prova já foi iniciada, encerrada ou está fora do período de início. Não é possível voltar a uma tentativa.')
    if (error.code === '23514' && nome === 'publicar_avaliacao') {
      throw new Error('Para publicar, adicione ao menos uma questão. Cada questão objetiva precisa de 2 a 5 alternativas e uma resposta correta.')
    }
    if (error.code === '23514' && nome === 'iniciar_tentativa') {
      throw new Error('A versão da prova no banco de testes não corresponde à versão deste site. Use o teste local da câmera; o início real precisa ser alinhado com a equipe.')
    }
    if (error.code === '23514') throw new Error('Confira o aviso da prova, as questões e os dados informados.')
    throw new Error('Não foi possível confirmar a operação. Atualize a página antes de repetir.')
  }
  return data
}

function lerProva(value: unknown): ProvaAluno | null {
  if (!record(value) || !id(value.id) || typeof value.titulo !== 'string' ||
      !lerDataComFuso(value.inicio_em) || !lerDataComFuso(value.fim_em) ||
      !nonNegativeInteger(value.duracao_minutos) || value.duracao_minutos < 1 ||
      !(value.tentativa_id === null || id(value.tentativa_id)) ||
      !(value.situacao === null || situacao(value.situacao)) ||
      !(value.falhas_camera === null || (nonNegativeInteger(value.falhas_camera) && value.falhas_camera <= 3))) return null
  return value as ProvaAluno
}

function lerQuestao(value: unknown): QuestaoProva | null {
  if (!record(value) || !id(value.id) || !nonNegativeInteger(value.ordem) || value.ordem < 1 ||
      (value.tipo !== 'OBJETIVA' && value.tipo !== 'DISSERTATIVA') ||
      typeof value.enunciado !== 'string' || typeof value.pontuacao !== 'number' ||
      !Array.isArray(value.alternativas) || 'correta' in value) return null
  const alternativas: AlternativaProva[] = []
  for (const item of value.alternativas) {
    if (!record(item) || !id(item.id) || !nonNegativeInteger(item.ordem) || item.ordem < 1 ||
        typeof item.texto !== 'string' || 'correta' in item) return null
    alternativas.push({ id: item.id, ordem: item.ordem, texto: item.texto })
  }
  if (value.tipo === 'OBJETIVA' && alternativas.length < 2) return null
  if (value.tipo === 'DISSERTATIVA' && alternativas.length !== 0) return null
  return { id: value.id, ordem: value.ordem, tipo: value.tipo,
    enunciado: value.enunciado, pontuacao: value.pontuacao, alternativas }
}

function lerResposta(value: unknown): RespostaProva | null {
  if (!record(value) || !id(value.questao_id) ||
      !(value.alternativa_id === null || id(value.alternativa_id)) ||
      !(value.texto === null || typeof value.texto === 'string') ||
      !lerDataComFuso(value.salvo_em)) return null
  return value as RespostaProva
}

function lerTentativa(value: unknown): TentativaProva | null {
  if (!record(value) || !id(value.id) || !id(value.avaliacao_id) || !situacao(value.situacao) ||
      !nonNegativeInteger(value.falhas_camera) || value.falhas_camera > 3 ||
      !nonNegativeInteger(value.tempo_restante_segundos)) return null
  const questoes: QuestaoProva[] = []
  const respostas: RespostaProva[] = []
  if ('questoes' in value && (!Array.isArray(value.questoes) || !value.questoes.every((item) => {
    const questao = lerQuestao(item)
    if (!questao || questoes.some((other) => other.id === questao.id)) return false
    questoes.push(questao)
    return true
  }))) return null
  if ('respostas' in value && (!Array.isArray(value.respostas) || !value.respostas.every((item) => {
    const resposta = lerResposta(item)
    if (!resposta || respostas.some((other) => other.questao_id === resposta.questao_id)) return false
    respostas.push(resposta)
    return true
  }))) return null
  if (value.situacao !== 'EM_ANDAMENTO' && (questoes.length || respostas.length)) return null
  return { id: value.id, avaliacao_id: value.avaliacao_id, situacao: value.situacao,
    falhas_camera: value.falhas_camera, tempo_restante_segundos: value.tempo_restante_segundos,
    questoes, respostas }
}

export async function listarProvasAluno(): Promise<ProvaAluno[]> {
  const data = await chamada('listar_provas_aluno')
  if (!Array.isArray(data)) throw new Error('Resposta inválida na lista de provas.')
  const result: ProvaAluno[] = []
  for (const item of data) {
    const prova = lerProva(item)
    if (!prova || result.some((other) => other.id === prova.id)) throw new Error('Resposta inválida na lista de provas.')
    result.push(prova)
  }
  return result
}

export async function publicarProva(avaliacaoId: string) {
  if (!id(avaliacaoId)) throw new Error('Avaliação inválida.')
  const result = await chamada('publicar_avaliacao', { p_avaliacao_id: avaliacaoId })
  if (!record(result) || result.id !== avaliacaoId || result.situacao !== 'PUBLICADA') {
    throw new Error('Não foi possível confirmar a publicação. Atualize os rascunhos antes de repetir.')
  }
}

export async function iniciarTentativa(avaliacaoId: string): Promise<TentativaProva> {
  if (!id(avaliacaoId)) throw new Error('Prova inválida.')
  const result = lerTentativa(await chamada('iniciar_tentativa', {
    p_avaliacao_id: avaliacaoId, p_aviso_versao: EXAM_NOTICE_VERSION,
  }))
  if (!result || result.avaliacao_id !== avaliacaoId) throw new Error('Não foi possível confirmar a tentativa.')
  return result
}

export async function carregarTentativa(tentativaId: string): Promise<TentativaProva> {
  if (!id(tentativaId)) throw new Error('Tentativa inválida.')
  const result = lerTentativa(await chamada('carregar_tentativa', { p_tentativa_id: tentativaId }))
  if (!result || result.id !== tentativaId) throw new Error('Não foi possível carregar a prova.')
  return result
}

export async function reportarFalhaCamera(tentativaId: string): Promise<TentativaProva> {
  if (!id(tentativaId)) throw new Error('Tentativa inválida.')
  const result = lerTentativa(await chamada('reportar_falha_camera', { p_tentativa_id: tentativaId }))
  if (!result || result.id !== tentativaId || result.situacao !== 'INTERROMPIDA') {
    throw new Error('Não foi possível confirmar a interrupção.')
  }
  return result
}

export async function interromperTentativa(tentativaId: string): Promise<TentativaProva> {
  if (!id(tentativaId)) throw new Error('Tentativa inválida.')
  const result = lerTentativa(await chamada('interromper_tentativa', { p_tentativa_id: tentativaId }))
  if (!result || result.id !== tentativaId || result.situacao !== 'INTERROMPIDA') {
    throw new Error('Não foi possível confirmar a saída da prova.')
  }
  return result
}

export async function salvarResposta(tentativaId: string, questao: QuestaoProva, resposta: string): Promise<RespostaProva> {
  if (!id(tentativaId) || !id(questao.id)) throw new Error('Questão inválida.')
  const alternativaId = questao.tipo === 'OBJETIVA' ? resposta : null
  const texto = questao.tipo === 'DISSERTATIVA' ? resposta.trim() : null
  if (questao.tipo === 'OBJETIVA' && !questao.alternativas.some((item) => item.id === alternativaId)) {
    throw new Error('Selecione uma alternativa.')
  }
  if (questao.tipo === 'DISSERTATIVA' && (!texto || [...texto].length > 10000)) {
    throw new Error('Digite uma resposta de até 10.000 caracteres.')
  }
  const result = lerResposta(await chamada('salvar_resposta_prova', {
    p_tentativa_id: tentativaId, p_questao_id: questao.id,
    p_alternativa_id: alternativaId, p_texto: texto,
  }))
  if (!result || result.questao_id !== questao.id || result.alternativa_id !== alternativaId || result.texto !== texto) {
    throw new Error('Não foi possível confirmar a resposta. Confira a prova antes de reenviar.')
  }
  return result
}

export async function finalizarTentativa(tentativaId: string): Promise<TentativaProva> {
  if (!id(tentativaId)) throw new Error('Tentativa inválida.')
  const result = lerTentativa(await chamada('finalizar_tentativa', { p_tentativa_id: tentativaId }))
  if (!result || result.id !== tentativaId || result.situacao !== 'FINALIZADA') {
    throw new Error('Não foi possível confirmar o envio. Confira a situação antes de repetir.')
  }
  return result
}
