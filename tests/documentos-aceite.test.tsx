import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.resetModules() })

test.each([
  ['true', 'false', '2026-11-18-v13', '2026-11-18-v10'],
  ['false', 'true', '2026-11-18-v13', '2026-11-18-v10'],
  ['true', 'true', '2026-11-18-v13', '2026-11-18-v10'],
  ['false', 'false', '2026-11-18-v14', '2026-11-18-v11'],
])('textos e versões correspondem ao ambiente com fotos=%s e gestão=%s', async (fotos, gestao, termos, privacidade) => {
  vi.stubEnv('VITE_EXAM_PHOTOS_ENABLED', fotos)
  vi.stubEnv('VITE_EXAM_MANAGEMENT_ENABLED', gestao)
  const { LegalPage } = await import('../src/components/LegalPage')
  const { TERMS_VERSION, PRIVACY_VERSION } = await import('../src/content/legalDocuments')
  expect(TERMS_VERSION).toBe(termos)
  expect(PRIVACY_VERSION).toBe(privacidade)
  const { unmount } = render(<LegalPage documentType="privacidade" />)
  expect(screen.getByText(`Versão ${privacidade}`)).toBeTruthy()
  expect(screen.getByText(/As questões objetivas são corrigidas automaticamente/)).toBeTruthy()
  expect(screen.getByRole('article').textContent).toContain('O professor corrige as respostas dissertativas.')
  expect(screen.getByRole('article').textContent).toContain('publicação manual pelo professor')
  expect(screen.getByRole('article').textContent).not.toContain('notas automáticas ou reconhecimento facial')
  expect(screen.getByRole('article').textContent).not.toContain('notas e identificação por imagem ainda não são coletados ou calculados')
  unmount()
  render(<LegalPage documentType="termos" />)
  expect(screen.getByText(`Versão ${termos}`)).toBeTruthy()
  if (fotos === 'true' || gestao === 'true') {
    expect(screen.getByText(/o cronômetro começa e as questões são liberadas somente após o servidor confirmar o recebimento da foto inicial/)).toBeTruthy()
    expect(screen.getByRole('article').textContent).toContain('O horário final definido pelo professor continua valendo')
    expect(screen.getByRole('article').textContent).not.toContain('O prazo continua correndo.')
  }
})
