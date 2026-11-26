/**
 * Standard response envelope returned by the Apps Script API (apiOk / apiFail).
 * Mirrors the backend `apiOk(data, code)` / `apiFail(error, code)` shape.
 */
export interface ApiEnvelope<T = unknown> {
  success: boolean
  data: T | null
  error: string | null
  code: string
  /** apiOk copies the data object's own keys onto the envelope for legacy callers. */
  [key: string]: unknown
}

/** App-level caller identity sent with every request (not Google OAuth). */
export interface AuthContext {
  username: string
  outlet?: string
  deviceId?: string
  [key: string]: unknown
}

/** Event types routed by the backend Orchestrator. */
export type ApiEventType =
  | 'checkout.completed'
  | 'purchase.recorded'
  | 'purchase.history.requested'
  | 'stock.updated'
  | 'stock.report.requested'
  | 'stock.history.status.requested'
  | 'stock.history.schedule.requested'
  | 'consumption.closing.requested'
  | 'consumption.recorded'
  | 'consumption.history.requested'
  | 'report.requested'
  | 'catalog.requested'
  | 'shift.report.requested'
  | 'shift.report.submitted'
  | 'shift.history.requested'
  | 'push.subscribed'
  | 'push.unsubscribed'
  | 'push.test.requested'
  | 'cooking.audit.requested'
  | 'cash.daily.requested'
  | 'auth.login'
  | 'auth.logout'
  | 'rpc'
  | 'health'

export type ApiPayload = Record<string, unknown>
