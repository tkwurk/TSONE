import { useCallback, useState } from 'react'
import type { Session } from '../types'
import { loginRequest, logoutRequest } from '../api'
import { getSelectedOutlet, selectOutlet } from '@/services/api'

const SESSION_KEY = 'ts4.session'
const DEVICE_KEY = 'ts4.deviceId'

/** A stable per-device id, persisted so the backend keeps one session per device. */
function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    // A session belongs to one outlet's backend: drop it if that outlet isn't the one selected.
    return s.backendOutlet && s.backendOutlet === getSelectedOutlet()?.name ? s : null
  } catch {
    return null
  }
}

/** Operator authentication state, persisted to localStorage. */
export function useAuth() {
  const [session, setSession] = useState<Session | null>(loadSession)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const login = useCallback(async (username: string, password: string, outletName?: string) => {
    if (outletName) selectOutlet(outletName)
    const backendOutlet = getSelectedOutlet()?.name
    if (!backendOutlet) {
      setError('Choose an outlet first.')
      return false
    }
    setLoading(true)
    setError(null)
    const res = await loginRequest(username, password, getDeviceId())
    setLoading(false)
    if (res.success && res.data) {
      const s: Session = { ...res.data, backendOutlet }
      localStorage.setItem(DEVICE_KEY, s.deviceId) // backend may canonicalize the id
      localStorage.setItem(SESSION_KEY, JSON.stringify(s))
      setSession(s)
      return true
    }
    setError(res.error ?? 'Login failed')
    return false
  }, [])

  const logout = useCallback(async () => {
    if (session) {
      await logoutRequest({ username: session.username, deviceId: session.deviceId, outlet: session.outlet })
    }
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
  }, [session])

  return { session, loading, error, login, logout }
}
