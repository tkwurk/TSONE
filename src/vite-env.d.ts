/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** JSON array of outlet backends: [{"name":"TS1","url":"https://script.google.com/macros/s/…/exec"}]. */
  readonly VITE_OUTLETS?: string
  /** Single-backend fallback when VITE_OUTLETS is not set. */
  readonly VITE_APPS_SCRIPT_URL?: string
  readonly VITE_API_TIMEOUT_MS?: string
  readonly VITE_BUSINESS_TZ?: string
  /** OAuth 2.0 Web client ID from Google Cloud. */
  readonly VITE_GOOGLE_CLIENT_ID: string
  /** Space-separated OAuth scopes. Optional; sensible default applied. */
  readonly VITE_GOOGLE_SCOPES?: string
  /** ID of the Google Sheet that backs the app. */
  readonly VITE_GOOGLE_SPREADSHEET_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
