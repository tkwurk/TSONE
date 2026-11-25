import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AuthContext } from '@/services/api'
import { useI18n } from '@/i18n'
import { fmtTimeOnly } from '@/lib/dates'
import { getCookRequests, type CookRequest } from '@/features/kitchen/api'
import { requestUrl, type RequestLink } from './deepLink'
import { KitchenFeedContext, alertKey, isReminder, type KitchenRequestFeed, type PushStatus } from './feedContext'
import { disablePush, enablePush, pushActiveFor } from './push'
import { canShowSystemNotifications, closeSystemNotifications, NOTIFY_TAG_PREFIX, setAppBadge, showSystemNotification } from './systemNotify'

const POLL_MS = 60_000
/** Coming back to the app refreshes at once unless the last load is this recent. */
const REFRESH_ON_SHOW_MS = 15_000
/** More new requests than this at once become one summary notification. */
const SUMMARY_OVER = 3

type IdMap = Record<string, string>
interface Stored {
  read: IdMap
  notified: IdMap
}

/**
 * Polls the outlet's open kitchen requests once for the whole app (bell,
 * toast, system notifications and the Kitchen tab all read this feed).
 * Read/notified state is kept per outlet + user on this device.
 */
export function KitchenRequestsProvider({
  auth: authProp,
  backendOutlet,
  enabled,
  onOpenRequest,
  children,
}: {
  auth: AuthContext
  backendOutlet?: string
  enabled: boolean
  onOpenRequest: (link: RequestLink) => void
  children: ReactNode
}) {
  const { t, fmtNum, lang } = useI18n()
  // The shell passes a new object each render; keep one per signed-in identity.
  const { username, deviceId, outlet } = authProp
  const auth = useMemo<AuthContext>(() => ({ username, deviceId, outlet }), [username, deviceId, outlet])
  const storeKey = `ts4.notify.${backendOutlet ?? ''}.${auth.username}`
  const [open, setOpen] = useState<CookRequest[]>([])
  const [recentDone, setRecentDone] = useState<CookRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadedAt, setLoadedAt] = useState(0)
  const [stored, setStored] = useState<Stored>(() => readStored(storeKey))
  const [arrival, setArrival] = useState<KitchenRequestFeed['arrival']>(null)
  const [push, setPushState] = useState<PushStatus>('checking')

  const inFlight = useRef(false)
  const firstLoad = useRef(true)
  const storedRef = useRef(stored)
  const openRef = useRef(onOpenRequest)
  const loadedAtRef = useRef(0)
  useEffect(() => {
    openRef.current = onOpenRequest
    loadedAtRef.current = loadedAt
  })

  const save = useCallback(
    (next: Stored) => {
      storedRef.current = next
      setStored(next)
      try {
        localStorage.setItem(storeKey, JSON.stringify(next))
      } catch {
        /* storage full / private mode */
      }
    },
    [storeKey],
  )

  const mine = useCallback((r: CookRequest) => String(r.requestedBy ?? '').toLowerCase() === auth.username.toLowerCase(), [auth.username])

  const describe = useCallback(
    (r: CookRequest) => {
      const name = r.productName || r.productCode || '?'
      const title = isReminder(r) ? `⏰ ${t('notify.reminderTitle')}: ${name}` : `🍳 ${t('notify.newTitle')}: ${name}`
      const parts = [
        r.remaining != null ? `${t('kitchen.remaining')} ${fmtNum(r.remaining)}` : '',
        r.requestedQty ? `${t('notify.qty')} ${fmtNum(r.requestedQty)}` : '',
        r.requestedBy ? `${t('notify.by')} ${r.requestedBy}` : '',
        r.createdAt ? fmtTimeOnly(r.createdAt) : '',
      ].filter(Boolean)
      return { title, body: parts.join(' · ') }
    },
    [t, fmtNum],
  )

  const reload = useCallback(async () => {
    if (!enabled || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    const r = await getCookRequests(auth)
    inFlight.current = false
    setLoading(false)
    if (!r.ok) {
      setError(r.error ?? '')
      return
    }
    setError('')
    const list = r.data?.open ?? []
    setOpen(list)
    setRecentDone(r.data?.recentDone ?? [])
    setLoadedAt(Date.now())

    // Which alerts are new for this device (never alert on your own requests)?
    const prev = storedRef.current
    const openIds = new Set(list.map((x) => x.requestId))
    const notified: IdMap = {}
    const read: IdMap = {}
    for (const [id, key] of Object.entries(prev.notified)) if (openIds.has(id)) notified[id] = key
    for (const [id, key] of Object.entries(prev.read)) if (openIds.has(id)) read[id] = key
    const fresh = list.filter((x) => !mine(x) && notified[x.requestId] !== alertKey(x))
    for (const x of fresh) notified[x.requestId] = alertKey(x)
    save({ read, notified })

    const first = firstLoad.current
    firstLoad.current = false
    // Existing requests on app open only update the badge/bell — no burst of alerts.
    if (fresh.length && !first) {
      // With push on, the service worker shows background alerts; don't show them twice.
      if (document.hidden && !pushActiveFor(auth.username, backendOutlet)) {
        const outlet = backendOutlet
        if (fresh.length > SUMMARY_OVER) {
          await showSystemNotification({
            tag: `${NOTIFY_TAG_PREFIX}summary`,
            title: `🍳 ${fresh.length} ${t('notify.manyTitle')}`,
            body: fresh.map((x) => x.productName || x.productCode).join(', '),
            url: requestUrl({ requestId: fresh[0].requestId, outlet }),
            renotify: true,
            data: { requestId: fresh[0].requestId, outlet },
          })
        } else {
          for (const x of fresh) {
            const { title, body } = describe(x)
            await showSystemNotification(
              {
                tag: NOTIFY_TAG_PREFIX + x.requestId,
                title,
                body,
                url: requestUrl({ requestId: x.requestId, outlet }),
                renotify: isReminder(x),
                timestamp: Date.parse(x.lastNotifiedAt || x.createdAt || '') || undefined,
                data: { requestId: x.requestId, outlet },
              },
              () => openRef.current({ requestId: x.requestId, outlet }),
            )
          }
        }
      } else if (!document.hidden) {
        setArrival((a) => ({ request: fresh[0], count: fresh.length, seq: (a?.seq ?? 0) + 1 }))
      }
    }
    // Handled requests: take their notifications away.
    await closeSystemNotifications(new Set([...openIds].map((id) => NOTIFY_TAG_PREFIX + id)))
  }, [enabled, auth, mine, save, describe, backendOutlet, t])

  // Poll; refresh at once when the app comes back on screen or back online.
  useEffect(() => {
    if (!enabled) return
    reload()
    const id = window.setInterval(reload, POLL_MS)
    const onShow = () => {
      if (!document.hidden && Date.now() - loadedAtRef.current > REFRESH_ON_SHOW_MS) reload()
    }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('online', onShow)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('online', onShow)
    }
  }, [enabled, reload])

  // Push: refresh this device's token on start (cheap; backend only on change / daily).
  useEffect(() => {
    if (!enabled) return
    let live = true
    if (!canShowSystemNotifications()) {
      setPushState('off')
      return
    }
    enablePush(auth, backendOutlet, lang).then((r) => live && setPushState(r))
    return () => {
      live = false
    }
  }, [enabled, auth, backendOutlet, lang])

  const setPush = useCallback(
    async (on: boolean) => {
      if (!on) {
        await disablePush(auth)
        setPushState('off')
        return
      }
      setPushState('checking')
      setPushState(await enablePush(auth, backendOutlet, lang, true))
    },
    [auth, backendOutlet, lang],
  )

  // A push arrived while the app is open: refresh now instead of waiting for the next poll.
  useEffect(() => {
    if (!enabled || !('serviceWorker' in navigator)) return
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'tsone:kitchen-push') {
        loadedAtRef.current = 0
        reload()
      }
    }
    navigator.serviceWorker.addEventListener('message', onMsg)
    return () => navigator.serviceWorker.removeEventListener('message', onMsg)
  }, [enabled, reload])

  const isUnread = useCallback(
    (r: CookRequest) => !mine(r) && stored.read[r.requestId] !== alertKey(r),
    [stored, mine],
  )
  const unreadCount = useMemo(() => open.filter(isUnread).length, [open, isUnread])

  useEffect(() => {
    setAppBadge(enabled ? unreadCount : 0)
  }, [enabled, unreadCount])

  const markRead = useCallback(
    (ids?: string[]) => {
      const want = new Set(ids ?? open.map((r) => r.requestId))
      const read = { ...storedRef.current.read }
      for (const r of open) if (want.has(r.requestId)) read[r.requestId] = alertKey(r)
      save({ ...storedRef.current, read })
    },
    [open, save],
  )

  const value = useMemo<KitchenRequestFeed>(
    () => ({
      enabled,
      open,
      recentDone,
      loading,
      error,
      loadedAt,
      reload,
      isUnread,
      unreadCount,
      markRead,
      arrival,
      dismissArrival: () => setArrival(null),
      push,
      setPush,
    }),
    [enabled, open, recentDone, loading, error, loadedAt, reload, isUnread, unreadCount, markRead, arrival, push, setPush],
  )

  return <KitchenFeedContext.Provider value={value}>{children}</KitchenFeedContext.Provider>
}

function readStored(key: string): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}') as Partial<Stored>
    return { read: v.read ?? {}, notified: v.notified ?? {} }
  } catch {
    return { read: {}, notified: {} }
  }
}
