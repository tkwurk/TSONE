/**
 * Deep links into a kitchen request: `?kitchenRequest=<id>&outlet=<backend outlet>`.
 * Used as the notification URL; the service worker either focuses an open app
 * window and posts OPEN_MESSAGE, or opens this URL in a new window.
 */
export const REQUEST_PARAM = 'kitchenRequest'
export const OUTLET_PARAM = 'outlet'
export const OPEN_MESSAGE = 'tsone:open-kitchen-request'

export interface RequestLink {
  requestId: string
  outlet?: string
}

export function requestUrl(link: RequestLink): string {
  const url = new URL(import.meta.env.BASE_URL, window.location.origin)
  url.searchParams.set(REQUEST_PARAM, link.requestId)
  if (link.outlet) url.searchParams.set(OUTLET_PARAM, link.outlet)
  return url.href
}

/** Reads a deep link from the current URL and removes it, so a reload doesn't reopen it. */
export function takeDeepLink(): RequestLink | null {
  const url = new URL(window.location.href)
  const requestId = url.searchParams.get(REQUEST_PARAM)
  if (!requestId) return null
  const outlet = url.searchParams.get(OUTLET_PARAM) ?? undefined
  url.searchParams.delete(REQUEST_PARAM)
  url.searchParams.delete(OUTLET_PARAM)
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  return { requestId, outlet }
}

/** Listens for notification taps relayed by the service worker to an open window. */
export function onNotificationOpen(cb: (link: RequestLink) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {}
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; requestId?: string; outlet?: string } | null
    if (d?.type === OPEN_MESSAGE && d.requestId) cb({ requestId: d.requestId, outlet: d.outlet })
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}
