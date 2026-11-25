/**
 * apiClient — the single client entry point to the Apps Script backend (Seam 1).
 *
 * All backend calls go through `callApi(eventType, payload, auth)`. The request
 * is POSTed as `text/plain` so the browser treats it as a "simple request" and
 * skips the CORS preflight that Apps Script Web Apps cannot answer. The backend
 * (`apiRouter.gs`) parses the JSON body regardless of content type.
 *
 * Returns the standard envelope; network/timeout errors are normalized into an
 * `apiFail`-shaped envelope so callers only deal with one shape.
 */
import { apiConfig, assertApiConfig } from './config'
import type { ApiEnvelope, ApiEventType, ApiPayload, AuthContext } from './types'

export async function callApi<T = unknown>(
  eventType: ApiEventType,
  payload: ApiPayload = {},
  auth?: AuthContext,
): Promise<ApiEnvelope<T>> {
  assertApiConfig()

  const body = {
    eventType,
    payload: auth ? { ...payload, _authContext: auth } : payload,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), apiConfig.timeoutMs)

  try {
    const res = await fetch(apiConfig.appsScriptUrl, {
      method: 'POST',
      // text/plain avoids a CORS preflight; the backend parses JSON either way.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: controller.signal,
    })

    const text = await res.text()
    let parsed: ApiEnvelope<T>
    try {
      parsed = JSON.parse(text) as ApiEnvelope<T>
    } catch {
      return failEnvelope<T>(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, 'BAD_RESPONSE')
    }

    if (!res.ok && parsed.success === undefined) {
      return failEnvelope<T>(`HTTP ${res.status}`, 'HTTP_ERROR')
    }
    return parsed
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    return failEnvelope<T>(
      aborted ? `Request timed out after ${apiConfig.timeoutMs}ms` : String(err),
      aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
    )
  } finally {
    clearTimeout(timer)
  }
}

function failEnvelope<T>(error: string, code: string): ApiEnvelope<T> {
  return { success: false, data: null, error, code }
}

async function callOrchestratedStep<T>(
  eventType: ApiEventType,
  step: string,
  payload: ApiPayload,
  auth?: AuthContext,
): Promise<ApiEnvelope<T>> {
  const response = await callApi<{ steps?: Record<string, ApiEnvelope<T>> }>(eventType, payload, auth)
  if (!response.success) {
    return {
      success: false,
      data: null,
      error: response.error,
      code: response.code,
    }
  }
  const result = response.data?.steps?.[step]
  return result ?? failEnvelope<T>(`Response step "${step}" is missing.`, 'BAD_RESPONSE')
}

/** Typed convenience wrappers for the known Orchestrator events. */
export const api = {
  checkout: <T = unknown>(payload: ApiPayload, auth?: AuthContext) =>
    callApi<T>('checkout.completed', payload, auth),
  purchase: <T = unknown>(payload: ApiPayload, auth?: AuthContext) =>
    callApi<T>('purchase.recorded', payload, auth),
  updateStock: <T = unknown>(payload: ApiPayload, auth?: AuthContext) =>
    callApi<T>('stock.updated', payload, auth),
  report: <T = unknown>(reportType: string, payload: ApiPayload = {}, auth?: AuthContext) =>
    callApi<T>('report.requested', { ...payload, reportType }, auth),
  stockReport: <T = unknown>(auth?: AuthContext) =>
    callOrchestratedStep<T>('stock.report.requested', 'stockReport', {}, auth),
  stockHistoryStatus: <T = unknown>(auth?: AuthContext) =>
    callOrchestratedStep<T>('stock.history.status.requested', 'stockHistoryStatus', {}, auth),
  scheduleStockHistory: <T = unknown>(hour: number, auth?: AuthContext) =>
    callOrchestratedStep<T>('stock.history.schedule.requested', 'stockHistorySchedule', { hour }, auth),
  consumptionClosing: <T = unknown>(auth?: AuthContext) =>
    callOrchestratedStep<T>('consumption.closing.requested', 'consumptionClosing', {}, auth),
  recordConsumption: <T = unknown>(payload: ApiPayload, auth?: AuthContext) =>
    callOrchestratedStep<T>('consumption.recorded', 'consumptionRecord', payload, auth),
  consumptionHistory: <T = unknown>(startDate: string, endDate: string, auth?: AuthContext) =>
    callOrchestratedStep<T>('consumption.history.requested', 'consumptionHistory', { startDate, endDate }, auth),
  shiftReport: <T = unknown>(auth?: AuthContext) =>
    callOrchestratedStep<T>('shift.report.requested', 'shiftReport', {}, auth),
  submitShiftReport: <T = unknown>(payload: ApiPayload, auth?: AuthContext) =>
    callOrchestratedStep<T>('shift.report.submitted', 'shiftSubmit', payload, auth),
  shiftHistory: <T = unknown>(startDate: string, endDate: string, auth?: AuthContext) =>
    callOrchestratedStep<T>('shift.history.requested', 'shiftHistory', { startDate, endDate }, auth),
  pushSubscribe: <T = unknown>(payload: ApiPayload, auth?: AuthContext) =>
    callOrchestratedStep<T>('push.subscribed', 'pushSubscribe', payload, auth),
  pushUnsubscribe: <T = unknown>(token: string, auth?: AuthContext) =>
    callOrchestratedStep<T>('push.unsubscribed', 'pushUnsubscribe', { token }, auth),
  pushTest: <T = unknown>(payload: ApiPayload, auth?: AuthContext) =>
    callOrchestratedStep<T>('push.test.requested', 'pushTest', payload, auth),
  cookingAudit: <T = unknown>(startDate: string, endDate: string, auth?: AuthContext) =>
    callOrchestratedStep<T>('cooking.audit.requested', 'cookingAudit', { startDate, endDate }, auth),
  products: <T = unknown>(payload: ApiPayload = {}, auth?: AuthContext) =>
    callApi<T>('catalog.requested', payload, auth),
  login: <T = unknown>(payload: ApiPayload) => callApi<T>('auth.login', payload),
  logout: <T = unknown>(auth?: AuthContext) => callApi<T>('auth.logout', {}, auth),
  health: <T = unknown>() => callApi<T>('health'),
}
