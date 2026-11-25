// Notification Worker: device push tokens are stored via Repo, kitchen alerts
// go to this outlet's other kitchen devices through FCM, in each device's
// language, and dead tokens are switched off. Failures never throw.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const src = (file) => readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8')
const plain = (x) => JSON.parse(JSON.stringify(x))

function setup({ configured = true, fcm = () => 200, tabs = ['kitchenCooking'], tokenThrows = false } = {}) {
  let table = { headers: [], rows: [] }
  const fetched = []
  const props = configured
    ? { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'tsone-push', client_email: 'sa@x', private_key: 'k' }) }
    : {}
  const ctx = vm.createContext({
    Logger: { log() {} },
    JSON,
    apiOk: (data, code) => ({ success: true, data, code }),
    apiFail: (error, code) => ({ success: false, error, code }),
    requirePermission_: (p, tab) => {
      const a = p._authContext || {}
      if (a.deviceId !== 'dev') throw new Error('Invalid or expired session')
      if (!tabs.includes(tab)) throw new Error('Permission denied: ' + tab)
      return { username: a.username, deviceId: 'dev', outlet: a.outlet || 'TS5' }
    },
    requireAuth_: (p) => {
      const a = p._authContext || {}
      if (a.deviceId !== 'dev') throw new Error('Invalid or expired session')
      return { username: a.username, deviceId: 'dev', outlet: 'TS5' }
    },
    canonicalOutletKey_: (o) => String(o || '').trim().toUpperCase(),
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    ServiceAccount: { getAccessTokenFor: (email, key, scope) => { if (tokenThrows) throw new Error('token boom'); assert.equal(scope, 'https://www.googleapis.com/auth/firebase.messaging'); return 'ACCESS' } },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => {
        const body = JSON.parse(r.payload)
        fetched.push({ url: r.url, auth: r.headers.Authorization, ...body.message })
        const code = fcm(body.message.token)
        return { getResponseCode: () => code, getContentText: () => (code === 404 ? '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' : '{}') }
      }),
    },
    Repo: {
      ensureTable: (c, headers) => { if (!table.headers.length) table = { headers: headers.slice(), rows: [] } },
      readTable: () => ({ headers: table.headers.slice(), rows: table.rows.map((r) => ({ ...r })) }),
      appendObjects: (c, o) => { table.rows.push({ ...o }) },
      updateRange: (c, a1, values) => {
        const row = Number(a1.match(/^A(\d+):/)[1]) - 2
        table.rows[row] = Object.fromEntries(table.headers.map((h, i) => [h, values[0][i]]))
      },
    },
  })
  vm.runInContext(src('notificationWorker.gs'), ctx, { filename: 'notificationWorker.gs' })
  return { W: ctx.NotificationWorker, table: () => table, fetched }
}

const sub = (W, username, token, extra = {}) =>
  W.subscribe({ _authContext: { username, deviceId: 'dev', outlet: extra.outlet }, token, lang: extra.lang, platform: 'test' }, {})
const T = (n) => `tok_${n}_${'x'.repeat(30)}`
const item = (id, extra = {}) => ({ requestId: id, productName: 'Nasi', remaining: 2, requestedQty: 10, requestedBy: 'kasir1', reminder: false, ...extra })

test('subscribe needs Kitchen access, validates the token, and upserts by token', () => {
  const { W, table } = setup()
  assert.equal(sub(W, 'chef1', 'short').code, 'PUSH_BAD_TOKEN')
  assert.equal(sub(W, 'chef1', T(1), { lang: 'id' }).code, 'PUSH_SUBSCRIBED')
  assert.equal(sub(W, 'chef2', T(1)).code, 'PUSH_SUBSCRIBED') // same device, new user → same row
  assert.equal(table().rows.length, 1)
  assert.equal(table().rows[0].Username, 'chef2')
  const { W: W2 } = setup({ tabs: ['orders'] })
  assert.throws(() => sub(W2, 'kasir1', T(2)), /Permission denied/)
})

test('sends to same-outlet active devices except the requester, in their language', () => {
  const { W, fetched } = setup()
  sub(W, 'chef1', T(1), { lang: 'id' })
  sub(W, 'chef2', T(2), { lang: 'en' })
  sub(W, 'kasir1', T(3))
  sub(W, 'chefX', T(4), { outlet: 'TS4' })
  const r = W.notifyKitchenRequests('ts5', [item('R1')], { excludeUsername: 'kasir1' })
  assert.deepEqual(plain(r), { sent: 2, failed: 0, removed: 0 })
  assert.deepEqual(fetched.map((f) => f.token).sort(), [T(1), T(2)])
  const byTok = Object.fromEntries(fetched.map((f) => [f.token, f]))
  assert.equal(byTok[T(1)].webpush.data.title, '🍳 Masak lagi: Nasi')
  assert.equal(byTok[T(2)].webpush.data.title, '🍳 Cook more: Nasi')
  assert.equal(byTok[T(2)].webpush.data.body, 'Remaining 2 · qty 10 · by kasir1')
  assert.equal(byTok[T(2)].webpush.data.tag, 'kitchen-request:R1')
  assert.equal(byTok[T(2)].webpush.headers.Urgency, 'high')
  assert.match(fetched[0].url, /projects\/tsone-push\/messages:send$/)
  assert.equal(fetched[0].auth, 'Bearer ACCESS')
  for (const f of fetched) for (const v of Object.values(f.webpush.data)) assert.equal(typeof v, 'string')
})

test('reminders re-alert; more than 3 alerts become one summary per device', () => {
  const { W, fetched } = setup()
  sub(W, 'chef1', T(1))
  W.notifyKitchenRequests('TS5', [item('R1', { reminder: true, requestedBy: 'auto' })])
  assert.equal(fetched[0].webpush.data.title, '⏰ Still waiting: Nasi')
  assert.equal(fetched[0].webpush.data.renotify, '1')
  assert.equal(fetched[0].webpush.data.body, 'Remaining 2 · qty 10')
  W.notifyKitchenRequests('TS5', ['R2', 'R3', 'R4', 'R5'].map((id) => item(id)))
  assert.equal(fetched.length, 2)
  assert.equal(fetched[1].webpush.data.tag, 'kitchen-request:summary')
  assert.equal(fetched[1].webpush.data.title, '🍳 4 new kitchen requests')
})

test('tokens FCM reports as unregistered are switched off', () => {
  const { W, table } = setup({ fcm: (tok) => (tok === T(2) ? 404 : 200) })
  sub(W, 'chef1', T(1))
  sub(W, 'chef2', T(2))
  const r = W.notifyKitchenRequests('TS5', [item('R1')])
  assert.deepEqual(plain(r), { sent: 1, failed: 1, removed: 1 })
  assert.equal(table().rows.find((x) => x.Token === T(2)).Active, 'N')
  assert.equal(W.notifyKitchenRequests('TS5', [item('R2')]).sent, 1)
})

test('not configured or failing: nothing sent and nothing thrown', () => {
  const { W, fetched } = setup({ configured: false })
  sub(W, 'chef1', T(1))
  assert.equal(W.notifyKitchenRequests('TS5', [item('R1')]).skipped, 'not-configured')
  assert.equal(fetched.length, 0)
  const bad = setup({ tokenThrows: true })
  sub(bad.W, 'chef1', T(1))
  const r = bad.W.notifyKitchenRequests('TS5', [item('R1')])
  assert.equal(r.sent, 0)
  assert.match(r.error, /token boom/)
  assert.equal(bad.fetched.length, 0)
})

test('unsubscribe only switches off the caller\'s own token', () => {
  const { W, table } = setup()
  sub(W, 'chef1', T(1))
  W.unsubscribe({ _authContext: { username: 'chef2', deviceId: 'dev' }, token: T(1) }, {})
  assert.equal(table().rows[0].Active, 'Y')
  W.unsubscribe({ _authContext: { username: 'chef1', deviceId: 'dev' }, token: T(1) }, {})
  assert.equal(table().rows[0].Active, 'N')
})
