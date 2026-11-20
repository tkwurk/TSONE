/**
 * apiRouter.gs — Seam 1: the single JSON API entry point for external clients.
 *
 * ARCHITECTURE (see /AGENTS.md): the Expo/web client talks to the backend through
 * ONE endpoint. doPost receives { eventType, payload } and DELEGATES to the
 * Orchestrator — it contains NO business logic (routing/transport only). The
 * legacy server-rendered HTML UI has been removed; doGet (code.js) only returns
 * a plain-text status line.
 *
 * Request body (POSTed as text/plain to avoid a CORS preflight):
 *   { "eventType": "checkout.completed",
 *     "payload": { ...order data..., "_authContext": { username, outlet, deviceId } } }
 *
 * Response: the standard apiOk / apiFail envelope as JSON.
 *
 * Deployment (Option C): Execute as = Me (owner); Who has access = Anyone (or
 * Anyone with Google account). Caller identity is carried in payload._authContext
 * and enforced by the existing secure delegates, exactly as the current UI does.
 */

function doPost(e) {
  try {
    var body = _parseApiRequest_(e);
    var eventType = body.eventType;
    var payload = body.payload || {};

    // Allow auth to arrive either inside payload._authContext or as body.auth.
    if (body.auth && !payload._authContext) payload._authContext = body.auth;

    if (!eventType) {
      return _apiJson_(apiFail('Missing "eventType" in request body.', 'BAD_REQUEST'));
    }
    if (eventType === 'health') {
      return _apiJson_(apiOk({ status: 'ok', time: new Date().toISOString() }, 'HEALTH_OK'));
    }
    if (eventType === 'auth.login') {
      return _apiJson_(_authEnvelope_(
        (typeof authenticateUserClean === 'function')
          ? authenticateUserClean(payload.username, payload.password, payload.deviceId)
          : { success: false, message: 'authenticateUserClean not available' }
      ));
    }
    if (eventType === 'auth.logout') {
      var who = payload._authContext || payload || {};
      return _apiJson_(_authEnvelope_(
        (typeof logoutUser === 'function')
          ? logoutUser(who.deviceId, who.username)
          : { success: false, message: 'logoutUser not available' }
      ));
    }
    if (eventType === 'rpc') {
      return _apiJson_(_rpcCall_(payload.fn, payload.args));
    }

    var ctx = Orchestrator.buildContext_(payload, eventType);
    var result = Orchestrator.routeEvent(eventType, payload, ctx);
    return _apiJson_(result);
  } catch (err) {
    try { Logger.log('doPost error: ' + err); } catch (e2) { /* ignore */ }
    return _apiJson_(apiFail('Server error: ' + err, 'SERVER_ERROR'));
  }
}

/** Normalize the login/logout result objects into the apiOk/apiFail envelope. */
function _authEnvelope_(res) {
  if (res && res.success) {
    return apiOk({
      username: res.username,
      outlet: res.outlet,
      role: res.role,
      allowedTabs: res.allowedTabs,
      deviceId: res.deviceId
    }, 'AUTH_OK');
  }
  return apiFail((res && res.message) || 'Authentication failed', 'AUTH_FAILED');
}

/** Parse the POST body as JSON, tolerating text/plain and form-encoded delivery. */
function _parseApiRequest_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      throw new Error('Request body is not valid JSON.');
    }
  }
  // Fallback: form parameters (?eventType=...&payload={...})
  if (e.parameter && e.parameter.eventType) {
    var payload = {};
    if (e.parameter.payload) {
      try { payload = JSON.parse(e.parameter.payload); } catch (err) { payload = {}; }
    }
    return { eventType: e.parameter.eventType, payload: payload };
  }
  return {};
}

/** Serialize an envelope as a JSON ContentService response. */
function _apiJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Generic RPC bridge (hybrid migration path, see /AGENTS.md). Lets the PWA call
 * EXISTING whitelisted server functions by name over HTTP — a drop-in for the
 * old google.script.run, which only works inside Apps Script's own HTML iframe.
 * The client passes args exactly as the function expects (including a params
 * object with _authContext for the *Secure functions). Only whitelisted names
 * may be invoked; the functions' own auth checks still apply.
 */
var RPC_ALLOWED = {
  // auth / session
  authenticateUserClean: 1, validateUserSession: 1, logoutUser: 1, getUserSessionEnhanced: 1,
  // products / menu
  getProducts: 1, getProductsWithOutletAndCategoryFilter: 1, getCookingProductsFromSheet: 1,
  // sales / orders
  saveOrderSecure: 1, saveMissedOrdersSecure: 1,
  // payment methods / expenses (checkout discount)
  getPaymentMethodsSecure: 1, recordExpenseSecure: 1,
  // cash drawer (manual open with PIN) + audit
  getDrawerUnlockStatusSecure: 1, validateDrawerUnlockPinSecure: 1,
  authorizeCashDrawerOpenSecure: 1, logCashDrawerOpenSecure: 1,
  // kitchen alerts shown on the ordering screen
  getRecookAlertsSecure: 1,
  // kitchen tab
  getCookingProductsSecure: 1, submitCookingBatchSecure: 1, getCookRequestsSecure: 1,
  updateCookRequestStatusSecure: 1, getCookingHistorySecure: 1, getCookingTodayReportSecure: 1,
  // purchasing / receive / local
  getProductsSecure: 1, getOrderedPurchases: 1, updateReceiveQuantitySecure: 1, getExpenseAccounts: 1,
  // deposits
  recordDepositSecure: 1, getDepositAccounts: 1, getDepositHistory: 1,
  // investments
  getInvestmentAccounts: 1, getInvestmentTransactions: 1,
  // reports
  getPnLBundleSecure: 1, getOrderLinesByDate: 1, getSalesAnalyticsSecure: 1,
  // attendance
  getEmployeeList: 1, recordMorningAttendance: 1, recordEveningAttendance: 1,
  getAttendanceForDate: 1, getAttendanceSummary: 1,
  // checklist
  getChecklistDefinitions: 1, getChecklistFillBundle: 1, submitChecklistResponses: 1,
  getPendingReviewQueue: 1, reviewChecklistShift: 1,
  // admin orders
  getOrdersForAdminSecure: 1, bulkUpdateOrdersSecure: 1, deleteOrderDataSecure: 1, getOutletsForAdminSecure: 1,
  // admin panel: products / people / bom / printers / checklist admin / smart picks
  getProductsForAdminSecure: 1, saveProductSecure: 1, updateProductFieldsSecure: 1, getMissingProductImagesSecure: 1,
  getPeopleForAdminSecure: 1, savePersonSecure: 1, getTriggerHealthSecure: 1, clearAllUsersCacheSecure: 1,
  getBomForAdminSecure: 1,
  getOutletPrinterSecure: 1, saveOutletPrinterSecure: 1, deleteOutletPrinterSecure: 1, getAllPrintersSecure: 1,
  saveOutletAutoPrintSecure: 1, saveOutletDrawerPinSecure: 1,
  saveDrawerUnlockPinSecure: 1, activateDrawerUnlockPinSecure: 1, getDrawerUnlockAdminSecure: 1,
  getAllChecklistDefinitions: 1, getChecklistRoleOptions: 1, saveChecklistDefinition: 1,
  getAllChecklistQuestions: 1, saveChecklistQuestion: 1,
  getSmartPicksTriggerInfoSecure: 1, scheduleSmartPicksTriggerSecure: 1, removeSmartPicksTriggerSecure: 1, refreshSmartPicksSecure: 1,
  getCookingAlertStatusSecure: 1, installCookingAlertTriggerSecure: 1, removeCookingAlertTriggerSecure: 1, runCookingAlertSweepNowSecure: 1,
  // purchases / inventory
  recordPurchaseSecure: 1,
  // reports
  getPnLBundle: 1, getCashSummary: 1, getSalesSummaryByDate: 1,
  getMonthlyUsageReport: 1,
  // misc
  getOutlets: 1
};

function _rpcCall_(fn, args) {
  if (!fn || !RPC_ALLOWED[fn]) {
    return apiFail('RPC function not allowed: ' + fn, 'RPC_FORBIDDEN');
  }
  var f = (typeof globalThis !== 'undefined') ? globalThis[fn] : null;
  if (typeof f !== 'function') {
    return apiFail('RPC function not found: ' + fn, 'RPC_NOT_FOUND');
  }
  try {
    var out = f.apply(null, Array.isArray(args) ? args : []);
    // Pass through functions that already return an apiOk/apiFail envelope.
    if (out && typeof out === 'object' && Object.prototype.hasOwnProperty.call(out, 'success')) {
      return out;
    }
    return apiOk(out == null ? null : out, 'RPC_OK');
  } catch (err) {
    return apiFail('RPC "' + fn + '" failed: ' + err, 'RPC_ERROR');
  }
}
