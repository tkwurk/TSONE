/**
 * Outlet backends. Each outlet has its own Google Sheet + Apps Script Web App;
 * the client only knows each outlet's /exec URL. The user picks an outlet on the
 * login screen and every API call then goes to that outlet's backend.
 *
 * The list comes from VITE_OUTLETS, a JSON array injected at build time:
 *   [{"name":"TS1","url":"https://script.google.com/macros/s/…/exec"}, …]
 * - GitHub Pages: repository secret VITE_OUTLETS (see .github/workflows/deploy.yml).
 * - Local dev: read automatically from outlets.local.json (vite.config.ts).
 * Falls back to a single outlet from VITE_APPS_SCRIPT_URL.
 */
export interface OutletBackend {
  name: string
  url: string
}

const SELECTED_KEY = 'ts4.backendOutlet'

function parseOutlets(): OutletBackend[] {
  const raw = (import.meta.env.VITE_OUTLETS as string | undefined)?.trim()
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      const entries: unknown[] = Array.isArray(parsed)
        ? parsed
        : Object.entries(parsed as Record<string, unknown>).map(([name, url]) => ({ name, url }))
      const list = entries.filter(
        (o): o is OutletBackend =>
          !!o && typeof (o as OutletBackend).name === 'string' && typeof (o as OutletBackend).url === 'string',
      )
      if (list.length) return list
    } catch {
      console.error('VITE_OUTLETS is not valid JSON; falling back to VITE_APPS_SCRIPT_URL.')
    }
  }
  const single = import.meta.env.VITE_APPS_SCRIPT_URL as string | undefined
  return single ? [{ name: 'Default', url: single }] : []
}

/** All outlets this build knows about. */
export const outlets: OutletBackend[] = parseOutlets()

/** The outlet this device is using, or null if none chosen yet (and more than one exists). */
export function getSelectedOutlet(): OutletBackend | null {
  const name = localStorage.getItem(SELECTED_KEY)
  const chosen = outlets.find((o) => o.name === name)
  if (chosen) return chosen
  return outlets.length === 1 ? outlets[0] : null
}

export function selectOutlet(name: string): void {
  localStorage.setItem(SELECTED_KEY, name)
}
