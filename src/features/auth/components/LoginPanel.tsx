import { useState, type FormEvent } from 'react'
import { getSelectedOutlet, outlets } from '@/services/api'
import { Button, Notice, Panel } from '@/components/ui'
import { useI18n } from '@/i18n'

/** Operator sign-in form: pick the outlet (its own Sheet + Apps Script), then sign in. */
export function LoginPanel({
  onLogin,
  loading,
  error,
}: {
  onLogin: (username: string, password: string, outletName: string) => void
  loading: boolean
  error: string | null
}) {
  const { t } = useI18n()
  const configured = outlets.length > 0
  const [outletName, setOutletName] = useState(() => getSelectedOutlet()?.name ?? '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onLogin(username, password, outletName)
  }

  return (
    <Panel title={t('login.title')}>
      {!configured && <Notice tone="warn">{t('login.setup')}</Notice>}
      <form onSubmit={submit}>
        {outlets.length > 1 && (
          <label className="ui-field">
            {t('login.outlet')}
            <select value={outletName} onChange={(e) => setOutletName(e.target.value)}>
              <option value="" disabled>
                {t('login.chooseOutlet')}
              </option>
              {outlets.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="ui-field">
          {t('login.username')}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label className="ui-field">
          {t('login.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <div className="actions">
          <Button type="submit" disabled={!configured || !outletName || loading || !username || !password}>
            {loading ? t('login.signingIn') : t('login.signIn')}
          </Button>
        </div>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </Panel>
  )
}
