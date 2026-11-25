// Shift Worker: the server computes expected cash and kitchen remaining, checks
// the receiver and every kitchen item, and writes one ShiftReports row via Repo.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const plain = (x) => JSON.parse(JSON.stringify(x))

const src = (file) => readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8')

function setup({ tabs = ['shiftReport'], cash = 250000 } = {}) {
  const appended = []
  const cache = {}
  const people = [
    { person_id: 'ani', display_name: 'Ani', outlet: 'TS5', active: 'Y' },
    { person_id: 'budi', display_name: 'Budi', outlet: 'TS5', active: 'Y' },
    { person_id: 'cici', display_name: 'Cici', outlet: 'TS4', active: 'Y' },
    { person_id: 'dodi', display_name: 'Dodi', outlet: 'TS5', active: 'N' },
  ]
  const ctx = vm.createContext({
    Logger: { log() {} },
    Session: { getScriptTimeZone: () => 'Asia/Jakarta' },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v } }) },
    apiOk: (data, code) => ({ success: true, data, code }),
    apiFail: (error, code) => ({ success: false, error, code }),
    requirePermission_: (params, tab) => {
      const a = params._authContext || {}
      if (a.deviceId !== 'dev' || a.username !== 'ani') throw new Error('Invalid or expired session')
      if (!tabs.includes(tab)) throw new Error('Permission denied: ' + tab)
      return { username: 'ani', deviceId: 'dev', outlet: 'TS5' }
    },
    canonicalOutletKey_: (o) => String(o || '').trim().toUpperCase(),
    getBusinessDateKey: () => '2026-11-24',
    getCashSummary: () => JSON.stringify({ cashInHand: cash }),
    getCookingProductsFromSheet: () => [{ productCode: 'AYAM' }, { productCode: 'NASI' }],
    _buildCookingStockSummary: () => [
      { productCode: 'AYAM', name: 'Ayam goreng', cookedToday: 20, soldToday: 14, remaining: 6 },
      { productCode: 'NASI', name: 'Nasi', cookedToday: 30, soldToday: 22, remaining: 8 },
    ],
    buildIdempotencyCacheKey_: (p, id) => p + id,
    getIdempotentResult_: (k) => (cache[k] ? JSON.parse(cache[k]) : null),
    Repo: {
      ensureTable() {},
      readRows: (c) => (c === 'PEOPLE' ? people : appended.slice()),
      readRowsFromEnd: () => ({ rows: appended.slice() }),
      appendObjects: (c, o) => { assert.equal(c, 'SHIFT_REPORTS'); appended.push(o) },
    },
  })
  vm.runInContext(src('shiftWorker.gs'), ctx, { filename: 'shiftWorker.gs' })
  return { W: ctx.ShiftWorker, appended }
}

const auth = { username: 'ani', deviceId: 'dev', outlet: 'TS5' }
const good = (extra = {}) => ({
  _authContext: auth,
  clientRequestId: 'shift-1',
  countedCash: 240000,
  cashConfirmed: true,
  receiverId: 'budi',
  kitchen: [{ productCode: 'AYAM', confirmed: true }, { productCode: 'NASI', actual: 7 }],
  notes: 'ok',
  ...extra,
})

test('load returns expected cash, kitchen items and same-outlet active staff (not self)', () => {
  const { W } = setup()
  const r = W.getShiftReport({ _authContext: auth }, {})
  assert.equal(r.success, true)
  assert.equal(r.data.expectedCash, 250000)
  assert.deepEqual(plain(r.data.kitchen.map((k) => [k.productCode, k.remaining])), [['AYAM', 6], ['NASI', 8]])
  assert.deepEqual(plain(r.data.staff.map((s) => s.id)), ['budi'])
})

test('submit stores server-computed variance and kitchen differences', () => {
  const { W, appended } = setup()
  const r = W.submitShiftReport(good(), {})
  assert.equal(r.success, true, r.error)
  assert.equal(r.data.cashVariance, -10000)
  assert.equal(r.data.handedTo, 'Budi')
  assert.deepEqual(plain(r.data.kitchenMismatches.map((m) => [m.productCode, m.system, m.actual, m.diff])), [['NASI', 8, 7, -1]])
  assert.equal(appended.length, 1)
  assert.equal(appended[0]['Expected Cash'], 250000)
  assert.equal(appended[0]['Kitchen Mismatches'], 1)
})

test('client cannot set expected cash or skip a kitchen item', () => {
  const { W, appended } = setup()
  const r = W.submitShiftReport(good({ expectedCash: 240000 }), {})
  assert.equal(r.data.cashVariance, -10000)
  const missing = W.submitShiftReport(good({ clientRequestId: 'shift-2', kitchen: [{ productCode: 'AYAM', confirmed: true }] }), {})
  assert.equal(missing.code, 'SHIFT_KITCHEN_INCOMPLETE')
  assert.equal(appended.length, 1)
})

test('rejects other-outlet receivers, missing confirmation, bad cash, and duplicates', () => {
  const { W, appended } = setup()
  assert.equal(W.submitShiftReport(good({ receiverId: 'cici' }), {}).code, 'SHIFT_BAD_RECEIVER')
  assert.equal(W.submitShiftReport(good({ receiverId: 'ani' }), {}).code, 'SHIFT_BAD_RECEIVER')
  assert.equal(W.submitShiftReport(good({ cashConfirmed: false }), {}).code, 'SHIFT_CASH_NOT_CONFIRMED')
  assert.equal(W.submitShiftReport(good({ countedCash: '' }), {}).code, 'SHIFT_BAD_CASH')
  assert.equal(W.submitShiftReport(good(), {}).code, 'SHIFT_REPORT_SAVED')
  assert.equal(W.submitShiftReport(good(), {}).code, 'SHIFT_REPORT_DUPLICATE')
  assert.equal(appended.length, 1)
})

test('requires a session with the shiftReport permission', () => {
  const { W } = setup({ tabs: ['orders'] })
  assert.throws(() => W.getShiftReport({ _authContext: auth }, {}), /Permission denied/)
  assert.throws(() => W.submitShiftReport(good({ _authContext: { ...auth, deviceId: 'x' } }), {}), /session/)
})

test('history returns this outlet only, within the date range, newest first, with details', () => {
  const { W, appended } = setup()
  const row = (id, date, outlet, details) => ({
    'Report ID': id, 'Submitted At': new Date(date + 'T10:00:00Z'), 'Business Date': date, 'Outlet': outlet,
    'Submitted By': 'ani', 'Handed To': 'Budi', 'Expected Cash': 100, 'Counted Cash': 90, 'Cash Variance': -10,
    'Kitchen Items': details.length, 'Kitchen Details': JSON.stringify(details), 'Notes': 'n',
  })
  appended.push(
    row('S1', '2026-11-20', 'TS5', []),
    row('S2', '2026-11-22', 'TS4', []),
    row('S3', '2026-11-23', 'TS5', [{ productCode: 'NASI', name: 'Nasi', system: 8, actual: 7, diff: -1 }, { productCode: 'AYAM', name: 'Ayam', system: 6, actual: 6, diff: 0 }]),
    row('S4', '2026-11-25', 'TS5', []),
  )
  const r = W.getShiftHistory({ _authContext: auth, startDate: '2026-11-24', endDate: '2026-11-20' }, {})
  assert.equal(r.success, true, r.error)
  assert.deepEqual(plain(r.data.rows.map((x) => x.reportId)), ['S3', 'S1'])
  assert.equal(r.data.rows[0].kitchenDetails.length, 2)
  assert.deepEqual(plain(r.data.rows[0].kitchenMismatches.map((m) => m.productCode)), ['NASI'])
  assert.equal(W.getShiftHistory({ _authContext: auth, startDate: 'x', endDate: '2026-11-24' }, {}).code, 'SHIFT_BAD_RANGE')
})
