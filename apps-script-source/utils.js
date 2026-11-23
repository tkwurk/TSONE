/**
 * Sanitize data for safe transfer via google.script.run (JSON serialization).
 * Converts Date objects to ISO strings, ensures no non-serializable types.
 * Use this on any object/array returned to the client.
 */
function sanitizeForClient(obj) {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(sanitizeForClient);
  if (typeof obj === 'object') {
    var clean = {};
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        clean[key] = sanitizeForClient(obj[key]);
      }
    }
    return clean;
  }
  return obj;
}

/** Uppercase trimmed outlet key for comparisons (Kitchen_Cooking, Keyfigures, filters). */
function canonicalOutletKey_(outlet) {
  var o = (outlet || '').toString().trim();
  if (!o || o === 'undefined' || o === 'DEFAULT') return '';
  return o.toUpperCase();
}

function outletKeysMatch_(a, b) {
  var ka = canonicalOutletKey_(a);
  var kb = canonicalOutletKey_(b);
  if (!ka && !kb) return true;
  if (!ka || !kb) return false;
  return ka === kb;
}

/** Match order/cooking rows to user outlet; blank row outlet counts as legacy (any outlet). */
function outletRowMatchesUser_(rowOutlet, userOutlet) {
  var userKey = canonicalOutletKey_(userOutlet);
  if (!userKey) return true;
  var rowKey = canonicalOutletKey_(rowOutlet);
  if (!rowKey) return true;
  return rowKey === userKey;
}

// Universal date format: dd-mmm-yyyy
function formatDateDDMMMYYYY(dateValue) {
  if (!dateValue) return "";
  let date;
  if (dateValue instanceof Date) {
    date = dateValue;
  } else if (typeof dateValue === 'number') {
    date = new Date(Math.round((dateValue - 25569) * 86400 * 1000));
  } else {
    date = new Date(dateValue);
  }
  if (isNaN(date)) return "";
  const day = String(date.getDate()).padStart(2, '0');
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}
let _spreadsheet = null; // Global variable

function getSpreadsheet() {
  if (_spreadsheet) {
    Logger.log("Using existing spreadsheet connection");
    return _spreadsheet;
  }

  _spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  return _spreadsheet;
}

/** Canonical sheet readers and date helpers (Snowbee A3.1 — single owner). */

function getSheetData(sheetName) {
  const spreadsheet = getGlobalSpreadsheet();
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  return sheet.getDataRange().getValues();
}

function findColumnIndex(headers, columnName) {
  if (!headers) return -1;
  const lowerColumn = columnName.toLowerCase();
  return headers.findIndex(header =>
    header && header.toString().toLowerCase() === lowerColumn
  );
}

/**
 * Resolve column index from COLUMNS field def (Snowbee A3.2).
 * @param {Array} headers Header row
 * @param {{col?: number, names?: string[], pattern?: RegExp}} fieldDef
 * @returns {number}
 */
function resolveColumnIndex(headers, fieldDef) {
  if (!fieldDef) return -1;
  if (headers && headers.length) {
    if (fieldDef.pattern) {
      var patternIdx = headers.findIndex(function(h) {
        return h && fieldDef.pattern.test(h.toString());
      });
      if (patternIdx >= 0) return patternIdx;
    }
    if (fieldDef.names && fieldDef.names.length) {
      for (var n = 0; n < fieldDef.names.length; n++) {
        var nameIdx = findColumnIndex(headers, fieldDef.names[n]);
        if (nameIdx >= 0) return nameIdx;
      }
    }
  }
  return (fieldDef.col !== undefined && fieldDef.col !== null) ? fieldDef.col : -1;
}

function getColumnIndex(headers, sheetKey, fieldKey) {
  var sheetCols = COLUMNS[sheetKey];
  if (!sheetCols || !sheetCols[fieldKey]) return -1;
  return resolveColumnIndex(headers, sheetCols[fieldKey]);
}

function buildColumnMap(headers, sheetKey) {
  var sheetCols = COLUMNS[sheetKey];
  var map = {};
  if (!sheetCols) return map;
  Object.keys(sheetCols).forEach(function(fieldKey) {
    map[fieldKey] = resolveColumnIndex(headers, sheetCols[fieldKey]);
  });
  return map;
}

function getRowField(row, headers, sheetKey, fieldKey) {
  var idx = getColumnIndex(headers, sheetKey, fieldKey);
  return (idx >= 0 && row) ? row[idx] : undefined;
}

function getFixedRowField(row, sheetKey, fieldKey) {
  var def = COLUMNS[sheetKey] && COLUMNS[sheetKey][fieldKey];
  if (!def || def.col === undefined) return undefined;
  return row ? row[def.col] : undefined;
}

/**
 * Standard column indices for Orders / Purchases / Expenses reads.
 * @param {Array} headers
 * @param {'ORDERS'|'PURCHASES'|'EXPENSES'|'SALES'} sheetKind
 * @returns {{date: number, total: number, outlet: number, amount?: number, category?: number, supplier?: number, productName?: number, productCode?: number}}
 */
function getTransactionColumns(headers, sheetKind) {
  var kind = String(sheetKind || '').toUpperCase();
  if (kind === 'SALES') kind = 'ORDERS';
  if (!headers || !headers.length) {
    return { date: -1, total: -1, outlet: -1 };
  }
  var result = {
    date: -1,
    total: -1,
    outlet: headers.findIndex(function(h) { return h && COLUMN_PATTERNS.OUTLET.test(h.toString()); })
  };
  if (kind === 'ORDERS') {
    result.date = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.TIMESTAMP.test(h.toString()); });
    result.total = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.TOTAL.test(h.toString()); });
    result.category = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.CATEGORY.test(h.toString()); });
    result.productName = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.PRODUCT_NAME.test(h.toString()); });
    result.productCode = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.PRODUCT_CODE.test(h.toString()); });
  } else if (kind === 'PURCHASES') {
    result.date = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.DATE.test(h.toString()); });
    result.total = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.PURCHASE_TOTAL.test(h.toString()); });
    result.category = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.CATEGORY.test(h.toString()); });
    result.supplier = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.SUPPLIER.test(h.toString()); });
    result.productName = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.PRODUCT_NAME.test(h.toString()); });
    result.productCode = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.PRODUCT_CODE.test(h.toString()); });
  } else if (kind === 'EXPENSES') {
    result.date = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.DATE.test(h.toString()); });
    result.amount = headers.findIndex(function(h) { return h && COLUMN_PATTERNS.AMOUNT.test(h.toString()); });
    result.total = result.amount;
  }
  return result;
}

/** Index of the purchase "Is Investment" flag column, or -1. */
function purchaseInvestmentColIndex_(headers) {
  if (!headers || !headers.length) return -1;
  return headers.findIndex(function(h) { return h && /is\s*investment/i.test(h.toString()); });
}

/** True when a purchase row is flagged as an investment (capital spend). */
function isInvestmentPurchaseRow_(row, invIdx) {
  if (invIdx == null || invIdx < 0 || !row) return false;
  var v = row[invIdx];
  if (v === true || v === 1) return true;
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1';
}

function formatDateForJSON(dateValue) {
  if (!dateValue) return "";
  let date;
  if (dateValue instanceof Date) {
    date = dateValue;
  } else if (typeof dateValue === 'number') {
    date = new Date(Math.round((dateValue - 25569) * 86400 * 1000));
  } else {
    date = new Date(dateValue);
  }

  if (isNaN(date)) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** Spreadsheet timezone when set, else Apps Script project timezone. */
function getAppTimeZone_() {
  try {
    var ss = typeof getGlobalSpreadsheet === 'function' ? getGlobalSpreadsheet() : null;
    if (ss && typeof ss.getSpreadsheetTimeZone === 'function') {
      var sheetTz = ss.getSpreadsheetTimeZone();
      if (sheetTz) return sheetTz;
    }
  } catch (e) { /* ignore */ }
  try {
    return Session.getScriptTimeZone() || 'Asia/Jakarta';
  } catch (e2) {
    return 'Asia/Jakarta';
  }
}

/** Calendar date key (yyyy-MM-dd) in app/spreadsheet timezone. */
function getAppDateKey_(date) {
  var d = date instanceof Date ? date : (date ? new Date(date) : new Date());
  if (!d || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, getAppTimeZone_(), 'yyyy-MM-dd');
}

/** Start of calendar day in app timezone. */
function getAppDayStart_(date) {
  var key = getAppDateKey_(date);
  if (!key) return new Date();
  return Utilities.parseDate(key + ' 00:00:00', getAppTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
}

function formatDateForBackend(date) {
  const d = new Date(date);
  
  // Use local time methods to avoid timezone issues
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  
  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
}

function formatTimestampForSheet(date) {
  // Return the Date object directly so Google Sheets stores it as a locale-independent
  // serial date number, avoiding ambiguity when the spreadsheet locale is not US.
  return new Date(date);
}

function isSameDay(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate();
}

/**
 * Parse a spreadsheet cell value as Date (handles common sheet string formats).
 * @returns {Date|null}
 */
function parseSheetDate_(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && value > 0) {
    var serialDate = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (!isNaN(serialDate.getTime())) return serialDate;
  }
  if (typeof value === 'string') {
    var tz = typeof getAppTimeZone_ === 'function' ? getAppTimeZone_() : Session.getScriptTimeZone();
    var formats = [
      'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd',
      'dd-MMM-yyyy HH:mm:ss', 'dd-MMM-yyyy HH:mm', 'dd-MMM-yyyy',
      'MM/dd/yyyy HH:mm:ss', 'MM/dd/yyyy',
      'dd-MM-yyyy HH:mm:ss', 'dd-MM-yyyy'
    ];
    for (var i = 0; i < formats.length; i++) {
      try {
        var dt = Utilities.parseDate(value.trim(), tz, formats[i]);
        if (dt && !isNaN(dt.getTime())) return dt;
      } catch (e) { /* try next format */ }
    }
  }
  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function monthKey(d) {
  var dt = parseSheetDate_(d);
  if (!dt) return '';
  return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2);
}

var _lastSpreadsheetInitError = '';

function getLastSpreadsheetInitError_() {
  return _lastSpreadsheetInitError || '';
}

function getSpreadsheetInitDiagnostics() {
  GLOBAL.spreadsheet = null;
  _lastSpreadsheetInitError = '';
  var ok = initializeSpreadsheet();
  return apiOk({
    ok: ok,
    spreadsheetId: resolveSpreadsheetIdForOpen_(),
    error: _lastSpreadsheetInitError || null
  }, ok ? 'INIT_OK' : 'INIT_FAILED');
}

function initializeSpreadsheet() {
  _lastSpreadsheetInitError = '';
  try {
    const spreadsheet = initSpreadsheet();
    if (!spreadsheet) {
      throw new Error('Failed to open spreadsheet');
    }
    ensureSchemaVersion_();
    if (typeof ensurePeopleSheet_ === 'function') {
      ensurePeopleSheet_();
    }
    validateRequiredSheets_();
    validateSheetHeaders_();
    return true;
  } catch (error) {
    _lastSpreadsheetInitError = (error && error.message) ? error.message : String(error);
    Logger.log('Error initializing spreadsheet: ' + _lastSpreadsheetInitError);
    return false;
  }
}

function ensureSchemaVersion_() {
  var expected = (typeof SCHEMA_VERSION !== 'undefined') ? SCHEMA_VERSION : 'unknown';
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('SCHEMA_VERSION');
  if (stored !== expected) {
    Logger.log('Schema version: stored=' + stored + ' expected=' + expected + ' (updating ScriptProperties)');
    props.setProperty('SCHEMA_VERSION', expected);
  }
}

function validateRequiredSheets_() {
  var required = [
    SHEETS.PRODUCTS, SHEETS.ORDERS, SHEETS.PEOPLE,
    SHEETS.DEPOSITS, SHEETS.EXPENSES, SHEETS.ACCOUNTS
  ];
  var ss = getGlobalSpreadsheet();
  var missing = required.filter(function(name) {
    return !ss.getSheetByName(name);
  });
  if (missing.length) {
    throw new Error('Missing required sheets: ' + missing.join(', '));
  }
}

/** Verify row-1 headers resolve required COLUMNS fields (Snowbee A3.3). */
function validateSheetHeaders_() {
  if (typeof VALIDATED_SHEETS === 'undefined') return;
  var ss = getGlobalSpreadsheet();
  VALIDATED_SHEETS.forEach(function(entry) {
    var sheetName = SHEETS[entry.sheetKey];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    if (!data.length) {
      throw new Error(sheetName + ': missing header row');
    }
    var headers = data[0];
    var requiredFields = (SCHEMA_VALIDATION && SCHEMA_VALIDATION[entry.columnsKey]) || [];
    var missing = [];
    requiredFields.forEach(function(fieldKey) {
      if (getColumnIndex(headers, entry.columnsKey, fieldKey) === -1) {
        missing.push(fieldKey);
      }
    });
    if (missing.length) {
      throw new Error(sheetName + ': unresolved columns: ' + missing.join(', '));
    }
  });
}

/**
 * Standard API envelope (Snowbee A3.4).
 * Legacy flat fields are copied onto the response for existing UI callers.
 */
function apiOk(data, code) {
  var payload = { success: true, data: data != null ? data : null, error: null, code: code || 'OK' };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    Object.keys(data).forEach(function(k) { payload[k] = data[k]; });
  }
  return payload;
}

function apiFail(error, code) {
  return {
    success: false,
    data: null,
    error: String(error || 'Unknown error'),
    code: code || 'ERROR'
  };
}

/** Append 2D rows in one write (Snowbee A3.5). */
function appendRowsAtomic_(sheet, rows) {
  if (!sheet || !rows || !rows.length) return;
  var width = rows[0].length;
  var startRow = sheet.getLastRow() + 1;
  // getRange(row, col, numRows, numColumns) — 3rd arg is row count, not end row
  sheet.getRange(startRow, 1, rows.length, width).setValues(rows);
}

/**
 * Write edits made in memory back to the sheet with as few calls as possible
 * (instead of one setValue per cell). `data` is the 2D array from
 * getDataRange().getValues(), so data[i] is sheet row i + 1.
 * @param {number[]} rowIdxs indexes into `data` that were changed
 * @param {number[]} colIdxs 0-based columns that were changed
 * Consecutive rows are written as one block; contiguous columns as one span.
 */
function writeRowsBack_(sheet, data, rowIdxs, colIdxs) {
  function uniqSorted(list) {
    var seen = {};
    return list.filter(function (n) {
      if (n < 0 || seen[n]) return false;
      seen[n] = true;
      return true;
    }).sort(function (a, b) { return a - b; });
  }
  var rows = uniqSorted(rowIdxs || []);
  var cols = uniqSorted(colIdxs || []);
  if (!sheet || !rows.length || !cols.length) return;
  var spans = (cols[cols.length - 1] - cols[0] === cols.length - 1)
    ? [[cols[0], cols.length]]
    : cols.map(function (c) { return [c, 1]; });
  for (var i = 0; i < rows.length;) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    var block = rows.slice(i, j + 1);
    spans.forEach(function (sp) {
      sheet.getRange(block[0] + 1, sp[0] + 1, block.length, sp[1])
        .setValues(block.map(function (r) { return data[r].slice(sp[0], sp[0] + sp[1]); }));
    });
    i = j + 1;
  }
}

function buildIdempotencyCacheKey_(prefix, clientRequestId) {
  var id = (clientRequestId || '').toString().trim();
  if (!id) return '';
  return String(prefix || 'idem_') + id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

function getIdempotentResult_(cacheKey) {
  if (!cacheKey) return null;
  try {
    var raw = CacheService.getScriptCache().get(cacheKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function putIdempotentResult_(cacheKey, result, ttlSeconds) {
  if (!cacheKey || result == null) return;
  try {
    CacheService.getScriptCache().put(
      cacheKey,
      JSON.stringify(result),
      Math.max(60, Math.min(Number(ttlSeconds) || 600, 21600))
    );
  } catch (e) { /* ignore */ }
}

/** Payment label indicates a split payment (legacy Partial label included). */
function isPartialPaymentLabel_(payment) {
  var p = (payment || '').toString().toLowerCase().trim();
  return p === 'partial' || p === 'split' || p.indexOf('partial') >= 0 || p.indexOf('split') >= 0;
}

/** Order object carries split payment lines from checkout. */
function isSplitPaymentOrder_(order) {
  if (!order) return false;
  if (order.paymentSplits && order.paymentSplits.length) return true;
  return isPartialPaymentOrder_(order);
}

/** @deprecated use isSplitPaymentOrder_ */
function isPartialPaymentOrder_(order) {
  if (!order || !order.paymentDetails) return false;
  if (order.paymentDetails.splits && order.paymentDetails.splits.length) return true;
  var cash = Number(order.paymentDetails.cash) || 0;
  var digital = Number(order.paymentDetails.nonCash || order.paymentDetails.dana || order.paymentDetails.qris) || 0;
  return cash > 0 || digital > 0;
}

/** Normalize split lines from paymentSplits or legacy paymentDetails. */
function getOrderPaymentSplits_(order) {
  if (!order) return [];
  if (order.paymentSplits && order.paymentSplits.length) {
    return order.paymentSplits.map(function(s) {
      var split = {
        method: (s.method || '').toString().trim(),
        amount: Number(s.amount) || 0,
        destinationAccount: s.destinationAccount || ''
      };
      if (s.autoDeposit !== undefined) split.autoDeposit = !!s.autoDeposit;
      return split;
    }).filter(function(s) { return s.method && s.amount > 0; });
  }
  if (!order.paymentDetails) return [];
  if (order.paymentDetails.splits && order.paymentDetails.splits.length) {
    return order.paymentDetails.splits.map(function(s) {
      return {
        method: (s.method || '').toString().trim(),
        amount: Number(s.amount) || 0,
        destinationAccount: s.destinationAccount || ''
      };
    }).filter(function(s) { return s.method && s.amount > 0; });
  }
  var splits = [];
  var cash = Number(order.paymentDetails.cash) || 0;
  var digital = Number(order.paymentDetails.nonCash || order.paymentDetails.dana || order.paymentDetails.qris) || 0;
  var digitalMethod = order.paymentDetails.nonCashMethod || order.paymentDetails.danaMethod || 'Non-Cash';
  if (digital > 0) splits.push({ method: digitalMethod, amount: digital, destinationAccount: order.destinationAccount || '' });
  if (cash > 0) splits.push({ method: 'Cash', amount: cash, destinationAccount: '' });
  return splits;
}
