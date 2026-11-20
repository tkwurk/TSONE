/**
 * Configuration for the Apps Script JSON API (Seam 1).
 * The backend URL is the selected outlet's Web App /exec URL (see ./outlets.ts).
 */
import { getSelectedOutlet, outlets } from './outlets'

export interface ApiConfig {
  /** The selected outlet's Apps Script Web App URL ('' if none selected). */
  readonly appsScriptUrl: string
  /** Request timeout in milliseconds. */
  timeoutMs: number
}

export const apiConfig: ApiConfig = {
  get appsScriptUrl() {
    return getSelectedOutlet()?.url ?? ''
  },
  timeoutMs: Number(import.meta.env.VITE_API_TIMEOUT_MS ?? 45000),
}

export function assertApiConfig(config: ApiConfig = apiConfig): void {
  if (!config.appsScriptUrl) {
    throw new Error(
      outlets.length
        ? 'No outlet selected. Choose an outlet on the sign-in screen.'
        : 'No outlets configured. Set VITE_OUTLETS (or create outlets.local.json for local dev).',
    )
  }
}
