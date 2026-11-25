/**
 * cookingAudit.js — Cooking audit report: how long customers had no stock.
 *
 * For every cooking product it replays the period minute by minute with the
 * same model as the Kitchen "Today" report:
 *   stock = leftover from the previous day + batches (at their ready time) − sales
 * A sell-out starts when a sale takes stock to 0 or below; it ends when the next
 * batch is ready. Per sell-out it reports the waiting time (sold out → ready),
 * the kitchen's reaction (sold out → cooking started) and the cooking time,
 * plus customers turned away (MissedOrders) during the gap.
 *
 * Per product it suggests a recook threshold: the stock at which cooking must
 * START so the batch is ready before stock runs out:
 *   ceil(sales per minute before sell-outs × (typical cooking minutes + buffer))
 *
 * Read-only. Served by ReportingWorker.cookingAudit (event cooking.audit.requested).
 * Reads via Repo; reuses the kitchen's product matching and carry-over helpers
 * (kitchenCooking.js) so numbers match the Today report.
 */

var COOKING_AUDIT_RATE_WINDOW_MIN = 60; // sales rate measured over the hour before a sell-out
var COOKING_AUDIT_BUFFER_MIN = 5;       // time for staff to notice and start cooking
var COOKING_AUDIT_MAX_COOK_MIN = 360;   // ignore implausible batch durations (data entry slips)

/**
 * Pure replay. No sheet access.
 * @param {{
 *   products: {productCode: string, name: string, recookThreshold?: number}[],
 *   leftover: number[],                                   // stock at the start of the first day
 *   days: {key: string, startMs: number, endMs: number}[], // consecutive, ascending
 *   batches: {p: number, startMs: ?number, readyMs: number, qty: number, chef?: string}[],
 *   sales: {p: number, ms: number, qty: number}[],
 *   missed: {p: number, ms: number, qty: number}[]
 * }} input
 */
function buildCookingAudit_(input) {
  var products = input.products || [];
  var n = products.length;
  var round1 = function (x) { return Math.round(x * 10) / 10; };
  var mins = function (ms) { return round1(ms / 60000); };
  var iso = function (ms) { return ms == null ? '' : new Date(ms).toISOString(); };

  var byP = [];
  for (var i = 0; i < n; i++) byP.push({ events: [], sales: [], missed: [], cookMins: [] });
  (input.batches || []).forEach(function (b) {
    if (b.p < 0 || b.p >= n || !(b.qty > 0)) return;
    byP[b.p].events.push({ ms: b.readyMs, kind: 0, qty: b.qty, startMs: b.startMs, chef: b.chef || '' });
    if (b.startMs != null && b.readyMs > b.startMs) {
      var d = (b.readyMs - b.startMs) / 60000;
      if (d <= COOKING_AUDIT_MAX_COOK_MIN) byP[b.p].cookMins.push(d);
    }
  });
  (input.sales || []).forEach(function (s) {
    if (s.p < 0 || s.p >= n || !(s.qty > 0)) return;
    byP[s.p].events.push({ ms: s.ms, kind: 1, qty: s.qty });
    byP[s.p].sales.push(s);
  });
  (input.missed || []).forEach(function (m) {
    if (m.p >= 0 && m.p < n && m.qty > 0) byP[m.p].missed.push(m);
  });

  var episodes = [];
  var summaries = [];
  var days = input.days || [];

  for (var p = 0; p < n; p++) {
    var info = byP[p];
    // Batches before sales at the same instant.
    info.events.sort(function (a, b) { return a.ms - b.ms || a.kind - b.kind; });
    var remaining = Number(input.leftover && input.leftover[p]) || 0;
    var open = null;
    var mine = [];
    var ev = 0;

    var closeEpisode = function (ep, endMs) {
      ep.turnedAway = info.missed
        .filter(function (m) { return m.ms >= ep.soldOutMs && m.ms < endMs; })
        .reduce(function (s, m) { return s + m.qty; }, 0);
      var since = ep.soldOutMs - COOKING_AUDIT_RATE_WINDOW_MIN * 60000;
      var soldBefore = info.sales
        .filter(function (s) { return s.ms > since && s.ms <= ep.soldOutMs; })
        .reduce(function (s, x) { return s + x.qty; }, 0);
      ep.ratePerHour = round1(soldBefore * 60 / COOKING_AUDIT_RATE_WINDOW_MIN);
      mine.push(ep);
    };

    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      if (di > 0) remaining = remaining > 0 ? remaining : 0; // carried stock never below 0
      while (ev < info.events.length && info.events[ev].ms < day.startMs) ev++; // before range
      for (; ev < info.events.length && info.events[ev].ms < day.endMs; ev++) {
        var e = info.events[ev];
        if (e.kind === 1) {
          var before = remaining;
          remaining -= e.qty;
          if (open) open.salesWhileOut += e.qty;
          else if (before > 0 && remaining <= 0) {
            open = { p: p, day: day.key, soldOutMs: e.ms, salesWhileOut: 0 };
          } else if (before <= 0) {
            // Already out (e.g. the day started at 0 and nothing is cooked yet):
            // the first unmet sale starts the sell-out.
            open = { p: p, day: day.key, soldOutMs: e.ms, salesWhileOut: e.qty };
          }
        } else {
          remaining += e.qty;
          if (open && remaining > 0) {
            open.readyMs = e.ms;
            open.startMs = e.startMs;
            open.cookedQty = e.qty;
            open.chef = e.chef;
            closeEpisode(open, e.ms);
            open = null;
          }
        }
      }
      if (open) { // not recooked that day
        closeEpisode(open, day.endMs);
        open = null;
      }
    }

    mine.forEach(function (ep) {
      var restocked = ep.readyMs != null;
      episodes.push({
        productCode: products[p].productCode,
        name: products[p].name,
        day: ep.day,
        soldOutAt: iso(ep.soldOutMs),
        cookStartAt: restocked ? iso(ep.startMs) : '',
        readyAt: restocked ? iso(ep.readyMs) : '',
        restocked: restocked,
        waitMin: restocked ? mins(ep.readyMs - ep.soldOutMs) : null,
        reactionMin: restocked && ep.startMs != null ? mins(ep.startMs - ep.soldOutMs) : null,
        cookMin: restocked && ep.startMs != null ? mins(ep.readyMs - ep.startMs) : null,
        cookedQty: restocked ? ep.cookedQty : 0,
        chef: restocked ? ep.chef : '',
        turnedAway: ep.turnedAway,
        salesWhileOut: ep.salesWhileOut,
        ratePerHour: ep.ratePerHour
      });
    });

    var done = mine.filter(function (e) { return e.readyMs != null; });
    var waits = done.map(function (e) { return (e.readyMs - e.soldOutMs) / 60000; });
    var reactions = done.filter(function (e) { return e.startMs != null; }).map(function (e) { return (e.startMs - e.soldOutMs) / 60000; });
    var avg = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; };
    var avgCook = avg(info.cookMins);
    var rates = mine.map(function (e) { return e.ratePerHour; }).filter(function (r) { return r > 0; });
    var ratePerHour = avg(rates);
    var threshold = Number(products[p].recookThreshold) || 0;
    var suggested = null;
    if (ratePerHour != null && avgCook != null) {
      suggested = Math.ceil((ratePerHour / 60) * (avgCook + COOKING_AUDIT_BUFFER_MIN));
    }
    summaries.push({
      productCode: products[p].productCode,
      name: products[p].name,
      sellOuts: mine.length,
      restocked: done.length,
      notRestocked: mine.length - done.length,
      avgWaitMin: waits.length ? round1(avg(waits)) : null,
      maxWaitMin: waits.length ? round1(Math.max.apply(null, waits)) : null,
      totalWaitMin: round1(waits.reduce(function (s, x) { return s + x; }, 0)),
      avgReactionMin: reactions.length ? round1(avg(reactions)) : null,
      avgCookMin: avgCook != null ? round1(avgCook) : null,
      batches: info.cookMins.length,
      turnedAway: mine.reduce(function (s, e) { return s + e.turnedAway; }, 0),
      salesWhileOut: mine.reduce(function (s, e) { return s + e.salesWhileOut; }, 0),
      ratePerHour: ratePerHour != null ? round1(ratePerHour) : null,
      recookThreshold: threshold,
      suggestedThreshold: suggested,
      raiseThreshold: suggested != null && suggested > threshold
    });
  }

  episodes.sort(function (a, b) { return a.soldOutAt < b.soldOutAt ? 1 : a.soldOutAt > b.soldOutAt ? -1 : 0; });
  var allWaits = episodes.filter(function (e) { return e.waitMin != null; }).map(function (e) { return e.waitMin; });
  return {
    episodes: episodes,
    products: summaries,
    totals: {
      sellOuts: episodes.length,
      notRestocked: episodes.filter(function (e) { return !e.restocked; }).length,
      avgWaitMin: allWaits.length ? round1(allWaits.reduce(function (s, x) { return s + x; }, 0) / allWaits.length) : null,
      maxWaitMin: allWaits.length ? round1(Math.max.apply(null, allWaits)) : null,
      turnedAway: episodes.reduce(function (s, e) { return s + e.turnedAway; }, 0),
      productsToRaise: summaries.filter(function (s) { return s.raiseThreshold; }).length
    },
    settings: { rateWindowMin: COOKING_AUDIT_RATE_WINDOW_MIN, bufferMin: COOKING_AUDIT_BUFFER_MIN }
  };
}

/**
 * Reads the period's data through Repo and shapes it for buildCookingAudit_.
 * One pass over Orders: days before the range feed the carry-over (leftover at
 * the range start), days inside the range become sale events.
 */
function loadCookingAuditInput_(outlet, startKey, endKey, now) {
  var nowMs = now.getTime();
  var products = getCookingProductsFromSheet(outlet) || [];
  var empty = { products: products, leftover: [], days: [], batches: [], sales: [], missed: [] };
  if (!products.length) return empty;
  var lookup = _buildCookingProductLookup_(products);

  var bounds = _dayBoundariesForRange_(startKey, _dayAfterDateKey_(endKey));
  var days = [];
  for (var b = 0; b + 1 < bounds.length; b++) {
    if (bounds[b].startMs > nowMs) break;
    days.push({ key: bounds[b].key, startMs: bounds[b].startMs, endMs: Math.min(bounds[b + 1].startMs, nowMs) });
  }
  if (!days.length) return empty;
  var rangeStart = days[0].startMs;
  var rangeEnd = days[days.length - 1].endMs;
  var dailyCooked = {};
  var dailySold = {};
  var batches = [];
  var sales = [];
  var missed = [];
  var bump = function (map, dayKey, p, qty) {
    if (!map[dayKey]) { map[dayKey] = []; for (var z = 0; z < products.length; z++) map[dayKey].push(0); }
    map[dayKey][p] += qty;
  };
  var ms = function (v) { var d = _parseSheetDate(v); return d ? d.getTime() : null; };

  // Cooking batches (completed, this outlet), at their ready time — as the Today report.
  var kt = Repo.readTable('KITCHEN_COOKING');
  var kcol = {};
  kt.headers.forEach(function (h) { kcol[h.toUpperCase().replace(/\s+/g, '_')] = h; });
  var kv = function (row, keys) {
    for (var i = 0; i < keys.length; i++) if (kcol[keys[i]] !== undefined) return row[kcol[keys[i]]];
    return '';
  };
  kt.rows.forEach(function (row) {
    if (!_isCompletedCookingStatus_(kv(row, ['STATUS']))) return;
    if (!_kitchenOutletMatches_(kv(row, ['OUTLET']), outlet)) return;
    var start = ms(kv(row, ['STARTTIME']));
    var end = ms(kv(row, ['ENDTIME']));
    var ready = (end != null && end <= nowMs && (start == null || end >= start)) ? end : (start != null && start <= nowMs ? start : null);
    if (ready == null) return;
    var p = _resolveCookingProductIdxForKitchenRow_(kv(row, ['PRODUCTCODE', 'PRODUCT_CODE']), kv(row, ['PRODUCTNAME', 'PRODUCT_NAME']), lookup);
    if (p < 0) return;
    var qty = Number(String(kv(row, ['QTY', 'QUANTITY'])).replace(/,/g, '')) || 0;
    if (qty <= 0) return;
    if (ready < rangeStart) {
      var cookDay = _appDateKey_(new Date(start != null ? start : ready));
      if (cookDay < startKey) bump(dailyCooked, cookDay, p, qty);
    } else if (ready < rangeEnd) {
      batches.push({ p: p, startMs: start, readyMs: ready, qty: qty, chef: String(kv(row, ['CHEF']) || '') });
    }
  });

  // Sales (Orders) — one pass for both the carry-over and the period's events.
  var ot = Repo.readTable('ORDERS');
  var find = function (re) { for (var i = 0; i < ot.headers.length; i++) if (re.test(ot.headers[i])) return ot.headers[i]; return null; };
  var oTs = find(/timestamp|date/i), oCode = find(/product.*code|^code$/i), oName = find(/product.*name|^name$/i);
  var oQty = find(/qty|quantity/i), oOutlet = find(/outlet/i);
  var resolved = {};
  var resolve = function (code, name) {
    var k = code + '\u0001' + name;
    if (resolved[k] === undefined) resolved[k] = _resolveCookingProductIdxByCodeOrName_(code, name, lookup);
    return resolved[k];
  };
  if (oTs && oQty) {
    ot.rows.forEach(function (row) {
      if (oOutlet && !_kitchenOutletMatches_(row[oOutlet], outlet)) return;
      var t = ms(row[oTs]);
      if (t == null || t >= rangeEnd) return;
      var qty = Number(row[oQty]) || 0;
      if (qty <= 0) return;
      var p = resolve(oCode ? String(row[oCode] || '') : '', oName ? String(row[oName] || '') : '');
      if (p < 0) return;
      if (t < rangeStart) bump(dailySold, getAppDateKey_(new Date(t)), p, qty);
      else sales.push({ p: p, ms: t, qty: qty });
    });
  }

  // Customers turned away: sold-out lines saved at checkout (MissedOrders).
  var mt = Repo.readTable('MISSED_ORDERS');
  mt.rows.forEach(function (row) {
    if (!_kitchenOutletMatches_(row['Outlet'], outlet)) return;
    var t = ms(row['Timestamp']);
    if (t == null || t < rangeStart || t >= rangeEnd) return;
    var p = resolve(String(row['ProductCode'] || ''), String(row['ProductName'] || ''));
    var qty = Number(row['Quantity']) || 0;
    if (p >= 0 && qty > 0) missed.push({ p: p, ms: t, qty: qty });
  });

  var chain = _carryOverFromDailyBuckets_(products.length, startKey, dailyCooked, dailySold, null);
  return { products: products, leftover: chain.leftoverFromYesterday || [], days: days, batches: batches, sales: sales, missed: missed };
}
