/**
 * Operating-system notifications (phone / desktop) and the app-icon badge.
 *
 * Best practices followed:
 * - Permission is only requested from a user gesture (the bell's "Turn on"
 *   button), never on page load.
 * - Notifications are shown through the service worker registration when there
 *   is one (required on Android), else with `new Notification` (desktop dev).
 * - Each request uses its own `tag`, so a reminder replaces the old notification
 *   instead of stacking; `renotify` only re-alerts for reminders.
 * - Notifications for requests that were handled are closed.
 * - There is an in-app off switch per device (permission can't be revoked by code).
 */

const MUTED_KEY = 'ts4.notify.muted'
export const NOTIFY_TAG_PREFIX = 'kitchen-request:'

export type NotifyPermission = NotificationPermission | 'unsupported'

export function notifySupport(): { supported: boolean; needsInstall: boolean } {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  // iOS/iPadOS only allows web notifications for apps added to the Home Screen.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  return { supported, needsInstall: ios && !standalone }
}

export function notifyPermission(): NotifyPermission {
  return notifySupport().supported ? Notification.permission : 'unsupported'
}

export function isMuted(): boolean {
  return localStorage.getItem(MUTED_KEY) === '1'
}

export function setMuted(muted: boolean): void {
  if (muted) localStorage.setItem(MUTED_KEY, '1')
  else localStorage.removeItem(MUTED_KEY)
}

/** Ask for permission. Call only from a click/tap handler. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!notifySupport().supported) return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    if (result === 'granted') setMuted(false)
    return result
  } catch {
    return Notification.permission
  }
}

export function canShowSystemNotifications(): boolean {
  return notifyPermission() === 'granted' && !isMuted()
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null
  } catch {
    return null
  }
}

export interface SystemNotice {
  tag: string
  title: string
  body: string
  /** In-app URL opened when the notification is tapped. */
  url: string
  /** Re-alert (sound/vibrate) even though a notification with this tag exists. */
  renotify?: boolean
  timestamp?: number
  data?: Record<string, unknown>
}

/** Shows a notification; `onClickFallback` handles taps when there is no service worker. */
export async function showSystemNotification(n: SystemNotice, onClickFallback?: () => void): Promise<void> {
  if (!canShowSystemNotifications()) return
  const icon = `${import.meta.env.BASE_URL}pwa-192x192.png`
  const options: NotificationOptions & { renotify?: boolean; timestamp?: number } = {
    tag: n.tag,
    body: n.body,
    icon,
    badge: icon,
    lang: document.documentElement.lang || undefined,
    renotify: !!n.renotify,
    timestamp: n.timestamp,
    data: { ...n.data, url: n.url },
  }
  const reg = await registration()
  try {
    if (reg) {
      await reg.showNotification(n.title, options)
      return
    }
    const note = new Notification(n.title, options)
    note.onclick = () => {
      window.focus()
      note.close()
      onClickFallback?.()
    }
  } catch {
    // Some browsers throw for `new Notification` (e.g. Android without a SW); the in-app bell still works.
  }
}

/** Closes notifications whose tag is no longer wanted (handled requests). */
export async function closeSystemNotifications(keepTags: Set<string>): Promise<void> {
  const reg = await registration()
  if (!reg?.getNotifications) return
  try {
    const list = await reg.getNotifications()
    for (const n of list) if (n.tag.startsWith(NOTIFY_TAG_PREFIX) && !keepTags.has(n.tag)) n.close()
  } catch {
    /* ignore */
  }
}

/** App-icon badge (installed PWA; ignored where unsupported). */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
  try {
    if (count > 0) nav.setAppBadge?.(count)?.catch(() => {})
    else nav.clearAppBadge?.()?.catch(() => {})
  } catch {
    /* ignore */
  }
}
