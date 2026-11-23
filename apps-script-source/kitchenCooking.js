// ===== KITCHEN COOKING MODULE =====
// Tracks chef cook batches; alerts cashiers when cooked stock is low.

function ensureKitchenCookingHeaders() {
  var ss = getGlobalSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.KITCHEN_COOKING);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.KITCHEN_COOKING);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'CookingId', 'StartTime', 'EndTime', 'ProductCode', 'ProductName',
      'Qty', 'Chef', 'Outlet', 'Status', 'Notes', 'CreatedBy', 'DeviceInfo'
    ]);
    Logger.log('Created Kitchen_Cooking sheet with headers');
  }
  return sheet;
}

function ensureProductCookingColumns() {
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.PRODUCTS);
  if (!sheet || sheet.getLastRow() === 0) return;
  _kcEnsureColumn(sheet, 'COOKING_PRODUCT');
  _kcEnsureColumn(sheet, 'RECOOK_THRESHOLD');
}

function _kcEnsureColumn(sheet, colName) {
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var upper = colName.toUpperCase();
  for (var i = 0; i < h.length; i++) {
    if (h[i] && h[i].toString().trim().toUpperCase() === upper) return;
  }
  sheet.getRange(1, sheet.getLastColumn() + 1).setValue(colName);
}

function _kcHeaders(sheet) {
  if (!sheet || sheet.getLastRow() === 0) return {};
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = {};
  h.forEach(function(col, i) {
    if (col) idx[col.toString().trim().toUpperCase().replace(/\s+/g, '_')] = i;
  });
  return idx;
}

function _sessionFromParams(params) {
  var deviceId = params.deviceId || (params._authContext && params._authContext.deviceId);
  var username = params.username || (params._authContext && params._authContext.username);
  var session = getUserSessionEnhanced(deviceId, username);
  if (!session) throw new Error('Not authenticated');
  return session;
}

function _canRecordCooking(session) {
  var tabs = session.allowedTabs || [];
  if (tabs.indexOf('*') !== -1) return true;
  var role = normalizeRole_(session.role || 'cashier');
  return ['chef', 'supervisor', 'manager', 'admin'].indexOf(role) !== -1 ||
    tabs.indexOf('kitchenCooking') !== -1;
}

function _isTruthyCookingFlag(val) {
  var v = (val || '').toString().trim().toUpperCase();
  return v === 'Y' || v === 'YES' || v === 'TRUE' || v === '1';
}

function _businessDateKey(date) {
  return typeof getAppDateKey_ === 'function'
    ? getAppDateKey_(date || new Date())
    : (function(d) {
      d = d || new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })(date);
}

function _appDateKey_(date) {
  if (typeof getAppDateKey_ === 'function') return getAppDateKey_(date);
  return _businessDateKey(date);
}

function _appTimeZone_() {
  return typeof getAppTimeZone_ === 'function' ? getAppTimeZone_() : 'Asia/Jakarta';
}

function _calendarDayStart_(date) {
  if (typeof getAppDayStart_ === 'function') return getAppDayStart_(date);
  var src = _asDate(date) || new Date();
  var d = new Date(src.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function _asDate(val) {
  if (val instanceof Date) return val;
  if (!val) return null;
  var d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function _parseSheetDate(val) {
  if (typeof parseSheetDate_ === 'function') return parseSheetDate_(val);
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (!val) return null;
  var d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function _parseClientDateTime_(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  var s = String(val).trim();
  var tz = _appTimeZone_();
  var formats = [
    "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm",
    'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm'
  ];
  for (var i = 0; i < formats.length; i++) {
    try {
      var dt = Utilities.parseDate(s, tz, formats[i]);
      if (dt && !isNaN(dt.getTime())) return dt;
    } catch (e) { /* try next */ }
  }
  return _parseSheetDate(val);
}

function _isCompletedCookingStatus_(status) {
  var s = (status || '').toString().trim().toUpperCase();
  if (!s) return true;
  return s === 'COMPLETED';
}

function _cookingBatchReadyTime_(row, idx, asOfTime) {
  var now = _asDate(asOfTime) || new Date();
  var start = idx['STARTTIME'] !== undefined ? _parseSheetDate(row[idx['STARTTIME']]) : null;
  var end = idx['ENDTIME'] !== undefined ? _parseSheetDate(row[idx['ENDTIME']]) : null;
  if (end && end.getTime() <= now.getTime()) {
    if (!start || end.getTime() >= start.getTime()) return end;
  }
  if (start && start.getTime() <= now.getTime()) return start;
  return null;
}

function idxStartTime_(row, idx) {
  return idx['STARTTIME'] !== undefined ? _parseSheetDate(row[idx['STARTTIME']]) : null;
}

function _kcRowVal_(row, idx, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (idx[keys[i]] !== undefined) return row[idx[keys[i]]];
  }
  return '';
}

function _readKitchenRowQty_(row, idx) {
  var raw = _kcRowVal_(row, idx, ['QTY', 'QUANTITY']);
  if (raw === '' || raw == null) return 0;
  if (typeof raw === 'number') return isNaN(raw) ? 0 : raw;
  var n = Number(String(raw).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function _registerCookingAliasKeys_(codes, alias) {
  if (!alias) return;
  var raw = alias.toString().trim();
  if (!raw) return;
  codes[raw.toUpperCase()] = true;
  codes[_normalizeProductCodeForMatch_(raw)] = true;
  if (typeof normalizeProductCodeKey_ === 'function') {
    var nk = normalizeProductCodeKey_(raw);
    if (nk) {
      codes[nk] = true;
      codes[nk.toUpperCase()] = true;
    }
  }
}

/** True when a Products-sheet index row is the same sell product as a cooking product. */
function _productIndexEntryBelongsToCookingProduct_(entry, product) {
  if (!entry || !product) return false;
  var nameU = (product.name || '').toString().trim().toUpperCase();
  var entryNameU = (entry.name || '').toString().trim().toUpperCase();
  if (nameU && entryNameU && nameU === entryNameU) return true;

  var canon = _canonicalCookingProductCode_(product);
  var rawCode = (product.productCode || '').toString().trim().toUpperCase();
  var aliases = [entry.code, entry.generated, entry.rawCode];
  for (var i = 0; i < aliases.length; i++) {
    var alias = (aliases[i] || '').toString().trim();
    if (!alias) continue;
    var aliasU = alias.toUpperCase();
    if (rawCode && aliasU === rawCode) return true;
    if (canon && aliasU === canon) return true;
    if (typeof normalizeProductCodeKey_ === 'function') {
      var aliasN = normalizeProductCodeKey_(alias);
      if (rawCode && aliasN === normalizeProductCodeKey_(rawCode)) return true;
      if (canon && aliasN === normalizeProductCodeKey_(canon)) return true;
    }
  }
  return false;
}

function _addProductIndexAliases_(keys, product, productIndex) {
  if (!productIndex || !product || !keys) return;
  var seen = {};
  function maybeRegister(entry) {
    if (!entry || seen[entry.code + '|' + entry.generated + '|' + entry.name]) return;
    if (!_productIndexEntryBelongsToCookingProduct_(entry, product)) return;
    seen[entry.code + '|' + entry.generated + '|' + entry.name] = true;
    _registerCookingAliasKeys_(keys.codes, entry.code);
    _registerCookingAliasKeys_(keys.codes, entry.generated);
    _registerCookingAliasKeys_(keys.codes, entry.rawCode);
  }
  Object.keys(productIndex.byCode || {}).forEach(function(k) {
    maybeRegister(productIndex.byCode[k]);
  });
  Object.keys(productIndex.byGenerated || {}).forEach(function(k) {
    maybeRegister(productIndex.byGenerated[k]);
  });
  Object.keys(productIndex.byName || {}).forEach(function(k) {
    maybeRegister(productIndex.byName[k]);
  });
}

function _productMatchKeys_(product, productIndex) {
  var codes = {};
  var names = {};
  var code = (product && product.productCode || '').toString().trim().toUpperCase();
  if (code) {
    codes[code] = true;
    codes[_normalizeProductCodeForMatch_(code)] = true;
  }
  var canonical = _canonicalCookingProductCode_(product);
  if (canonical) {
    codes[canonical] = true;
    codes[_normalizeProductCodeForMatch_(canonical)] = true;
  }
  var name = (product && product.name || '').toString().trim().toUpperCase();
  if (name) names[name] = true;
  if (productIndex) _addProductIndexAliases_({ codes: codes, names: names }, product, productIndex);
  return { codes: codes, names: names };
}

function _cookingRowMatchesProduct_(rowCode, rowName, product) {
  var keys = _productMatchKeys_(product);
  var rc = (rowCode || '').toString().trim().toUpperCase();
  var rn = (rowName || '').toString().trim().toUpperCase();
  if (rc && (keys.codes[rc] || keys.codes[_normalizeProductCodeForMatch_(rc)])) return true;
  if (rn && keys.names[rn]) return true;
  return _rowMatchesCookingProduct_(rowCode, rowName, product && product.category, product);
}

var KC_STOCK_CACHE_PREFIX = 'kc_stock_summary_v15_';
var KC_STOCK_CACHE_TTL = 45;

function _cookingStockCacheKey_(outlet, asOfTime) {
  var reportKey = _appDateKey_(asOfTime || new Date()) || 'unknown';
  return KC_STOCK_CACHE_PREFIX + (outlet || 'ALL').toString().trim().toUpperCase() + '_' + reportKey;
}

function _clearCookingStockCache_(outlet, asOfTime) {
  try {
    CacheService.getScriptCache().remove(_cookingStockCacheKey_(outlet, asOfTime || new Date()));
  } catch (e) { /* ignore */ }
}

/**
 * Public wrapper so other modules (e.g. orders.js on every sale) can keep the
 * cashier's recook view fresh without reaching into private helpers. Clears
 * today's cached cooking-stock summary for the given outlet.
 */
function invalidateCookingStockCache_(outlet) {
  _clearCookingStockCache_(outlet, new Date());
}

/**
 * Classify remaining cooked stock into a severity tier the sales screen can
 * color-code: 'out' (nothing left), 'low' (at/below recook threshold), 'ok'.
 */
function _cookingStockStatus_(remaining, threshold) {
  var rem = Number(remaining) || 0;
  var thr = Number(threshold) || 0;
  if (rem <= 0) return 'out';
  if (rem <= thr) return 'low';
  return 'ok';
}

function _buildCookingProductLookup_(products, productIndex) {
  productIndex = productIndex || _getKitchenOrderProductIndex_();
  var codeToIdx = {};
  var nameToIdx = {};
  products.forEach(function(p, i) {
    var keys = _productMatchKeys_(p, productIndex);
    Object.keys(keys.codes).forEach(function(c) {
      if (c && codeToIdx[c] === undefined) codeToIdx[c] = i;
    });
    Object.keys(keys.names).forEach(function(n) {
      if (n && nameToIdx[n] === undefined) nameToIdx[n] = i;
    });
  });
  return { products: products, codeToIdx: codeToIdx, nameToIdx: nameToIdx, productIndex: productIndex };
}

function _dayBeforeDateKey_(dateKey) {
  if (!dateKey) return '';
  try {
    var tz = _appTimeZone_();
    var d = Utilities.parseDate(String(dateKey).trim(), tz, 'yyyy-MM-dd');
    d.setDate(d.getDate() - 1);
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  } catch (e) {
    return '';
  }
}

function _dayAfterDateKey_(dateKey) {
  if (!dateKey) return '';
  try {
    var tz = _appTimeZone_();
    var d = Utilities.parseDate(String(dateKey).trim(), tz, 'yyyy-MM-dd');
    d.setDate(d.getDate() + 1);
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  } catch (e) {
    return '';
  }
}

/**
 * Sold qty per cooking product per day — read directly from the Orders sheet.
 * Matches each order row to a cooking product by that product's own code/name only.
 * Deliberately does NOT use the BOM / sales-report resolver, so combos and recipe
 * components are never expanded or misattributed onto cooking products.
 */
function _buildDailySoldFromOrders_(outlet, fromDayKey, toDayKey, asOfTime, lookup) {
  var dailySold = {};
  var n = lookup && lookup.products ? lookup.products.length : 0;
  if (!n || !fromDayKey || !toDayKey || fromDayKey > toDayKey) return dailySold;

  var ordersSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ORDERS);
  if (!ordersSheet || ordersSheet.getLastRow() < 2) return dailySold;

  var lastRow = ordersSheet.getLastRow();
  var lastCol = Math.max(ordersSheet.getLastColumn(), 1);
  var data = ordersSheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headerRow = data[0];
  var tsIdx = headerRow.findIndex(function(h) { return h && /timestamp|date/i.test(h.toString()); });
  var codeIdx = headerRow.findIndex(function(h) { return h && /product.*code|^code$/i.test(h.toString()); });
  var nameIdx = headerRow.findIndex(function(h) { return h && /product.*name|^name$/i.test(h.toString()); });
  var qtyIdx = headerRow.findIndex(function(h) { return h && /qty|quantity/i.test(h.toString()); });
  var outletIdx = headerRow.findIndex(function(h) { return h && /outlet/i.test(h.toString()); });
  if (tsIdx < 0 || qtyIdx < 0) return dailySold;

  // Precompute day boundaries once so we never call Utilities.formatDate per order row.
  var boundaries = _dayBoundariesForRange_(String(fromDayKey).trim(), String(toDayKey).trim());
  if (!boundaries.length) return dailySold;
  var windowStartMs = boundaries[0].startMs;
  var asOf = _asDate(asOfTime);
  var asOfMs = asOf ? asOf.getTime() : null;

  // Cache resolved product index per code/name string to avoid repeat lookups on hot items.
  var resolveCache = {};
  function resolveIdx_(code, name) {
    var ck = code + '\u0001' + name;
    var hit = resolveCache[ck];
    if (hit !== undefined) return hit;
    var idx = _resolveCookingProductIdxByCodeOrName_(code, name, lookup);
    resolveCache[ck] = idx;
    return idx;
  }

  function bucketKeyForMs_(ms) {
    // Last boundary whose startMs <= ms (binary search; boundaries sorted ascending).
    var lo = 0, hi = boundaries.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (boundaries[mid].startMs <= ms) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans >= 0 ? boundaries[ans].key : '';
  }

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (outletIdx >= 0 && !_kitchenOutletMatches_(row[outletIdx], outlet)) continue;
    var ts = _parseSheetDate(row[tsIdx]);
    if (!ts) continue;
    var tms = ts.getTime();
    if (tms < windowStartMs) continue;
    if (asOfMs !== null && tms > asOfMs) continue;
    var qty = Number(row[qtyIdx]) || 0;
    if (qty <= 0) continue;
    var dayKey = bucketKeyForMs_(tms);
    if (!dayKey) continue;
    var code = codeIdx >= 0 ? (row[codeIdx] || '').toString() : '';
    var name = nameIdx >= 0 ? (row[nameIdx] || '').toString() : '';
    var pIdx = resolveIdx_(code, name);
    if (pIdx < 0) continue;
    if (!dailySold[dayKey]) {
      dailySold[dayKey] = new Array(n);
      for (var b = 0; b < n; b++) dailySold[dayKey][b] = 0;
    }
    dailySold[dayKey][pIdx] += qty;
  }
  return dailySold;
}

/** Ascending list of { key:'yyyy-MM-dd', startMs } for each day in [fromKey, toKey]. */
function _dayBoundariesForRange_(fromKey, toKey) {
  var out = [];
  if (!fromKey || !toKey || fromKey > toKey) return out;
  var tz = _appTimeZone_();
  var key = fromKey;
  for (var guard = 0; guard < 4000 && key && key <= toKey; guard++) {
    try {
      var startMs = Utilities.parseDate(key + ' 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss').getTime();
      out.push({ key: key, startMs: startMs });
    } catch (e) { break; }
    if (key >= toKey) break;
    key = _dayAfterDateKey_(key);
  }
  return out;
}

function _earliestDateKey_(dayMap) {
  var keys = Object.keys(dayMap || {}).filter(Boolean).sort();
  return keys.length ? keys[0] : '';
}

function _carryOverFromDailyBuckets_(productCount, reportDateKey, dailyCooked, dailySold, soldTodayArr) {
  var n = productCount || 0;
  var empty = {
    leftoverFromYesterday: [],
    cookedToday: [],
    soldToday: [],
    remaining: [],
    cookedTotal: [],
    soldTotal: []
  };
  if (!n || !reportDateKey) return empty;

  var startDay = _earliestDateKey_(dailyCooked) || _earliestDateKey_(dailySold) || reportDateKey;
  var prevRemaining = new Array(n);
  for (var i = 0; i < n; i++) prevRemaining[i] = 0;

  var walkDay = startDay;
  while (walkDay && walkDay < reportDateKey) {
    var cooked = dailyCooked[walkDay] || [];
    var sold = dailySold[walkDay] || [];
    for (var j = 0; j < n; j++) {
      var leftover = Number(prevRemaining[j]) || 0;
      var cookedQty = Number(cooked[j]) || 0;
      var soldQty = Number(sold[j]) || 0;
      // Physical prepared stock cannot go negative; leftover carried to the next day floors at 0.
      var dayRemaining = leftover + cookedQty - soldQty;
      prevRemaining[j] = dayRemaining > 0 ? dayRemaining : 0;
    }
    walkDay = _dayAfterDateKey_(walkDay);
  }

  var leftoverFromYesterday = prevRemaining.slice();
  var cookedToday = new Array(n);
  var soldToday = new Array(n);
  var remaining = new Array(n);
  var cookedTotal = new Array(n);
  var soldTotal = new Array(n);
  var cookedArr = dailyCooked[reportDateKey] || [];
  var soldArr = dailySold[reportDateKey] || [];

  for (var p = 0; p < n; p++) {
    cookedToday[p] = Number(cookedArr[p]) || 0;
    soldToday[p] = soldTodayArr
      ? (Number(soldTodayArr[p]) || 0)
      : (Number(soldArr[p]) || 0);
    // remaining = leftover from previous day + cooked today − sold today (never below 0).
    var todayRemaining = leftoverFromYesterday[p] + cookedToday[p] - soldToday[p];
    remaining[p] = todayRemaining > 0 ? todayRemaining : 0;

    var ct = 0;
    var st = 0;
    var tallyDay = startDay;
    while (tallyDay && tallyDay <= reportDateKey) {
      var cRow = dailyCooked[tallyDay];
      ct += Number(cRow && cRow[p]) || 0;
      var sRow = dailySold[tallyDay];
      st += Number(sRow && sRow[p]) || 0;
      if (tallyDay >= reportDateKey) break;
      tallyDay = _dayAfterDateKey_(tallyDay);
    }
    cookedTotal[p] = ct;
    soldTotal[p] = st;
  }

  return {
    leftoverFromYesterday: leftoverFromYesterday,
    cookedToday: cookedToday,
    soldToday: soldToday,
    remaining: remaining,
    cookedTotal: cookedTotal,
    soldTotal: soldTotal
  };
}

/** Product index for resolving order row codes (same as BOM/sales). */
function _getKitchenOrderProductIndex_() {
  if (typeof getCachedProductCodeIndex_ === 'function') return getCachedProductCodeIndex_();
  if (typeof loadProductCodeIndex_ === 'function') return loadProductCodeIndex_();
  return null;
}

/** Strict code/name lookup — no fuzzy generateProductCode matching (avoids ayam cross-count). */
function _resolveCookingProductIdxByCodeOrName_(code, name, lookup) {
  if (!lookup) return -1;
  var tried = {};
  function tryKey(k) {
    if (!k || tried[k]) return -1;
    tried[k] = true;
    if (lookup.codeToIdx[k] !== undefined) return lookup.codeToIdx[k];
    return -1;
  }
  if (code) {
    var raw = code.toString().trim();
    var hit = tryKey(raw.toUpperCase());
    if (hit >= 0) return hit;
    if (typeof normalizeProductCodeKey_ === 'function') {
      hit = tryKey(normalizeProductCodeKey_(raw).toUpperCase());
      if (hit >= 0) return hit;
    }
    hit = tryKey(_normalizeProductCodeForMatch_(raw));
    if (hit >= 0) return hit;
  }
  var rn = (name || '').toString().trim().toUpperCase();
  if (rn && lookup.nameToIdx[rn] !== undefined) return lookup.nameToIdx[rn];
  return -1;
}

function _resolveCookingProductIdx_(rowCode, rowName, rowCat, lookup) {
  if (!lookup || !lookup.products.length) return -1;
  var pIdx = _resolveCookingProductIdxByCodeOrName_(rowCode, rowName, lookup);
  if (pIdx >= 0) return pIdx;
  for (var i = 0; i < lookup.products.length; i++) {
    if (_rowMatchesCookingProduct_(rowCode, rowName, rowCat, lookup.products[i])) return i;
  }
  return -1;
}

function _resolveCookingProductIdxForKitchenRow_(rowCode, rowName, lookup) {
  if (!lookup || !lookup.products.length) return -1;
  var rc = (rowCode || '').toString().trim().toUpperCase();
  var rn = (rowName || '').toString().trim().toUpperCase();
  if (rc && lookup.codeToIdx[rc] !== undefined) return lookup.codeToIdx[rc];
  var norm = _normalizeProductCodeForMatch_(rc);
  if (norm && lookup.codeToIdx[norm] !== undefined) return lookup.codeToIdx[norm];
  if (rn && lookup.nameToIdx[rn] !== undefined) return lookup.nameToIdx[rn];
  for (var i = 0; i < lookup.products.length; i++) {
    if (_cookingRowMatchesProduct_(rowCode, rowName, lookup.products[i])) return i;
  }
  return -1;
}

function _kitchenOutletMatches_(rowOutlet, outlet) {
  if (typeof outletRowMatchesUser_ === 'function') {
    return outletRowMatchesUser_(rowOutlet, outlet);
  }
  var rowKey = (rowOutlet || '').toString().trim().toUpperCase();
  var filterKey = (outlet || '').toString().trim().toUpperCase();
  if (!filterKey) return true;
  if (!rowKey) return true;
  return rowKey === filterKey;
}

/** Read all rows from a sheet (header + data). Full scan for lifetime cooked/sold totals. */
function _readSheetAllRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return [];
  return sheet.getDataRange().getValues();
}

/** Full history scan; leftover = previous day's remaining via day-by-day carry-over chain. */
function _aggregateCookingTotalsFullScan_(outlet, asOfTime, products) {
  var now = _asDate(asOfTime) || new Date();
  if (!products.length) return [];

  var reportDateKey = _appDateKey_(now);
  var productIndex = _getKitchenOrderProductIndex_();
  var lookup = _buildCookingProductLookup_(products, productIndex);
  var n = products.length;
  var dailyCooked = {};

  ensureKitchenCookingHeaders();
  var kSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.KITCHEN_COOKING);
  if (kSheet && kSheet.getLastRow() > 1) {
    var kIdx = _kcHeaders(kSheet);
    var kData = _readSheetAllRows_(kSheet);
    for (var kr = 1; kr < kData.length; kr++) {
      var kRow = kData[kr];
      var status = _kcRowVal_(kRow, kIdx, ['STATUS']);
      if (!_isCompletedCookingStatus_(status)) continue;
      if (!_kitchenOutletMatches_(_kcRowVal_(kRow, kIdx, ['OUTLET']), outlet)) continue;
      var readyAt = _cookingBatchReadyTime_(kRow, kIdx, now);
      if (!readyAt || readyAt > now) continue;
      var cookStart = idxStartTime_(kRow, kIdx);
      var cookDayKey = _appDateKey_(cookStart || readyAt);
      if (!cookDayKey || cookDayKey > reportDateKey) continue;
      var kCode = _kcRowVal_(kRow, kIdx, ['PRODUCTCODE', 'PRODUCT_CODE']);
      var kName = _kcRowVal_(kRow, kIdx, ['PRODUCTNAME', 'PRODUCT_NAME']);
      var pIdx = _resolveCookingProductIdxForKitchenRow_(kCode, kName, lookup);
      if (pIdx < 0) continue;
      var qty = _readKitchenRowQty_(kRow, kIdx);
      if (!dailyCooked[cookDayKey]) {
        dailyCooked[cookDayKey] = new Array(n);
        for (var zi = 0; zi < n; zi++) dailyCooked[cookDayKey][zi] = 0;
      }
      dailyCooked[cookDayKey][pIdx] += qty;
    }
  }

  var minCookDay = _earliestDateKey_(dailyCooked) || reportDateKey;
  var dailySold = _buildDailySoldFromOrders_(outlet, minCookDay, reportDateKey, now, lookup);
  var chain = _carryOverFromDailyBuckets_(n, reportDateKey, dailyCooked, dailySold, null);

  return products.map(function(p, i) {
    var cookedTotal = chain.cookedTotal[i];
    var soldTotal = chain.soldTotal[i];
    var remaining = chain.remaining[i];
    var threshold = Number(p.recookThreshold) || 0;
    return {
      productCode: p.productCode,
      name: p.name,
      category: p.category,
      sellUnit: p.sellUnit,
      leftoverFromYesterday: chain.leftoverFromYesterday[i],
      cookedToday: chain.cookedToday[i],
      soldToday: chain.soldToday[i],
      cookedInWindow: cookedTotal,
      soldInWindow: soldTotal,
      cookedTotal: cookedTotal,
      soldTotal: soldTotal,
      remaining: remaining,
      recookThreshold: threshold,
      needsRecook: remaining <= threshold,
      stockStatus: _cookingStockStatus_(remaining, threshold)
    };
  });
}

function _resolvedSessionOutlet_(session) {
  if (!session) return '';
  var o = session.outlet || '';
  if (typeof resolveUserOutlet_ === 'function' && session.username) {
    o = resolveUserOutlet_(session.username, o);
  }
  return (o || '').toString().trim();
}

function _outletRowMatchesFilter_(rowOutlet, filterOutlet) {
  if (!filterOutlet) return true;
  if (typeof outletRowMatchesUser_ === 'function') {
    return outletRowMatchesUser_(rowOutlet, filterOutlet);
  }
  var rowKey = (rowOutlet || '').toString().trim().toUpperCase();
  var filterKey = (filterOutlet || '').toString().trim().toUpperCase();
  if (!rowKey) return true;
  return rowKey === filterKey;
}

function _parseHistoryFilterStart_(dateStr) {
  if (!dateStr) return null;
  try {
    var tz = _appTimeZone_();
    return Utilities.parseDate(String(dateStr).trim(), tz, 'yyyy-MM-dd');
  } catch (e) {
    return null;
  }
}

function _parseHistoryFilterEnd_(dateStr) {
  if (!dateStr) return null;
  try {
    var tz = _appTimeZone_();
    var d = Utilities.parseDate(String(dateStr).trim(), tz, 'yyyy-MM-dd');
    d.setHours(23, 59, 59, 999);
    return d;
  } catch (e) {
    return null;
  }
}

function _historyStartInRange_(start, startDate, endDate) {
  if (!startDate && !endDate) return true;
  if (!start) return true;
  if (startDate && start < startDate) return false;
  if (endDate && start > endDate) return false;
  return true;
}

function _outletMatchesProduct(productOutlet, userOutlet) {
  var o = (productOutlet || '').toString().trim();
  if (!o || o.toUpperCase() === 'ALL') return true;
  return o.split(',').some(function(x) {
    var part = x.trim();
    if (!part) return false;
    if (typeof outletKeysMatch_ === 'function') return outletKeysMatch_(part, userOutlet);
    return part.toUpperCase() === (userOutlet || '').toString().trim().toUpperCase();
  });
}

function getCookingProductsFromSheet(outlet) {
  ensureProductCookingColumns();
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.PRODUCTS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return h.toString().trim().toUpperCase(); });
  var idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });

  var nameIdx = idx['NAME'];
  var codeIdx = idx['PRODUCTCODE'];
  var typeIdx = idx['TYPE'];
  var cookIdx = idx['COOKING_PRODUCT'];
  var threshIdx = idx['RECOOK_THRESHOLD'];
  var outletIdx = idx['OUTLET'];
  var activeIdx = idx['ACTIVE'];
  var catIdx = idx['CATEGORY'];
  var sellUnitIdx = idx['SELLUNIT'];

  if (cookIdx === undefined) return [];

  var products = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (!_isTruthyCookingFlag(row[cookIdx])) continue;
    var type = typeIdx >= 0 ? (row[typeIdx] || '').toString().trim().toUpperCase() : '';
    if (type && type !== 'SELL') continue;
    if (activeIdx >= 0) {
      var active = (row[activeIdx] || '').toString().trim().toUpperCase();
      if (active === 'N' || active === 'NO' || active === 'FALSE' || active === '0') continue;
    }
    if (!_outletMatchesProduct(outletIdx >= 0 ? row[outletIdx] : '', outlet)) continue;
    var code = codeIdx >= 0 ? (row[codeIdx] || '').toString().trim() : '';
    var name = nameIdx >= 0 ? (row[nameIdx] || '').toString().trim() : '';
    var category = catIdx >= 0 ? (row[catIdx] || '').toString().trim() : '';
    if (!code && !name) continue;
    if (!code && typeof generateProductCode === 'function') {
      code = generateProductCode({ name: name, category: category, productCode: '' });
    }
    products.push({
      productCode: code,
      name: name,
      category: catIdx >= 0 ? (row[catIdx] || '').toString() : '',
      sellUnit: sellUnitIdx >= 0 ? (row[sellUnitIdx] || '').toString() : '',
      recookThreshold: threshIdx >= 0 ? (Number(row[threshIdx]) || 0) : 0
    });
  }
  products.sort(function(a, b) { return a.name.localeCompare(b.name); });
  return _dedupeCookingProducts_(products);
}

function _dedupeCookingProducts_(products) {
  var seen = {};
  var out = [];
  products.forEach(function(p) {
    var key = _canonicalCookingProductCode_(p) || (p.name || '').toString().trim().toUpperCase();
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(p);
  });
  return out;
}

function _normalizeProductCodeForMatch_(code) {
  return (code || '').toString().trim().toUpperCase()
    .replace(/[^A-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function _canonicalCookingProductCode_(product) {
  var code = (product && product.productCode || '').toString().trim();
  if (code) return code.toUpperCase();
  if (typeof generateProductCode === 'function') {
    return generateProductCode({
      category: product && product.category,
      name: product && product.name,
      productCode: code
    }).toUpperCase();
  }
  return '';
}

/** Match order/cooking rows to a cooking product by code, derived code, or name. */
function _rowMatchesCookingProduct_(rowCode, rowName, rowCategory, product) {
  var codeU = _canonicalCookingProductCode_(product);
  var nameU = (product && product.name || '').toString().trim().toUpperCase();
  var rowCodeU = (rowCode || '').toString().trim().toUpperCase();
  var rowNameU = (rowName || '').toString().trim().toUpperCase();
  var rowCat = (rowCategory || '').toString().trim();

  if (codeU && rowCodeU && (rowCodeU === codeU ||
      _normalizeProductCodeForMatch_(rowCodeU) === _normalizeProductCodeForMatch_(codeU))) {
    return true;
  }
  if (nameU && rowNameU && rowNameU === nameU) return true;
  if (typeof generateProductCode === 'function') {
    var derivedFromRow = generateProductCode({
      category: rowCat,
      name: rowName,
      productCode: rowCode
    }).toUpperCase();
    if (codeU && derivedFromRow === codeU) return true;
    if (!codeU && nameU && rowNameU && derivedFromRow === generateProductCode({
      category: product.category,
      name: product.name
    }).toUpperCase()) {
      return true;
    }
  }
  return false;
}

function _sumCookedQtyForProduct_(outlet, product, asOfTime) {
  var items = _aggregateCookingTotalsFullScan_(outlet, asOfTime, [product]);
  return (items[0] && items[0].cookedTotal) || 0;
}

function _sumSoldQtyForProduct_(outlet, product, asOfTime) {
  var items = _aggregateCookingTotalsFullScan_(outlet, asOfTime, [product]);
  return (items[0] && items[0].soldTotal) || 0;
}

function _buildCookingStockSummary(outlet, asOfTime, options) {
  options = options || {};
  var now = _asDate(asOfTime) || new Date();
  var products = options.products || getCookingProductsFromSheet(outlet);
  if (!products.length) return [];

  if (!options.skipCache) {
    try {
      var cache = CacheService.getScriptCache();
      var cacheKey = _cookingStockCacheKey_(outlet, now);
      var cached = cache.get(cacheKey);
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.items)) return parsed.items;
      }
    } catch (cacheReadErr) { /* compute fresh */ }
  }

  var items = _aggregateCookingTotalsFullScan_(outlet, now, products);

  if (!options.skipCache) {
    try {
      CacheService.getScriptCache().put(
        _cookingStockCacheKey_(outlet, now),
        JSON.stringify({ items: items, asOf: now.toISOString() }),
        KC_STOCK_CACHE_TTL
      );
    } catch (cacheWriteErr) { /* ignore */ }
  }

  return items;
}

function getCookingProductsSecure(params) {
  try {
    var session = _sessionFromParams(params);
    if (!_canRecordCooking(session)) throw new Error('Access denied');
    var outlet = _resolvedSessionOutlet_(session);
    var now = new Date();
    var items = getCookingProductsFromSheet(outlet);
    var cookedTodayByCode = {};
    if (items.length) {
      var summary = _buildCookingStockSummary(outlet, now, { skipCache: false, products: items });
      summary.forEach(function(row) {
        var code = (row.productCode || '').toString().trim().toUpperCase();
        if (code) cookedTodayByCode[code] = Number(row.cookedToday) || 0;
      });
    }
    items = items.map(function(p) {
      var codeU = (p.productCode || '').toString().trim().toUpperCase();
      return {
        productCode: p.productCode,
        name: p.name,
        category: p.category,
        sellUnit: p.sellUnit,
        recookThreshold: p.recookThreshold,
        cookedToday: cookedTodayByCode[codeU] || 0
      };
    });
    return sanitizeForClient({
      success: true,
      items: items,
      reportDate: _businessDateKey(now),
      timeZone: _appTimeZone_()
    });
  } catch (e) {
    Logger.log('getCookingProductsSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

function submitCookingReportSecure(params) {
  try {
    var productCode = (params.productCode || '').toString().trim();
    var qty = Number(params.qty);
    if (!productCode) throw new Error('Product is required');
    if (!qty || qty <= 0) throw new Error('Quantity must be greater than zero');
    return submitCookingBatchSecure({
      startTime: params.startTime,
      endTime: params.endTime,
      notes: params.notes,
      deviceInfo: params.deviceInfo,
      lines: [{ productCode: productCode, qty: qty }],
      _authContext: params._authContext,
      deviceId: params.deviceId,
      username: params.username
    });
  } catch (e) {
    Logger.log('submitCookingReportSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/**
 * Submit one cooking session: shared start/end time, multiple product qty lines.
 * @param {{startTime:string,endTime:string,notes?:string,lines:Array<{productCode:string,qty:number}>}} params
 */
function submitCookingBatchSecure(params) {
  try {
    var session = _sessionFromParams(params);
    if (!_canRecordCooking(session)) throw new Error('Access denied');

    var idemKey = typeof buildIdempotencyCacheKey_ === 'function'
      ? buildIdempotencyCacheKey_('cook_batch_', params.clientRequestId)
      : '';
    if (idemKey && typeof getIdempotentResult_ === 'function') {
      var cached = getIdempotentResult_(idemKey);
      if (cached) {
        cached.duplicate = true;
        return sanitizeForClient(cached);
      }
    }

    var lines = Array.isArray(params.lines) ? params.lines : [];
    var normalized = [];
    lines.forEach(function(line) {
      var code = (line && line.productCode || '').toString().trim();
      var qty = Number(line && line.qty);
      if (!code || !qty || qty <= 0) return;
      normalized.push({ productCode: code, qty: qty });
    });
    if (!normalized.length) throw new Error('Enter quantity for at least one product');

    var startTime = _parseClientDateTime_(params.startTime) || new Date();
    var endTime = _parseClientDateTime_(params.endTime) || startTime;
    if (isNaN(startTime.getTime())) throw new Error('Invalid start time');
    if (isNaN(endTime.getTime())) throw new Error('Invalid end time');
    if (endTime < startTime) endTime = startTime;

    var outlet = _resolvedSessionOutlet_(session);
    var products = getCookingProductsFromSheet(outlet);
    var productMap = {};
    products.forEach(function(p) {
      var codeU = (p.productCode || '').toString().trim().toUpperCase();
      if (codeU) productMap[codeU] = p;
      var canonical = _canonicalCookingProductCode_(p);
      if (canonical) productMap[canonical] = p;
    });

    var sheet = ensureKitchenCookingHeaders();
    var cookingId = 'COOK-' + Date.now();
    var notes = (params.notes || '').toString();
    var deviceInfo = (params.deviceInfo || '').toString();
    var startStr = formatTimestampForSheet(startTime);
    var endStr = formatTimestampForSheet(endTime);
    var saved = [];
    var sheetRows = [];

    normalized.forEach(function(line) {
      var lineCodeU = line.productCode.toUpperCase();
      var product = productMap[lineCodeU];
      if (!product) {
        product = products.find(function(p) {
          return _canonicalCookingProductCode_(p) === lineCodeU ||
            (p.productCode || '').toString().trim().toUpperCase() === lineCodeU ||
            (p.name || '').toString().trim().toUpperCase() === lineCodeU;
        });
      }
      if (!product) throw new Error('Product is not configured as a cooking product: ' + line.productCode);
      sheetRows.push([
        cookingId,
        startStr,
        endStr,
        product.productCode,
        product.name,
        line.qty,
        session.username,
        outlet,
        'Completed',
        notes,
        session.username,
        deviceInfo
      ]);
      saved.push({ productCode: product.productCode, qty: line.qty });
    });

    if (sheetRows.length) {
      if (typeof appendRowsAtomic_ === 'function') {
        appendRowsAtomic_(sheet, sheetRows);
      } else {
        sheetRows.forEach(function(row) { sheet.appendRow(row); });
      }
    }

    // No AuditLog row here: the batch (id, lines, times, user, outlet) is already
    // the KitchenCooking record above; a second sheet write only slowed submit.

    _clearCookingStockCache_(outlet, startTime);

    var resolvedRequests = null;
    try {
      resolvedRequests = _resolveCookRequestsAfterBatch_(
        outlet,
        saved.map(function(s) { return s.productCode; }),
        session.username,
        products
      );
    } catch (reqErr) {
      Logger.log('cook request auto-resolve failed: ' + reqErr.toString());
    }

    var response = {
      success: true,
      cookingId: cookingId,
      lineCount: saved.length,
      lines: saved,
      requests: resolvedRequests
    };
    if (idemKey && typeof putIdempotentResult_ === 'function') {
      putIdempotentResult_(idemKey, response, 600);
    }

    return sanitizeForClient(response);
  } catch (e) {
    Logger.log('submitCookingBatchSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

function _cookingHistoryProductMatchesFilter_(rowCode, rowName, productFilter) {
  var filter = (productFilter || '').toString().trim();
  if (!filter) return true;
  var pf = filter.toLowerCase();
  var code = (rowCode || '').toString().trim().toLowerCase();
  var name = (rowName || '').toString().trim().toLowerCase();
  if (!pf) return true;
  if (code && code.indexOf(pf) !== -1) return true;
  if (name && name.indexOf(pf) !== -1) return true;
  return false;
}

function getCookingHistorySecure(params) {
  try {
    var session = _sessionFromParams(params);
    if (!_canRecordCooking(session)) throw new Error('Access denied');

    ensureKitchenCookingHeaders();
    var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.KITCHEN_COOKING);
    if (!sheet || sheet.getLastRow() < 2) return sanitizeForClient({ success: true, rows: [] });

    var startDate = _parseHistoryFilterStart_(params.startDate);
    var endDate = _parseHistoryFilterEnd_(params.endDate);
    // Date-bounded: binary-search the (ascending) sheet instead of reading it all; helper falls back to a full read.
    var data;
    if (startDate && endDate) {
      var part = readRowsForDay_(sheet, /start/i, startDate, endDate);
      data = [part.headers].concat(part.rows);
    } else {
      data = sheet.getDataRange().getValues();
    }
    var idx = _kcHeaders(sheet);
    var filterOutlet = _resolvedSessionOutlet_(session);
    if (params.outlet) filterOutlet = (params.outlet || '').toString().trim();
    var productFilter = (params.productFilter || params.productCode || '').toString().trim();
    var filterChef = params.chef ? params.chef.toString().trim().toLowerCase() : '';
    var filterStatus = params.status ? params.status.toString().trim() : '';
    var sortBy = (params.sortBy || 'startTime').toString();
    var sortDir = (params.sortDir || 'desc').toString().toLowerCase() === 'asc' ? 1 : -1;

    var rows = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (!row || !row.some(function(c) { return c !== '' && c != null; })) continue;

      var rowOutletRaw = idx['OUTLET'] !== undefined ? row[idx['OUTLET']] : '';
      if (!_outletRowMatchesFilter_(rowOutletRaw, filterOutlet)) continue;

      var rowCode = (row[idx['PRODUCTCODE']] || '').toString().trim();
      var rowName = (row[idx['PRODUCTNAME']] || '').toString().trim();
      if (!_cookingHistoryProductMatchesFilter_(rowCode, rowName, productFilter)) continue;
      var chef = (row[idx['CHEF']] || '').toString().trim().toLowerCase();
      if (filterChef && chef.indexOf(filterChef) === -1) continue;
      var status = (row[idx['STATUS']] || '').toString();
      if (filterStatus && status !== filterStatus) continue;

      var start = _parseSheetDate(row[idx['STARTTIME']]);
      if (!_historyStartInRange_(start, startDate, endDate)) continue;

      rows.push({
        cookingId: (row[idx['COOKINGID']] || '').toString(),
        startTime: start ? start.toISOString() : '',
        endTime: _parseSheetDate(row[idx['ENDTIME']]) ? _parseSheetDate(row[idx['ENDTIME']]).toISOString() : '',
        productCode: (row[idx['PRODUCTCODE']] || '').toString(),
        productName: (row[idx['PRODUCTNAME']] || '').toString(),
        qty: Number(row[idx['QTY']]) || 0,
        chef: (row[idx['CHEF']] || '').toString(),
        outlet: (rowOutletRaw || '').toString().trim(),
        status: status,
        notes: (row[idx['NOTES']] || '').toString()
      });
    }

    rows.sort(function(a, b) {
      var av, bv;
      if (sortBy === 'qty') { av = a.qty; bv = b.qty; }
      else if (sortBy === 'endTime') { av = a.endTime; bv = b.endTime; }
      else if (sortBy === 'productName') { av = a.productName; bv = b.productName; }
      else { av = a.startTime; bv = b.startTime; }
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });

    return sanitizeForClient({
      success: true,
      rows: rows,
      filter: {
        startDate: params.startDate || '',
        endDate: params.endDate || '',
        outlet: filterOutlet,
        productFilter: productFilter
      }
    });
  } catch (e) {
    Logger.log('getCookingHistorySecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

function getRecookAlertsSecure(params) {
  try {
    var session = _sessionFromParams(params);
    var outlet = _resolvedSessionOutlet_(session);
    if (params.outlet) outlet = params.outlet;
    var now = new Date();
    var items = _buildCookingStockSummary(outlet, now);
    var alerts = items.filter(function(i) { return i.needsRecook; });
    return sanitizeForClient({
      success: true,
      date: _businessDateKey(now),
      asOf: now.toISOString(),
      items: items,
      alerts: alerts,
      alertCount: alerts.length
    });
  } catch (e) {
    Logger.log('getRecookAlertsSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

// ===== COOK REQUESTS (sales → kitchen closed loop) =====
// Sales raises a "please cook more" request; the kitchen screen acknowledges it
// (COOKING) and completes it (DONE). Logging a matching cook batch auto-resolves
// open requests so cashiers get confirmation without a verbal round-trip.

var KC_REQUEST_OPEN_STATUSES = ['REQUESTED', 'COOKING'];
var KC_REQUEST_RECENT_DONE_MS = 2 * 60 * 60 * 1000; // show recently completed for 2h

function ensureKitchenCookRequestsHeaders() {
  var ss = getGlobalSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.KITCHEN_COOK_REQUESTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.KITCHEN_COOK_REQUESTS);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'RequestId', 'CreatedAt', 'Outlet', 'ProductCode', 'ProductName',
      'RequestedQty', 'RequestedBy', 'Status', 'Severity', 'Remaining',
      'UpdatedAt', 'HandledBy', 'Notes', 'Source', 'LastNotifiedAt', 'NotifyCount'
    ]);
    Logger.log('Created Kitchen_CookRequests sheet with headers');
  } else {
    // Migrate older sheets that predate the reminder-state columns.
    _kcEnsureColumn(sheet, 'LastNotifiedAt');
    _kcEnsureColumn(sheet, 'NotifyCount');
  }
  return sheet;
}

function _isOpenCookRequestStatus_(status) {
  return KC_REQUEST_OPEN_STATUSES.indexOf((status || '').toString().trim().toUpperCase()) !== -1;
}

function _cookRequestRowToObject_(row, idx) {
  return {
    requestId: row[idx.REQUESTID],
    createdAt: _kcFormatReportTimeSafe_(row[idx.CREATEDAT]),
    outlet: row[idx.OUTLET],
    productCode: row[idx.PRODUCTCODE],
    productName: row[idx.PRODUCTNAME],
    requestedQty: Number(row[idx.REQUESTEDQTY]) || 0,
    requestedBy: row[idx.REQUESTEDBY],
    status: (row[idx.STATUS] || '').toString().trim().toUpperCase(),
    severity: (row[idx.SEVERITY] || '').toString().trim().toLowerCase(),
    remaining: (row[idx.REMAINING] === '' || row[idx.REMAINING] == null) ? null : Number(row[idx.REMAINING]),
    updatedAt: _kcFormatReportTimeSafe_(row[idx.UPDATEDAT]),
    handledBy: row[idx.HANDLEDBY],
    notes: row[idx.NOTES],
    source: row[idx.SOURCE] !== undefined ? row[idx.SOURCE] : '',
    lastNotifiedAt: idx.LASTNOTIFIEDAT !== undefined ? _kcFormatReportTimeSafe_(row[idx.LASTNOTIFIEDAT]) : '',
    notifyCount: idx.NOTIFYCOUNT !== undefined ? (Number(row[idx.NOTIFYCOUNT]) || 0) : 0
  };
}

function _kcFormatReportTimeSafe_(value) {
  if (value == null || value === '') return '';
  try { return value instanceof Date ? value.toISOString() : String(value); }
  catch (e) { return String(value); }
}

function _findOpenCookRequestRowIndex_(data, idx, outlet, productCode) {
  var pc = (productCode || '').toString().trim().toUpperCase();
  var ou = (outlet || '').toString().trim().toUpperCase();
  for (var r = data.length - 1; r >= 1; r--) {
    var row = data[r];
    if (!_isOpenCookRequestStatus_(row[idx.STATUS])) continue;
    if ((row[idx.PRODUCTCODE] || '').toString().trim().toUpperCase() !== pc) continue;
    if (ou && (row[idx.OUTLET] || '').toString().trim().toUpperCase() !== ou) continue;
    return r;
  }
  return -1;
}

/** Sales action: ask the kitchen to cook more of a product (de-duplicates open requests). */
function requestCookMoreSecure(params) {
  try {
    var session = _sessionFromParams(params);
    var outlet = _resolvedSessionOutlet_(session);
    if (params.outlet) outlet = (params.outlet || '').toString().trim();
    var productCode = (params.productCode || '').toString().trim();
    if (!productCode) throw new Error('Product is required');
    var productName = (params.productName || '').toString().trim();
    var requestedQty = Number(params.requestedQty) || 0;
    var severity = (params.severity || '').toString().trim().toLowerCase();
    var remaining = (params.remaining == null || params.remaining === '') ? '' : Number(params.remaining);
    var notes = (params.notes || '').toString();

    var sheet = ensureKitchenCookRequestsHeaders();
    var idx = _kcHeaders(sheet);
    var now = new Date();
    var nowStr = formatTimestampForSheet(now);
    var data = _readSheetAllRows_(sheet);

    var existing = _findOpenCookRequestRowIndex_(data, idx, outlet, productCode);
    if (existing >= 1) {
      var sheetRow = existing + 1;
      var range = sheet.getRange(sheetRow, 1, 1, sheet.getLastColumn());
      var vals = range.getValues()[0];
      if (requestedQty > (Number(vals[idx.REQUESTEDQTY]) || 0)) vals[idx.REQUESTEDQTY] = requestedQty;
      if (severity) vals[idx.SEVERITY] = severity;
      if (remaining !== '') vals[idx.REMAINING] = remaining;
      vals[idx.UPDATEDAT] = nowStr;
      if (notes) vals[idx.NOTES] = notes;
      range.setValues([vals]);
      // CookRequests row (UpdatedAt) is the record; no duplicate AuditLog write.
      return sanitizeForClient({
        success: true,
        requestId: vals[idx.REQUESTID],
        status: (vals[idx.STATUS] || 'REQUESTED').toString().toUpperCase(),
        updated: true
      });
    }

    var requestId = 'REQ-' + Date.now();
    var row = [];
    for (var c = 0; c < sheet.getLastColumn(); c++) row.push('');
    row[idx.REQUESTID] = requestId;
    row[idx.CREATEDAT] = nowStr;
    row[idx.OUTLET] = outlet;
    row[idx.PRODUCTCODE] = productCode;
    row[idx.PRODUCTNAME] = productName;
    row[idx.REQUESTEDQTY] = requestedQty;
    row[idx.REQUESTEDBY] = session.username;
    row[idx.STATUS] = 'REQUESTED';
    row[idx.SEVERITY] = severity;
    row[idx.REMAINING] = remaining;
    row[idx.UPDATEDAT] = nowStr;
    row[idx.NOTES] = notes;
    row[idx.SOURCE] = (params.source || 'sales').toString();

    if (typeof appendRowsAtomic_ === 'function') {
      appendRowsAtomic_(sheet, [row]);
    } else {
      sheet.appendRow(row);
    }
    // CookRequests row (RequestedBy/CreatedAt) is the record; no duplicate AuditLog write.
    return sanitizeForClient({ success: true, requestId: requestId, status: 'REQUESTED', updated: false });
  } catch (e) {
    Logger.log('requestCookMoreSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Returns open cook requests (+ recently completed) for the outlet. */
function getCookRequestsSecure(params) {
  try {
    var session = _sessionFromParams(params);
    var outlet = _resolvedSessionOutlet_(session);
    if (params.outlet) outlet = (params.outlet || '').toString().trim();
    var sheet = ensureKitchenCookRequestsHeaders();
    var idx = _kcHeaders(sheet);
    var data = _readSheetAllRows_(sheet);
    var ou = (outlet || '').toString().trim().toUpperCase();
    var nowMs = Date.now();
    var open = [];
    var openByCode = {};
    var recentDone = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (ou && (row[idx.OUTLET] || '').toString().trim().toUpperCase() !== ou) continue;
      var status = (row[idx.STATUS] || '').toString().trim().toUpperCase();
      var obj = _cookRequestRowToObject_(row, idx);
      if (_isOpenCookRequestStatus_(status)) {
        // One open request per product: keep the earliest (original) request,
        // surface the latest reminder across any duplicates.
        var code = (obj.productCode || obj.productName || '').toString().trim().toUpperCase();
        var prev = openByCode[code];
        if (!prev) {
          openByCode[code] = obj;
          open.push(obj);
        } else {
          if (obj.createdAt && (!prev.createdAt || obj.createdAt < prev.createdAt)) {
            prev.createdAt = obj.createdAt;
            prev.requestId = obj.requestId;
            prev.requestedBy = obj.requestedBy;
          }
          if (obj.lastNotifiedAt && (!prev.lastNotifiedAt || obj.lastNotifiedAt > prev.lastNotifiedAt)) prev.lastNotifiedAt = obj.lastNotifiedAt;
          prev.notifyCount = (Number(prev.notifyCount) || 0) + (Number(obj.notifyCount) || 0);
          if (obj.updatedAt && (!prev.updatedAt || obj.updatedAt > prev.updatedAt)) {
            prev.updatedAt = obj.updatedAt;
            prev.remaining = obj.remaining;
            prev.severity = obj.severity;
            prev.status = obj.status;
          }
        }
      } else if (status === 'DONE') {
        var upd = _parseSheetDate(row[idx.UPDATEDAT]);
        if (upd && (nowMs - upd.getTime()) <= KC_REQUEST_RECENT_DONE_MS) recentDone.push(obj);
      }
    }
    return sanitizeForClient({
      success: true,
      outlet: outlet,
      open: open,
      openCount: open.length,
      recentDone: recentDone
    });
  } catch (e) {
    Logger.log('getCookRequestsSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Kitchen action: move a request to COOKING / DONE / CANCELLED. */
function updateCookRequestStatusSecure(params) {
  try {
    var session = _sessionFromParams(params);
    if (!_canRecordCooking(session)) throw new Error('Access denied');
    var requestId = (params.requestId || '').toString().trim();
    if (!requestId) throw new Error('Request id is required');
    var newStatus = (params.status || '').toString().trim().toUpperCase();
    if (['REQUESTED', 'COOKING', 'DONE', 'CANCELLED'].indexOf(newStatus) === -1) {
      throw new Error('Invalid status');
    }
    var sheet = ensureKitchenCookRequestsHeaders();
    var idx = _kcHeaders(sheet);
    var data = _readSheetAllRows_(sheet);
    for (var r = 1; r < data.length; r++) {
      if ((data[r][idx.REQUESTID] || '').toString().trim() === requestId) {
        // data[r] was just read (same width as the sheet), so no second row read.
        var vals = data[r].slice();
        vals[idx.STATUS] = newStatus;
        vals[idx.UPDATEDAT] = formatTimestampForSheet(new Date());
        vals[idx.HANDLEDBY] = session.username;
        sheet.getRange(r + 1, 1, 1, vals.length).setValues([vals]);
        // CookRequests row (Status/HandledBy/UpdatedAt) is the record; no duplicate AuditLog write.
        return sanitizeForClient({ success: true, requestId: requestId, status: newStatus });
      }
    }
    throw new Error('Request not found');
  } catch (e) {
    Logger.log('updateCookRequestStatusSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Auto-close open requests when a matching cook batch is logged. */
/**
 * After a cooking batch: close open requests only for products whose remaining
 * stock is now ABOVE the recook threshold. Products still at/below threshold
 * keep their request open (status COOKING, remaining refreshed) so the alert
 * persists until enough has been cooked.
 */
function _resolveCookRequestsAfterBatch_(outlet, productCodes, username, products) {
  var result = { done: [], stillOpen: [] };
  if (!productCodes || !productCodes.length) return result;
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.KITCHEN_COOK_REQUESTS);
  if (!sheet || sheet.getLastRow() < 2) return result;

  var wanted = {};
  productCodes.forEach(function(c) {
    var u = (c || '').toString().trim().toUpperCase();
    if (u) wanted[u] = true;
  });

  // Fresh stock position (cache was just cleared by the caller).
  var byCode = {};
  try {
    var summary = _buildCookingStockSummary(outlet, new Date(), { skipCache: true, products: products || getCookingProductsFromSheet(outlet) });
    summary.forEach(function(it) {
      var u = (it.productCode || '').toString().trim().toUpperCase();
      if (u) byCode[u] = it;
    });
  } catch (e) {
    Logger.log('_resolveCookRequestsAfterBatch_: summary failed, falling back to unconditional close: ' + e);
  }

  var idx = _kcHeaders(sheet);
  var ou = (outlet || '').toString().trim().toUpperCase();
  var nowStr = formatTimestampForSheet(new Date());
  var data = _readSheetAllRows_(sheet);
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (!_isOpenCookRequestStatus_(row[idx.STATUS])) continue;
    var code = (row[idx.PRODUCTCODE] || '').toString().trim().toUpperCase();
    if (!wanted[code]) continue;
    if (ou && (row[idx.OUTLET] || '').toString().trim().toUpperCase() !== ou) continue;

    var item = byCode[code];
    var aboveThreshold = !item || !item.needsRecook; // unknown product → treat as satisfied (legacy behaviour)
    // data[r] was just read (same width as the sheet): write it back, no re-read.
    var vals = row.slice();
    if (item && idx.REMAINING !== undefined) vals[idx.REMAINING] = item.remaining;
    if (item && idx.SEVERITY !== undefined) vals[idx.SEVERITY] = item.stockStatus || '';
    vals[idx.UPDATEDAT] = nowStr;
    if (username) vals[idx.HANDLEDBY] = username;
    if (aboveThreshold) {
      vals[idx.STATUS] = 'DONE';
      result.done.push(code);
    } else {
      vals[idx.STATUS] = 'COOKING';
      result.stillOpen.push({ productCode: code, remaining: item.remaining, threshold: item.recookThreshold });
    }
    sheet.getRange(r + 1, 1, 1, vals.length).setValues([vals]);
  }
  return result;
}

/** Legacy: unconditional close (kept for callers that need it). */
function _resolveCookRequestsForProducts_(outlet, productCodes, username) {
  try {
    if (!productCodes || !productCodes.length) return;
    var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.KITCHEN_COOK_REQUESTS);
    if (!sheet || sheet.getLastRow() < 2) return;
    var idx = _kcHeaders(sheet);
    var wanted = {};
    productCodes.forEach(function(c) {
      var u = (c || '').toString().trim().toUpperCase();
      if (u) wanted[u] = true;
    });
    var ou = (outlet || '').toString().trim().toUpperCase();
    var nowStr = formatTimestampForSheet(new Date());
    var data = _readSheetAllRows_(sheet);
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (!_isOpenCookRequestStatus_(row[idx.STATUS])) continue;
      if (!wanted[(row[idx.PRODUCTCODE] || '').toString().trim().toUpperCase()]) continue;
      if (ou && (row[idx.OUTLET] || '').toString().trim().toUpperCase() !== ou) continue;
      var range = sheet.getRange(r + 1, 1, 1, sheet.getLastColumn());
      var vals = range.getValues()[0];
      vals[idx.STATUS] = 'DONE';
      vals[idx.UPDATEDAT] = nowStr;
      if (username) vals[idx.HANDLEDBY] = username;
      range.setValues([vals]);
    }
  } catch (e) {
    Logger.log('_resolveCookRequestsForProducts_ error: ' + e.toString());
  }
}

function getCookingTodayReportSecure(params) {
  try {
    var session = _sessionFromParams(params);
    if (!_canRecordCooking(session)) throw new Error('Access denied');
    var outlet = _resolvedSessionOutlet_(session);
    if (params.outlet) outlet = (params.outlet || '').toString().trim();
    var now = new Date();
    var reportDateStr = params.reportDate ? String(params.reportDate).trim() : '';
    var asOf;
    if (reportDateStr) {
      asOf = _parseHistoryFilterEnd_(reportDateStr) || now;
    } else if (params.asOf) {
      asOf = _parseClientDateTime_(params.asOf);
    } else {
      asOf = now;
    }
    if (!asOf || isNaN(asOf.getTime())) asOf = now;
    if (asOf.getTime() > now.getTime()) asOf = now;
    if (!reportDateStr) reportDateStr = _businessDateKey(asOf);
    var forceRefresh = params.forceRefresh === true || params.forceRefresh === 'true';
    var products = getCookingProductsFromSheet(outlet);
    var items = _buildCookingStockSummary(outlet, asOf, { skipCache: forceRefresh, products: products });
    var needsRecook = items.filter(function(i) { return i.needsRecook; });
    return sanitizeForClient({
      success: true,
      outlet: outlet,
      reportDate: reportDateStr,
      timeZone: _appTimeZone_(),
      asOf: asOf.toISOString(),
      items: items,
      needsRecookCount: needsRecook.length,
      productCount: items.length
    });
  } catch (e) {
    Logger.log('getCookingTodayReportSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Chef report: lifetime cooked vs sold; remaining = total cooked − total sold. */
function getCookingVsSalesReportSecure(params) {
  try {
    var session = _sessionFromParams(params);
    if (!_canRecordCooking(session)) throw new Error('Access denied');
    var outlet = _resolvedSessionOutlet_(session);
    if (params.outlet) outlet = (params.outlet || '').toString().trim();
    var asOf = params.asOf ? _parseClientDateTime_(params.asOf) : new Date();
    if (!asOf || isNaN(asOf.getTime())) asOf = new Date();
    var forceRefresh = params.forceRefresh === true || params.forceRefresh === 'true';
    var items = _buildCookingStockSummary(outlet, asOf, { skipCache: forceRefresh });
    var needsRecook = items.filter(function(i) { return i.needsRecook; });
    return sanitizeForClient({
      success: true,
      outlet: outlet,
      date: _businessDateKey(asOf),
      timeZone: _appTimeZone_(),
      asOf: asOf.toISOString(),
      items: items,
      needsRecookCount: needsRecook.length,
      productCount: items.length
    });
  } catch (e) {
    Logger.log('getCookingVsSalesReportSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}
