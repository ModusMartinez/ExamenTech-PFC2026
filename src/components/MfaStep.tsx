import { useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type TotpSetup = {
  id: string
  qrCode: string
  secret: string
}

type MfaStepProps = {
  mode: 'setup' | 'verify'
  factorId?: string
  onComplete: () => Promise<void>
  onCancel: () => Promise<void>
}

export function MfaStep({ mode, factorId, onComplete, onCancel }: MfaStepProps) {
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function generateQrCode() {
    if (loading || setup) return

    setLoading(true)
    setError('')

    try {
      const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors()

      if (factorsError || !factors) {
        throw new Error('Não foi possível consultar os fatores de autenticação.')
      }

      // Uma tentativa interrompida deixa um fator não confirmado. O Supabase
      // não permite cadastrar outro com o mesmo nome até remover esse fator.
      const unfinishedSetup = factors.all.find(
        (factor) =>
          factor.factor_type === 'totp' &&
          factor.status === 'unverified' &&
          factor.friendly_name === 'ExamenTech',
      )

      if (unfinishedSetup) {
        const { error: removeError } = await supabase.auth.mfa.unenroll({
          factorId: unfinishedSetup.id,
        })

        if (removeError) {
          throw new Error('Não foi possível reiniciar a configuração anterior.')
        }
      }

      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'ExamenTech',
      })

      if (enrollError || !data || data.type !== 'totp') {
        throw new Error('Não foi possível configurar o aplicativo autenticador.')
      }

      setSetup({
        id: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      })
    } catch {
      setError('Não foi possível gerar o código QR. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault()

    if (loading) return

    const selectedFactor = mode === 'setup' ? setup?.id : factorId

    if (!selectedFactor || !/^\d{6}$/.test(code.trim())) {
      setError('Digite o código de 6 números do aplicativo autenticador.')
      return
    }

    setLoading(true)
    setError('')

    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: selectedFactor,
        code: code.trim(),
      })

      if (verifyError) {
        setError('Código inválido ou expirado. Confira o aplicativo e tente novamente.')
        return
      }

      await onComplete()
    } catch {
      setError('Não foi possível confirmar o código. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }

  async function cancelAccess() {
    setLoading(true)
    setError('')

    try {
      await onCancel()
    } catch {
      setError('Não foi possível sair da conta. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <header className="form-header">
        <p className="overline">VERIFICAÇÃO EM DUAS ETAPAS</p>
        <h2>{mode === 'setup' ? 'Proteja sua conta' : 'Confirme seu acesso'}</h2>
        <p className="subtitle">
          {mode === 'setup'
            ? 'Configure um aplicativo autenticador para continuar.'
            : 'Informe o código exibido no seu aplicativo autenticador.'}
        </p>
      </header>

      {mode === 'setup' && !setup && (
        <>
          <p className="security-note">
            Se você interrompeu uma configuração anterior, um novo código substituirá a tentativa incompleta.
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={loading}
            onClick={() => void generateQrCode()}
          >
            {loading ? 'Preparando...' : 'Gerar código QR'}
          </button>
        </>
      )}

      {mode === 'setup' && setup && (
        <div className="mfa-setup">
          <p>Escaneie este código no aplicativo autenticador:</p>
          <img
            className="mfa-qr"
            src={setup.qrCode}
            alt="Código QR para configurar a autenticação em duas etapas"
          />
          <p>Se não puder escanear, digite esta chave no aplicativo:</p>
          <code className="mfa-secret">{setup.secret}</code>
          <p className="security-note">Não compartilhe essa chave com ninguém.</p>
        </div>
      )}

      {(mode === 'verify' || setup) && (
        <form noValidate onSubmit={verifyCode}>
          <div className="input-group">
            <label htmlFor="mfa-code">Código de 6 números</label>
            <input
              id="mfa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              disabled={loading}
            />
          </div>

          {error && <div className="alert error" role="alert">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Confirmando...' : 'Confirmar código'}
          </button>
        </form>
      )}

      {error && mode === 'setup' && !setup && (
        <div className="alert error" role="alert">{error}</div>
      )}

      <button
        type="button"
        className="btn-back mfa-cancel"
        disabled={loading}
        onClick={() => void cancelAccess()}
      >
        Sair da conta
      </button>
    </>
  )
}
