/**
 * cashWarehouse.js — Incremental daily cash warehouse for Deposits ▸ Daily summary.
 *
 * Instead of reading Orders / Expenses / Purchases / Deposits in full on every
 * report, per-day totals live in DailyCashWarehouse (one row per day + outlet).
 * WarehouseState keeps, per source sheet, how many data rows were processed and
 * a fingerprint of the last one. A sync reads only rows appended since then and
 * adds them to their days.
 *
 * A source is re-read in full (its columns rebuilt) only when:
 *  - it was never loaded, or rows were removed (row count went down),
 *  - the last processed row changed (fingerprint mismatch: edits/reordering),
 *  - it was flagged by markForRebuild (admin order edits/deletes),
 *  - the weekly full rebuild is due (catches edits made directly in the Sheet).
 *
 * The per-row rules mirror getDailyCashSummary (cashManagement.js) exactly, so
 * the report's numbers do not change. Reads/writes go through Repo; the sync's
 * read-modify-write runs under a short script lock.
 */

var CASH_WAREHOUSE_HEADERS = [
  'Date', 'Outlet', 'Total Sales', 'Cash Sales', 'Sales By Method',
  'Cash Expenses', 'Deductible Expenses', 'Cash Purchases',
  'Deposits', 'Deposits QRIS', 'Deposits Transfer', 'Deposits By Method', 'Updated At'
];
var WAREHOUSE_STATE_HEADERS = ['Source', 'Rows Processed', 'Fingerprint', 'Needs Rebuild', 'Last Full Rebuild', 'Updated At'];
var CASH_WAREHOUSE_FULL_REBUILD_MS = 7 * 24 * 3600 * 1000;

var CashWarehouse = {

  /** Source sheet → warehouse fields it owns. */
  SOURCES: {
    ORDERS: { fields: ['totalSales', 'cashSales'], maps: ['salesByMethod'] },
    EXPENSES: { fields: ['cashExpenses', 'deductibleExpenses'], maps: [] },
    PURCHASES: { fields: ['cashPurchases'], maps: [] },
    DEPOSITS: { fields: ['deposits', 'depositsQris', 'depositsTransfer'], maps: ['depositsByMethod'] }
  },

  COLUMN: {
    totalSales: 'Total Sales', cashSales: 'Cash Sales', salesByMethod: 'Sales By Method',
    cashExpenses: 'Cash Expenses', deductibleExpenses: 'Deductible Expenses', cashPurchases: 'Cash Purchases',
    deposits: 'Deposits', depositsQris: 'Deposits QRIS', depositsTransfer: 'Deposits Transfer',
    depositsByMethod: 'Deposits By Method'
  },

  /**
   * Bring the warehouse up to date. Cheap when nothing changed (one row-count
   * probe per source); otherwise reads only the new rows.
   * @return {{ ok: boolean, skipped?: string, sources: Object }}
   */
  sync: function (options) {
    options = options || {};
    // Document lock (bound script): never queues behind checkout / login, which use the script lock.
    var lock = (typeof LockService.getDocumentLock === 'function' && LockService.getDocumentLock()) || LockService.getScriptLock();
    if (!lock.tryLock(options.lockMs || 8000)) return { ok: false, skipped: 'busy', sources: {} };
    try {
      Repo.ensureTable('CASH_WAREHOUSE', CASH_WAREHOUSE_HEADERS);
      Repo.ensureTable('WAREHOUSE_STATE', WAREHOUSE_STATE_HEADERS);
      var stateTable = Repo.readTable('WAREHOUSE_STATE');
      var state = {};
      stateTable.rows.forEach(function (r, i) { state[String(r['Source'])] = { row: r, index: i }; });
      var days = this._readWarehouse_();
      var now = new Date();
      var report = {};
      var changed = false;
      var self = this;

      Object.keys(this.SOURCES).forEach(function (source) {
        var st = state[source] ? state[source].row : null;
        var processed = st ? Number(st['Rows Processed']) || 0 : 0;
        var lastFull = st && st['Last Full Rebuild'] ? new Date(st['Last Full Rebuild']).getTime() : 0;
        var due = !st || String(st['Needs Rebuild']).toUpperCase() === 'Y' || options.full ||
          !(now.getTime() - lastFull < CASH_WAREHOUSE_FULL_REBUILD_MS);
        var total = Repo.readRowsFromEnd(source, 0, 0).totalRows;
        var mode = 'unchanged';
        var rowsRead = 0;
        var fingerprint = st ? String(st['Fingerprint'] || '') : '';

        if (!due && total < processed) due = true; // rows removed
        if (!due && processed > 0) {
          // Re-read the last processed row with any new rows after it.
          var tail = Repo.readRowsFromEnd(source, 0, total - processed + 1);
          rowsRead = tail.rows.length;
          if (!tail.rows.length || self._fingerprint_(tail.headers, tail.rows[0]) !== fingerprint) {
            due = true;
          } else if (tail.rows.length > 1) {
            self._apply_(days, source, tail.headers, tail.rows.slice(1));
            fingerprint = self._fingerprint_(tail.headers, tail.rows[tail.rows.length - 1]);
            processed = total;
            mode = 'incremental';
            changed = true;
          }
        } else if (!due && total > 0) {
          due = true;
        }

        if (due) {
          var all = Repo.readTable(source);
          rowsRead = all.rows.length;
          self._clearSource_(days, source);
          self._apply_(days, source, all.headers, all.rows);
          processed = all.rows.length;
          fingerprint = processed ? self._fingerprint_(all.headers, all.rows[processed - 1]) : '';
          lastFull = now.getTime();
          mode = 'rebuilt';
          changed = true;
        }

        report[source] = { mode: mode, rowsRead: rowsRead, rows: processed };
        if (mode !== 'unchanged' || !st) {
          var rec = {
            'Source': source,
            'Rows Processed': processed,
            'Fingerprint': fingerprint,
            'Needs Rebuild': 'N',
            'Last Full Rebuild': lastFull ? new Date(lastFull).toISOString() : '',
            'Updated At': now.toISOString()
          };
          if (state[source]) self._writeRow_('WAREHOUSE_STATE', stateTable.headers, state[source].index, rec);
          else Repo.appendObjects('WAREHOUSE_STATE', rec);
        }
      });

      if (changed) this._writeWarehouse_(days, now);
      return { ok: true, sources: report };
    } finally {
      lock.releaseLock();
    }
  },

  /** Flag sources for a full re-read on the next sync (after admin edits/deletes). Never throws. */
  markForRebuild: function (sources) {
    try {
      var table = Repo.readTable('WAREHOUSE_STATE');
      var self = this;
      table.rows.forEach(function (r, i) {
        if (sources.indexOf(String(r['Source'])) === -1) return;
        r['Needs Rebuild'] = 'Y';
        self._writeRow_('WAREHOUSE_STATE', table.headers, i, r);
      });
    } catch (e) {
      try { Logger.log('CashWarehouse.markForRebuild: ' + e); } catch (e2) { /* ignore */ }
    }
  },

  /**
   * Per-day rows for one outlet in getDailyCashSummary's shape (newest first,
   * running cash in hand), read from the warehouse only.
   */
  dailyRows: function (userOutlet) {
    var days = this._readWarehouse_();
    var merged = {};
    var self = this;
    Object.keys(days).forEach(function (k) {
      var d = days[k];
      if (userOutlet && d.outlet !== '*' && d.outlet !== userOutlet) return;
      var m = merged[d.date] || (merged[d.date] = self._emptyDay_(d.date, ''));
      self._allFields_().forEach(function (f) { m[f] += d[f]; });
      ['salesByMethod', 'depositsByMethod'].forEach(function (mp) {
        Object.keys(d[mp]).forEach(function (key) { m[mp][key] = (m[mp][key] || 0) + d[mp][key]; });
      });
    });
    var rows = Object.keys(merged).sort(function (a, b) { return b.localeCompare(a); }).map(function (date) {
      var d = merged[date];
      return {
        date: date,
        month: date.substring(0, 7),
        totalSales: d.totalSales,
        cashSales: d.cashSales,
        cashExpenses: d.cashExpenses,
        deductibleExpenses: d.deductibleExpenses,
        cashPurchases: d.cashPurchases,
        deposits: d.deposits,
        depositsQris: d.depositsQris,
        depositsTransfer: d.depositsTransfer,
        salesByPaymentMethod: d.salesByMethod,
        depositsByPaymentMethod: d.depositsByMethod,
        cashInHand: 0
      };
    });
    var running = 0;
    for (var i = rows.length - 1; i >= 0; i--) {
      running += rows[i].totalSales - rows[i].deductibleExpenses - rows[i].cashPurchases - rows[i].deposits;
      rows[i].cashInHand = running;
    }
    return rows;
  },

  // ── Per-row rules (same as getDailyCashSummary) ──────────────────────────

  _apply_: function (days, source, headers, rows) {
    var find = function (re) { for (var i = 0; i < headers.length; i++) if (headers[i] && re.test(headers[i])) return headers[i]; return null; };
    var dateCol = find(/timestamp|date/i);
    var outletCol = find(/outlet/i);
    var self = this;
    var invIdx = source === 'PURCHASES' && typeof purchaseInvestmentColIndex_ === 'function' ? purchaseInvestmentColIndex_(headers) : -1;
    var amountCol, payCol, accountCol, methodCol;
    if (source === 'ORDERS' || source === 'PURCHASES') { amountCol = find(/total|amount/i); payCol = find(/payment/i); }
    if (source === 'EXPENSES') { amountCol = find(/amount|total/i); payCol = find(/payment/i); }
    if (source === 'DEPOSITS') { amountCol = find(/amount|total/i); accountCol = find(/account/i); methodCol = find(/paymentmethod|payment.method/i); }

    rows.forEach(function (row) {
      var dk = self._dayKey_(dateCol ? row[dateCol] : null);
      if (!dk) return;
      var outlet = outletCol ? String(row[outletCol] == null ? '' : row[outletCol]) : '*';
      if (source === 'ORDERS') {
        var pay = payCol ? String(row[payCol] || '').trim() : 'cash';
        var amt = Number(row[amountCol]) || 0;
        var d = self._day_(days, dk, outlet);
        d.totalSales += amt;
        if (pay.toLowerCase() === 'cash') d.cashSales += amt;
        if (pay) d.salesByMethod[pay] = (d.salesByMethod[pay] || 0) + amt;
      } else if (source === 'EXPENSES') {
        var ep = payCol ? String(row[payCol] || '').toLowerCase().trim() : 'cash';
        var ea = Number(row[amountCol]) || 0;
        if (ep === 'cash') self._day_(days, dk, outlet).cashExpenses += ea;
        if (['cash', 'partial', 'qris', 'dana', 'free'].indexOf(ep) !== -1) self._day_(days, dk, outlet).deductibleExpenses += ea;
      } else if (source === 'PURCHASES') {
        if (invIdx >= 0 && typeof isInvestmentPurchaseRow_ === 'function' &&
            isInvestmentPurchaseRow_(headers.map(function (h) { return row[h]; }), invIdx)) return;
        var pp = payCol ? String(row[payCol] || '').toLowerCase().trim() : 'cash';
        if (pp === 'cash') self._day_(days, dk, outlet).cashPurchases += Number(row[amountCol]) || 0;
      } else if (source === 'DEPOSITS') {
        var da = Number(row[amountCol]) || 0;
        if (da <= 0) return;
        var dd = self._day_(days, dk, outlet);
        dd.deposits += da;
        var acct = accountCol ? String(row[accountCol] || '').toUpperCase().trim() : '';
        var payKey = methodCol ? String(row[methodCol] || '').trim() : '';
        var isQris = payKey ? (payKey.toLowerCase() === 'qris' || payKey.toLowerCase() === 'dana') : acct === 'DANA';
        if (isQris) dd.depositsQris += da; else dd.depositsTransfer += da;
        var mk = payKey || (isQris ? 'qris' : 'transfer');
        dd.depositsByMethod[mk] = (dd.depositsByMethod[mk] || 0) + da;
      }
    });
  },

  /** Same calendar-day key as getDailyCashSummary (script time zone). */
  _dayKey_: function (val) {
    var d = (val instanceof Date) ? val : new Date(val);
    if (!val || !d || isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  },

  _fingerprint_: function (headers, row) {
    return headers.map(function (h) {
      var v = row[h];
      return v instanceof Date ? v.toISOString() : String(v == null ? '' : v);
    }).join('\u0001').slice(0, 500);
  },

  // ── Warehouse storage ───────────────────────────────────────────────────

  _allFields_: function () {
    return ['totalSales', 'cashSales', 'cashExpenses', 'deductibleExpenses', 'cashPurchases', 'deposits', 'depositsQris', 'depositsTransfer'];
  },

  _emptyDay_: function (date, outlet) {
    var d = { date: date, outlet: outlet, salesByMethod: {}, depositsByMethod: {} };
    this._allFields_().forEach(function (f) { d[f] = 0; });
    return d;
  },

  _day_: function (days, date, outlet) {
    var k = date + '\u0001' + outlet;
    return days[k] || (days[k] = this._emptyDay_(date, outlet));
  },

  _clearSource_: function (days, source) {
    var spec = this.SOURCES[source];
    Object.keys(days).forEach(function (k) {
      spec.fields.forEach(function (f) { days[k][f] = 0; });
      spec.maps.forEach(function (m) { days[k][m] = {}; });
    });
  },

  _readWarehouse_: function () {
    var days = {};
    var self = this;
    var dateOf = function (v) {
      // Sheets may turn "yyyy-MM-dd" into a Date cell.
      return v instanceof Date ? self._dayKey_(v) : String(v || '').replace(/^'/, '').slice(0, 10);
    };
    var json = function (v) { try { return JSON.parse(String(v || '{}')) || {}; } catch (e) { return {}; } };
    Repo.readTable('CASH_WAREHOUSE').rows.forEach(function (r) {
      var date = dateOf(r['Date']);
      if (!date) return;
      var d = self._day_(days, date, String(r['Outlet'] == null ? '' : r['Outlet']));
      self._allFields_().forEach(function (f) { d[f] += Number(r[self.COLUMN[f]]) || 0; });
      d.salesByMethod = json(r['Sales By Method']);
      d.depositsByMethod = json(r['Deposits By Method']);
    });
    return days;
  },

  _writeWarehouse_: function (days, now) {
    var self = this;
    var rows = Object.keys(days).map(function (k) { return days[k]; }).filter(function (d) {
      return self._allFields_().some(function (f) { return d[f] !== 0; }) ||
        Object.keys(d.salesByMethod).length || Object.keys(d.depositsByMethod).length;
    }).sort(function (a, b) { return a.date.localeCompare(b.date) || a.outlet.localeCompare(b.outlet); });
    Repo.replaceRows('CASH_WAREHOUSE', rows.map(function (d) {
      var o = { 'Date': "'" + d.date, 'Outlet': d.outlet, 'Updated At': now.toISOString() };
      self._allFields_().forEach(function (f) { o[self.COLUMN[f]] = d[f]; });
      o['Sales By Method'] = JSON.stringify(d.salesByMethod);
      o['Deposits By Method'] = JSON.stringify(d.depositsByMethod);
      return o;
    }));
  },

  _writeRow_: function (collection, headers, index, obj) {
    var values = headers.map(function (h) { return obj[h] == null ? '' : obj[h]; });
    var r = index + 2;
    var col = '', n = headers.length;
    while (n > 0) { var m = (n - 1) % 26; col = String.fromCharCode(65 + m) + col; n = Math.floor((n - 1) / 26); }
    Repo.updateRange(collection, 'A' + r + ':' + col + r, [values]);
  }
};

/** Run from the Apps Script editor to rebuild the warehouse from all rows now. */
function rebuildCashWarehouse() {
  var result = CashWarehouse.sync({ full: true, lockMs: 30000 });
  Logger.log('rebuildCashWarehouse: ' + JSON.stringify(result));
  return result;
}

/** Nightly time trigger: keeps the warehouse current (and does the weekly rebuild) off-hours. */
function runCashWarehouseSync() {
  return CashWarehouse.sync({ lockMs: 30000 });
}

/** Installs the nightly sync once (checked at most daily). Never throws. */
CashWarehouse.ensureNightlyTrigger = function () {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('cash_wh_trigger_ok')) return;
    var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runCashWarehouseSync'; });
    if (!exists) ScriptApp.newTrigger('runCashWarehouseSync').timeBased().atHour(3).nearMinute(30).everyDays(1).create();
    cache.put('cash_wh_trigger_ok', '1', 24 * 3600);
  } catch (e) {
    try { Logger.log('CashWarehouse.ensureNightlyTrigger: ' + e); } catch (e2) { /* ignore */ }
  }
};
