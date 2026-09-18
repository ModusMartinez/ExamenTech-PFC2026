import { useEffect, useRef, useState } from 'react'

const SCRIPT_ID = 'cloudflare-turnstile-script'
const SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

type TurnstileOptions = {
  sitekey: string
  action: string
  theme: 'light'
  language: 'pt-br'
  appearance: 'always'
  retry: 'auto'
  'refresh-expired': 'auto'
  callback: (token: string) => void
  'expired-callback': () => void
  'error-callback': (errorCode: string) => boolean
}

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

type TurnstileWidgetProps = {
  siteKey: string
  resetSignal: number
  onVerify: (token: string) => void
  onExpire: () => void
  onError: (message: string) => void
}

let scriptPromise: Promise<TurnstileApi> | null = null

function loadTurnstileScript() {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile)
  }

  if (scriptPromise) {
    return scriptPromise
  }

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existingScript = document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null

    const handleLoad = () => {
      if (window.turnstile) {
        resolve(window.turnstile)
        return
      }

      scriptPromise = null
      reject(new Error('API do Turnstile não foi disponibilizada.'))
    }

    const handleError = () => {
      scriptPromise = null
      reject(new Error('Não foi possível carregar o Cloudflare Turnstile.'))
    }

    if (existingScript) {
      existingScript.addEventListener('load', handleLoad, { once: true })
      existingScript.addEventListener('error', handleError, { once: true })
      return
    }

    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = SCRIPT_URL
    script.async = true
    script.defer = true
    script.addEventListener('load', handleLoad, { once: true })
    script.addEventListener('error', handleError, { once: true })
    document.head.appendChild(script)
  })

  return scriptPromise
}

export function TurnstileWidget({
  siteKey,
  resetSignal,
  onVerify,
  onExpire,
  onError,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const onVerifyRef = useRef(onVerify)
  const onExpireRef = useRef(onExpire)
  const onErrorRef = useRef(onError)
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'verified' | 'error'
  >('loading')

  useEffect(() => {
    onVerifyRef.current = onVerify
    onExpireRef.current = onExpire
    onErrorRef.current = onError
  }, [onVerify, onExpire, onError])

  useEffect(() => {
    let active = true

    async function renderWidget() {
      if (!siteKey) {
        setStatus('error')
        onErrorRef.current(
          'A chave pública do Turnstile não foi configurada.',
        )
        return
      }

      try {
        const turnstile = await loadTurnstileScript()

        if (!active || !containerRef.current) {
          return
        }

        setStatus('ready')

        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: 'login',
          theme: 'light',
          language: 'pt-br',
          appearance: 'always',
          retry: 'auto',
          'refresh-expired': 'auto',
          callback: (token) => {
            if (!active) return
            setStatus('verified')
            onVerifyRef.current(token)
          },
          'expired-callback': () => {
            if (!active) return
            setStatus('ready')
            onExpireRef.current()
          },
          'error-callback': () => {
            if (!active) return true
            setStatus('error')
            onErrorRef.current(
              'A verificação de segurança falhou. Atualize e tente novamente.',
            )
            return true
          },
        })
      } catch {
        if (!active) return
        setStatus('error')
        onErrorRef.current(
          'Não foi possível carregar a verificação de segurança.',
        )
      }
    }

    void renderWidget()

    return () => {
      active = false

      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
  }, [siteKey])

  useEffect(() => {
    if (!resetSignal || !widgetIdRef.current || !window.turnstile) {
      return
    }

    window.turnstile.reset(widgetIdRef.current)
    setStatus('ready')
  }, [resetSignal])

  return (
    <div className="sgpa-turnstile-block">
      <div ref={containerRef} className="sgpa-turnstile-widget" />

      <p
        className={`sgpa-turnstile-status sgpa-turnstile-status-${status}`}
        aria-live="polite"
      >
        {status === 'loading' && 'Carregando verificação de segurança...'}
        {status === 'ready' && 'Conclua a verificação para habilitar o acesso.'}
        {status === 'verified' && 'Verificação concluída. Você pode continuar.'}
        {status === 'error' && 'Verificação indisponível no momento.'}
      </p>
    </div>
  )
}
