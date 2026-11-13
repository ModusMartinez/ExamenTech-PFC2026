import { vi } from 'vitest'

export function instalarTelaCheia() {
  let elemento: Element | null = null
  function alterar(proximo: Element | null) {
    elemento = proximo
    document.dispatchEvent(new Event('fullscreenchange'))
  }
  const solicitar = vi.fn(async () => alterar(document.documentElement))
  const sair = vi.fn(async () => alterar(null))
  Object.defineProperties(document, {
    fullscreenEnabled: { configurable: true, value: true },
    fullscreenElement: { configurable: true, get: () => elemento },
    exitFullscreen: { configurable: true, value: sair },
  })
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: solicitar })
  function restaurar() {
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen')
    for (const campo of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) Reflect.deleteProperty(document, campo)
  }
  return { solicitar, sair, restaurar }
}
