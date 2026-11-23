function ensureDepositsSheetHeaders() {
  const sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.DEPOSITS);
  if (!sheet) {
    throw new Error("Deposits sheet not found.");
  }
  // Runs on every save: only add headers to an empty sheet. (It used to also read
  // and compare the header row just to log a mismatch — a wasted round trip.)
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SHEET_HEADER_ROWS.DEPOSITS);
    Logger.log("Added headers to Deposits sheet: " + SHEET_HEADER_ROWS.DEPOSITS.join(", "));
  }
}

function parseDepositDate(dateString) {
  let date = null;
  
  if (dateString instanceof Date) {
    return dateString;
  }
  
  if (typeof dateString === 'string') {
    // Try Utilities.parseDate first for Google Sheets compatibility
    try {
      // Try dd-MM-yyyy format first (our standard format)
      date = Utilities.parseDate(dateString, Session.getScriptTimeZone(), 'dd-MM-yyyy HH:mm:ss');
      if (!date || isNaN(date.getTime())) {
        date = Utilities.parseDate(dateString, Session.getScriptTimeZone(), 'dd-MM-yyyy');
      }
      if (!date || isNaN(date.getTime())) {
        date = Utilities.parseDate(dateString, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      if (!date || isNaN(date.getTime())) {
        date = Utilities.parseDate(dateString, Session.getScriptTimeZone(), 'MM/dd/yyyy');
      }
    } catch (e) {
      Logger.log('Utilities.parseDate failed, trying standard Date: ' + e);
    }
    
    // Fallback to standard Date parsing if Utilities.parseDate failed
    if (!date || isNaN(date.getTime())) {
      date = new Date(dateString);
    }
  } else {
    date = new Date(dateString);
  }
  
  if (!date || isNaN(date.getTime())) {
    Logger.log('Failed to parse date: ' + dateString + ', using current time');
    date = new Date();
  }
  
  return date;
}

function recordDeposit(deposit) {
  try {
    var sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.DEPOSITS);
    if (!sheet) {
      return apiFail('Deposits sheet not found.', 'DEPOSIT_SHEET_MISSING');
    }

    ensureDepositsSheetHeaders();

    if (typeof deposit === 'string') deposit = JSON.parse(deposit);

    const { deviceId, username } = deposit;
    if (!deviceId || !username) {
      return apiFail('Device ID and username are required to record a deposit.', 'DEPOSIT_AUTH_REQUIRED');
    }

    // Refuse without a valid session (it used to save with a blank user/outlet).
    const session = getUserSessionEnhanced(deviceId, username);
    if (!session || !session.username) {
      return apiFail('Invalid or expired session', 'DEPOSIT_SESSION_INVALID');
    }
    var timestamp = new Date();

    var row = [
      formatTimestampForSheet(timestamp),
      Number(deposit.amount) || 0,
      deposit.account || "",
      deposit.note || "",
      session.username || "",
      session.outlet || "",
      deposit.paymentMethod || 'Dana'
    ];

    sheet.appendRow(row);
    return apiOk({ message: 'Deposit recorded' }, 'DEPOSIT_SAVED');
  } catch (error) {
    Logger.log("ERROR in recordDeposit: " + error.toString());
    return apiFail(error.message || error, 'DEPOSIT_SAVE_FAILED');
  }
}

function getDepositHistory(deviceId, username) {
  const session = getUserSessionEnhanced(deviceId, username) || {};
  const userOutlet = session.outlet;
  
  Logger.log("getDepositHistory - Session: " + JSON.stringify(session));
  Logger.log("getDepositHistory - User outlet: " + (userOutlet || 'NOT SET'));

  const data = getSheetData(SHEETS.DEPOSITS);
  Logger.log("getDepositHistory - Total rows from sheet: " + data.length);
  
  if (data.length < 2) {
    Logger.log("getDepositHistory - No data rows found (only headers or empty)");
    return [];
  }

  const headers = data[0];
  Logger.log("getDepositHistory - Headers: " + JSON.stringify(headers));
  
  const outletIdx = headers.findIndex(h => /outlet/i.test(h));
  const dateIdx = headers.findIndex(h => /date|timestamp/i.test(h));
  const amountIdx = headers.findIndex(h => /amount/i.test(h));
  const accountIdx = headers.findIndex(h => /account/i.test(h));
  const noteIdx = headers.findIndex(h => /note/i.test(h));
  const userIdx = headers.findIndex(h => /user(name)?/i.test(h));
  const paymentMethodIdx = headers.findIndex(h => /paymentmethod|payment.?method/i.test(h));
  
  Logger.log("getDepositHistory - Column indices: outlet=" + outletIdx + ", date=" + dateIdx + ", amount=" + amountIdx + ", account=" + accountIdx + ", note=" + noteIdx + ", user=" + userIdx);

  // Filter for this outlet only (if outlet column exists and user has outlet)
  let filtered = data.slice(1);
  
  if (outletIdx >= 0 && userOutlet) {
    filtered = filtered.filter(row => row[outletIdx] === userOutlet);
    Logger.log("getDepositHistory - Filtered by outlet '" + userOutlet + "': " + filtered.length + " rows");
  } else {
    Logger.log("getDepositHistory - No outlet filtering (outletIdx=" + outletIdx + ", userOutlet=" + userOutlet + ")");
  }
  
  Logger.log("getDepositHistory - Raw filtered data: " + JSON.stringify(filtered.slice(0, 3))); // Log first 3 rows

  function formatDateDDMMMYYYY(dateValue) {
    if (!dateValue) return "";
    let d = (dateValue instanceof Date) ? dateValue : new Date(dateValue);
    if (isNaN(d.getTime())) return "";
    const day = String(d.getDate()).padStart(2, '0');
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = monthNames[d.getMonth()];
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  const result = filtered.map(row => ({
    date: dateIdx >= 0 ? formatDateDDMMMYYYY(row[dateIdx]) : "",
    amount: amountIdx >= 0 ? row[amountIdx] : "",
    account: accountIdx >= 0 ? row[accountIdx] : "",
    note: noteIdx >= 0 ? row[noteIdx] : "",
    user: userIdx >= 0 ? row[userIdx] : "",
    outlet: outletIdx >= 0 ? row[outletIdx] : "",
    paymentMethod: paymentMethodIdx >= 0 ? (row[paymentMethodIdx] || "") : ""
  }));
  
  Logger.log("getDepositHistory - Returning " + result.length + " deposit records");
  Logger.log("getDepositHistory - Sample result: " + JSON.stringify(result.slice(0, 2)));
  
  return result;
}

// Test function to record deposit with explicit session data
function testDepositWithSession(amount, account, note, username, outlet) {
  try {
    Logger.log("=== Testing Deposit Recording ===");
    
    // Temporarily set session properties for testing
    const userProps = PropertiesService.getUserProperties();
    userProps.setProperties({
      'username': username || 'TestUser',
      'outlet': outlet || 'TestOutlet'
    });
    
    const deposit = {
      amount: amount || 100,
      account: account || 'Test Account',
      note: note || 'Test deposit'
    };
    
    Logger.log("Test deposit data: " + JSON.stringify(deposit));
    
    // Check session before recording (for testing only)
    const sessionBefore = getUserSessionEnhanced(deposit.deviceId, deposit.username);
    Logger.log("Session before deposit: " + JSON.stringify(sessionBefore));
    
    // Record the deposit
    recordDeposit(deposit);
    
    Logger.log("Test deposit completed successfully");
    return { success: true, deposit: deposit, session: sessionBefore };
    
  } catch (error) {
    Logger.log("Test deposit failed: " + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * SecurityWrapper-compatible deposit recording function
 * @param {Object} params - Parameters object from SecurityWrapper (contains _authContext and deposit data)
 * @returns {Object} Success response or throws error
 */
function recordDepositSecure(params) {
  try {
    var deposit = params;
    var authContext = params._authContext;

    if (!authContext || !authContext.username || !authContext.outlet) {
      return apiFail('Authentication required: Missing username or outlet information', 'DEPOSIT_AUTH_INVALID');
    }
    try {
      requirePermission_(params, 'deposits');
    } catch (authErr) {
      return apiFail(authErr.message || String(authErr), 'DEPOSIT_FORBIDDEN');
    }

    const depositWithAuth = {
      ...deposit,
      deviceId: authContext.deviceId,
      username: authContext.username
    };

    return recordDeposit(depositWithAuth);
  } catch (error) {
    Logger.log("recordDepositSecure error: " + error.toString());
    return apiFail(error.message || error, 'DEPOSIT_SAVE_FAILED');
  }
}