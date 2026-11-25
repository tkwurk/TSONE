/**
 * shiftWorker.gs — Shift Worker agent: end-of-shift handover reports.
 *
 * Owns the ShiftReports collection. A shift report records, for one outlet and
 * business day: the cash counted at handover vs. the expected cash in hand, who
 * received it, and the kitchen "remaining" counts confirmed (or corrected) per
 * item. Expected values are always computed here on the server; the client only
 * sends what the staff counted.
 *
 * Events (routed by the Orchestrator):
 *   shift.report.requested  → ShiftWorker.getShiftReport   (read)
 *   shift.report.submitted  → ShiftWorker.submitShiftReport (write via Repo)
 *
 * Depends on existing globals: requirePermission_, getCashSummary
 * (cashManagement.js), getCookingProductsFromSheet / _buildCookingStockSummary
 * (kitchenCooking.js), getBusinessDateKey (businessDay.js),
 * buildIdempotencyCacheKey_ / getIdempotentResult_ (utils.js), Repo, apiOk/apiFail.
 */

var SHIFT_REPORT_HEADERS = [
  'Report ID', 'Submitted At', 'Business Date', 'Outlet', 'Submitted By', 'Handed To',
  'Expected Cash', 'Counted Cash', 'Cash Variance',
  'Kitchen Items', 'Kitchen Mismatches', 'Kitchen Details', 'Notes', 'Request ID'
];

var ShiftWorker = {

  PERMISSION: 'shiftReport',

  // Copilot: Load everything the shift handover form needs for the caller's outlet:
  // expected cash in hand, today's kitchen remaining counts, the staff who can
  // receive the handover, and the reports already submitted today.
  getShiftReport: function (payload, ctx) {
    var session = requirePermission_(payload, this.PERMISSION);
    var outlet = String(session.outlet || '').trim();
    if (!outlet) return apiFail('No outlet is assigned to this account.', 'SHIFT_NO_OUTLET');
    var now = new Date();
    var businessDate = getBusinessDateKey(now);

    return apiOk({
      outlet: outlet,
      businessDate: businessDate,
      asOf: now.toISOString(),
      expectedCash: this._expectedCash_(session),
      kitchen: this._kitchenItems_(outlet, now),
      staff: this._staff_(outlet, session.username),
      todayReports: this._reportsFor_(outlet, businessDate)
    }, 'SHIFT_REPORT_OK');
  },

  // Copilot: Save one shift handover report through Repo. Recomputes expected cash
  // and kitchen remaining on the server, compares them with what staff counted,
  // and stores the variance. Re-delivered requests return the first result.
  submitShiftReport: function (payload, ctx) {
    var session = requirePermission_(payload, this.PERMISSION);
    var outlet = String(session.outlet || '').trim();
    if (!outlet) return apiFail('No outlet is assigned to this account.', 'SHIFT_NO_OUTLET');

    var requestId = String(payload.clientRequestId || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(requestId)) return apiFail('A valid request ID is required.', 'SHIFT_BAD_REQUEST');
    var idemKey = buildIdempotencyCacheKey_('shift_', requestId);
    var previous = getIdempotentResult_(idemKey);
    if (previous) return apiOk(previous, 'SHIFT_REPORT_DUPLICATE');

    var counted = Number(payload.countedCash);
    if (payload.countedCash === '' || payload.countedCash == null || !isFinite(counted) || counted < 0) {
      return apiFail('Enter the cash you counted (0 or more).', 'SHIFT_BAD_CASH');
    }
    if (payload.cashConfirmed !== true) return apiFail('Confirm the cash handover.', 'SHIFT_CASH_NOT_CONFIRMED');

    var staff = this._staff_(outlet, session.username);
    var receiverId = String(payload.receiverId || '').trim();
    var receiver = staff.filter(function (p) { return p.id === receiverId; })[0];
    if (!receiver) return apiFail('Choose who receives the handover.', 'SHIFT_BAD_RECEIVER');

    var now = new Date();
    var businessDate = getBusinessDateKey(now);
    var expected = this._expectedCash_(session);

    // Every kitchen item must be either confirmed as correct or given a real count.
    var sent = {};
    (Array.isArray(payload.kitchen) ? payload.kitchen : []).forEach(function (k) {
      var code = String((k && k.productCode) || '').trim();
      if (code) sent[code] = k;
    });
    var details = [];
    var mismatches = 0;
    var missing = [];
    this._kitchenItems_(outlet, now).forEach(function (item) {
      var k = sent[item.productCode];
      var actual;
      if (k && k.confirmed === true) {
        actual = item.remaining;
      } else if (k && k.actual !== '' && k.actual != null && isFinite(Number(k.actual)) && Number(k.actual) >= 0) {
        actual = Number(k.actual);
      } else {
        missing.push(item.name);
        return;
      }
      var diff = Math.round((actual - item.remaining) * 1000) / 1000;
      if (diff !== 0) mismatches++;
      details.push({ productCode: item.productCode, name: item.name, system: item.remaining, actual: actual, diff: diff });
    });
    if (missing.length) {
      return apiFail('Confirm or count every kitchen item: ' + missing.join(', '), 'SHIFT_KITCHEN_INCOMPLETE');
    }

    var notes = String(payload.notes || '').slice(0, 500);
    var reportId = 'SHIFT-' + now.getTime();
    var variance = Math.round(counted - expected);

    Repo.ensureTable('SHIFT_REPORTS', SHIFT_REPORT_HEADERS);
    Repo.appendObjects('SHIFT_REPORTS', {
      'Report ID': reportId,
      'Submitted At': now,
      'Business Date': businessDate,
      'Outlet': outlet,
      'Submitted By': session.username,
      'Handed To': receiver.name,
      'Expected Cash': expected,
      'Counted Cash': counted,
      'Cash Variance': variance,
      'Kitchen Items': details.length,
      'Kitchen Mismatches': mismatches,
      'Kitchen Details': JSON.stringify(details),
      'Notes': notes,
      'Request ID': requestId
    });

    var summary = {
      reportId: reportId,
      submittedAt: now.toISOString(),
      businessDate: businessDate,
      outlet: outlet,
      submittedBy: session.username,
      handedTo: receiver.name,
      expectedCash: expected,
      countedCash: counted,
      cashVariance: variance,
      kitchenItems: details.length,
      kitchenMismatches: details.filter(function (d) { return d.diff !== 0; }),
      notes: notes
    };
    try { CacheService.getScriptCache().put(idemKey, JSON.stringify(summary), 600); } catch (e) { /* best effort */ }
    return apiOk(summary, 'SHIFT_REPORT_SAVED');
  },

  /** Same figure as the Deposits screen's "Cash in hand". */
  _expectedCash_: function (session) {
    var raw = getCashSummary(session.deviceId, session.username);
    var summary = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return Math.round(Number(summary.cashInHand) || 0);
  },

  /** Today's kitchen remaining per cooking product (same as Kitchen → Today). */
  _kitchenItems_: function (outlet, now) {
    var products = getCookingProductsFromSheet(outlet) || [];
    if (!products.length) return [];
    var items = _buildCookingStockSummary(outlet, now, { products: products }) || [];
    return items.map(function (i) {
      return {
        productCode: String(i.productCode || i.name || '').trim(),
        name: String(i.name || i.productCode || ''),
        leftoverFromYesterday: Number(i.leftoverFromYesterday) || 0,
        cookedToday: Number(i.cookedToday) || 0,
        soldToday: Number(i.soldToday) || 0,
        remaining: Number(i.remaining) || 0
      };
    }).filter(function (i) { return i.productCode; });
  },

  /** Active people of this outlet who can receive a handover (never the sender). */
  _staff_: function (outlet, username) {
    var key = canonicalOutletKey_(outlet);
    var self = String(username || '').trim().toLowerCase();
    var list = [];
    Repo.readRows('PEOPLE').forEach(function (row) {
      var id = String(ShiftWorker._field_(row, 'person_id') || '').trim();
      var name = String(ShiftWorker._field_(row, 'display_name') || id).trim();
      if (!id) return;
      if (String(ShiftWorker._field_(row, 'active') || 'Y').toUpperCase() === 'N') return;
      var personOutlet = String(ShiftWorker._field_(row, 'outlet') || '').trim();
      if (personOutlet && canonicalOutletKey_(personOutlet) !== key) return;
      if (id.toLowerCase() === self || name.toLowerCase() === self) return;
      list.push({ id: id, name: name });
    });
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return list;
  },

  // Copilot: List saved shift reports for the caller's outlet between two business
  // dates (inclusive), newest first, with full details for the detail view.
  getShiftHistory: function (payload, ctx) {
    var session = requirePermission_(payload, this.PERMISSION);
    var outlet = String(session.outlet || '').trim();
    if (!outlet) return apiFail('No outlet is assigned to this account.', 'SHIFT_NO_OUTLET');
    var re = /^\d{4}-\d{2}-\d{2}$/;
    var start = String((payload && payload.startDate) || '');
    var end = String((payload && payload.endDate) || '');
    if (!re.test(start) || !re.test(end)) return apiFail('Choose a valid date range.', 'SHIFT_BAD_RANGE');
    if (start > end) { var tmp = start; start = end; end = tmp; }

    var key = canonicalOutletKey_(outlet);
    var tz = Session.getScriptTimeZone();
    var rows = Repo.readRows('SHIFT_REPORTS').filter(function (r) {
      var bd = ShiftWorker._dateKey_(r['Business Date'], tz);
      return bd >= start && bd <= end && canonicalOutletKey_(String(r['Outlet'] || '')) === key;
    }).map(function (r) {
      return ShiftWorker._report_(r, tz);
    }).reverse();
    return apiOk({ outlet: outlet, startDate: start, endDate: end, rows: rows }, 'SHIFT_HISTORY_OK');
  },

  /** Reports already submitted for this outlet and business day (newest first). */
  _reportsFor_: function (outlet, businessDate) {
    var key = canonicalOutletKey_(outlet);
    var tail = Repo.readRowsFromEnd('SHIFT_REPORTS', 0, 100);
    var tz = Session.getScriptTimeZone();
    return tail.rows.filter(function (r) {
      return ShiftWorker._dateKey_(r['Business Date'], tz) === businessDate &&
        canonicalOutletKey_(String(r['Outlet'] || '')) === key;
    }).map(function (r) {
      var full = ShiftWorker._report_(r, tz);
      full.kitchenMismatches = full.kitchenMismatches.length;
      delete full.kitchenDetails;
      return full;
    }).reverse();
  },

  /** Sheets turns "yyyy-MM-dd" into a Date cell; read it back in the script zone. */
  _dateKey_: function (value, tz) {
    return value instanceof Date ? Utilities.formatDate(value, tz, 'yyyy-MM-dd') : String(value || '').slice(0, 10);
  },

  /** One ShiftReports row as the client sees it, including parsed kitchen details. */
  _report_: function (r, tz) {
    var at = r['Submitted At'];
    var details = [];
    try { details = JSON.parse(String(r['Kitchen Details'] || '[]')) || []; } catch (e) { details = []; }
    return {
      reportId: String(r['Report ID'] || ''),
      submittedAt: at instanceof Date ? at.toISOString() : String(at || ''),
      businessDate: this._dateKey_(r['Business Date'], tz),
      outlet: String(r['Outlet'] || ''),
      submittedBy: String(r['Submitted By'] || ''),
      handedTo: String(r['Handed To'] || ''),
      expectedCash: Number(r['Expected Cash']) || 0,
      countedCash: Number(r['Counted Cash']) || 0,
      cashVariance: Number(r['Cash Variance']) || 0,
      kitchenItems: Number(r['Kitchen Items']) || details.length,
      kitchenDetails: details,
      kitchenMismatches: details.filter(function (d) { return Number(d.diff) !== 0; }),
      notes: String(r['Notes'] || '')
    };
  },

  _field_: function (row, name) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
    var want = name.toLowerCase();
    for (var k in row) {
      if (Object.prototype.hasOwnProperty.call(row, k) && String(k).trim().toLowerCase() === want) return row[k];
    }
    return '';
  }
};
