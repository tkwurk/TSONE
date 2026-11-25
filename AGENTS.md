# TS4 — Architecture (authoritative)

**This file is the source of truth for how TS4 is built. Respect it on every task.**
Do **not** rediscover, re-derive, or "correct" the architecture toward a different
design. If existing code conflicts with these rules, the **code** is wrong — flag it
and ask, do not silently redesign. Propose architecture changes to the user
explicitly; never refactor across these boundaries on your own initiative.

## System shape — three layers, two seams

```
Client (PWA: Vite + React + TS)       → iOS · Android · Web, one codebase, $0
        │  SEAM 1: one JSON API contract
Backend (Apps Script Web App)         → doPost router → Orchestrator → Workers
        │  SEAM 2: Data Access Layer (Repo + adapter)
Data (Google Sheets today)            → swappable for Firestore / Postgres later
```

- **Seam 1 (JSON API):** lets us add platforms or replace the client without touching logic.
- **Seam 2 (Data Access Layer):** lets us migrate the database by writing ONE new adapter; business logic stays untouched.

## Hard rules

### MUST
- All client↔backend traffic goes through **one** JSON API: `POST /exec` with body
  `{ eventType, payload, ctx }`, returning the existing `apiOk` / `apiFail` envelope.
- **Business logic, permissions, validation, and all data writes live in Apps Script only.**
- All database reads/writes go through the **`Repo` / adapter layer** — never
  `SpreadsheetApp` (or raw sheet access) directly inside workers.
- Web App is deployed **Execute as: the owner (me)**, so the script reaches the
  spreadsheet with the owner's access and **end users never get direct access to
  the Sheet**. The data path requires no Google Cloud project and keeps the app free.
  **Approved exception (push only):** one free Firebase project is used for
  Firebase Cloud Messaging push notifications — nothing else. Its service-account
  key lives only in each outlet's Script Property `FIREBASE_SERVICE_ACCOUNT`; the
  client gets only the public web config (`VITE_FIREBASE_CONFIG`,
  `VITE_FIREBASE_VAPID_KEY`). Without them push is off and the app falls back to
  in-app notifications while it is open.
  (Future option for per-user concurrency: deploy *execute as user accessing* and
  switch the data layer to the service-account adapter — see `SheetsAdapter` /
  `serviceAccount.gs`. Not active today.)
- Keep calls **coarse-grained**: one `doPost` per business action (checkout,
  report) — never one call per field.
- Wrap only the critical write (order number, stock ledger) in `LockService`,
  with the smallest possible lock window.

### MUST NOT
- **MUST NOT** call the Google Sheets API directly from the client/browser. The
  direct-write path in `src/services/google/sheets.ts` is **deprecated** — do not
  extend or reintroduce it.
- **MUST NOT** put business logic, pricing, permissions, or reconciliation in the client.
- Purchasing History may filter already-authorized rows locally and sum their
  existing line totals for display only. These derived totals are not
  authoritative and must never be used for writes, pricing, or reconciliation.
- **MUST NOT** put business logic in the **Orchestrator** (routing / workflow
  state / logging only).
- **MUST NOT** bypass `Repo` to touch `SpreadsheetApp` inside a worker.
- **MUST NOT** reintroduce server-rendered HTML UI or `google.script.run` as the
  application UI.

## Agent responsibility matrix

| Agent | Owns | MUST NOT do |
|---|---|---|
| Orchestrator | Routing, workflow state, logging decisions | Business logic, data writes |
| Sales Worker | Checkout/transaction persistence (delegates to `saveOrderSecure`) | Stock, reporting, validation |
| Inventory Worker | Stock ledger + restock | Sales pricing, reporting |
| Reporting Worker | Report/summary generation | Writing transactional data |
| Shift Worker | Shift handover reports (`ShiftReports`): expected vs counted cash, kitchen confirmation | Stock, sales, pricing |
| Notification Worker | Push subscriptions (`PushSubscriptions`) and push delivery via FCM | Deciding business events; must never throw into the caller |
| Reflection Agent | Validation, compliance, reconciliation | Mutating business data |
| Error Handler | Logging, retry, alerting | Business decisions |

Time-driven triggers and email (e.g. `cookingAlerts.gs`) **stay in Apps Script** —
they cannot move to the client.

## Routing events

New capability = a new `eventType` routed by the Orchestrator to a Worker that
calls `Repo`. Known events include `checkout.completed`, `stock.updated`,
`stock.report.requested`, `stock.history.status.requested`,
`stock.history.schedule.requested`, `consumption.closing.requested`,
`consumption.recorded`, `consumption.history.requested`, `shift.report.requested`, `shift.report.submitted`, `shift.history.requested`,
`push.subscribed`, `push.unsubscribed`,
`report.requested`, and `purchase.recorded`.
Keep the `// Copilot:` intent comment above each worker method.

## Shared context object

```js
ctx = { username, outlet, deviceId, requestId, eventType };
```
Server resolves the real caller via `Session.getActiveUser().getEmail()`, looks
them up in the People/roles sheet, and enforces `requirePermission_` before acting.

## Quotas to respect (execute-as-user)
- Per-user pool of **30 simultaneous executions**; **6-minute** runtime cap per execution.
- Switching transport (`google.script.run` → `doPost`) does **not** add quota — the
  risks are call granularity and concurrency. Keep calls coarse and locks short.

## Seam 1 — JSON API

- Backend: `apps-script-source/apiRouter.gs` exposes `doPost(e)` — the single
  external entry point. It parses `{ eventType, payload }` and delegates to
  `Orchestrator.routeEvent`; **no business logic**. It also dispatches `health`
  and the `auth.login` / `auth.logout` events to the existing
  `authenticateUserClean` / `logoutUser` functions. The legacy HTML UI has been
  removed; `doGet` (`code.js`) only returns a plain-text status line.
- Client: `src/services/api/` (`callApi(eventType, payload, auth)` + typed `api.*`
  wrappers). Posts `text/plain` to skip the CORS preflight; returns the
  `apiOk`/`apiFail` envelope. The URL is the selected outlet's (see below).
  Operator login lives in `src/features/auth/` and supplies the `_authContext`.

## Multi-outlet deployment

- **One outlet = one Google Sheet + its own bound Apps Script project**, all
  running the **same** `apps-script-source/` code. Outlets share no data.
- Each script finds its sheet via its own Script Property `SPREADSHEET_ID`.
  Sheet IDs never appear in the repo or the client.
- Script IDs + Web App deployment IDs live only in git-ignored
  `outlets.local.json` (template: `outlets.example.json`).
  `apps-script-source/.clasp.json` is git-ignored too. Never commit these IDs.
- Deploy the backend with `npm run deploy /all` (every outlet) or
  `npm run deploy TS1` (one outlet) — `scripts/deploy-apps-script.mjs` pushes
  the code and updates the existing deployment so each `/exec` URL stays fixed.
- Client: `src/services/api/outlets.ts` reads `VITE_OUTLETS`
  (`[{ name, url }]`, GitHub repository **secret** in CI; derived from
  `outlets.local.json` in local dev). The login screen picks the outlet;
  `apiConfig.appsScriptUrl` resolves to it, and a session is only valid for
  the outlet it was created on. The URLs are visible in the built JS, which is
  expected: security comes from server-side auth + execute-as-owner.

## Dates & timezone (client rule)
The business runs in the Apps Script project timezone (`appsscript.json`
`timeZone`, Asia/Jakarta). Devices may be elsewhere. On the client, ALWAYS use
`src/lib/dates.ts` (`localDate`, `localDateTime`, `addDays`, `fmtDateTime`,
`fmtDateOnly`, `fmtTimeOnly`) for date-picker defaults, business dates sent to
the server, and displayed timestamps. Never use `toISOString().slice(0,10)`
(UTC) or `toLocaleString()` without a timezone (device zone) for business data.
Full ISO instants (e.g. `submittedAt`) are fine as-is.

## Data Access Layer (Seam 2)
Implemented in `apps-script-source/`: `repo.gs` (facade — workers call this),
`spreadsheetAppAdapter.gs` (**default** adapter, Option C: execute-as-owner,
free), plus `sheetsAdapter.gs` + `serviceAccount.gs` (Option B: service-account
REST, available for future per-user concurrency). Workers MUST use `Repo`; only
an adapter knows the store is Sheets. Swap stores by setting `Repo.adapter`.
Setup + migration: [apps-script-source/DATA_ACCESS_LAYER.md](apps-script-source/DATA_ACCESS_LAYER.md).

## Reference docs (read before large changes)
- [apps-script-source/DATA_ACCESS_LAYER.md](apps-script-source/DATA_ACCESS_LAYER.md)
- [apps-script-source/ORCHESTRATOR_ARCHITECTURE.md](apps-script-source/ORCHESTRATOR_ARCHITECTURE.md)
- [apps-script-source/AGENT_GUIDE.md](apps-script-source/AGENT_GUIDE.md)
- [src/features/README.md](src/features/README.md) · [README.md](README.md)
