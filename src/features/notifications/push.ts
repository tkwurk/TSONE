/**
 * Push notifications through Firebase Cloud Messaging, so kitchen requests
 * reach a device even when TSONE is closed.
 *
 * The device gets an FCM token (via our own service worker) and registers it
 * with the outlet backend (`push.subscribed`); the backend sends data-only
 * pushes and public/notification-sw.js shows them. The Firebase SDK is loaded
 * on demand, only on devices that turn notifications on.
 *
 * Config (public by design; not secrets): VITE_FIREBASE_CONFIG (JSON) and
 * VITE_FIREBASE_VAPID_KEY. Without them push is off and the app falls back to
 * notifications while it is open.
 */
import { api, type AuthContext } from '@/services/api'

const STORE_KEY = 'ts4.push'
/** Re-confirm the token with the backend at most this often (tokens can rotate). */
const REFRESH_MS = 24 * 60 * 60 * 1000

interface Stored {
  token: string
  username: string
  outlet: string
  lang: string
  at: number
}

function firebaseConfig(): Record<string, string> | null {
  try {
    const raw = import.meta.env.VITE_FIREBASE_CONFIG
    const cfg = raw ? (JSON.parse(raw) as Record<string, string>) : null
    return cfg?.apiKey && cfg.projectId && cfg.messagingSenderId && cfg.appId ? cfg : null
  } catch {
    return null
  }
}

export function pushConfigured(): boolean {
  return !!(firebaseConfig() && import.meta.env.VITE_FIREBASE_VAPID_KEY && 'serviceWorker' in navigator && 'PushManager' in window)
}

function readStored(): Stored | null {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') as Stored | null
  } catch {
    return null
  }
}

/** True when this device is registered for push for this user + outlet. */
export function pushActiveFor(username: string, outlet?: string): boolean {
  const s = readStored()
  return !!s && s.username === username && s.outlet === (outlet ?? '')
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  // In `npm run dev` there is no service worker; don't wait for one forever.
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return null
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 5000))])
}

async function messaging() {
  const cfg = firebaseConfig()
  if (!cfg) return null
  const [{ initializeApp, getApps }, fm] = await Promise.all([import('firebase/app'), import('firebase/messaging')])
  if (!(await fm.isSupported())) return null
  const app = getApps()[0] ?? initializeApp(cfg)
  return { m: fm.getMessaging(app), fm }
}

export type PushResult = 'on' | 'not-configured' | 'unsupported' | 'no-permission' | 'error'

/**
 * Register this device for push (after notification permission is granted).
 * Cheap to call on every app start: it only contacts the backend when the
 * token, user, outlet or language changed, or once a day.
 */
export async function enablePush(auth: AuthContext, outlet: string | undefined, lang: string, force = false): Promise<PushResult> {
  if (!pushConfigured()) return 'not-configured'
  if (Notification.permission !== 'granted') return 'no-permission'
  try {
    const reg = await swRegistration()
    if (!reg) return 'unsupported'
    const fb = await messaging()
    if (!fb) return 'unsupported'
    const token = await fb.fm.getToken(fb.m, { vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg })
    if (!token) return 'error'
    const prev = readStored()
    const same = prev && prev.token === token && prev.username === auth.username && prev.outlet === (outlet ?? '') && prev.lang === lang
    if (same && !force && Date.now() - prev.at < REFRESH_MS) return 'on'
    const r = await api.pushSubscribe({ token, lang, platform: navigator.userAgent.slice(0, 120) }, auth)
    if (!r.success) return 'error'
    const next: Stored = { token, username: auth.username, outlet: outlet ?? '', lang, at: Date.now() }
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
    return 'on'
  } catch {
    return 'error'
  }
}

/** Drop this device's FCM token so the next getToken() creates a fresh one. Never throws. */
async function forgetToken(): Promise<void> {
  localStorage.removeItem(STORE_KEY)
  try {
    const fb = await messaging()
    if (fb) await fb.fm.deleteToken(fb.m)
  } catch {
    /* already gone */
  }
}

/** Stop pushes to this device for the signed-in user (sign-out / turned off). Never throws. */
export async function disablePush(auth: AuthContext): Promise<void> {
  const s = readStored()
  try {
    if (s?.token) await api.pushUnsubscribe(s.token, auth)
  } catch {
    /* best effort */
  }
  // Turning off and on again must give a fresh registration, not the old one.
  await forgetToken()
}

/** Firebase no longer knows this device's token (or the backend switched it off). */
const DEAD_TOKEN = /\b404\b|NotRegistered|UNREGISTERED|not registered/i

/**
 * Asks the backend to push a test notification to this device after `delaySeconds`
 * (max 15). If the device's registration turns out to be dead, it is replaced with
 * a fresh one and the test is sent once more.
 */
export async function sendTestPush(
  auth: AuthContext,
  outlet: string | undefined,
  lang: string,
  delaySeconds: number,
): Promise<{ ok: boolean; error?: string; renewed?: boolean }> {
  const send = async () => {
    const s = readStored()
    if (!s?.token) return { ok: false, error: 'not-registered' }
    const r = await api.pushTest({ token: s.token, delaySeconds }, auth)
    // The orchestrator prefixes worker errors; show only the worker's own message.
    return r.success ? { ok: true } : { ok: false, error: String(r.error ?? '').replace(/^Pipeline failed at step "[^"]+": /, '') }
  }
  const first = await send()
  if (first.ok || !DEAD_TOKEN.test(first.error ?? '')) return first
  await forgetToken()
  const again = await enablePush(auth, outlet, lang, true)
  if (again !== 'on') return { ok: false, error: first.error }
  return { ...(await send()), renewed: true }
}
