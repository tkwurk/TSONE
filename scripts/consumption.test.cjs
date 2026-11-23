const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const now = '2026-11-19T05:00:00Z'
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])) }
  static now() { return new Date(now).getTime() }
}

function app(options = {}) {
  const tables = {
    PRODUCTS: [
      ['Name', 'Category', 'Type', 'Product Code', 'BuyUnit', 'Active'],
      ['Rice', 'Food', 'Buy', 'RICE', 'kg', 'Y'],
      ['Sauce', 'Food', 'Buy', 'SAUCE', 'kg', 'Y'],
      ['Other', 'Food', 'Buy', 'OTHER', 'kg', 'Y'],
    ],
    ORDERS: [
      ['Timestamp', 'Order Number', 'Product Code', 'Quantity', 'Outlet'],
      [new TestDate('2026-11-17T20:00:00Z'), 'old', 'MEAL', 100, 'Main'],
      [new TestDate('2026-11-18T18:00:00Z'), 'one', 'MEAL', 2, 'Main'],
      [new TestDate('2026-11-19T01:00:00Z'), 'two', 'MEAL2', 3, 'Main'],
      [new TestDate('2026-11-19T02:00:00Z'), 'other', 'MEAL', 100, 'West'],
      [new TestDate('2026-11-19T02:00:00Z'), 'blank', 'MEAL', 100, ''],
    ],
    BOM: [
      ['BOM Id', 'BOM Item Id', 'Recipe Item Code', 'Item Quantity', 'Unit Product Code', 'Status'],
      ['1', '1', 'RICE', 2, 'MEAL', 'Active'],
      ['2', '2', 'RICE', 1, 'MEAL2', 'Active'],
      ['3', '3', 'SAUCE', 0.5, 'MEAL', 'Active'],
      ['4', '4', 'MISSING', 0.25, 'MEAL', 'Active'],
    ],
    BOM_USAGE: [],
    INVENTORY_CONSUMPTION: [
      ['Timestamp', 'Product Code', 'Quantity Consumed', 'Outlet', 'Username'],
      [new TestDate('2026-11-18T16:59:00Z'), 'RICE', 2, 'Main', 'operator'],
      [new TestDate('2026-11-18T17:00:00Z'), 'RICE', 3, 'Main', 'operator'],
      [new TestDate('2026-11-19T02:00:00Z'), 'RICE', 4, 'Main', 'operator'],
      [new TestDate('2026-11-19T02:00:00Z'), 'RICE', 90, 'West', 'other'],
      [new TestDate('2026-11-19T02:00:00Z'), 'RICE', 80, '', 'other'],
    ],
    STOCK_HISTORY: [],
    PURCHASES: [['Timestamp', 'Product Code', 'RQuantity', 'Outlet']],
    Keyfigures: [],
  }
  const cache = new Map()
  const session = options.session ?? { username: 'operator', deviceId: 'device', outlet: 'Main', allowedTabs: ['inventoryConsumption'] }
  const context = vm.createContext({
    Date: TestDate, Map,
    SHEETS: {},
    Logger: { log() {} },
    Session: { getScriptTimeZone: () => 'Asia/Jakarta' },
    getUserSessionEnhanced: (device, username) => device === 'device' && username === 'operator' ? session : null,
    CacheService: { getScriptCache: () => ({
      get: (key) => cache.get(key) ?? null,
      put: (key, value) => cache.set(key, value),
      remove: (key) => cache.delete(key),
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => 'test-request',
      formatDate(date, timeZone, format) {
        assert.equal(format, 'yyyy-MM-dd')
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(date).map((part) => [part.type, part.value]))
        return `${parts.year}-${parts.month}-${parts.day}`
      },
      parseDate() { throw new Error('Unsupported test date') },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) }),
    },
    getGlobalSpreadsheet: () => { throw new Error('Direct spreadsheet access is forbidden') },
  })
  for (const file of [
    'utils.js', 'accessControl.js', 'repo.gs', 'products.js', 'bom.js', 'consumptionPerformance.js',
    'inventoryConsumption.js', 'stockHistory.js', 'inventoryWorker.gs', 'reportingWorker.gs',
    'orchestrator.gs', 'apiRouter.gs',
  ]) {
    vm.runInContext(readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8'), context, { filename: file })
  }
  context.getAppTimeZone_ = () => 'Asia/Jakarta'
  context.formatDateForComparison = (date) => context.getAppDateKey_(date)
  context.Repo.adapter = {
    getValues(name) {
      const headerOnly = name.endsWith('!1:1')
      const table = headerOnly ? name.slice(0, -4) : name
      if (!(table in tables)) throw new Error('Unexpected collection: ' + name)
      return headerOnly ? tables[table].slice(0, 1) : tables[table]
    },
    ensureTable(name, headers) {
      if (!tables[name].length) tables[name] = [Array.from(headers)]
    },
    appendRows(name, rows) { tables[name].push(...rows) },
  }
  context.WorkflowLog.record = () => {}
  context.ErrorHandler = { wrap(step, run) {
    try { return run() } catch (error) { return context.apiFail(error.message, 'TEST_ERROR') }
  } }
  function request(eventType, payload = {}, auth = { username: 'operator', deviceId: 'device', outlet: 'West' }) {
    return context.doPost({ postData: { contents: JSON.stringify({ eventType, payload: { ...payload, _authContext: auth } }) } })
  }
  return { request, tables }
}

function step(result, name) {
  assert.equal(result.success, true, result.error)
  return result.data.steps[name].data
}

test('closing suggests full-day BOM totals across sold products for the session outlet', () => {
  const closing = step(app().request('consumption.closing.requested'), 'consumptionClosing')
  assert.equal(closing.autoPrefill.date, '2026-11-19')
  assert.deepEqual(closing.products.map((product) => product.productCode), ['RICE', 'SAUCE', 'OTHER'])
  assert.deepEqual(closing.autoPrefill.items.map((item) => [item.productCode, item.quantity]), [['RICE', 7], ['SAUCE', 1]])
  assert.deepEqual(closing.autoPrefill.missingProductCodes, ['MISSING'])
  assert.equal(closing.summary.totalQuantity, 7)
})

test('daily report groups recorded entries by Jakarta date and authenticated outlet', () => {
  const result = step(app().request('consumption.history.requested', {
    startDate: '2026-11-18', endDate: '2026-11-19', outlet: 'West',
  }), 'consumptionHistory')
  assert.deepEqual(result.rows.map((row) => [row.date, row.productCode, row.name, row.quantity]), [
    ['2026-11-19', 'RICE', 'Rice', 7], ['2026-11-18', 'RICE', 'Rice', 2],
  ])
})

test('closing and history reject invalid sessions, permissions, and date ranges', () => {
  const denied = app({ session: { username: 'operator', outlet: 'Main', allowedTabs: [] } })
  assert.equal(denied.request('consumption.closing.requested').success, false)
  assert.equal(denied.request('consumption.history.requested', { startDate: '2026-11-18', endDate: '2026-11-19' }).success, false)
  const instance = app()
  assert.equal(instance.request('consumption.closing.requested', {}, {}).success, false)
  assert.equal(instance.request('consumption.history.requested', { startDate: '2026-11-31', endDate: '2026-12-01' }).success, false)
  assert.equal(instance.request('consumption.history.requested', { startDate: '2026-11-19', endDate: '2026-11-18' }).success, false)
})

test('save validates products and quantities, uses session outlet and deduplicates request IDs', () => {
  const instance = app()
  const payload = { items: [{ productCode: 'RICE', quantity: 1.5 }], clientRequestId: 'request-1' }
  const before = instance.tables.INVENTORY_CONSUMPTION.length
  step(instance.request('consumption.recorded', payload), 'consumptionRecord')
  step(instance.request('consumption.recorded', payload), 'consumptionRecord')
  assert.equal(instance.tables.INVENTORY_CONSUMPTION.length, before + 1)
  assert.equal(instance.tables.INVENTORY_CONSUMPTION.at(-1)[3], 'Main')
  assert.equal(instance.request('consumption.recorded', { ...payload, clientRequestId: 'request-2', items: [{ productCode: 'BAD', quantity: 2 }] }).success, false)
  assert.equal(instance.request('consumption.recorded', { ...payload, clientRequestId: 'request-3', items: [{ productCode: 'RICE', quantity: -1 }] }).success, false)
  assert.equal(instance.tables.INVENTORY_CONSUMPTION.length, before + 1)
})
