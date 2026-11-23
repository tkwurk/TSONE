// ===== ATTENDANCE MODULE =====

/**
 * Every attendance read/write needs a valid session with the "attendance" tab.
 * (These were callable over the API with no sign-in check at all.)
 */
function requireAttendanceAccess_(deviceId, username) {
  return requirePermission_({ _authContext: { deviceId: deviceId, username: username } }, 'attendance');
}

function ensureAttendanceSheetHeaders() {
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ATTENDANCE);
  if (!sheet) {
    throw new Error("Attendance sheet not found.");
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SHEET_HEADER_ROWS.ATTENDANCE);
    Logger.log("Added headers to attendance sheet");
  }
}

function ensureEmployeesSheetHeaders() {
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.EMPLOYEES);
  if (!sheet) {
    throw new Error("Employees sheet not found.");
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SHEET_HEADER_ROWS.EMPLOYEES);
    Logger.log("Added headers to employees sheet");
  }
}

/**
 * Get all employees for dropdown
 */
function getEmployeeList(deviceId, username) {
  if (typeof getEmployeeListFromPeople === 'function') {
    var fromPeople = getEmployeeListFromPeople(deviceId, username);
    if (fromPeople && fromPeople.length) return fromPeople;
  }
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.EMPLOYEES);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var cols = buildColumnMap(headers, 'EMPLOYEES');

  var employees = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var empId = row[cols.EMPLOYEE_ID >= 0 ? cols.EMPLOYEE_ID : 0];
    var empflag = getFixedRowField(row, 'EMPLOYEES', 'INACTIVE_FLAG');

    if (!empId || empflag=='X') continue;
    employees.push({
      employee_id: empId.toString(),
      name: row[cols.NAME >= 0 ? cols.NAME : 1] || '',
      department: row[cols.DEPARTMENT >= 0 ? cols.DEPARTMENT : 2] || '',
      position: row[cols.POSITION >= 0 ? cols.POSITION : 3] || ''
    });
  }
  return employees;
}

/**
 * Record morning attendance (start time) for multiple employees
 * @param {string|Object} payload - JSON with supervisor, date, entries[]
 */
function recordMorningAttendance(payload, deviceId, username) {
  requireAttendanceAccess_(deviceId, username);
  if (typeof payload === 'string') payload = JSON.parse(payload);

  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ATTENDANCE);
  if (!sheet) throw new Error("Attendance sheet not found.");
  ensureAttendanceSheetHeaders();

  var dateStr = payload.date;
  var entries = payload.entries || [];
  var recorded = 0;
  var skipped = 0;

  // Build set of employee_ids that already have a record for this date
  var existingSet = {};
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var empIdCol = headers.findIndex(function(h) { return /employee_id/i.test(h); });
  var dateCol = headers.findIndex(function(h) { return /^date$/i.test(h); });
  for (var r = 1; r < data.length; r++) {
    var rowDate = formatAttendanceDate(data[r][dateCol]);
    if (rowDate === dateStr) {
      existingSet[(data[r][empIdCol] || '').toString()] = true;
    }
  }

  var newRows = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (existingSet[entry.employee_id]) {
      skipped++;
      continue; // already recorded for this date
    }
    var attendanceId = 'ATT-' + new Date().getTime() + '-' + i;
    newRows.push([
      attendanceId,
      entry.employee_id,
      dateStr,
      entry.start_time,
      '',           // end_time blank for morning
      '',           // work_hours calculated on evening
      entry.status || 'Present'
    ]);
    existingSet[entry.employee_id] = true; // prevent duplicates within same batch
    recorded++;
  }
  // One write for the whole team instead of one appendRow per employee.
  appendRowsAtomic_(sheet, newRows);

  Logger.log("Recorded morning attendance for " + recorded + " employees, skipped " + skipped + " duplicates");
  return { success: true, recorded: recorded, skipped: skipped };
}

/**
 * Record evening attendance (end time) - updates existing morning rows
 * @param {string|Object} payload - JSON with supervisor, date, entries[]
 */
function recordEveningAttendance(payload, deviceId, username) {
  requireAttendanceAccess_(deviceId, username);
  if (typeof payload === 'string') payload = JSON.parse(payload);

  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ATTENDANCE);
  if (!sheet) throw new Error("Attendance sheet not found.");

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.findIndex(function(h) { return /attendance_id/i.test(h); });
  var empIdCol = headers.findIndex(function(h) { return /employee_id/i.test(h); });
  var dateCol = headers.findIndex(function(h) { return /^date$/i.test(h); });
  var startCol = headers.findIndex(function(h) { return /start_time/i.test(h); });
  var endCol = headers.findIndex(function(h) { return /end_time/i.test(h); });
  var hoursCol = headers.findIndex(function(h) { return /work_hours/i.test(h); });
  var statusCol = headers.findIndex(function(h) { return /^status$/i.test(h); });

  var dateStr = payload.date;
  var entries = payload.entries || [];
  var updated = 0;
  var changedRows = [];
  var changedCols = [endCol, hoursCol];

  for (var e = 0; e < entries.length; e++) {
    var entry = entries[e];
    // Find the matching morning row for this employee + date
    for (var r = data.length - 1; r >= 1; r--) {
      var rowDate = formatAttendanceDate(data[r][dateCol]);
      var rowEmpId = (data[r][empIdCol] || '').toString();
      var rowEnd = (data[r][endCol] || '').toString().trim();

      if (rowEmpId === entry.employee_id && rowDate === dateStr && rowEnd === '') {
        // Found the morning row without end_time - update it in memory
        data[r][endCol] = entry.end_time;
        data[r][hoursCol] = calculateWorkHours(data[r][startCol], entry.end_time);
        if (entry.status) {
          data[r][statusCol] = entry.status;
          changedCols.push(statusCol);
        }
        changedRows.push(r);
        updated++;
        break;
      }
    }
  }
  // One write per employee row (end/hours/status together), not 2–3 per employee.
  writeRowsBack_(sheet, data, changedRows, changedCols);

  Logger.log("Updated evening attendance for " + updated + " employees");
  return { success: true, updated: updated };
}

/**
 * Get today's attendance records for a given date
 */
function getAttendanceForDate(dateStr, deviceId, username) {
  requireAttendanceAccess_(deviceId, username);
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ATTENDANCE);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var empIdCol = headers.findIndex(function(h) { return /employee_id/i.test(h); });
  var dateCol = headers.findIndex(function(h) { return /^date$/i.test(h); });
  var startCol = headers.findIndex(function(h) { return /start_time/i.test(h); });
  var endCol = headers.findIndex(function(h) { return /end_time/i.test(h); });
  var hoursCol = headers.findIndex(function(h) { return /work_hours/i.test(h); });
  var statusCol = headers.findIndex(function(h) { return /^status$/i.test(h); });

  var results = [];
  for (var i = 1; i < data.length; i++) {
    var rowDate = formatAttendanceDate(data[i][dateCol]);
    if (rowDate === dateStr) {
      results.push({
        employee_id: (data[i][empIdCol] || '').toString(),
        date: rowDate,
        start_time: formatAttendanceTime(data[i][startCol]),
        end_time: formatAttendanceTime(data[i][endCol]),
        work_hours: data[i][hoursCol] || '',
        status: (data[i][statusCol] || '').toString()
      });
    }
  }
  return results;
}

/**
 * Get attendance summary for a date range
 */
function getAttendanceSummary(startDate, endDate, deviceId, username) {
  requireAttendanceAccess_(deviceId, username);
  var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ATTENDANCE);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var empIdCol = headers.findIndex(function(h) { return /employee_id/i.test(h); });
  var dateCol = headers.findIndex(function(h) { return /^date$/i.test(h); });
  var startTimeCol = headers.findIndex(function(h) { return /start_time/i.test(h); });
  var endTimeCol = headers.findIndex(function(h) { return /end_time/i.test(h); });
  var hoursCol = headers.findIndex(function(h) { return /work_hours/i.test(h); });
  var statusCol = headers.findIndex(function(h) { return /^status$/i.test(h); });

  var start = new Date(startDate);
  var end = new Date(endDate);
  var results = [];

  for (var i = 1; i < data.length; i++) {
    var rowDate = new Date(data[i][dateCol]);
    if (isNaN(rowDate.getTime())) continue;
    if (rowDate >= start && rowDate <= end) {
      results.push({
        employee_id: (data[i][empIdCol] || '').toString(),
        date: formatAttendanceDate(data[i][dateCol]),
        start_time: formatAttendanceTime(data[i][startTimeCol]),
        end_time: formatAttendanceTime(data[i][endTimeCol]),
        work_hours: data[i][hoursCol] || '',
        status: (data[i][statusCol] || '').toString()
      });
    }
  }
  return results;
}

// ===== HELPER FUNCTIONS =====

function formatAttendanceTime(timeValue) {
  if (!timeValue) return '';
  if (timeValue instanceof Date) {
    var hh = String(timeValue.getHours()).padStart(2, '0');
    var mm = String(timeValue.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }
  var s = timeValue.toString().trim();
  // If it looks like a Date string with 1899 or similar, try to parse HH:mm from it
  if (/^\w{3}\s\w{3}/.test(s)) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
  }
  return s;
}

function formatAttendanceDate(dateValue) {
  if (!dateValue) return '';
  var d;
  if (dateValue instanceof Date) {
    d = dateValue;
  } else {
    d = new Date(dateValue);
  }
  if (isNaN(d.getTime())) return dateValue.toString();
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

function calculateWorkHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  try {
    var startStr = formatAttendanceTime(startTime);
    var endStr = (typeof endTime === 'string') ? endTime : formatAttendanceTime(endTime);
    var today = new Date().toDateString();
    var start = new Date(today + ' ' + startStr);
    var end = new Date(today + ' ' + endStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    var diffMs = end - start;
    if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000; // handle overnight
    return Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
  } catch (e) {
    Logger.log('Error calculating work hours: ' + e);
    return 0;
  }
}
