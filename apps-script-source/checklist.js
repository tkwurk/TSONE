// ===== CHECKLIST MODULE =====
// CHECKLISTDEFS (definitions) + CHECKLISTMASTER (questions) + CLRESPONSES (answers)

var CHECKLIST_DEFAULT_ID = 'CL-DEFAULT';

// ─────────────────────────────────────────
// SHEET SETUP & MIGRATION
// ─────────────────────────────────────────

function ensureChecklistDefsHeaders() {
  var ss = getGlobalSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CHECKLIST_DEFS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.CHECKLIST_DEFS);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'ID', 'Name', 'Description', 'Status',
      'Assigned Roles', 'Reviewer Roles', 'Outlets',
      'Sort Order', 'CreatedBy', 'UpdatedBy', 'UpdatedDate'
    ]);
    var now = formatTimestampForSheet(new Date());
    sheet.appendRow([
      CHECKLIST_DEFAULT_ID,
      'Closing Checklist',
      'Default end-of-shift closing checklist',
      'Active',
      'supervisor,manager',
      'manager,admin',
      '',
      1,
      'system',
      'system',
      now
    ]);
    Logger.log('Created CHECKLISTDEFS with default Closing Checklist');
  }
  return sheet;
}

function ensureChecklistMasterHeaders() {
  var ss = getGlobalSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CHECKLIST_MASTER);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.CHECKLIST_MASTER);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'SN', 'CHECKLISTID', 'QUESTION', 'QUESTIONTYPE', 'DROPDOWNVALUES',
      'STATUS', 'ROLE', 'OUTLET', 'CATEGORY',
      'MANDATORYFLAG', 'ORDER', 'UPDATEDBY', 'UPDATEDDATE'
    ]);
    Logger.log('Created CHECKLISTMASTER sheet with headers');
  } else {
    _ensureSheetColumn(sheet, 'CHECKLISTID');
  }
  return sheet;
}

function ensureChecklistResponsesHeaders() {
  var ss = getGlobalSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CHECKLIST_RESPONSES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.CHECKLIST_RESPONSES);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'DATETIME', 'FILLEDBY', 'CHECKLISTID', 'QUESTIONSN', 'RESPONSE',
      'OUTLET', 'COMMENTS', 'SHIFTID', 'STATUS',
      'REVIEWEDBY', 'REVIEWEDDATE', 'ATTACHMENTLINK', 'DEVICEINFO'
    ]);
    Logger.log('Created CLRESPONSES sheet with headers');
  } else {
    _ensureSheetColumn(sheet, 'CHECKLISTID');
  }
  return sheet;
}

function _ensureSheetColumn(sheet, colName) {
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var upper = colName.toUpperCase();
  for (var i = 0; i < h.length; i++) {
    if (h[i] && h[i].toString().toUpperCase() === upper) return;
  }
  var col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue(colName);
}

/** Build one row of `numCols` cells, placing values by header key. */
function _rowByHeaders_(numCols, idx, valuesByHeader) {
  var row = new Array(numCols);
  for (var i = 0; i < numCols; i++) row[i] = '';
  Object.keys(valuesByHeader).forEach(function(key) {
    if (idx[key] !== undefined) row[idx[key]] = valuesByHeader[key];
  });
  return row;
}

function _appendRowByHeaders(sheet, idx, valuesByHeader) {
  sheet.appendRow(_rowByHeaders_(sheet.getLastColumn(), idx, valuesByHeader));
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function _cmHeaders(sheet) {
  if (sheet.getLastRow() === 0) return {};
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = {};
  h.forEach(function(col, i) { if (col) idx[col.toString().trim().toUpperCase().replace(/\s+/g, '_')] = i; });
  return idx;
}

function _crHeaders(sheet) {
  if (sheet.getLastRow() === 0) return {};
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = {};
  h.forEach(function(col, i) { if (col) idx[col.toString().trim().toUpperCase().replace(/\s+/g, '_')] = i; });
  return idx;
}

function _cdHeaders(sheet) {
  return _cmHeaders(sheet);
}

function _parseCsvList(str) {
  if (!str) return [];
  return String(str).split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

function _listIncludesRole(rolesCsv, userRole) {
  var roles = _parseCsvList(rolesCsv);
  if (roles.length === 0) return true;
  var r = normalizeRole_((userRole || '').toString().trim().toLowerCase());
  if (r === 'admin') return true;
  if (roles.indexOf(r) !== -1) return true;
  if (r === 'chef' && roles.indexOf('kitchen') !== -1) return true;
  return false;
}

function _outletMatches(defOutlets, userOutlet) {
  var outlets = _parseCsvList(defOutlets);
  if (outlets.length === 0) return true;
  var o = (userOutlet || '').toString().trim().toUpperCase();
  return outlets.some(function(x) { return x.toUpperCase() === o; });
}

function _isChecklistAdmin(session) {
  var tabs = session.allowedTabs || [];
  if (tabs.indexOf('*') !== -1 || tabs.indexOf('adminOrders') !== -1) return true;
  return normalizeRole_(session.role || '') === 'admin';
}

function _rowToDefinition(row, idx) {
  return {
    id:             (row[idx['ID']]             || '').toString().trim(),
    name:           (row[idx['NAME']]           || '').toString().trim(),
    description:    (row[idx['DESCRIPTION']]    || '').toString(),
    status:         (row[idx['STATUS']]         || 'Active').toString(),
    assignedRoles:  (row[idx['ASSIGNED_ROLES']] || '').toString(),
    reviewerRoles:  (row[idx['REVIEWER_ROLES']] || '').toString(),
    outlets:        (row[idx['OUTLETS']]        || '').toString(),
    sortOrder:      Number(row[idx['SORT_ORDER']]) || 0,
    createdBy:      (row[idx['CREATEDBY']]      || '').toString(),
    updatedBy:      (row[idx['UPDATEDBY']]      || '').toString(),
    updatedDate:    row[idx['UPDATEDDATE']] instanceof Date
                      ? row[idx['UPDATEDDATE']].toISOString()
                      : (row[idx['UPDATEDDATE']] || '').toString()
  };
}

function _rowToMaster(row, idx) {
  var checklistId = idx['CHECKLISTID'] !== undefined
    ? (row[idx['CHECKLISTID']] || CHECKLIST_DEFAULT_ID).toString().trim()
    : CHECKLIST_DEFAULT_ID;
  return {
    sn:             (row[idx['SN']]             || '').toString(),
    checklistId:    checklistId || CHECKLIST_DEFAULT_ID,
    question:       (row[idx['QUESTION']]       || '').toString(),
    questionType:   (row[idx['QUESTIONTYPE']]   || 'text').toString().toLowerCase(),
    dropdownValues: (row[idx['DROPDOWNVALUES']] || '').toString(),
    status:         (row[idx['STATUS']]         || 'Active').toString(),
    role:           (row[idx['ROLE']]           || '').toString(),
    outlet:         (row[idx['OUTLET']]         || '').toString(),
    category:       (row[idx['CATEGORY']]       || '').toString(),
    mandatory:      (row[idx['MANDATORYFLAG']]  || '').toString().toUpperCase() === 'YES',
    order:          Number(row[idx['ORDER']])   || 0,
    updatedBy:      (row[idx['UPDATEDBY']]      || '').toString(),
    updatedDate:    row[idx['UPDATEDDATE']] instanceof Date
                      ? row[idx['UPDATEDDATE']].toISOString()
                      : (row[idx['UPDATEDDATE']] || '').toString()
  };
}

function _rowToResponse(row, idx) {
  var checklistId = idx['CHECKLISTID'] !== undefined
    ? (row[idx['CHECKLISTID']] || CHECKLIST_DEFAULT_ID).toString()
    : CHECKLIST_DEFAULT_ID;
  return {
    datetime:       row[idx['DATETIME']] instanceof Date
                      ? row[idx['DATETIME']].toISOString()
                      : (row[idx['DATETIME']] || '').toString(),
    filledBy:       (row[idx['FILLEDBY']]       || '').toString(),
    checklistId:    checklistId,
    questionSn:     (row[idx['QUESTIONSN']]     || '').toString(),
    response:       (row[idx['RESPONSE']]       || '').toString(),
    outlet:         (row[idx['OUTLET']]         || '').toString(),
    comments:       (row[idx['COMMENTS']]       || '').toString(),
    shiftId:        (row[idx['SHIFTID']]        || '').toString(),
    status:         (row[idx['STATUS']]         || 'Submitted').toString(),
    reviewedBy:     (row[idx['REVIEWEDBY']]     || '').toString(),
    reviewedDate:   row[idx['REVIEWEDDATE']] instanceof Date
                      ? row[idx['REVIEWEDDATE']].toISOString()
                      : (row[idx['REVIEWEDDATE']] || '').toString(),
    attachmentLink: (row[idx['ATTACHMENTLINK']] || '').toString(),
    deviceInfo:     (row[idx['DEVICEINFO']]     || '').toString()
  };
}

function _loadAllDefinitions() {
  ensureChecklistDefsHeaders();
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.CHECKLIST_DEFS);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  var data = sheet.getDataRange().getValues();
  var idx = _cdHeaders(sheet);
  var defs = [];
  for (var r = 1; r < data.length; r++) {
    var d = _rowToDefinition(data[r], idx);
    if (d.id) defs.push(d);
  }
  defs.sort(function(a, b) { return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name); });
  return defs;
}

function _getDefinitionById(checklistId) {
  var id = (checklistId || CHECKLIST_DEFAULT_ID).toString().trim();
  var defs = _loadAllDefinitions();
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].id === id) return defs[i];
  }
  return null;
}

function _decorateDefinitionForSession(def, session) {
  var role = normalizeRole_(session.role || 'cashier');
  var isAdmin = _isChecklistAdmin(session);
  return {
    id:             def.id,
    name:           def.name,
    description:    def.description,
    status:         def.status,
    assignedRoles:  def.assignedRoles,
    reviewerRoles:  def.reviewerRoles,
    outlets:        def.outlets,
    sortOrder:      def.sortOrder,
    canFill:        def.status.toUpperCase() === 'ACTIVE' &&
                      _outletMatches(def.outlets, session.outlet) &&
                      (isAdmin || _listIncludesRole(def.assignedRoles, role)),
    canReview:      def.status.toUpperCase() === 'ACTIVE' &&
                      (isAdmin || _listIncludesRole(def.reviewerRoles, role)),
    canManage:      isAdmin
  };
}

function _generateShiftId(outlet, dateStr, checklistId) {
  var safe = (outlet || 'XX').replace(/\s+/g, '').toUpperCase().slice(0, 6);
  var d = dateStr || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  var cid = (checklistId || CHECKLIST_DEFAULT_ID).replace(/\s+/g, '').toUpperCase().slice(0, 12);
  return safe + '-' + cid + '-' + d;
}

function _legacyShiftId(outlet, dateStr) {
  var safe = (outlet || 'XX').replace(/\s+/g, '').toUpperCase().slice(0, 6);
  var d = dateStr || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return safe + '-' + d;
}

// ─────────────────────────────────────────
// PUBLIC API — Definitions
// ─────────────────────────────────────────

function getChecklistDefinitions(deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');

    var defs = _loadAllDefinitions();
    var isAdmin = _isChecklistAdmin(session);
    var result = defs
      .map(function(d) { return _decorateDefinitionForSession(d, session); })
      .filter(function(d) {
        if (isAdmin) return true;
        return d.canFill || d.canReview;
      });
    return sanitizeForClient(result);
  } catch (e) {
    Logger.log('getChecklistDefinitions error: ' + e.toString());
    throw e;
  }
}

function getAllChecklistDefinitions(deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');
    if (!_isChecklistAdmin(session)) throw new Error('Access denied');

    var defs = _loadAllDefinitions().map(function(d) {
      return _decorateDefinitionForSession(d, session);
    });
    return sanitizeForClient(defs);
  } catch (e) {
    Logger.log('getAllChecklistDefinitions error: ' + e.toString());
    throw e;
  }
}

/**
 * Admin: create or update a checklist definition.
 * payload: { id, name, description, status, assignedRoles, reviewerRoles, outlets, sortOrder }
 */
function saveChecklistDefinition(payloadStr, deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');
    if (!_isChecklistAdmin(session)) throw new Error('Access denied');

    var payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    var sheet = ensureChecklistDefsHeaders();
    var idx = _cdHeaders(sheet);
    var now = formatTimestampForSheet(new Date());

    if (payload.id) {
      var data = sheet.getDataRange().getValues();
      for (var r = 1; r < data.length; r++) {
        if ((data[r][idx['ID']] || '').toString().trim() === payload.id.toString().trim()) {
          var sheetRow = r + 1;
          sheet.getRange(sheetRow, idx['NAME']           + 1).setValue(payload.name           || '');
          sheet.getRange(sheetRow, idx['DESCRIPTION']    + 1).setValue(payload.description    || '');
          sheet.getRange(sheetRow, idx['STATUS']         + 1).setValue(payload.status         || 'Active');
          sheet.getRange(sheetRow, idx['ASSIGNED_ROLES'] + 1).setValue(payload.assignedRoles  || '');
          sheet.getRange(sheetRow, idx['REVIEWER_ROLES'] + 1).setValue(payload.reviewerRoles  || '');
          sheet.getRange(sheetRow, idx['OUTLETS']        + 1).setValue(payload.outlets        || '');
          sheet.getRange(sheetRow, idx['SORT_ORDER']     + 1).setValue(Number(payload.sortOrder) || 0);
          sheet.getRange(sheetRow, idx['UPDATEDBY']      + 1).setValue(session.username);
          sheet.getRange(sheetRow, idx['UPDATEDDATE']    + 1).setValue(now);
          return { success: true, id: payload.id, action: 'updated' };
        }
      }
      throw new Error('Checklist definition not found: ' + payload.id);
    }

    var newId = 'CHK-' + (sheet.getLastRow());
    sheet.appendRow([
      newId,
      payload.name           || 'New Checklist',
      payload.description    || '',
      payload.status         || 'Active',
      payload.assignedRoles  || 'supervisor',
      payload.reviewerRoles  || 'manager',
      payload.outlets        || '',
      Number(payload.sortOrder) || sheet.getLastRow(),
      session.username,
      session.username,
      now
    ]);
    return { success: true, id: newId, action: 'inserted' };
  } catch (e) {
    Logger.log('saveChecklistDefinition error: ' + e.toString());
    throw e;
  }
}

function getChecklistRoleOptions(deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');
    return sanitizeForClient(getKnownRolesFromSheet_().filter(function(r) { return r !== 'admin'; }));
  } catch (e) {
    Logger.log('getChecklistRoleOptions error: ' + e.toString());
    throw e;
  }
}

// ─────────────────────────────────────────
// PUBLIC API — Questions
// ─────────────────────────────────────────

function getChecklistQuestions(deviceId, username, checklistId) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');
    return sanitizeForClient(_getChecklistQuestionsForSession_(session, checklistId));
  } catch (e) {
    Logger.log('getChecklistQuestions error: ' + e.toString());
    throw e;
  }
}

function _getChecklistQuestionsForSession_(session, checklistId) {
  var cid = (checklistId || CHECKLIST_DEFAULT_ID).toString().trim();
  var def = _getDefinitionById(cid);
  if (def) {
    var decorated = _decorateDefinitionForSession(def, session);
    if (!decorated.canFill && !_isChecklistAdmin(session)) {
      throw new Error('Access denied for checklist: ' + cid);
    }
  }

  var sheet = ensureChecklistMasterHeaders();
  if (sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var idx = _cmHeaders(sheet);
  var outlet = (session.outlet || '').toString().toUpperCase();
  var userRole = normalizeRole_(session.role || 'cashier');

  var questions = [];
  for (var r = 1; r < data.length; r++) {
    var q = _rowToMaster(data[r], idx);
    if (!q.sn) continue;
    if (q.checklistId !== cid) continue;
    if (q.status.toUpperCase() !== 'ACTIVE') continue;
    if (q.outlet && q.outlet.toUpperCase() !== outlet) continue;
    if (q.role && !_listIncludesRole(q.role, userRole)) continue;
    questions.push(q);
  }

  questions.sort(function(a, b) { return a.order - b.order; });
  return questions;
}

function getAllChecklistQuestions(deviceId, username, checklistId) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');
    if (!_isChecklistAdmin(session)) throw new Error('Access denied');

    var cid = checklistId ? checklistId.toString().trim() : null;
    var sheet = ensureChecklistMasterHeaders();
    if (sheet.getLastRow() <= 1) return sanitizeForClient([]);

    var data = sheet.getDataRange().getValues();
    var idx = _cmHeaders(sheet);
    var questions = [];
    for (var r = 1; r < data.length; r++) {
      var q = _rowToMaster(data[r], idx);
      if (!q.sn) continue;
      if (cid && q.checklistId !== cid) continue;
      questions.push(q);
    }
    questions.sort(function(a, b) { return a.order - b.order; });
    return sanitizeForClient(questions);
  } catch (e) {
    Logger.log('getAllChecklistQuestions error: ' + e.toString());
    throw e;
  }
}

function saveChecklistQuestion(payloadStr, deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');
    if (!_isChecklistAdmin(session)) throw new Error('Access denied');

    var payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    var checklistId = (payload.checklistId || CHECKLIST_DEFAULT_ID).toString().trim();

    var sheet = ensureChecklistMasterHeaders();
    var idx = _cmHeaders(sheet);
    var now = formatTimestampForSheet(new Date());

    if (payload.sn) {
      var data = sheet.getDataRange().getValues();
      for (var r = 1; r < data.length; r++) {
        if ((data[r][idx['SN']] || '').toString() === payload.sn.toString()) {
          var sheetRow = r + 1;
          if (idx['CHECKLISTID'] !== undefined) {
            sheet.getRange(sheetRow, idx['CHECKLISTID'] + 1).setValue(checklistId);
          }
          sheet.getRange(sheetRow, idx['QUESTION']       + 1).setValue(payload.question       || '');
          sheet.getRange(sheetRow, idx['QUESTIONTYPE']   + 1).setValue(payload.questionType   || 'text');
          sheet.getRange(sheetRow, idx['DROPDOWNVALUES'] + 1).setValue(payload.dropdownValues || '');
          sheet.getRange(sheetRow, idx['STATUS']         + 1).setValue(payload.status         || 'Active');
          sheet.getRange(sheetRow, idx['ROLE']           + 1).setValue(payload.role           || '');
          sheet.getRange(sheetRow, idx['OUTLET']         + 1).setValue(payload.outlet         || '');
          sheet.getRange(sheetRow, idx['CATEGORY']       + 1).setValue(payload.category       || '');
          sheet.getRange(sheetRow, idx['MANDATORYFLAG']  + 1).setValue(payload.mandatory ? 'YES' : 'NO');
          sheet.getRange(sheetRow, idx['ORDER']          + 1).setValue(Number(payload.order)  || 0);
          sheet.getRange(sheetRow, idx['UPDATEDBY']      + 1).setValue(session.username);
          sheet.getRange(sheetRow, idx['UPDATEDDATE']    + 1).setValue(now);
          return { success: true, sn: payload.sn, action: 'updated' };
        }
      }
      throw new Error('Question SN not found: ' + payload.sn);
    }

    var lastRow = sheet.getLastRow();
    var newSn = 'CL-' + lastRow;
    _appendRowByHeaders(sheet, idx, {
      SN: newSn,
      CHECKLISTID: checklistId,
      QUESTION: payload.question || '',
      QUESTIONTYPE: payload.questionType || 'text',
      DROPDOWNVALUES: payload.dropdownValues || '',
      STATUS: payload.status || 'Active',
      ROLE: payload.role || '',
      OUTLET: payload.outlet || '',
      CATEGORY: payload.category || '',
      MANDATORYFLAG: payload.mandatory ? 'YES' : 'NO',
      ORDER: Number(payload.order) || lastRow,
      UPDATEDBY: session.username,
      UPDATEDDATE: now
    });
    return { success: true, sn: newSn, action: 'inserted' };
  } catch (e) {
    Logger.log('saveChecklistQuestion error: ' + e.toString());
    throw e;
  }
}

// ─────────────────────────────────────────
// PUBLIC API — Responses
// ─────────────────────────────────────────

function getShiftChecklistStatus(shiftId, outlet, deviceId, username, checklistId) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');
    return sanitizeForClient(_getShiftChecklistStatusForSession_(session, shiftId, outlet, checklistId));
  } catch (e) {
    Logger.log('getShiftChecklistStatus error: ' + e.toString());
    throw e;
  }
}

function _getShiftChecklistStatusForSession_(session, shiftId, outlet, checklistId) {
  var sheet = ensureChecklistResponsesHeaders();
  if (sheet.getLastRow() <= 1) return { submitted: false, responses: [] };

  var lastRow = sheet.getLastRow();
  var idx = _crHeaders(sheet);
  var shiftColIdx = idx['SHIFTID'];
  var responses = [];
  var cid = checklistId ? checklistId.toString().trim() : null;
  var outletUpper = (outlet || session.outlet || '').toString().toUpperCase();
  var shiftKey = (shiftId || '').toString();

  var data;
  if (lastRow > 400 && shiftColIdx !== undefined) {
    var shiftCol = shiftColIdx + 1;
    var shiftValues = sheet.getRange(2, shiftCol, lastRow, shiftCol).getValues();
    var matchCount = 0;
    for (var si = 0; si < shiftValues.length; si++) {
      if ((shiftValues[si][0] || '').toString() === shiftKey) matchCount++;
    }
    if (matchCount === 0) {
      return { submitted: false, responses: [] };
    }
  }

  data = sheet.getDataRange().getValues();

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var rowShift = (row[idx['SHIFTID']] || '').toString();
    if (rowShift !== shiftKey) continue;
    var rowOutlet = (row[idx['OUTLET']] || '').toString().toUpperCase();
    if (rowOutlet !== outletUpper) continue;
    if (cid) {
      var rowCid = idx['CHECKLISTID'] !== undefined
        ? (row[idx['CHECKLISTID']] || CHECKLIST_DEFAULT_ID).toString().trim()
        : CHECKLIST_DEFAULT_ID;
      if (rowCid !== cid) continue;
    }
    responses.push(_rowToResponse(row, idx));
  }

  var submitted = responses.length > 0 &&
    responses.every(function(r) { return r.status === 'Submitted' || r.status === 'Reviewed'; });

  return { submitted: submitted, responses: responses };
}

/**
 * Single round-trip: questions + shift status for opening a checklist fill form.
 */
function getChecklistFillBundle(deviceId, username, checklistId, shiftId, outlet) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');

    var resolvedOutlet = outlet || session.outlet;
    var questions = _getChecklistQuestionsForSession_(session, checklistId);
    var status = _getShiftChecklistStatusForSession_(session, shiftId, resolvedOutlet, checklistId);

    return sanitizeForClient({
      questions: questions,
      status: status
    });
  } catch (e) {
    Logger.log('getChecklistFillBundle error: ' + e.toString());
    throw e;
  }
}

function submitChecklistResponses(payloadStr, deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');

    var payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    var checklistId = (payload.checklistId || CHECKLIST_DEFAULT_ID).toString().trim();
    var def = _getDefinitionById(checklistId);
    if (def) {
      var decorated = _decorateDefinitionForSession(def, session);
      if (!decorated.canFill) throw new Error('You are not assigned to fill this checklist.');
    }

    var outlet = (session.outlet || '').toString().toUpperCase();
    var shiftId = payload.shiftId || _generateShiftId(session.outlet, null, checklistId);

    var existing = getShiftChecklistStatus(shiftId, outlet, deviceId, username, checklistId);
    if (existing.submitted) {
      throw new Error('Checklist already submitted and locked for this period.');
    }

    var masterSheet = ensureChecklistMasterHeaders();
    var masterData  = masterSheet.getDataRange().getValues();
    var mIdx = _cmHeaders(masterSheet);
    var mandatorySns = {};
    for (var r = 1; r < masterData.length; r++) {
      var q = _rowToMaster(masterData[r], mIdx);
      if (!q.sn || q.status.toUpperCase() !== 'ACTIVE') continue;
      if (q.checklistId !== checklistId) continue;
      if (q.outlet && q.outlet.toUpperCase() !== outlet) continue;
      if (q.mandatory) mandatorySns[q.sn] = true;
    }

    var responseMap = {};
    (payload.responses || []).forEach(function(resp) {
      responseMap[resp.questionSn] = resp.response;
    });
    var missing = Object.keys(mandatorySns).filter(function(sn) {
      return !responseMap[sn] || responseMap[sn].toString().trim() === '';
    });
    if (missing.length > 0) {
      throw new Error('Mandatory questions not answered: ' + missing.join(', '));
    }

    var respSheet = ensureChecklistResponsesHeaders();
    var rIdx = _crHeaders(respSheet);
    var now = formatTimestampForSheet(new Date());
    var deviceInfo = payload.deviceInfo || '';

    // Build every answer row first, then write them in ONE call (it used to be
    // one appendRow + getLastColumn per question).
    var numCols = respSheet.getLastColumn();
    var newRows = [];
    (payload.responses || []).forEach(function(item) {
      newRows.push(_rowByHeaders_(numCols, rIdx, {
        DATETIME: now,
        FILLEDBY: session.username,
        CHECKLISTID: checklistId,
        QUESTIONSN: item.questionSn || '',
        RESPONSE: item.response || '',
        OUTLET: outlet,
        COMMENTS: item.comments || '',
        SHIFTID: shiftId,
        STATUS: 'Submitted',
        REVIEWEDBY: '',
        REVIEWEDDATE: '',
        ATTACHMENTLINK: item.attachmentLink || '',
        DEVICEINFO: deviceInfo
      }));
    });
    appendRowsAtomic_(respSheet, newRows);

    return { success: true, shiftId: shiftId, checklistId: checklistId, count: (payload.responses || []).length };
  } catch (e) {
    Logger.log('submitChecklistResponses error: ' + e.toString());
    throw e;
  }
}

function reviewChecklistShift(payloadStr, deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');

    var payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    var shiftId  = payload.shiftId;
    var outlet   = (payload.outlet || session.outlet || '').toString().toUpperCase();
    var checklistId = (payload.checklistId || CHECKLIST_DEFAULT_ID).toString().trim();

    var def = _getDefinitionById(checklistId);
    if (def) {
      var decorated = _decorateDefinitionForSession(def, session);
      if (!decorated.canReview) {
        throw new Error('Your role is not authorized to review this checklist.');
      }
    } else if (!_isChecklistAdmin(session)) {
      throw new Error('Access denied: reviewer role required');
    }

    var sheet = ensureChecklistResponsesHeaders();
    var data  = sheet.getDataRange().getValues();
    var idx   = _crHeaders(sheet);
    var now   = formatTimestampForSheet(new Date());
    var updated = 0;
    var changedRows = [];

    for (var r = 1; r < data.length; r++) {
      var rowShift  = (data[r][idx['SHIFTID']] || '').toString();
      var rowOutlet = (data[r][idx['OUTLET']]  || '').toString().toUpperCase();
      var rowCid = idx['CHECKLISTID'] !== undefined
        ? (data[r][idx['CHECKLISTID']] || CHECKLIST_DEFAULT_ID).toString().trim()
        : CHECKLIST_DEFAULT_ID;
      if (rowShift === shiftId && rowOutlet === outlet && rowCid === checklistId) {
        data[r][idx['STATUS']] = 'Reviewed';
        data[r][idx['REVIEWEDBY']] = session.username;
        data[r][idx['REVIEWEDDATE']] = now;
        changedRows.push(r);
        updated++;
      }
    }
    // A shift's answers sit in consecutive rows: usually ONE write instead of 3 per answer.
    writeRowsBack_(sheet, data, changedRows, [idx['STATUS'], idx['REVIEWEDBY'], idx['REVIEWEDDATE']]);

    if (updated === 0) throw new Error('No responses found for shift: ' + shiftId);

    return { success: true, shiftId: shiftId, checklistId: checklistId, reviewedRows: updated };
  } catch (e) {
    Logger.log('reviewChecklistShift error: ' + e.toString());
    throw e;
  }
}

function getPendingReviewQueue(deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');

    var defs = _loadAllDefinitions();
    var reviewableIds = {};
    defs.forEach(function(d) {
      var dec = _decorateDefinitionForSession(d, session);
      if (dec.canReview) reviewableIds[d.id] = d.name;
    });
    if (Object.keys(reviewableIds).length === 0) return sanitizeForClient([]);

    var respSheet = ensureChecklistResponsesHeaders();
    if (respSheet.getLastRow() <= 1) return sanitizeForClient([]);

    var data = respSheet.getDataRange().getValues();
    var idx = _crHeaders(respSheet);
    var shiftMap = {};

    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var status = (row[idx['STATUS']] || '').toString();
      if (status !== 'Submitted') continue;
      var cid = idx['CHECKLISTID'] !== undefined
        ? (row[idx['CHECKLISTID']] || CHECKLIST_DEFAULT_ID).toString().trim()
        : CHECKLIST_DEFAULT_ID;
      if (!reviewableIds[cid]) continue;

      var shiftId = (row[idx['SHIFTID']] || '').toString();
      var key = shiftId + '|' + cid;
      if (!shiftMap[key]) {
        var dt = row[idx['DATETIME']];
        shiftMap[key] = {
          shiftId:     shiftId,
          checklistId: cid,
          checklistName: reviewableIds[cid],
          outlet:      (row[idx['OUTLET']] || '').toString(),
          filledBy:    (row[idx['FILLEDBY']] || '').toString(),
          submittedAt: dt instanceof Date ? dt.toISOString() : (dt || '').toString(),
          responseCount: 0
        };
      }
      shiftMap[key].responseCount++;
    }

    var results = Object.keys(shiftMap).map(function(k) { return shiftMap[k]; });
    results.sort(function(a, b) { return (b.submittedAt || '').localeCompare(a.submittedAt || ''); });
    return sanitizeForClient(results);
  } catch (e) {
    Logger.log('getPendingReviewQueue error: ' + e.toString());
    throw e;
  }
}

// ─────────────────────────────────────────
// PUBLIC API — Compliance Reporting
// ─────────────────────────────────────────

function getComplianceReport(payloadStr, deviceId, username) {
  try {
    var session = getUserSessionEnhanced(deviceId, username);
    if (!session) throw new Error('Not authenticated');

    var payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    var startDate = new Date(payload.startDate + 'T00:00:00');
    var endDate   = new Date(payload.endDate   + 'T23:59:59');
    var filterOutlet = (payload.outlet || session.outlet || '').toString().toUpperCase();
    var filterChecklistId = payload.checklistId ? payload.checklistId.toString().trim() : null;

    var respSheet = ensureChecklistResponsesHeaders();
    if (respSheet.getLastRow() <= 1) return sanitizeForClient([]);

    var data = respSheet.getDataRange().getValues();
    var idx  = _crHeaders(respSheet);
    var defMap = {};
    _loadAllDefinitions().forEach(function(d) { defMap[d.id] = d.name; });

    var shiftMap = {};
    for (var r = 1; r < data.length; r++) {
      var row    = data[r];
      var dt     = row[idx['DATETIME']];
      var rowDate = dt instanceof Date ? dt : new Date(dt);
      if (isNaN(rowDate)) continue;
      if (rowDate < startDate || rowDate > endDate) continue;

      var rowOutlet = (row[idx['OUTLET']] || '').toString().toUpperCase();
      if (filterOutlet && rowOutlet !== filterOutlet) continue;

      var cid = idx['CHECKLISTID'] !== undefined
        ? (row[idx['CHECKLISTID']] || CHECKLIST_DEFAULT_ID).toString().trim()
        : CHECKLIST_DEFAULT_ID;
      if (filterChecklistId && cid !== filterChecklistId) continue;

      var shiftId   = (row[idx['SHIFTID']]  || '').toString();
      var filledBy  = (row[idx['FILLEDBY']] || '').toString();
      var status    = (row[idx['STATUS']]   || '').toString();
      var reviewed  = status === 'Reviewed';
      var reviewedBy = (row[idx['REVIEWEDBY']] || '').toString();
      var mapKey = shiftId + '|' + cid;

      if (!shiftMap[mapKey]) {
        shiftMap[mapKey] = {
          shiftId:       shiftId,
          checklistId:   cid,
          checklistName: defMap[cid] || cid,
          outlet:        rowOutlet,
          date:          rowDate.toISOString().slice(0, 10),
          filledBy:      filledBy,
          totalAnswered: 0,
          totalReviewed: 0,
          reviewedBy:    reviewedBy,
          reviewedDate:  ''
        };
      }
      shiftMap[mapKey].totalAnswered++;
      if (reviewed) {
        shiftMap[mapKey].totalReviewed++;
        if (!shiftMap[mapKey].reviewedBy) shiftMap[mapKey].reviewedBy = reviewedBy;
        var rd = row[idx['REVIEWEDDATE']];
        if (rd instanceof Date && !shiftMap[mapKey].reviewedDate) {
          shiftMap[mapKey].reviewedDate = rd.toISOString();
        }
      }
    }

    var masterSheet = ensureChecklistMasterHeaders();
    var masterData  = masterSheet.getDataRange().getValues();
    var mIdx = _cmHeaders(masterSheet);

    function countQuestionsForChecklist(cid) {
      var total = 0;
      var mandatory = 0;
      for (var mr = 1; mr < masterData.length; mr++) {
        var mq = _rowToMaster(masterData[mr], mIdx);
        if (!mq.sn || mq.status.toUpperCase() !== 'ACTIVE') continue;
        if (mq.checklistId !== cid) continue;
        if (mq.outlet && mq.outlet.toUpperCase() !== filterOutlet) continue;
        total++;
        if (mq.mandatory) mandatory++;
      }
      return { total: total, mandatory: mandatory };
    }

    var results = Object.keys(shiftMap).map(function(key) {
      var s = shiftMap[key];
      var counts = countQuestionsForChecklist(s.checklistId);
      var pct = counts.total > 0 ? Math.round((s.totalAnswered / counts.total) * 100) : 0;
      var fullyReviewed = s.totalAnswered > 0 && s.totalReviewed === s.totalAnswered;
      return {
        shiftId:          s.shiftId,
        checklistId:      s.checklistId,
        checklistName:    s.checklistName,
        outlet:           s.outlet,
        date:             s.date,
        filledBy:         s.filledBy,
        totalAnswered:    s.totalAnswered,
        totalQuestions:   counts.total,
        mandatoryCount:   counts.mandatory,
        completionPct:    pct,
        fullyReviewed:    fullyReviewed,
        reviewedBy:       s.reviewedBy,
        reviewedDate:     s.reviewedDate
      };
    });

    results.sort(function(a, b) { return b.date.localeCompare(a.date); });
    return sanitizeForClient(results);
  } catch (e) {
    Logger.log('getComplianceReport error: ' + e.toString());
    throw e;
  }
}
