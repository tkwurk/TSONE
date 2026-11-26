// Incremental cash warehouse: must give exactly the same daily rows as the
// full-scan getDailyCashSummary, while reading only rows appended since the
// last sync — and fall back to a full re-read when history changed.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const src = (file) => readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8')
const plain = (x) => JSON.parse(JSON.stringify(x))
const noon = (d) => new Date(`${d}T12:00:00`)
const NAMES = { ORDERS: 'Orders', EXPENSES: 'Expenses', PURCHASES: 'Purchases', DEPOSITS: 'Deposits', CASH_WAREHOUSE: 'DailyCashWarehouse', WAREHOUSE_STATE: 'WarehouseState' }

function makeSheets() {
  return {
    Orders: [
      ['Timestamp', 'Order Number', 'Product Name', 'Quantity', 'Price', 'Payment', 'Total', 'Outlet'],
      [noon('2026-10-31'), 'A-001', 'Ayam', 1, 100000, 'Cash', 100000, 'TS5'],
      [noon('2026-11-01'), 'B-001', 'Ayam', 1, 50000, 'Cash', 50000, 'TS5'],
      [noon('2026-11-01'), 'B-002', 'Teh', 1, 20000, 'QRIS', 20000, 'TS5'],
      [noon('2026-11-02'), 'X-001', 'Ayam', 1, 999999, 'Cash', 999999, 'TS4'],
    ],
    Expenses: [
      ['Timestamp', 'Account', 'Amount', 'Payment', 'Outlet'],
      [noon('2026-11-01'), 'Gas', 10000, 'Cash', 'TS5'],
      [noon('2026-11-01'), 'Transfer fee', 7000, 'Transfer', 'TS5'], // neither cash nor deductible
      [noon('2026-11-02'), 'Discount', 5000, 'QRIS', 'TS5'],
    ],
    Purchases: [
      ['Timestamp', 'Product', 'Total', 'Payment', 'Outlet'],
      [noon('2026-11-02'), 'Beras', 15000, 'Cash', 'TS5'],
      [noon('2026-11-02'), 'Minyak', 8000, 'Transfer', 'TS5'],
    ],
    Deposits: [
      ['Timestamp', 'Amount', 'Account', 'Note', 'User', 'Outlet', 'PaymentMethod'],
      [noon('2026-11-01'), 20000, 'DANA', '', 'sup', 'TS5', 'QRIS'],
      [noon('2026-11-02'), 40000, 'BCA', '', 'sup', 'TS5', 'Transfer'],
    ],
  }
}

function setup(sheets = makeSheets(), opts = {}) {
  const reads = {} // data rows read per sheet
  const count = (name, n) => { reads[name] = (reads[name] || 0) + n }
  const toObj = (headers, row) => Object.fromEntries(headers.map((h, i) => [h, row[i]]))
  const name = (c) => NAMES[c] || c
  const Repo = {
    readTable(c) {
      const s = sheets[name(c)]
      if (!s || !s.length) return { headers: [], rows: [] }
      count(name(c), s.length - 1)
      return { headers: s[0].slice(), rows: s.slice(1).map((r) => toObj(s[0], r)) }
    },
    readRowsFromEnd(c, offset, n) {
      const s = sheets[name(c)]
      if (!s || !s.length) return { headers: [], rows: [], totalRows: 0 }
      const total = s.length - 1
      const end = Math.max(0, total - offset)
      const start = Math.max(0, end - n)
      count(name(c), end - start)
      return { headers: s[0].slice(), rows: s.slice(1 + start, 1 + end).map((r) => toObj(s[0], r)), totalRows: total }
    },
    ensureTable(c, headers) { if (!sheets[name(c)] || !sheets[name(c)].length) sheets[name(c)] = [headers.slice()] },
    replaceRows(c, objs) { const s = sheets[name(c)]; sheets[name(c)] = [s[0], ...objs.map((o) => s[0].map((h) => (o[h] == null ? '' : o[h])))] },
    appendObjects(c, o) { const s = sheets[name(c)]; s.push(s[0].map((h) => (o[h] == null ? '' : o[h]))) },
    updateRange(c, a1, values) { const row = Number(a1.match(/^A(\d+):/)[1]) - 1; sheets[name(c)][row] = values[0].slice() },
  }
  const cache = {}
  const ctx = vm.createContext({
    Logger: { log() {} },
    JSON,
    SHEETS: NAMES,
    Repo,
    LockService: { getDocumentLock: () => ({ tryLock: () => !opts.busy, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v } }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ atHour: () => ({ nearMinute: () => ({ everyDays: () => ({ create() {} }) }) }) }) }) },
    getUserSessionEnhanced: () => ({ username: 'sup', outlet: 'TS5' }),
    getGlobalSpreadsheet: () => ({ getSheetByName: (n) => (sheets[n] ? { getDataRange: () => ({ getValues: () => sheets[n].map((r) => r.slice()) }) } : null) }),
    purchaseInvestmentColIndex_: () => -1,
    isInvestmentPurchaseRow_: () => false,
  })
  vm.runInContext(src('cashManagement.js'), ctx, { filename: 'cashManagement.js' })
  vm.runInContext(src('cashDailyReport.js'), ctx, { filename: 'cashDailyReport.js' })
  vm.runInContext(src('cashWarehouse.js'), ctx, { filename: 'cashWarehouse.js' })
  const resetReads = () => { for (const k of Object.keys(reads)) delete reads[k] }
  return { ctx, sheets, reads, resetReads }
}

// Compare the numbers the report uses (display-only fields are not in the warehouse).
const KEYS = ['date', 'month', 'totalSales', 'cashSales', 'cashExpenses', 'deductibleExpenses', 'cashPurchases', 'deposits', 'depositsQris', 'depositsTransfer', 'salesByPaymentMethod', 'depositsByPaymentMethod', 'cashInHand']
const pick = (rows) => plain(rows).map((r) => Object.fromEntries(KEYS.map((k) => [k, r[k]])))
const sameAsFullScan = (ctx) => assert.deepEqual(pick(ctx.CashWarehouse.dailyRows('TS5')), pick(ctx.getDailyCashSummary('dev', 'sup')))

test('first sync builds the warehouse; numbers equal the full-scan report', () => {
  const { ctx } = setup()
  const r = plain(ctx.CashWarehouse.sync())
  assert.equal(r.ok, true)
  for (const s of ['ORDERS', 'EXPENSES', 'PURCHASES', 'DEPOSITS']) assert.equal(r.sources[s].mode, 'rebuilt')
  sameAsFullScan(ctx)
  assert.equal(ctx.CashWarehouse.dailyRows('TS5')[0].cashInHand, 80000) // 100k + 40k − 60k (2 Nov sale is TS4's)
})

test('appended rows: only the new rows (plus one check row) are read', () => {
  const { ctx, sheets, reads, resetReads } = setup()
  ctx.CashWarehouse.sync()
  sheets.Orders.push([noon('2026-11-03'), 'C-001', 'Ayam', 2, 30000, 'Cash', 60000, 'TS5'], [noon('2026-11-03'), 'C-002', 'Teh', 1, 15000, 'QRIS', 15000, 'TS5'])
  sheets.Deposits.push([noon('2026-11-03'), 50000, 'BCA', '', 'sup', 'TS5', 'Transfer'])
  resetReads()
  const r = plain(ctx.CashWarehouse.sync())
  assert.equal(r.sources.ORDERS.mode, 'incremental')
  assert.equal(r.sources.DEPOSITS.mode, 'incremental')
  assert.equal(r.sources.EXPENSES.mode, 'unchanged')
  assert.equal(reads.Orders, 3) // 2 new + the last processed row (fingerprint)
  assert.equal(reads.Deposits, 2)
  assert.equal(reads.Expenses, 1)
  assert.equal(reads.Purchases, 1)
  sameAsFullScan(ctx)
})

test('nothing new: one row per source is read, warehouse untouched', () => {
  const { ctx, reads, resetReads } = setup()
  ctx.CashWarehouse.sync()
  resetReads()
  const r = plain(ctx.CashWarehouse.sync())
  for (const s of ['ORDERS', 'EXPENSES', 'PURCHASES', 'DEPOSITS']) assert.equal(r.sources[s].mode, 'unchanged')
  assert.deepEqual(plain(reads), { Orders: 1, Expenses: 1, Purchases: 1, Deposits: 1, DailyCashWarehouse: reads.DailyCashWarehouse, WarehouseState: reads.WarehouseState })
  sameAsFullScan(ctx)
})

test('history changed: edited last row or deleted rows trigger a full re-read of that source only', () => {
  const { ctx, sheets } = setup()
  ctx.CashWarehouse.sync()
  sheets.Orders[sheets.Orders.length - 1][6] = 1 // edit the last processed row
  let r = plain(ctx.CashWarehouse.sync())
  assert.equal(r.sources.ORDERS.mode, 'rebuilt')
  assert.equal(r.sources.DEPOSITS.mode, 'unchanged')
  sameAsFullScan(ctx)
  sheets.Expenses.splice(1, 1) // delete a row
  r = plain(ctx.CashWarehouse.sync())
  assert.equal(r.sources.EXPENSES.mode, 'rebuilt')
  sameAsFullScan(ctx)
})

test('an edit in the middle is caught after markForRebuild (admin edits) and by the weekly rebuild', () => {
  const { ctx, sheets } = setup()
  ctx.CashWarehouse.sync()
  sheets.Orders[2][6] = 70000 // edit an older row: invisible to the incremental check
  assert.equal(plain(ctx.CashWarehouse.sync()).sources.ORDERS.mode, 'unchanged')
  ctx.CashWarehouse.markForRebuild(['ORDERS'])
  assert.equal(plain(ctx.CashWarehouse.sync()).sources.ORDERS.mode, 'rebuilt')
  sameAsFullScan(ctx)
  // Weekly: pretend the last full rebuild was 8 days ago.
  sheets.Deposits[1][1] = 25000
  const st = sheets.WarehouseState
  const col = st[0].indexOf('Last Full Rebuild')
  for (const row of st.slice(1)) row[col] = new Date(Date.now() - 8 * 86400000).toISOString()
  const r = plain(ctx.CashWarehouse.sync())
  assert.equal(r.sources.DEPOSITS.mode, 'rebuilt')
  sameAsFullScan(ctx)
})

test('dates are stored as text and survive a round trip; busy lock skips without error', () => {
  const { ctx, sheets } = setup()
  ctx.CashWarehouse.sync()
  assert.match(String(sheets.DailyCashWarehouse[1][0]), /^'\d{4}-\d{2}-\d{2}$/)
  sameAsFullScan(ctx)
  const busy = setup(makeSheets(), { busy: true })
  assert.equal(plain(busy.ctx.CashWarehouse.sync()).skipped, 'busy')
})
