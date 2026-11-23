/**
 * orchestrator.gs — central routing for the orchestrator–worker architecture.
 *
 * ADDITIVE: this file introduces NEW google.script.run entry points
 * (processCheckoutEvent, processPurchaseEvent, processReportEvent,
 * processStockUpdateEvent) that run an orchestrated pipeline. The existing
 * entry points (saveOrderSecure, recordPurchaseSecure, getPnLBundle, …) remain
 * unchanged and are still the ones the current UI calls. Nothing here alters
 * existing behavior until the client is pointed at these new entry points.
 *
 * Depends on globals: SalesWorker, InventoryWorker, ReportingWorker,
 * ReflectionAgent, ErrorHandler, apiOk/apiFail, getGlobalSpreadsheet, Logger.
 */

/** Lightweight workflow state log (Logger + a WorkflowLog sheet on demand). */
var WorkflowLog = {
  SHEET: 'WorkflowLog',
  record: function (requestId, eventType, step, status, ctx) {
    var c = ctx || {};
    try { Logger.log('[WORKFLOW] ' + requestId + ' | ' + eventType + ' | ' + step + ' | ' + status); } catch (e) { /* ignore */ }
    // Each sheet append is a slow round trip on the request path: only failures and
    // anomalies go to the sheet. Routine START/OK/DONE traces stay in Logger above.
    if (status === 'START' || status === 'OK' || status === 'DONE') return;
    try {
      var ss = getGlobalSpreadsheet();
      if (!ss) return;
      var sheet = ss.getSheetByName(this.SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(this.SHEET);
        sheet.appendRow(['Timestamp', 'RequestId', 'EventType', 'Step', 'Status', 'Username', 'Outlet']);
      }
      sheet.appendRow([new Date(), requestId, eventType, step, status, c.username || '', c.outlet || '']);
    } catch (e) {
      try { Logger.log('WorkflowLog sheet error: ' + e); } catch (e2) { /* ignore */ }
    }
  }
};

// Copilot: Implement a central Orchestrator agent.
// Route incoming POS events to the correct worker pipeline. Maintain workflow
// state, log every routing decision to WorkflowLog, wrap each hop in
// ErrorHandler, and return the Reflection-validated final output. Contains no
// business logic — only routing and coordination.
var Orchestrator = {

  /** eventType -> ordered list of pipeline steps. */
  ROUTES: {
    // Checkout is latency-critical: only persist the order. The stock snapshot and
    // daily-closing report are read-only and are served by stock.updated / report.requested.
    'checkout.completed': ['sales'],
    'purchase.recorded':  ['restock', 'reporting', 'reflection'],
    'purchase.history.requested': ['purchaseHistory'],
    'stock.updated':      ['inventory', 'reporting', 'reflection'],
    'stock.report.requested': ['stockReport'],
    'stock.history.status.requested': ['stockHistoryStatus'],
    'stock.history.schedule.requested': ['stockHistorySchedule'],
    'consumption.closing.requested': ['consumptionClosing'],
    'consumption.recorded': ['consumptionRecord'],
    'consumption.history.requested': ['consumptionHistory'],
    'report.requested':   ['reporting', 'reflection'],
    'catalog.requested':  ['catalog']
  },

  /** step name -> runner. Each runner returns an apiOk/apiFail-style envelope. */
  STEP_RUNNERS: {
    sales:      function (payload, ctx, bag) { return SalesWorker.handleCheckout(payload, ctx); },
    inventory:  function (payload, ctx, bag) { return InventoryWorker.updateStock(payload, ctx); },
    restock:    function (payload, ctx, bag) { return InventoryWorker.restock(payload, ctx); },
    purchaseHistory: function (payload, ctx, bag) { return ReportingWorker.purchaseHistory(payload, ctx); },
    stockReport: function (payload, ctx, bag) { return InventoryWorker.getStockReport(payload, ctx); },
    stockHistoryStatus: function (payload, ctx, bag) { return InventoryWorker.getStockHistoryJobStatus(payload, ctx); },
    stockHistorySchedule: function (payload, ctx, bag) { return InventoryWorker.scheduleStockHistoryJob(payload, ctx); },
    consumptionClosing: function (payload, ctx, bag) { return InventoryWorker.getDailyClosing(payload, ctx); },
    consumptionRecord: function (payload, ctx, bag) { return InventoryWorker.recordConsumption(payload, ctx); },
    consumptionHistory: function (payload, ctx, bag) { return ReportingWorker.consumptionHistory(payload, ctx); },
    reporting:  function (payload, ctx, bag) { return ReportingWorker.generateReport((payload && payload.reportType) || 'dailyClosing', payload, ctx); },
    reflection: function (payload, ctx, bag) { return ReflectionAgent.validate(bag.reporting, ctx); },
    catalog:    function (payload, ctx, bag) { return InventoryWorker.listProducts(ctx, payload); }
  },

  /** Builds the shared context from a SecurityWrapper params object. */
  buildContext_: function (params, eventType) {
    var auth = (params && params._authContext) || {};
    var requestId;
    try { requestId = Utilities.getUuid(); } catch (e) { requestId = String(Date.now()); }
    return {
      username: auth.username || '',
      outlet: auth.outlet || '',
      deviceId: auth.deviceId || '',
      requestId: requestId,
      eventType: eventType
    };
  },

  /**
   * Routes an event through its worker pipeline, logging each decision and
   * short-circuiting on the first failing step.
   * @return {Object} apiOk with per-step results, or apiFail.
   */
  routeEvent: function (eventType, payload, ctx) {
    var steps = this.ROUTES[eventType];
    if (!steps) return apiFail('Unknown event type: ' + eventType, 'UNKNOWN_EVENT');

    var c = ctx || this.buildContext_(payload, eventType);
    WorkflowLog.record(c.requestId, eventType, 'pipeline', 'START', c);

    var bag = {};
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      var runner = this.STEP_RUNNERS[step];
      if (!runner) {
        WorkflowLog.record(c.requestId, eventType, step, 'NO_RUNNER', c);
        return apiFail('No runner for step: ' + step, 'NO_RUNNER');
      }
      WorkflowLog.record(c.requestId, eventType, step, 'START', c);
      var res = ErrorHandler.wrap(step, (function (s) {
        return function () { return Orchestrator.STEP_RUNNERS[s](payload, c, bag); };
      })(step), c);
      bag[step] = res;

      if (res && res.success === false) {
        WorkflowLog.record(c.requestId, eventType, step, 'FAIL', c);
        return apiFail('Pipeline failed at step "' + step + '": ' + (res.error || ''), 'PIPELINE_FAILED');
      }
      WorkflowLog.record(c.requestId, eventType, step, 'OK', c);
    }

    WorkflowLog.record(c.requestId, eventType, 'pipeline', 'DONE', c);
    return apiOk({ eventType: eventType, requestId: c.requestId, steps: bag }, 'PIPELINE_OK');
  }
};

/* ---------------------------------------------------------------------------
 * New google.script.run entry points (additive). Invoke via SecurityWrapper so
 * params carries _authContext. These do NOT replace existing entry points.
 * ------------------------------------------------------------------------- */

// Copilot: Orchestrated checkout entry point. Routes a completed checkout through
// Sales -> Inventory -> Reporting -> Reflection and returns the validated output.
function processCheckoutEvent(params) {
  return Orchestrator.routeEvent('checkout.completed', params, Orchestrator.buildContext_(params, 'checkout.completed'));
}

// Copilot: Orchestrated purchase/restock entry point.
function processPurchaseEvent(params) {
  return Orchestrator.routeEvent('purchase.recorded', params, Orchestrator.buildContext_(params, 'purchase.recorded'));
}

// Copilot: Orchestrated stock-update entry point.
function processStockUpdateEvent(params) {
  return Orchestrator.routeEvent('stock.updated', params, Orchestrator.buildContext_(params, 'stock.updated'));
}

// Copilot: Orchestrated report entry point (pass params.reportType).
function processReportEvent(params) {
  return Orchestrator.routeEvent('report.requested', params, Orchestrator.buildContext_(params, 'report.requested'));
}
