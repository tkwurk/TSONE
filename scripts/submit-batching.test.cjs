// Guards the "fast submit" changes: multi-row submissions must hit the sheet
// with a constant number of calls, and routine pipeline traces must not
// append to the WorkflowLog sheet.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const src = (file) => readFileSync(path.join(__dirname, '..', 'apps-script-source', file), 'utf8')

/** In-memory sheet that counts every write call. */
function fakeSheet(rows) {
  const data = rows.map((r) => r.slice())
  const calls = { setValues: 0, setValue: 0, appendRow: 0 }
  const sheet = {
    data,
    calls,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(0, ...data.map((r) => r.length)),
    getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
    appendRow(row) { calls.appendRow++; data.push(row.slice()) },
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues: () => data.slice(row - 1, row - 1 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols)),
        setValue(v) { calls.setValue++; (data[row - 1] ||= [])[col - 1] = v },
        setValues(values) {
          calls.setValues++
          values.forEach((vals, i) => {
            const target = (data[row - 1 + i] ||= [])
            vals.forEach((v, j) => { target[col - 1 + j] = v })
          })
        },
      }
    },
  }
  return sheet
}

function load(files, globals) {
  const context = vm.createContext({ Logger: { log() {} }, ...globals })
  for (const f of files) vm.runInContext(src(f), context, { filename: f })
  return context
}

test('writeRowsBack_ writes consecutive rows + contiguous columns in one call', () => {
  const ctx = load(['utils.js'], {})
  const sheet = fakeSheet([['h1', 'h2', 'h3', 'h4'], ['a', '', '', 'x'], ['b', '', '', 'y'], ['c', '', '', 'z']])
  const data = sheet.getDataRange().getValues()
  data[1][1] = 1; data[1][2] = 2; data[2][1] = 3; data[2][2] = 4
  ctx.writeRowsBack_(sheet, data, [1, 2], [1, 2])
  assert.equal(sheet.calls.setValues, 1)
  assert.deepEqual(sheet.data.slice(1, 3), [['a', 1, 2, 'x'], ['b', 3, 4, 'y']])
  assert.deepEqual(sheet.data[3], ['c', '', '', 'z'])
})

test('morning attendance appends the whole team in one write', () => {
  const sheet = fakeSheet([['attendance_id', 'employee_id', 'date', 'start_time', 'end_time', 'work_hours', 'status']])
  const ctx = load(['utils.js', 'attendance.js'], {
    SHEETS: { ATTENDANCE: 'Attendance' },
    SHEET_HEADER_ROWS: { ATTENDANCE: [] },
    getGlobalSpreadsheet: () => ({ getSheetByName: () => sheet }),
    requirePermission_: (params, tab) => {
      const a = params._authContext || {}
      if (a.deviceId !== 'dev' || a.username !== 'sup') throw new Error('Invalid or expired session')
      if (tab !== 'attendance') throw new Error('Permission denied: ' + tab)
      return { username: 'sup' }
    },
  })
  const entries = ['E1', 'E2', 'E3', 'E4'].map((id) => ({ employee_id: id, start_time: '08:00' }))
  const res = ctx.recordMorningAttendance({ date: '2026-11-23', entries }, 'dev', 'sup')
  // No/invalid session → refused before touching the sheet.
  assert.throws(() => ctx.recordMorningAttendance({ date: '2026-11-23', entries }), /session/)
  assert.throws(() => ctx.getAttendanceForDate('2026-11-23', 'dev', 'intruder'), /session/)
  assert.equal(res.recorded, 4)
  assert.equal(sheet.calls.appendRow, 0)
  assert.equal(sheet.calls.setValues, 1)
  assert.equal(sheet.data.length, 5)
  // Re-submitting the same day skips everyone and writes nothing.
  const again = ctx.recordMorningAttendance({ date: '2026-11-23', entries }, 'dev', 'sup')
  assert.equal(again.skipped, 4)
  assert.equal(sheet.calls.setValues, 1)
})

test('evening attendance writes end/hours/status with one call per employee row', () => {
  const sheet = fakeSheet([
    ['attendance_id', 'employee_id', 'date', 'start_time', 'end_time', 'work_hours', 'status'],
    ['A1', 'E1', '2026-11-23', '08:00', '', '', 'Present'],
    ['A2', 'E2', '2026-11-23', '09:00', '', '', 'Present'],
  ])
  const ctx = load(['utils.js', 'attendance.js'], {
    SHEETS: { ATTENDANCE: 'Attendance' },
    getGlobalSpreadsheet: () => ({ getSheetByName: () => sheet }),
    requirePermission_: (params, tab) => {
      const a = params._authContext || {}
      if (a.deviceId !== 'dev' || a.username !== 'sup') throw new Error('Invalid or expired session')
      if (tab !== 'attendance') throw new Error('Permission denied: ' + tab)
      return { username: 'sup' }
    },
  })
  const res = ctx.recordEveningAttendance({
    date: '2026-11-23',
    entries: [{ employee_id: 'E1', end_time: '17:00' }, { employee_id: 'E2', end_time: '18:00', status: 'Late' }],
  }, 'dev', 'sup')
  assert.equal(res.updated, 2)
  assert.equal(sheet.calls.setValue, 0)
  assert.equal(sheet.calls.setValues, 1) // rows 2-3 are consecutive → one block
  assert.equal(sheet.data[1][4], '17:00')
  assert.equal(sheet.data[1][6], 'Present')
  assert.equal(sheet.data[2][4], '18:00')
  assert.equal(sheet.data[2][6], 'Late')
  assert.ok(sheet.data[1][5] !== '')
})

test('routine pipeline traces never touch the WorkflowLog sheet; failures still do', () => {
  let opened = 0
  const ctx = load(['orchestrator.gs'], {
    getGlobalSpreadsheet: () => { opened++; return { getSheetByName: () => ({ appendRow() {} }) } },
  })
  for (const status of ['START', 'OK', 'DONE']) ctx.WorkflowLog.record('r', 'checkout.completed', 'pipeline', status, {})
  ctx.WorkflowLog.record('r', 'checkout.completed', 'sales', 'START', {})
  assert.equal(opened, 0)
  ctx.WorkflowLog.record('r', 'checkout.completed', 'sales', 'FAIL', {})
  assert.equal(opened, 1)
})

test('receive requires a real session, permission, and the same outlet', () => {
  const header = Array(20).fill('h'); header[11] = 'Outlet'; header[18] = 'PSTATUS'; header[19] = 'RQUANTITY'
  const mine = Array(20).fill(''); mine[11] = 'Main'; mine[18] = 'ORDERED'
  const theirs = Array(20).fill(''); theirs[11] = 'Other'; theirs[18] = 'ORDERED'
  const sheet = fakeSheet([header, mine, theirs])
  const sessions = { good: { username: 'op', outlet: 'Main', allowedTabs: ['purchasingReceive'] },
                     cashier: { username: 'op', outlet: 'Main', allowedTabs: ['orders'] } }
  const ctx = load(['purchases.js'], {
    SHEETS: { PURCHASES: 'Purchases' },
    getGlobalSpreadsheet: () => ({ getSheetByName: () => sheet }),
    requireAuth_: (p) => {
      const s = sessions[(p._authContext || {}).deviceId]
      if (!s) throw new Error('Invalid or expired session')
      return s
    },
    resolveEffectiveTabsFromSession: (s) => s.allowedTabs,
  })
  const call = (deviceId, rowIndex) => ctx.updateReceiveQuantitySecure({ rowIndex, rquantity: 4, _authContext: { username: 'op', deviceId } })
  assert.match(call('forged', 2).error, /session/)
  assert.match(call('cashier', 2).error, /Permission denied/)
  assert.match(call('good', 3).error, /another outlet/)
  assert.equal(sheet.data[2][18], 'ORDERED')
  assert.equal(call('good', 2).success, true)
  assert.deepEqual([sheet.data[1][18], sheet.data[1][19]], ['RECEIVED', 4])
  assert.equal(sheet.calls.setValues, 1)
  assert.equal(sheet.calls.setValue, 0)
})

test('expenses and deposits are refused without a valid session', () => {
  let writes = 0
  const sheet = { getLastRow: () => 1, appendRow() { writes++ } }
  const ctx = load(['expenses.js', 'deposits.js'], {
    SHEETS: { EXPENSES: 'Expenses', DEPOSITS: 'Deposits' },
    SHEET_HEADER_ROWS: { EXPENSES: [], DEPOSITS: [] },
    getGlobalSpreadsheet: () => ({ getSheetByName: () => sheet }),
    getUserSessionEnhanced: () => null,
    requirePermission_: () => { throw new Error('Invalid or expired session') },
    formatTimestampForSheet: (d) => d,
    invalidatePnLCache_: () => {},
    apiOk: (data, code) => ({ success: true, data, code }),
    apiFail: (error, code) => ({ success: false, error: String(error), code }),
  })
  const auth = { username: 'op', deviceId: 'forged', outlet: 'Main' }
  assert.equal(ctx.recordExpenseSecure({ amount: 5, account: 'Discount', _authContext: auth }).success, false)
  assert.equal(ctx.recordDepositSecure({ amount: 5, account: 'Bank', _authContext: auth }).success, false)
  assert.equal(ctx.recordExpense({ amount: 5, deviceId: 'forged', username: 'op' }).code, 'EXPENSE_SESSION_INVALID')
  assert.equal(ctx.recordDeposit({ amount: 5, deviceId: 'forged', username: 'op' }).code, 'DEPOSIT_SESSION_INVALID')
  assert.equal(writes, 0)
})
