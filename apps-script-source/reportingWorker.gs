/**
 * reportingWorker.gs — Reporting / Analytics worker agent.
 *
 * Additive namespace that DELEGATES to the existing analytics functions.
 *
 * Depends on existing globals: getPnLBundle (pnlBundle.js), getCashSummary
 * (cashManagement.js), getSalesSummaryByDate (salesReports.js),
 * getDailyClosingBundle (inventoryConsumption.js), Repo (repo.gs), apiOk/apiFail.
 */

// Copilot: Implement a Reporting Worker agent for reports and summaries.
// Given a report type, delegate to the existing analytics functions
// (getPnLBundle, getCashSummary, getSalesSummaryByDate, getDailyClosingBundle)
// and return the report object. The result is sent to the Reflection Agent for
// validation before it reaches the Orchestrator.
var ReportingWorker = {

  // Copilot: Cooking audit for the authenticated outlet: every sell-out of a cooked
  // product in the period, how long until the next batch was ready, customers
  // turned away meanwhile, and a suggested recook threshold per product.
  cookingAudit: function (params, ctx) {
    var session = requirePermission_(params, 'kitchenCooking');
    var outlet = String(session.outlet || '').trim();
    if (!outlet) throw new Error('Outlet is required for the cooking audit.');
    var re = /^\d{4}-\d{2}-\d{2}$/;
    var start = String(params.startDate || '');
    var end = String(params.endDate || '');
    if (!re.test(start) || !re.test(end) || start > end) throw new Error('Choose a valid date range.');
    var spanDays = (new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 86400000;
    if (spanDays > 92) throw new Error('Choose a period of at most 3 months.');
    var audit = buildCookingAudit_(loadCookingAuditInput_(outlet, start, end, new Date()));
    audit.outlet = outlet;
    audit.startDate = start;
    audit.endDate = end;
    return apiOk(audit, 'COOKING_AUDIT_OK');
  },

  // Copilot: Report daily recorded consumption totals for the authenticated outlet.
  consumptionHistory: function (params, ctx) {
    var session = requirePermission_(params, 'inventoryConsumption');
    var outlet = String(session.outlet || '').trim();
    if (!outlet) throw new Error('Outlet is required for consumption history.');
    function validDate(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      var date = new Date(value + 'T00:00:00Z');
      return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    if (!validDate(params.startDate) || !validDate(params.endDate) || params.startDate > params.endDate) {
      throw new Error('A valid consumption history date range is required.');
    }
    var table = Repo.readTable('INVENTORY_CONSUMPTION');
    if (!table.headers.length) throw new Error('Inventory_Consumption is missing or has no headers.');
    var required = ['Timestamp', 'Product Code', 'Quantity Consumed', 'Outlet'];
    required.forEach(function (name) {
      if (!table.headers.some(function (header) { return header.toLowerCase() === name.toLowerCase(); })) {
        throw new Error('Inventory_Consumption is missing the ' + name + ' column.');
      }
    });
    var names = getProductNamesByCode();
    var units = {};
    getBuyTypeProducts().forEach(function (product) { units[normalizeProductCodeKey_(product.productCode)] = product.unit || ''; });
    var groups = {};
    table.rows.forEach(function (row) {
      if (canonicalOutletKey_(ReportingWorker._field_(row, 'Outlet')) !== canonicalOutletKey_(outlet)) return;
      var code = normalizeProductCodeKey_(ReportingWorker._field_(row, 'Product Code'));
      if (!code) return;
      var date = parseSheetDate_(ReportingWorker._field_(row, 'Timestamp'));
      if (!date) throw new Error('Inventory_Consumption contains an invalid timestamp for ' + code + '.');
      var day = getAppDateKey_(date);
      if (day < params.startDate || day > params.endDate) return;
      var quantity = Number(ReportingWorker._field_(row, 'Quantity Consumed'));
      if (!isFinite(quantity) || quantity <= 0) throw new Error('Inventory_Consumption contains an invalid quantity for ' + code + '.');
      var key = JSON.stringify([day, code]);
      if (!groups[key]) groups[key] = { date: day, productCode: code, name: names[code] || code, unit: units[code] || '', quantity: 0 };
      groups[key].quantity += quantity;
    });
    var rows = Object.keys(groups).map(function (key) {
      groups[key].quantity = Math.round(groups[key].quantity * 1000) / 1000;
      return groups[key];
    });
    rows.sort(function (a, b) { return b.date.localeCompare(a.date) || b.quantity - a.quantity || a.name.localeCompare(b.name); });
    return apiOk({ rows: rows }, 'CONSUMPTION_HISTORY_OK');
  },

  // Copilot: Return all purchase lines for the authenticated outlet, optionally grouped by product or Monday-based week.
  purchaseHistory: function (params, ctx) {
    var session = requirePermission_(params, params.local === true ? 'purchasingLocal' : 'purchasing');
    var outlet = String(session.outlet || '').trim();
    if (!outlet) throw new Error('Outlet is required for purchasing history.');
    var groupBy = params.groupBy || 'none';
    if (['none', 'product', 'week'].indexOf(groupBy) === -1) throw new Error('Invalid purchasing history grouping.');
    var filters = params.filters || {};
    if (typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Invalid purchasing history filters.');
    var allowedFilters = ['date', 'product', 'qty', 'unit', 'price', 'total', 'payment', 'username', 'pstatus', 'rquantity'];
    Object.keys(filters).forEach(function (key) {
      if (allowedFilters.indexOf(key) === -1 || typeof filters[key] !== 'string') {
        throw new Error('Invalid purchasing history filter: ' + key);
      }
    });

    var table = Repo.readTable('PURCHASES');
    if (!table.headers.length) throw new Error('Purchases sheet is missing or has no headers.');
    var field = ReportingWorker._field_;
    var rows = [];
    var tz = Session.getScriptTimeZone();
    table.rows.forEach(function (r, index) {
      if (String(field(r, 'Outlet') || '').trim().toLowerCase() !== outlet.toLowerCase()) return;
      var product = String(field(r, 'Product Name', 'ProductName', 'Product', 'Item', 'Name') || '');
      var purchaseId = String(field(r, 'Purchase ID', 'PurchaseID', 'ID') || '');
      if (!product && !purchaseId) return;
      var rawDate = field(r, 'Timestamp', 'Date');
      var date = parseSheetDate_(rawDate);
      var day = date ? Utilities.formatDate(date, tz, 'yyyy-MM-dd') : '';
      var monday = '';
      if (day) {
        // Calendar arithmetic on the business date, not the instant's UTC weekday.
        var calendar = new Date(day + 'T00:00:00Z');
        calendar.setUTCDate(calendar.getUTCDate() - (calendar.getUTCDay() + 6) % 7);
        monday = Utilities.formatDate(calendar, 'UTC', 'yyyy-MM-dd');
      }
      var payment = field(r, '_selectingPayment');
      if (payment == null || String(payment).trim() === '') payment = field(r, 'Payment', 'Payment Method');
      var purchase = {
        rowIndex: index + 2,
        purchaseId: purchaseId,
        date: date ? date.toISOString() : String(rawDate || ''),
        weekStart: monday,
        product: product,
        code: String(field(r, 'Product Code', 'ProductCode', 'Code') || ''),
        supplier: String(field(r, 'Supplier') || ''),
        outlet: outlet,
        qty: Number(field(r, 'Quantity', 'Qty')) || 0,
        unit: String(field(r, 'Buy Unit', 'BuyUnit', 'Unit') || ''),
        price: Number(field(r, 'Price', 'Unit Price', 'Buy Price')) || 0,
        total: Number(field(r, 'Total', 'Amount')) || 0,
        account: String(field(r, 'Account', 'Expense Account') || ''),
        payment: String(payment || ''),
        username: String(field(r, 'Username', 'User')) || '',
        pstatus: String(field(r, 'PSTATUS', 'Status') || ''),
        rquantity: Number(field(r, 'RQUANTITY', 'Received Quantity')) || 0
      };
      var matches = Object.keys(filters).every(function (key) {
        var query = filters[key].trim().toLowerCase();
        if (!query) return true;
        var values = [String(purchase[key] == null ? '' : purchase[key])];
        if (key === 'date' && date) {
          values.push(day, Utilities.formatDate(date, tz, 'dd/MM/yyyy'), Utilities.formatDate(date, tz, 'MM/dd/yyyy'),
            Utilities.formatDate(date, tz, 'HH:mm'));
        }
        if (key === 'pstatus') {
          if (purchase.pstatus.toUpperCase() === 'ORDERED') values.push('Ordered', 'Dipesan');
          if (purchase.pstatus.toUpperCase() === 'RECEIVED') values.push('Received', 'Diterima');
        }
        return values.some(function (value) { return value.toLowerCase().indexOf(query) !== -1; });
      });
      if (matches) rows.push(purchase);
    });
    rows.sort(function (a, b) {
      var ad = new Date(a.date).getTime() || 0;
      var bd = new Date(b.date).getTime() || 0;
      return bd - ad || b.rowIndex - a.rowIndex;
    });

    var groups = new Map();
    var total = 0;
    rows.forEach(function (row) {
      var key = groupBy === 'week' ? row.weekStart
        : groupBy === 'product' ? JSON.stringify([row.code || row.product, row.unit]) : 'all';
      if (!groups.has(key)) {
        groups.set(key, {
          key: key, product: groupBy === 'product' ? row.product : '',
          code: groupBy === 'product' ? row.code : '',
          unit: groupBy === 'product' ? row.unit : '',
          weekStart: groupBy === 'week' ? row.weekStart : '',
          rows: [], total: 0
        });
      }
      var group = groups.get(key);
      group.rows.push(row);
      group.total += row.total;
      total += row.total;
    });
    var list = Array.from(groups.values());
    if (groupBy === 'product') list.sort(function (a, b) { return a.product.localeCompare(b.product); });
    if (groupBy === 'week') list.sort(function (a, b) { return b.weekStart.localeCompare(a.weekStart); });
    return apiOk({ groups: list, count: rows.length, total: total }, 'PURCHASE_HISTORY_OK');
  },

  /**
   * Produces a report by type, delegating to existing analytics.
   * @param {string} type one of 'pnl' | 'cash' | 'sales' | 'dailyClosing'
   * @param {Object} params report-specific params (e.g. { year, date })
   * @param {Object} ctx { deviceId, username, outlet, requestId }
   * @return {Object} apiOk wrapping the report, or apiFail.
   */
  generateReport: function (type, params, ctx) {
    var c = ctx || {};
    var p = params || {};
    var report;
    switch (String(type || 'dailyClosing')) {
      case 'pnl':
        if (typeof getPnLBundle !== 'function') return apiFail('getPnLBundle missing', 'REPORT_DELEGATE_MISSING');
        report = getPnLBundle(c.deviceId, c.username, p.year);
        break;
      case 'cash':
        if (typeof getCashSummary !== 'function') return apiFail('getCashSummary missing', 'REPORT_DELEGATE_MISSING');
        report = getCashSummary(c.deviceId, c.username);
        break;
      case 'sales':
        if (typeof getSalesSummaryByDate !== 'function') return apiFail('getSalesSummaryByDate missing', 'REPORT_DELEGATE_MISSING');
        report = getSalesSummaryByDate(params);
        break;
      case 'salesSummary':
        report = ReportingWorker._salesSummaryFromRepo(p, c);
        break;
      case 'recentOrders':
        report = ReportingWorker._recentOrdersFromRepo(p, c);
        break;
      case 'dailyClosing':
      default:
        if (typeof getDailyClosingBundle !== 'function') return apiFail('getDailyClosingBundle missing', 'REPORT_DELEGATE_MISSING');
        report = getDailyClosingBundle(c.deviceId, c.username);
        break;
    }
    return apiOk({ type: String(type || 'dailyClosing'), report: report }, 'REPORT_GENERATED');
  },

  /**
   * Repo-backed sales summary (Seam 2): aggregates the Orders sheet through the
   * Data Access Layer instead of SpreadsheetApp. Optional outlet filter.
   * @return {Object} { source, outlet, lineCount, totalSales, totalQty, byPayment }
   */
  _salesSummaryFromRepo: function (params, ctx) {
    var rows = Repo.readRows('ORDERS');
    var outlet = (params && params.outlet) || (ctx && ctx.outlet) || '';
    var want = String(outlet).trim().toLowerCase();
    var filtered = outlet
      ? rows.filter(function (r) {
          return String(ReportingWorker._field_(r, 'Outlet') || '').trim().toLowerCase() === want;
        })
      : rows;

    var totalSales = 0, totalQty = 0, byPayment = {};
    filtered.forEach(function (r) {
      totalSales += Number(ReportingWorker._field_(r, 'Total')) || 0;
      totalQty += Number(ReportingWorker._field_(r, 'Quantity', 'Qty')) || 0;
      var pay = String(ReportingWorker._field_(r, 'Payment') || 'unknown').trim() || 'unknown';
      byPayment[pay] = (byPayment[pay] || 0) + (Number(ReportingWorker._field_(r, 'Total')) || 0);
    });

    return {
      source: 'repo',
      outlet: outlet || null,
      lineCount: filtered.length,
      totalSales: totalSales,
      totalQty: totalQty,
      byPayment: byPayment
    };
  },

  /** Case-insensitive header lookup; pass one or more candidate names. */
  _field_: function (obj) {
    var keys = Object.keys(obj);
    for (var a = 1; a < arguments.length; a++) {
      var want = String(arguments[a]).toUpperCase();
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].toUpperCase() === want) return obj[keys[i]];
      }
    }
    return undefined;
  },

  /**
   * Repo-backed recent orders (Seam 2): returns the most recently appended order
   * lines from the Orders sheet (newest first). Optional outlet filter + limit.
   * @return {Object} { source, outlet, count, orders[] }
   */
  _recentOrdersFromRepo: function (params, ctx) {
    var rows = Repo.readRows('ORDERS');
    var outlet = (params && params.outlet) || (ctx && ctx.outlet) || '';
    var want = String(outlet).trim().toLowerCase();
    var filtered = outlet
      ? rows.filter(function (r) {
          return String(ReportingWorker._field_(r, 'Outlet') || '').trim().toLowerCase() === want;
        })
      : rows;

    var limit = Number(params && params.limit) || 25;
    var recent = filtered.slice(Math.max(0, filtered.length - limit)).reverse();
    var orders = recent.map(function (r) {
      return {
        timestamp: ReportingWorker._field_(r, 'Timestamp'),
        orderNumber: ReportingWorker._field_(r, 'Order Number', 'OrderNumber'),
        product: ReportingWorker._field_(r, 'Product Name', 'ProductName', 'Name'),
        qty: ReportingWorker._field_(r, 'Quantity', 'Qty'),
        price: ReportingWorker._field_(r, 'Price'),
        total: ReportingWorker._field_(r, 'Total'),
        payment: ReportingWorker._field_(r, 'Payment'),
        outlet: ReportingWorker._field_(r, 'Outlet'),
        username: ReportingWorker._field_(r, 'Username')
      };
    });
    return { source: 'repo', outlet: outlet || null, count: orders.length, orders: orders };
  }
};
