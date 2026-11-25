// Login sessions must not pile up in Script Properties: one session per user
// per device (re-login overwrites it), no unused per-user keys, and a purge that
// removes only expired sessions and the old unused key types.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const src = (file) => readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8')

function setup(initial = {}) {
  const store = { ...initial }
  const cache = {}
  const ctx = vm.createContext({
    Logger: { log() {} },
    console: { log() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v) },
        deleteProperty: (k) => { delete store[k] },
        getProperties: () => ({ ...store }),
      }),
    },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    validateLoginPersonOrUser_: (u, code) =>
      code === 'ok' ? { success: true, username: u.toLowerCase(), outlet: 'TS5', role: 'cashier', allowedTabs: ['orders'] } : { success: false },
    resolveUserOutlet_: (u, o) => o,
    normalizeAllowedTabsForRole_: (tabs) => tabs,
    normalizeRole_: (r) => r,
    refreshSessionAuthFromPeople_: (u, s) => s,
  })
  vm.runInContext(src('login.js'), ctx, { filename: 'login.js' })
  vm.runInContext(src('cleanLoginBackend.js'), ctx, { filename: 'cleanLoginBackend.js' })
  return { ctx, store, cache }
}

const keys = (store) => Object.keys(store).sort()

test('the same device + user always maps to the same device id', () => {
  const { ctx } = setup()
  const base = '3f1c2a9e-1111-4c4c-8888-123456789abc'
  assert.equal(ctx.ensureDeviceIdForUser_(base, 'ani'), base + '_user_ani')
  assert.equal(ctx.ensureDeviceIdForUser_(base + '_user_budi', 'ani'), base + '_user_ani')
  assert.equal(ctx.ensureDeviceIdForUser_(base + '_user_ani', 'ani'), base + '_user_ani')
  // Old server-made ids keep their base too.
  assert.equal(ctx.ensureDeviceIdForUser_('device_1700000000000_session_abc123_user_budi', 'ani'), 'device_1700000000000_session_abc123_user_ani')
  // Junk gets a fresh random base.
  assert.match(ctx.ensureDeviceIdForUser_('<script>', 'ani'), /^device_\d+_session_[a-z0-9]+_user_ani$/)
})

test('users taking turns on one till: property count stays fixed', () => {
  const { ctx, store } = setup({ SPREADSHEET_ID: 'sheet' })
  let deviceId = '3f1c2a9e-1111-4c4c-8888-123456789abc'
  for (let round = 0; round < 10; round++) {
    for (const user of ['ani', 'budi', 'cici']) {
      const r = ctx.authenticateUserClean(user, 'ok', deviceId)
      assert.equal(r.success, true, r.message)
      deviceId = r.deviceId // the app stores what the server returns
    }
  }
  // 1 session per user on this device + SPREADSHEET_ID; no user_devices_ / active_session_.
  assert.deepEqual(keys(store), [
    'SPREADSHEET_ID',
    'session_ani_3f1c2a9e-1111-4c4c-8888-123456789abc_user_ani',
    'session_budi_3f1c2a9e-1111-4c4c-8888-123456789abc_user_budi',
    'session_cici_3f1c2a9e-1111-4c4c-8888-123456789abc_user_cici',
  ])
  // Each session is still valid for its user.
  assert.equal(ctx.getUserSessionEnhanced('3f1c2a9e-1111-4c4c-8888-123456789abc_user_budi', 'budi').username, 'budi')
})

test('purge removes only expired sessions and the old unused key types', () => {
  const now = Date.now()
  const fresh = JSON.stringify({ username: 'ani', deviceId: 'd1_user_ani', lastActivity: now - 60_000 })
  const stale = JSON.stringify({ username: 'ani', deviceId: 'd0_user_ani', lastActivity: now - 25 * 3600_000 })
  const { ctx, store } = setup({
    SPREADSHEET_ID: 'sheet',
    STOCK_HISTORY_SCHEDULE_HOUR: '3',
    FIREBASE_SERVICE_ACCOUNT: '{}',
    session_ani_d1_user_ani: fresh,
    session_ani_d0_user_ani: stale,
    session_broken: 'not json',
    user_devices_ani: '["d0","d1"]',
    active_session_ani: '{"active":true}',
  })
  const r = ctx.cleanUpSessionProperties()
  assert.deepEqual(keys(store), ['FIREBASE_SERVICE_ACCOUNT', 'SPREADSHEET_ID', 'STOCK_HISTORY_SCHEDULE_HOUR', 'session_ani_d1_user_ani'])
  assert.equal(r.before, 8)
  assert.equal(r.after, 4)
  assert.equal(r.deleted.expiredSessions, 2)
  assert.equal(r.deleted.deviceLists, 1)
  assert.equal(r.deleted.activeSessions, 1)
})

test('automatic purge on login is throttled and bounded', () => {
  const old = JSON.stringify({ username: 'x', lastActivity: 0 })
  const initial = {}
  for (let i = 0; i < 120; i++) initial[`session_u${i}_dev${i}_user_u${i}`] = old
  const { ctx, store } = setup(initial)
  ctx.authenticateUserClean('ani', 'ok', '3f1c2a9e-1111-4c4c-8888-123456789abc')
  assert.equal(Object.keys(store).filter((k) => k.startsWith('session_u')).length, 70) // 50 removed
  ctx.authenticateUserClean('budi', 'ok', '3f1c2a9e-1111-4c4c-8888-123456789abc')
  assert.equal(Object.keys(store).filter((k) => k.startsWith('session_u')).length, 70) // throttled
})
