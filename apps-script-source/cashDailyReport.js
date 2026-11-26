/**
 * cashDailyReport.js — Deposits ▸ Daily cash report (restores the HTML app's
 * "Daily Summary" under Cash position).
 *
 * Takes the per-day rows from getDailyCashSummary (cashManagement.js, newest
 * first, with running cash in hand) and adds every total the screen shows, so
 * the client only displays numbers:
 *   daily net = sales − deductible expenses − cash purchases − deposits
 *   per month: summed columns, net, and cash in hand at the month's last day
 *   all time:  summed columns, net, and current cash in hand
 * Served by ReportingWorker.dailyCash (event cash.daily.requested).
 */

var CASH_DAILY_SUM_FIELDS_ = [
  'totalSales', 'cashSales', 'cashExpenses', 'deductibleExpenses',
  'cashPurchases', 'deposits', 'depositsQris', 'depositsTransfer'
];

/** Pure. `days` = getDailyCashSummary rows, newest first. */
function buildDailyCashReport_(days) {
  days = Array.isArray(days) ? days : [];
  var salesMethods = {};
  var depositMethods = {};
  days.forEach(function (d) {
    Object.keys(d.salesByPaymentMethod || {}).forEach(function (k) { salesMethods[k] = true; });
    Object.keys(d.depositsByPaymentMethod || {}).forEach(function (k) { depositMethods[k] = true; });
  });

  var netOf = function (r) {
    return (r.totalSales || 0) - (r.deductibleExpenses || 0) - (r.cashPurchases || 0) - (r.deposits || 0);
  };
  var blank = function () {
    var s = { salesByPaymentMethod: {}, depositsByPaymentMethod: {} };
    CASH_DAILY_SUM_FIELDS_.forEach(function (f) { s[f] = 0; });
    return s;
  };
  var add = function (s, d) {
    CASH_DAILY_SUM_FIELDS_.forEach(function (f) { s[f] += Number(d[f]) || 0; });
    ['salesByPaymentMethod', 'depositsByPaymentMethod'].forEach(function (m) {
      Object.keys(d[m] || {}).forEach(function (k) { s[m][k] = (s[m][k] || 0) + (Number(d[m][k]) || 0); });
    });
  };

  var out = days.map(function (d) {
    var row = {};
    Object.keys(d).forEach(function (k) { row[k] = d[k]; });
    row.dailyNet = netOf(d);
    return row;
  });

  var months = [];
  var byMonth = {};
  var total = blank();
  out.forEach(function (d) {
    if (!byMonth[d.month]) {
      // Rows are newest first, so the first row seen is the month's last day.
      byMonth[d.month] = blank();
      byMonth[d.month].month = d.month;
      byMonth[d.month].monthDisplayName = d.monthDisplayName;
      byMonth[d.month].cashInHand = d.cashInHand;
      byMonth[d.month].days = 0;
      months.push(byMonth[d.month]);
    }
    add(byMonth[d.month], d);
    byMonth[d.month].days++;
    add(total, d);
  });
  months.forEach(function (m) { m.net = netOf(m); });
  total.net = netOf(total);
  total.cashInHand = out.length ? out[0].cashInHand : 0;

  return {
    days: out,
    months: months,
    total: total,
    salesMethods: Object.keys(salesMethods).sort(),
    depositMethods: Object.keys(depositMethods).sort()
  };
}
