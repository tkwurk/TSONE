/* Imported by the generated service worker (vite.config.ts → workbox.importScripts).
 *
 * push: test pushes (always shown) and kitchen-request pushes from Firebase Cloud Messaging (data-only; see
 * apps-script-source/notificationWorker.gs). If a TSONE window is on screen it
 * gets a message to refresh (it shows its own in-app alert); otherwise a system
 * notification is shown. One tag per request, so a reminder replaces it.
 *
 * notificationclick: focus an open TSONE window and tell it which request to
 * show; if none is open, open the deep link. */

const KITCHEN_PUSH = 'tsone:kitchen-push'
const OPEN_REQUEST = 'tsone:open-kitchen-request'
// Browsers can't play a custom sound; not silent = the phone's notification sound.
const ALERT = { silent: false, vibrate: [250, 120, 250, 120, 500] }

function appWindows() {
  const scope = self.registration.scope
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => list.filter((c) => c.url.startsWith(scope)))
}

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  // FCM wraps data-only messages as { data: {...}, from, fcmMessageId, … }.
  const d = payload.data || payload
  const scope = self.registration.scope
  // Test push from the bell: always shown, even with TSONE on screen.
  if (d.type === 'test') {
    event.waitUntil(
      self.registration.showNotification(d.title || 'TSONE', {
        body: d.body || '',
        ...ALERT,
        tag: 'tsone-test',
        renotify: true,
        icon: scope + 'pwa-192x192.png',
        badge: scope + 'pwa-192x192.png',
        timestamp: Date.now(),
        data: { url: scope },
      }),
    )
    return
  }
  if (d.type !== 'kitchen-request') return
  event.waitUntil(
    (async () => {
      const windows = await appWindows()
      const visible = windows.filter((c) => c.visibilityState === 'visible')
      if (visible.length) {
        visible.forEach((c) => c.postMessage({ type: KITCHEN_PUSH, requestId: d.requestId }))
        return
      }
      const url = new URL(scope)
      if (d.requestId) url.searchParams.set('kitchenRequest', d.requestId)
      await self.registration.showNotification(d.title || 'TSONE', {
        body: d.body || '',
        ...ALERT,
        // Kitchen alerts stay until someone looks at them (desktop; phones keep them anyway).
        requireInteraction: true,
        tag: d.tag || 'kitchen-request:' + (d.requestId || ''),
        renotify: d.renotify === '1',
        icon: scope + 'pwa-192x192.png',
        badge: scope + 'pwa-192x192.png',
        timestamp: Date.now(),
        data: { requestId: d.requestId, url: url.href },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const scope = self.registration.scope
  const target = new URL(data.url || scope, scope).href
  event.waitUntil(
    (async () => {
      const windows = await appWindows()
      const app = windows[0]
      if (app) {
        await app.focus()
        app.postMessage({ type: OPEN_REQUEST, requestId: data.requestId, outlet: data.outlet })
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})
