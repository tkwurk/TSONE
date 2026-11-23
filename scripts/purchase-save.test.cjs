const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const headers = [
  'Timestamp', 'Supplier', 'Product Name', 'Product Code', 'Quantity', 'Price',
  'Category', 'Buy Unit', 'Buy Unit Size', 'Total', 'Account', 'Outlet',
  'Username', 'Purchase ID', '_selectingPayment', 'Expiry Date', 'Mode', '', 'PSTATUS', 'RQUANTITY',
]
const misc = { productName: 'Paper towels', name: 'Paper towels', qty: 2.5, price: 120, category: 'Supplies', expiryDate: '2027-02-28', mode: '', isMisc: true }

function setup(options = {}) {
  const purchaseRows = [(options.headers || headers).slice(), ...(options.rows || [])]
  const accounts = [['Name', 'Type'], ['Expenses', 'Expense'], ['Equipment', 'Investment']]
  let locked = false
  let writes = 0
  let fullReads = 0
  const cache = options.cache || new Map()
  const context = vm.createContext({
    Date, SHEETS: { PURCHASES: 'Purchases', ACCOUNTS: 'Accounts' },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(locked, false); locked = true },
      releaseLock() { assert.equal(locked, true); locked = false },
    }) },
    getUserSessionEnhanced: () => ({ outlet: 'Main', username: 'operator' }),
    requireAuth_: (params) => {
      if (!params._authContext || params._authContext.deviceId !== 'device') throw new Error('Invalid session')
      return { username: 'operator', outlet: 'Main', allowedTabs: options.tabs || ['purchasing'] }
    },
    resolveEffectiveTabsFromSession: (session) => session.allowedTabs,
    buildColumnMap: () => ({ NAME: 0, TYPE: 1 }),
    normalizeAccountNameKey_: (name) => String(name || '').trim().toLowerCase(),
    formatTimestampForSheet: (date) => new Date(date),
    invalidatePnLCache_: (outlet) => assert.equal(outlet, 'Main'),
    withAgentGuard_: (label, params, fn) => fn(),
    buildIdempotencyCacheKey_: (prefix, id) => (id ? prefix + id : ''),
    getIdempotentResult_: (key) => (cache.has(key) ? JSON.parse(cache.get(key)) : null),
    putIdempotentResult_: (key, value) => { cache.set(key, JSON.stringify(value)) },
    apiOk: (data, code) => ({ success: true, data, code }),
    apiFail: (error, code) => ({ success: false, error: String(error), code }),
  })
  vm.runInContext(readFileSync(path.join(__dirname, '..', 'apps-script-source', 'repo.gs'), 'utf8'), context)
  vm.runInContext(readFileSync(path.join(__dirname, '..', 'apps-script-source', 'purchases.js'), 'utf8'), context)
  context.Repo.adapter = {
    getValues(name) {
      if (name === 'Accounts') return accounts.map((r) => r.slice())
      assert.equal(locked, true)
      if (name === 'Purchases!1:1') return [purchaseRows[0].slice()]
      assert.equal(name, 'Purchases')
      fullReads++
      return purchaseRows.map((r) => r.slice())
    },
    updateValues(range, rows) {
      assert.equal(locked, true)
      assert.match(range, /^Purchases![A-Z]+1:[A-Z]+1$/)
      purchaseRows[0].push(...rows[0])
    },
    appendRows(name, rows) {
      assert.equal(name, 'Purchases')
      assert.equal(locked, true)
      if (options.failWrite) throw new Error('Write failed')
      writes++
      purchaseRows.push(...rows.map((r) => Array.from(r)))
    },
  }
  const submit = (items = [misc], extra = {}) => context.recordPurchase({
    id: 'test-id', username: 'operator', deviceId: 'device', outlet: 'Main',
    account: 'Expenses', payment: 'Cash', items, ...extra,
  })
  return { submit, secure: (params) => context.recordPurchaseSecure(params), purchaseRows, writes: () => writes, locked: () => locked, fullReads: () => fullReads }
}

test('saves misc and normal lines with legacy layout and investment fields in one append', () => {
  const app = setup()
  const result = app.submit([misc, { productName: 'Rice', code: 'RICE', qty: 3, price: 20, supplier: 'Shop', category: 'Food', mode: 'L' }], { account: 'Equipment' })
  assert.equal(result.success, true)
  assert.equal(app.writes(), 1)
  assert.deepEqual(app.purchaseRows[0].slice(20), ['Is Investment', 'Source Account'])
  const [first, second] = app.purchaseRows.slice(1)
  assert.ok(first[0] instanceof Date)
  assert.deepEqual(first.slice(1), ['', 'Paper towels', '', 2.5, 120, 'Supplies', '', '', 300, 'Equipment', 'Main', 'operator', 'test-id', 'Cash', '2027-02-28', '', '', 'ORDERED', '', 'Y', ''])
  assert.deepEqual(second.slice(1), ['Shop', 'Rice', 'RICE', 3, 20, 'Food', '', '', 60, 'Equipment', 'Main', 'operator', 'test-id', 'Cash', '', 'L', '', 'ORDERED', '', 'Y', ''])
  assert.equal(app.locked(), false)
})

test('existing investment columns and extra columns remain aligned', () => {
  const app = setup({ headers: [...headers, 'Other', 'Source Account', 'Is Investment'] })
  assert.equal(app.submit().success, true)
  assert.deepEqual(app.purchaseRows[1].slice(20), ['', '', ''])
  assert.equal(app.purchaseRows[0].length, 23)
})

test('a re-delivered purchase (same id) is rejected without scanning the sheet', () => {
  const app = setup()
  assert.equal(app.submit().success, true)
  assert.equal(app.submit().code, 'PURCHASE_DUPLICATE')
  assert.equal(app.writes(), 1)
  assert.equal(app.fullReads(), 0)
  assert.equal(app.locked(), false)
})

test('invalid manual details never write', () => {
  for (const patch of [
    { productName: ' ' }, { qty: 0 }, { qty: -1 }, { qty: 'x' },
    { price: 0 }, { price: -1 }, { price: 'x' }, { category: ' ' },
    { expiryDate: '2027-02-30' }, { expiryDate: 'nonsense' },
  ]) {
    const app = setup()
    assert.equal(app.submit([{ ...misc, ...patch }]).success, false, JSON.stringify(patch))
    assert.equal(app.writes(), 0)
  }
})

test('missing purchase columns or failed append return errors and release lock', () => {
  const missing = setup({ headers: headers.slice(0, 19) })
  assert.equal(missing.submit().success, false)
  assert.equal(missing.locked(), false)
  const failed = setup({ failWrite: true })
  assert.match(failed.submit().error, /Write failed/)
  assert.equal(failed.locked(), false)
})

test('secure save requires permission and uses session outlet rather than client outlet', () => {
  const denied = setup({ tabs: ['orders'] })
  const params = { _authContext: { username: 'operator', deviceId: 'device', outlet: 'Other' }, items: [misc], account: 'Expenses', payment: 'Cash' }
  const deniedResult = denied.secure(params)
  assert.equal(deniedResult.code, 'PURCHASE_FORBIDDEN')
  assert.equal(denied.writes(), 0)
  const allowed = setup({ tabs: ['purchasingLocal'] })
  const result = allowed.secure(params)
  assert.equal(result.success, true)
  assert.equal(allowed.purchaseRows[1][11], 'Main')
})
