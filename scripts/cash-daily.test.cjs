// Deposits > Daily cash report: per-day rows from getDailyCashSummary plus
// server-computed daily net, monthly subtotals (cash in hand at month end)
// and the all-time total.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const src = (file) => readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8')
const plain = (x) => JSON.parse(JSON.stringify(x))
const noon = (d) => new Date(`${d}T12:00:00`)

function setup(sheets) {
  const ctx = vm.createContext({
    Logger: { log() {} },
    SHEETS: { ORDERS: 'Orders', EXPENSES: 'Expenses', PURCHASES: 'Purchases', DEPOSITS: 'Deposits' },
    getUserSessionEnhanced: () => ({ username: 'sup', outlet: 'TS5' }),
    getGlobalSpreadsheet: () => ({
      getSheetByName: (n) => (sheets[n] ? { getDataRange: () => ({ getValues: () => sheets[n].map((r) => r.slice()) }) } : null),
    }),
    purchaseInvestmentColIndex_: () => -1,
    isInvestmentPurchaseRow_: () => false,
  })
  vm.runInContext(src('cashManagement.js'), ctx, { filename: 'cashManagement.js' })
  vm.runInContext(src('cashDailyReport.js'), ctx, { filename: 'cashDailyReport.js' })
  return ctx
}

const sheets = {
  Orders: [
    ['Timestamp', 'Order Number', 'Product Name', 'Quantity', 'Price', 'Payment', 'Total', 'Outlet'],
    [noon('2026-10-31'), 'A-001', 'Ayam', 1, 100000, 'Cash', 100000, 'TS5'],
    [noon('2026-11-01'), 'B-001', 'Ayam', 1, 50000, 'Cash', 50000, 'TS5'],
    [noon('2026-11-01'), 'B-002', 'Teh', 1, 20000, 'QRIS', 20000, 'TS5'],
    [noon('2026-11-02'), 'C-001', 'Ayam', 1, 30000, 'Cash', 30000, 'TS5'],
    [noon('2026-11-02'), 'X-001', 'Ayam', 1, 999999, 'Cash', 999999, 'TS4'], // other outlet
  ],
  Expenses: [
    ['Timestamp', 'Account', 'Amount', 'Payment', 'Outlet'],
    [noon('2026-11-01'), 'Gas', 10000, 'Cash', 'TS5'],
    [noon('2026-11-02'), 'Discount', 5000, 'QRIS', 'TS5'],
  ],
  Purchases: [
    ['Timestamp', 'Product', 'Total', 'Payment', 'Outlet'],
    [noon('2026-11-02'), 'Beras', 15000, 'Cash', 'TS5'],
  ],
  Deposits: [
    ['Timestamp', 'Amount', 'Account', 'Note', 'User', 'Outlet', 'PaymentMethod'],
    [noon('2026-11-01'), 20000, 'DANA', '', 'sup', 'TS5', 'QRIS'],
    [noon('2026-11-02'), 40000, 'BCA', '', 'sup', 'TS5', 'Transfer'],
  ],
}

test('per-day rows with daily net and running cash in hand (newest first)', () => {
  const ctx = setup(sheets)
  const r = plain(ctx.buildDailyCashReport_(ctx.getDailyCashSummary('dev', 'sup')))
  assert.deepEqual(r.days.map((d) => d.date), ['2026-11-02', '2026-11-01', '2026-10-31'])
  // 11-01: sales 70k − exp 10k − purch 0 − deposits 20k = 40k
  assert.equal(r.days[1].dailyNet, 40000)
  // 11-02: sales 30k − exp 5k − purch 15k − deposits 40k = −30k
  assert.equal(r.days[0].dailyNet, -30000)
  // running: 100k → 140k → 110k
  assert.deepEqual(r.days.map((d) => d.cashInHand), [110000, 140000, 100000])
  assert.equal(r.days[1].cashSales, 50000)
  assert.equal(r.days[0].depositsTransfer, 40000)
})

test('monthly subtotals use the month-end cash in hand; all-time total uses today\'s', () => {
  const ctx = setup(sheets)
  const r = plain(ctx.buildDailyCashReport_(ctx.getDailyCashSummary('dev', 'sup')))
  assert.deepEqual(r.months.map((m) => [m.month, m.days, m.totalSales, m.net, m.cashInHand]), [
    ['2026-11', 2, 100000, 10000, 110000],
    ['2026-10', 1, 100000, 100000, 100000],
  ])
  assert.equal(r.months[0].deposits, 60000)
  assert.deepEqual(r.months[0].salesByPaymentMethod, { Cash: 80000, QRIS: 20000 })
  assert.equal(r.total.totalSales, 200000)
  assert.equal(r.total.net, 110000)
  assert.equal(r.total.cashInHand, 110000)
  assert.deepEqual(r.salesMethods, ['Cash', 'QRIS'])
  assert.deepEqual(r.depositMethods, ['QRIS', 'Transfer'])
})

test('no data → empty report, no errors', () => {
  const ctx = setup({})
  const r = plain(ctx.buildDailyCashReport_(ctx.getDailyCashSummary('dev', 'sup')))
  assert.deepEqual(r.days, [])
  assert.deepEqual(r.months, [])
  assert.equal(r.total.cashInHand, 0)
})
