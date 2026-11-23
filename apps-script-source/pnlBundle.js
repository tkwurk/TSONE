/**
 * P&L performance bundle (Snowbee E1) — one sheet scan per year, cached 5 min.
 */

var PNL_CACHE_TTL_SEC = 300;
var PNL_CACHE_VERSION = 'v1';

function pnlCacheKey_(outlet, year) {
  return 'pnl_' + PNL_CACHE_VERSION + '_' + (outlet || '_all_') + '_' + year;
}

/** Clear P&L cache after financial writes (orders, purchases, expenses). */
function invalidatePnLCache_(outlet) {
  try {
    var y = new Date().getFullYear();
    var keys = [];
    for (var i = 0; i < 5; i++) {
      keys.push(pnlCacheKey_(outlet, y - i), pnlCacheKey_(null, y - i));
    }
    // One cache call instead of ten (runs on every order/purchase/expense save).
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) {
    Logger.log('invalidatePnLCache_ failed: ' + e);
  }
}

function resolvePnLSession_(deviceId, username) {
  if (deviceId && username) {
    return getUserSessionEnhanced(deviceId, username) || {};
  }
  return getUserSessionEnhanced(deviceId) || {};
}

/** Fast date → YYYY-MM-DD without verbose logging (bulk P&L scans). */
function getDayKeyFast_(date) {
  if (!date) return null;
  var d;
  if (date instanceof Date) {
    d = date;
  } else if (typeof date === 'string') {
    var tz = Session.getScriptTimeZone();
    var formats = [
      'yyyy-MM-dd', 'MM-dd-yyyy HH:mm:ss', 'MM/dd/yyyy HH:mm:ss',
      'MM-dd-yyyy', 'MM/dd/yyyy', 'dd-MM-yyyy'
    ];
    for (var i = 0; i < formats.length; i++) {
      try {
        d = Utilities.parseDate(date, tz, formats[i]);
        if (d && !isNaN(d.getTime())) break;
      } catch (e) { /* try next */ }
    }
    if (!d || isNaN(d.getTime())) d = new Date(date);
  } else {
    d = new Date(date);
  }
  if (!d || isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' +
    ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getDate()).slice(-2);
}

function pnlRowMatchesOutlet_(row, outletIdx, userOutlet) {
  return !(outletIdx !== -1 && userOutlet && row[outletIdx] !== userOutlet);
}

function pnlYearFromDayKey_(dayKey) {
  return parseInt(dayKey.substring(0, 4), 10);
}

function buildPnLBundle_(userOutlet, year) {
  var monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  var daily = {};
  var months = [];
  var m;
  for (m = 0; m < 12; m++) {
    months.push({
      month: m,
      label: monthNames[m] + ' ' + year,
      sales: 0,
      purchases: 0,
      expenses: 0
    });
  }
  var categoryData = {};
  var monthlyCategoryRaw = {};
  var monthlyExpenses = {};
  var yearExpenses = 0;

  function ensureDaily(dayKey) {
    if (!daily[dayKey]) {
      daily[dayKey] = { sales: 0, purchases: 0, expenses: 0 };
    }
  }

  function ensureCat(cat) {
    if (!categoryData[cat]) categoryData[cat] = { sales: 0, purchases: 0 };
  }

  function ensureMonthCat(ym, cat) {
    if (!monthlyCategoryRaw[ym]) monthlyCategoryRaw[ym] = {};
    if (!monthlyCategoryRaw[ym][cat]) {
      monthlyCategoryRaw[ym][cat] = { sales: 0, purchases: 0 };
    }
  }

  function normalizeCat(row, categoryIdx) {
    var cat = (categoryIdx !== -1 && row[categoryIdx])
      ? row[categoryIdx].toString().trim()
      : 'Uncategorized';
    return cat || 'Uncategorized';
  }

  var ss = getGlobalSpreadsheet();
  var salesSheet = ss.getSheetByName(SHEETS.ORDERS);
  if (salesSheet) {
    var salesData = salesSheet.getDataRange().getValues();
    if (salesData.length > 1) {
      var salesHeaders = salesData.shift();
      var salesCols = getTransactionColumns(salesHeaders, 'ORDERS');
      salesData.forEach(function(row) {
        if (!pnlRowMatchesOutlet_(row, salesCols.outlet, userOutlet)) return;
        if (!row || salesCols.date === -1 || !row[salesCols.date]) return;
        var dayKey = getDayKeyFast_(row[salesCols.date]);
        if (!dayKey || pnlYearFromDayKey_(dayKey) !== year) return;
        var amt = Number(row[salesCols.total]) || 0;
        var ym = dayKey.substring(0, 7);
        var txMonth = parseInt(dayKey.substring(5, 7), 10) - 1;
        var cat = normalizeCat(row, salesCols.category);

        ensureDaily(dayKey);
        daily[dayKey].sales += amt;
        months[txMonth].sales += amt;
        ensureCat(cat);
        categoryData[cat].sales += amt;
        ensureMonthCat(ym, cat);
        monthlyCategoryRaw[ym][cat].sales += amt;
      });
    }
  }

  var purchaseSheet = ss.getSheetByName(SHEETS.PURCHASES);
  if (purchaseSheet) {
    var purchaseData = purchaseSheet.getDataRange().getValues();
    if (purchaseData.length > 1) {
      var purchaseHeaders = purchaseData.shift();
      var purchaseCols = getTransactionColumns(purchaseHeaders, 'PURCHASES');
      var purchaseInvIdx = purchaseInvestmentColIndex_(purchaseHeaders);
      purchaseData.forEach(function(row) {
        if (!pnlRowMatchesOutlet_(row, purchaseCols.outlet, userOutlet)) return;
        if (isInvestmentPurchaseRow_(row, purchaseInvIdx)) return; // capital spend, not P&L cost
        if (!row || purchaseCols.date === -1 || !row[purchaseCols.date]) return;
        var dayKey = getDayKeyFast_(row[purchaseCols.date]);
        if (!dayKey || pnlYearFromDayKey_(dayKey) !== year) return;
        var amt = Number(row[purchaseCols.total]) || 0;
        var ym = dayKey.substring(0, 7);
        var txMonth = parseInt(dayKey.substring(5, 7), 10) - 1;
        var cat = normalizeCat(row, purchaseCols.category);

        ensureDaily(dayKey);
        daily[dayKey].purchases += amt;
        months[txMonth].purchases += amt;
        ensureCat(cat);
        categoryData[cat].purchases += amt;
        ensureMonthCat(ym, cat);
        monthlyCategoryRaw[ym][cat].purchases += amt;
      });
    }
  }

  var expenseSheet = ss.getSheetByName(SHEETS.EXPENSES);
  if (expenseSheet) {
    var expenseData = expenseSheet.getDataRange().getValues();
    if (expenseData.length > 1) {
      var expenseHeaders = expenseData.shift();
      var expenseCols = getTransactionColumns(expenseHeaders, 'EXPENSES');
      var amountIdx = expenseCols.amount !== -1 ? expenseCols.amount : expenseCols.total;
      expenseData.forEach(function(row) {
        if (!pnlRowMatchesOutlet_(row, expenseCols.outlet, userOutlet)) return;
        if (!row || expenseCols.date === -1 || !row[expenseCols.date]) return;
        var dayKey = getDayKeyFast_(row[expenseCols.date]);
        if (!dayKey || pnlYearFromDayKey_(dayKey) !== year) return;
        var amt = Number(row[amountIdx]) || 0;
        var ym = dayKey.substring(0, 7);
        var txMonth = parseInt(dayKey.substring(5, 7), 10) - 1;

        ensureDaily(dayKey);
        daily[dayKey].expenses += amt;
        months[txMonth].expenses += amt;
        yearExpenses += amt;
        monthlyExpenses[ym] = (monthlyExpenses[ym] || 0) + amt;
      });
    }
  }

  var dailyArray = Object.keys(daily).sort().map(function(dayKey) {
    var d = daily[dayKey];
    return {
      date: dayKey,
      sales: d.sales,
      purchases: d.purchases,
      expenses: d.expenses,
      profit: d.sales - d.purchases - d.expenses
    };
  });

  var now = new Date();
  var currentYear = now.getFullYear();
  var currentMonth = now.getMonth();
  var monthly = months.map(function(item) {
    return {
      label: item.label,
      sales: item.sales,
      purchases: item.purchases,
      expenses: item.expenses,
      profit: item.sales - item.purchases - item.expenses,
      isFuture: year > currentYear || (year === currentYear && item.month > currentMonth),
      isPartial: year === currentYear && item.month === currentMonth
    };
  });

  var totalSales = 0;
  Object.keys(categoryData).forEach(function(cat) {
    totalSales += categoryData[cat].sales;
  });
  var categories = Object.keys(categoryData).map(function(cat) {
    var d = categoryData[cat];
    var salesPct = totalSales > 0 ? d.sales / totalSales : 0;
    var allocatedExpenses = Math.round(yearExpenses * salesPct);
    return {
      category: cat,
      sales: d.sales,
      purchases: d.purchases,
      expenses: allocatedExpenses,
      salesPct: Math.round(salesPct * 1000) / 10,
      profit: d.sales - d.purchases - allocatedExpenses
    };
  }).sort(function(a, b) { return b.profit - a.profit; });

  var monthlyCategory = {};
  Object.keys(monthlyCategoryRaw).forEach(function(ym) {
    var monthExp = monthlyExpenses[ym] || 0;
    var monthSales = 0;
    Object.keys(monthlyCategoryRaw[ym]).forEach(function(cat) {
      monthSales += monthlyCategoryRaw[ym][cat].sales;
    });
    var monthCats = Object.keys(monthlyCategoryRaw[ym]).map(function(cat) {
      var d = monthlyCategoryRaw[ym][cat];
      var salesPct = monthSales > 0 ? d.sales / monthSales : 0;
      var allocatedExpenses = Math.round(monthExp * salesPct);
      return {
        category: cat,
        sales: d.sales,
        purchases: d.purchases,
        expenses: allocatedExpenses,
        salesPct: Math.round(salesPct * 1000) / 10,
        profit: d.sales - d.purchases - allocatedExpenses
      };
    }).sort(function(a, b) { return b.profit - a.profit; });
    monthlyCategory[ym] = { categories: monthCats, totalExpenses: monthExp };
  });

  return {
    year: year,
    daily: dailyArray,
    monthly: monthly,
    category: { categories: categories, totalExpenses: yearExpenses },
    monthlyCategory: monthlyCategory
  };
}

/**
 * Single entry point for Weekly / Monthly / Category P&L views.
 * @returns {{year:number,daily:Array,monthly:Array,category:Object,monthlyCategory:Object}}
 */
function getPnLBundle(deviceId, username, year) {
  year = Number(year) || new Date().getFullYear();
  var session = resolvePnLSession_(deviceId, username);
  var userOutlet = session.outlet;
  var cache = CacheService.getScriptCache();
  var key = pnlCacheKey_(userOutlet, year);
  var cached = cache.get(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      Logger.log('PnL cache parse failed: ' + e);
    }
  }

  var bundle = buildPnLBundle_(userOutlet, year);
  try {
    cache.put(key, JSON.stringify(bundle), PNL_CACHE_TTL_SEC);
  } catch (e) {
    Logger.log('PnL cache put skipped (payload too large?): ' + e);
  }
  return bundle;
}

function getPnLMonthlyCategoryFromBundle(deviceId, username, year, month) {
  var ym = year + '-' + ('0' + Number(month)).slice(-2);
  var bundle = getPnLBundle(deviceId, username, year);
  return bundle.monthlyCategory[ym] || { categories: [], totalExpenses: 0 };
}
