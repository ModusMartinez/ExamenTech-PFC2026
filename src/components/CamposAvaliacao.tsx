import type { CamposAvaliacaoRascunho } from '../services/avaliacaoValidation'
import { dataISOParaLocal } from '../services/avaliacaoForm'
import type { ErroFormularioAvaliacao } from '../services/avaliacaoForm'

export function CamposAvaliacao({ prefixo, erro, valores }: {
  prefixo: string; erro: ErroFormularioAvaliacao; valores?: CamposAvaliacaoRascunho
}) {
  function erroDoCampo(name: string) {
    return {
      'aria-invalid': erro.campo === name,
      'aria-describedby': erro.campo === name ? `${prefixo}-form-error` : undefined,
    }
  }
  return <>
    <label htmlFor={`${prefixo}-titulo`}>Título</label>
    <input id={`${prefixo}-titulo`} name="titulo" defaultValue={valores?.titulo} required {...erroDoCampo('titulo')} />
    <label htmlFor={`${prefixo}-tipo`}>Tipo</label>
    <select id={`${prefixo}-tipo`} name="tipo" defaultValue={valores?.tipo ?? 'PROVA'} required {...erroDoCampo('tipo')}>
      <option value="PROVA">Prova</option>
      <option value="ATIVIDADE">Atividade</option>
    </select>
    <p className="turmas-note" id={`${prefixo}-fuso`}>Horários no fuso do navegador: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
    <label htmlFor={`${prefixo}-inicio`}>Início</label>
    <input id={`${prefixo}-inicio`} name="inicio_em" type="datetime-local" required
      defaultValue={valores && dataISOParaLocal(valores.inicio_em)} {...erroDoCampo('inicio_em')}
      aria-describedby={`${prefixo}-fuso${erro.campo === 'inicio_em' ? ` ${prefixo}-form-error` : ''}`} />
    <label htmlFor={`${prefixo}-fim`}>Fim</label>
    <input id={`${prefixo}-fim`} name="fim_em" type="datetime-local" required
      defaultValue={valores && dataISOParaLocal(valores.fim_em)} {...erroDoCampo('fim_em')}
      aria-describedby={`${prefixo}-fuso${erro.campo === 'fim_em' ? ` ${prefixo}-form-error` : ''}`} />
    <label htmlFor={`${prefixo}-duracao`}>Duração (minutos)</label>
    <input id={`${prefixo}-duracao`} name="duracao_minutos" type="number" min={1} max={2147483647} step={1}
      defaultValue={valores?.duracao_minutos} required {...erroDoCampo('duracao_minutos')} />
  </>
}
