// Cooking audit: replays stock (leftover + batches at ready time − sales) to find
// each sell-out, the wait until the next batch was ready, customers turned away
// meanwhile, and a suggested recook threshold. Also checks the loader against
// the real kitchen helpers with fake sheets, so numbers match the Today report.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const src = (file) => readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8')
const plain = (x) => JSON.parse(JSON.stringify(x))

// Jakarta = UTC+7, no DST.
const TZ_MS = 7 * 3600_000
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+07:00`)
const dayStart = (key) => at(key, '00:00')

function load(extra = {}) {
  const fmt = (d, tz, pattern) => {
    const x = new Date(d.getTime() + TZ_MS)
    const p = (n) => String(n).padStart(2, '0')
    return pattern
      .replace('yyyy', x.getUTCFullYear()).replace('MM', p(x.getUTCMonth() + 1)).replace('dd', p(x.getUTCDate()))
      .replace('HH', p(x.getUTCHours())).replace('mm', p(x.getUTCMinutes())).replace('ss', p(x.getUTCSeconds()))
  }
  const ctx = vm.createContext({
    Logger: { log() {} },
    Utilities: {
      formatDate: fmt,
      parseDate: (s) => new Date(Date.parse(s.replace(' ', 'T').slice(0, 19) + (s.length <= 10 ? 'T00:00:00' : '') + '+07:00')),
    },
    getAppTimeZone_: () => 'Asia/Jakarta',
    ...extra,
  })
  vm.runInContext(src('kitchenCooking.js'), ctx, { filename: 'kitchenCooking.js' })
  vm.runInContext('function getAppDateKey_(d) { return Utilities.formatDate(d, "Asia/Jakarta", "yyyy-MM-dd") }', ctx)
  vm.runInContext(src('cookingAudit.js'), ctx, { filename: 'cookingAudit.js' })
  return ctx
}

const D1 = '2026-11-20'
const D2 = '2026-11-21'
const days = [
  { key: D1, startMs: dayStart(D1), endMs: dayStart(D2) },
  { key: D2, startMs: dayStart(D2), endMs: dayStart('2026-11-22') },
]

test('replay finds sell-outs, waits, reaction, cook time and customers turned away', () => {
  const ctx = load()
  const audit = plain(ctx.buildCookingAudit_({
    products: [{ productCode: 'AYAM', name: 'Ayam goreng', recookThreshold: 2 }, { productCode: 'NASI', name: 'Nasi', recookThreshold: 5 }],
    leftover: [2, 50],
    days,
    batches: [
      { p: 0, startMs: at(D1, '10:45'), readyMs: at(D1, '11:05'), qty: 10, chef: 'chef1' },
    ],
    sales: [
      { p: 0, ms: at(D1, '10:00'), qty: 1 },
      { p: 0, ms: at(D1, '10:30'), qty: 1 }, // → 0: sold out
      { p: 0, ms: at(D1, '10:50'), qty: 1 }, // sold while out (stock data gap)
      { p: 0, ms: at(D1, '15:00'), qty: 9 }, // 10 − 1 − 9 = 0: sold out again, never recooked
      { p: 1, ms: at(D1, '12:00'), qty: 3 },
    ],
    missed: [
      { p: 0, ms: at(D1, '10:40'), qty: 2 },
      { p: 0, ms: at(D1, '16:00'), qty: 1 },
      { p: 0, ms: at(D1, '12:00'), qty: 5 }, // in stock then: not counted
    ],
  }))
  assert.equal(audit.episodes.length, 2)
  const [late, early] = audit.episodes // newest first
  assert.equal(early.soldOutAt, new Date(at(D1, '10:30')).toISOString())
  assert.equal(early.restocked, true)
  assert.equal(early.waitMin, 35)
  assert.equal(early.reactionMin, 15)
  assert.equal(early.cookMin, 20)
  assert.equal(early.turnedAway, 2)
  assert.equal(early.salesWhileOut, 1)
  assert.equal(early.ratePerHour, 2) // 2 sold in the hour before 10:30
  assert.equal(early.chef, 'chef1')
  assert.equal(late.restocked, false)
  assert.equal(late.waitMin, null)
  assert.equal(late.turnedAway, 1)
  assert.equal(late.ratePerHour, 9)

  const ayam = audit.products[0]
  assert.equal(ayam.sellOuts, 2)
  assert.equal(ayam.notRestocked, 1)
  assert.equal(ayam.avgWaitMin, 35)
  assert.equal(ayam.avgCookMin, 20)
  assert.equal(ayam.turnedAway, 3)
  // (2 + 9) / 2 = 5.5 per hour → 5.5/60 × (20 + 5 min) = 2.29 → start cooking at 3 left.
  assert.equal(ayam.suggestedThreshold, 3)
  assert.equal(ayam.raiseThreshold, true)
  assert.equal(audit.products[1].sellOuts, 0)
  assert.equal(audit.products[1].suggestedThreshold, null)
  assert.equal(audit.totals.sellOuts, 2)
  assert.equal(audit.totals.turnedAway, 3)
  assert.equal(audit.totals.productsToRaise, 1)
})

test('stock carried to the next day never goes below 0; batch before sale at the same time', () => {
  const ctx = load()
  const audit = plain(ctx.buildCookingAudit_({
    products: [{ productCode: 'AYAM', name: 'Ayam', recookThreshold: 1 }],
    leftover: [1],
    days,
    batches: [{ p: 0, startMs: at(D2, '09:00'), readyMs: at(D2, '09:30'), qty: 2 }],
    sales: [
      { p: 0, ms: at(D1, '20:00'), qty: 3 }, // −2 at night → day 2 starts at 0, not −2
      { p: 0, ms: at(D2, '09:30'), qty: 2 }, // same instant as the batch: batch first → 0, sells out again
    ],
    missed: [],
  }))
  assert.equal(audit.episodes.length, 2)
  assert.equal(audit.episodes[0].day, D2)
  assert.equal(audit.episodes[1].restocked, false) // day 1 ended out of stock
})

test('loader: reads sheets via Repo, matches the Today report model, filters outlet and time', () => {
  const now = new Date(at(D2, '18:00'))
  const tables = {
    KITCHEN_COOKING: {
      headers: ['CookingId', 'StartTime', 'EndTime', 'ProductCode', 'ProductName', 'Qty', 'Chef', 'Outlet', 'Status'],
      rows: [
        { StartTime: new Date(at('2026-11-19', '08:00')), EndTime: new Date(at('2026-11-19', '08:30')), ProductCode: 'AYAM', ProductName: 'Ayam', Qty: 10, Outlet: 'TS5', Status: 'COMPLETED' },
        { StartTime: new Date(at(D1, '10:45')), EndTime: new Date(at(D1, '11:05')), ProductCode: 'AYAM', ProductName: 'Ayam', Qty: 10, Chef: 'chef1', Outlet: 'TS5', Status: '' },
        { StartTime: new Date(at(D1, '10:45')), EndTime: new Date(at(D1, '11:05')), ProductCode: 'AYAM', ProductName: 'Ayam', Qty: 99, Outlet: 'TS4', Status: '' },
        { StartTime: new Date(at(D2, '19:00')), EndTime: new Date(at(D2, '19:30')), ProductCode: 'AYAM', ProductName: 'Ayam', Qty: 99, Outlet: 'TS5', Status: '' }, // future
      ],
    },
    ORDERS: {
      headers: ['Timestamp', 'Product Code', 'Product Name', 'Quantity', 'Outlet'],
      rows: [
        { Timestamp: new Date(at('2026-11-19', '12:00')), 'Product Code': 'AYAM', 'Product Name': 'Ayam', Quantity: 8, Outlet: 'TS5' }, // leftover 2
        { Timestamp: new Date(at(D1, '10:30')), 'Product Code': 'AYAM', 'Product Name': 'Ayam', Quantity: 2, Outlet: 'TS5' }, // → sold out
        { Timestamp: new Date(at(D1, '10:31')), 'Product Code': 'AYAM', 'Product Name': 'Ayam', Quantity: 5, Outlet: 'TS4' }, // other outlet
      ],
    },
    MISSED_ORDERS: {
      headers: ['Timestamp', 'ProductName', 'Quantity', 'Outlet', 'ProductCode'],
      rows: [{ Timestamp: new Date(at(D1, '10:40')), ProductName: 'Ayam', Quantity: 3, Outlet: 'TS5', ProductCode: 'AYAM' }],
    },
  }
  const ctx = load({
    Repo: { readTable: (c) => tables[c] ?? { headers: [], rows: [] } },
  })
  // Replace the kitchen file's sheet readers (loaded above) with fakes.
  vm.runInContext('_getKitchenOrderProductIndex_ = function () { return null }; getCookingProductsFromSheet = function () { return [{ productCode: "AYAM", name: "Ayam", recookThreshold: 2 }] }', ctx)
  const input = ctx.loadCookingAuditInput_('TS5', D1, D2, now)
  assert.deepEqual(plain(input.leftover), [2])
  assert.equal(input.batches.length, 1)
  assert.equal(input.sales.length, 1)
  assert.equal(input.missed.length, 1)
  assert.equal(input.days[1].endMs, now.getTime()) // today stops at "now"
  const audit = plain(ctx.buildCookingAudit_(input))
  assert.equal(audit.episodes.length, 1)
  assert.equal(audit.episodes[0].waitMin, 35)
  assert.equal(audit.episodes[0].turnedAway, 3)
})

test('a day that starts with no stock: the first unmet sale starts a sell-out', () => {
  const ctx = load()
  const audit = plain(ctx.buildCookingAudit_({
    products: [{ productCode: 'AYAM', name: 'Ayam', recookThreshold: 1 }],
    leftover: [0],
    days: [days[0]],
    batches: [{ p: 0, startMs: at(D1, '08:30'), readyMs: at(D1, '09:00'), qty: 5 }],
    sales: [{ p: 0, ms: at(D1, '08:40'), qty: 2 }],
    missed: [],
  }))
  assert.equal(audit.episodes.length, 1)
  assert.equal(audit.episodes[0].soldOutAt, new Date(at(D1, '08:40')).toISOString())
  assert.equal(audit.episodes[0].waitMin, 20)
  assert.equal(audit.episodes[0].salesWhileOut, 2)
})
