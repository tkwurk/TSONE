function ensureExpensesSheetHeaders() {
  const sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.EXPENSES);
  if (!sheet) {
    throw new Error("Expenses sheet not found.");
  }
  // Runs on every save: only add headers to an empty sheet. (It used to also read
  // and compare the header row just to log a mismatch — a wasted round trip.)
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SHEET_HEADER_ROWS.EXPENSES);
    Logger.log("Added headers to Expenses sheet: " + SHEET_HEADER_ROWS.EXPENSES.join(", "));
  }
}

function recordExpense(expense) {
  try {
    const spreadsheet = getGlobalSpreadsheet();
    if (!spreadsheet) {
      return apiFail('Could not access spreadsheet', 'EXPENSE_SHEET_ERROR');
    }

    const sheet = spreadsheet.getSheetByName(SHEETS.EXPENSES);
    if (!sheet) {
      return apiFail('Expenses sheet not found', 'EXPENSE_SHEET_MISSING');
    }

    ensureExpensesSheetHeaders();

    if (typeof expense === 'string') {
      expense = JSON.parse(expense);
    }

    const { deviceId, username } = expense;
    if (!deviceId || !username) {
      return apiFail('Device ID and username are required to record an expense.', 'EXPENSE_AUTH_REQUIRED');
    }

    // Refuse without a valid session (it used to save with a blank user/outlet).
    const session = getUserSessionEnhanced(deviceId, username);
    if (!session || !session.username) {
      return apiFail('Invalid or expired session', 'EXPENSE_SESSION_INVALID');
    }
    const timestamp = new Date();

    const row = [
      formatTimestampForSheet(timestamp),
      Number(expense.amount) || 0,
      expense.account || "",
      expense.payment|| "",
      expense.note || "",
      session.username || "",
      session.outlet || ""
    ];

    sheet.appendRow(row);
    invalidatePnLCache_(session.outlet);
    return apiOk({ message: 'Expense recorded' }, 'EXPENSE_SAVED');
  } catch (error) {
    Logger.log("ERROR in recordExpense: " + error.toString());
    return apiFail(error.message || error, 'EXPENSE_SAVE_FAILED');
  }
}

function getExpenseAccounts() {
  return getAccountsByType('Expense');
}

function getExpenseHistory(filterOptions, deviceId, username) {
  try {
    const spreadsheet = getGlobalSpreadsheet();
    if (!spreadsheet) {
      throw new Error("Could not access spreadsheet");
    }

    const sheet = spreadsheet.getSheetByName(SHEETS.EXPENSES);
    if (!sheet) {
      throw new Error("Expenses sheet not found");
    }

    let rows = [];
    try {
      rows = sheet.getDataRange().getValues() || [];
    } catch (dataError) {
      Logger.log("Error getting sheet data: " + dataError);
      rows = [];
    }

    if (!Array.isArray(rows) || rows.length < 2) {
      return {
        success: true,
        data: [],
        message: "No expense history found"
      };
    }

    // Parse filter options
    const filters = filterOptions ? (typeof filterOptions === 'string' ? JSON.parse(filterOptions) : filterOptions) : {};
    const groupBy = filters.groupBy || 'none'; // 'month', 'account', 'both', 'none'
    const selectedMonth = filters.month; // Format: 'YYYY-MM'
    const selectedAccount = filters.account;

    // Process headers and data
    const headers = (rows[0] || []).map(h => String(h).toLowerCase());
    const dateIdx = headers.findIndex(h => /timestamp|date/i.test(h));
    const amountIdx = headers.findIndex(h => /amount/i.test(h));
    const accountIdx = headers.findIndex(h => /account/i.test(h));
    const paymentIdx = headers.findIndex(h => /payment|source/i.test(h));
    const noteIdx = headers.findIndex(h => /note/i.test(h));
    const outletIdx = headers.findIndex(h => /outlet/i.test(h));

    Logger.log("Expense History - Headers: " + JSON.stringify(headers));
    Logger.log("Column indices - Date: " + dateIdx + ", Amount: " + amountIdx + ", Account: " + accountIdx + ", Payment: " + paymentIdx + ", Note: " + noteIdx + ", Outlet: " + outletIdx);

    // Get user session for filtering
    const session = getUserSessionEnhanced(deviceId, username) || {};
    const userOutlet = session.outlet;
    
    Logger.log("=== OUTLET FILTERING DEBUG ===");
    Logger.log("User session: " + JSON.stringify(session));
    Logger.log("User outlet from session: '" + userOutlet + "'");
    Logger.log("Outlet column index: " + outletIdx);
    Logger.log("Total rows to process: " + (rows.length - 1));

    // Ensure we have valid array data before processing
    const validRows = Array.isArray(rows.slice(1)) ? rows.slice(1) : [];
    
    // Debug: Show some sample outlet values from the data
    if (validRows.length > 0 && outletIdx !== -1) {
      Logger.log("Sample outlet values from data:");
      validRows.slice(0, 5).forEach((row, index) => {
        Logger.log("Row " + index + " outlet: '" + row[outletIdx] + "' (type: " + typeof row[outletIdx] + ")");
      });
    }

    // Map data to structured format with filtering
    const history = validRows
      .filter(row => {
        if (!Array.isArray(row)) {
          Logger.log("Skipping non-array row: " + JSON.stringify(row));
          return false;
        }
        
        // Filter by outlet with enhanced debugging
        if (outletIdx !== -1 && userOutlet) {
          const rowOutlet = String(row[outletIdx] || "").trim();
          const userOutletTrimmed = String(userOutlet).trim();
          
          if (rowOutlet !== userOutletTrimmed) {
            Logger.log("Outlet filter: Excluding row with outlet '" + rowOutlet + "' (user outlet: '" + userOutletTrimmed + "')");
            return false;
          } else {
            Logger.log("Outlet filter: Including row with outlet '" + rowOutlet + "'");
          }
        } else {
          if (outletIdx === -1) {
            Logger.log("Warning: No outlet column found in expenses data");
          }
          if (!userOutlet) {
            Logger.log("Warning: No user outlet in session, showing all expenses");
          }
        }
        
        // Filter by account if specified
        if (selectedAccount && row[accountIdx] !== selectedAccount) return false;
        
        // Filter by month if specified
        if (selectedMonth) {
          let date;
          try {
            const dateRaw = row[dateIdx];
            
            if (dateRaw instanceof Date) {
              date = dateRaw;
            } else if (typeof dateRaw === 'string') {
              // Try Utilities.parseDate first for Google Sheets compatibility
              try {
                date = Utilities.parseDate(dateRaw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
                if (!date || isNaN(date.getTime())) {
                  date = Utilities.parseDate(dateRaw, Session.getScriptTimeZone(), 'MM/dd/yyyy');
                }
                if (!date || isNaN(date.getTime())) {
                  date = Utilities.parseDate(dateRaw, Session.getScriptTimeZone(), 'dd-MM-yyyy');
                }
              } catch (e) {
                Logger.log('Utilities.parseDate failed, trying standard Date: ' + e);
              }
              
              // Fallback to standard Date parsing if Utilities.parseDate failed
              if (!date || isNaN(date.getTime())) {
                date = new Date(dateRaw);
              }
            } else {
              date = new Date(dateRaw);
            }
            
            if (!date || isNaN(date.getTime())) {
              Logger.log('Failed to parse date in expenses filter: ' + JSON.stringify(dateRaw));
              return false;
            }
            
            const rowMonth = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
            if (rowMonth !== selectedMonth) return false;
          } catch (e) {
            Logger.log('Error parsing date in expenses filter: ' + e + ', dateRaw: ' + JSON.stringify(row[dateIdx]));
            return false;
          }
        }
        
        return true;
      })
      .map(row => {
        try {
          let date;
          let month = '';
          
          try {
            const dateRaw = row[dateIdx];
            
            if (dateRaw instanceof Date) {
              date = dateRaw;
            } else if (typeof dateRaw === 'string') {
              // Try Utilities.parseDate first for Google Sheets compatibility
              try {
                date = Utilities.parseDate(dateRaw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
                if (!date || isNaN(date.getTime())) {
                  date = Utilities.parseDate(dateRaw, Session.getScriptTimeZone(), 'MM/dd/yyyy');
                }
                if (!date || isNaN(date.getTime())) {
                  date = Utilities.parseDate(dateRaw, Session.getScriptTimeZone(), 'dd-MM-yyyy');
                }
              } catch (e) {
                Logger.log('Utilities.parseDate failed, trying standard Date: ' + e);
              }
              
              // Fallback to standard Date parsing if Utilities.parseDate failed
              if (!date || isNaN(date.getTime())) {
                date = new Date(dateRaw);
              }
            } else {
              date = new Date(dateRaw);
            }
            
            if (date && !isNaN(date.getTime())) {
              month = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
            } else {
              Logger.log('Failed to parse date in expenses map: ' + JSON.stringify(dateRaw));
            }
          } catch (e) {
            Logger.log('Error parsing date in expenses map: ' + e + ', dateRaw: ' + JSON.stringify(row[dateIdx]));
          }
          
          return {
            date: formatDateForJSON(row[dateIdx]),
            month: month,
            amount: Number(row[amountIdx]) || 0,
            account: String(row[accountIdx] || ""),
            payment: String(row[paymentIdx] || ""),
            note: String(row[noteIdx] || "")
          };
        } catch (rowError) {
          Logger.log("Error processing row: " + rowError + " Row data: " + JSON.stringify(row));
          return null;
        }
      })
      .filter(entry => entry !== null);

    // Group data based on groupBy option
    let result = history;
    if (groupBy !== 'none') {
      const groupedData = {};
      
      history.forEach(entry => {
        let key = '';
        if (groupBy === 'month') {
          key = entry.month;
        } else if (groupBy === 'account') {
          key = entry.account;
        } else if (groupBy === 'both') {
          key = entry.month + '||' + entry.account;
        }
        
        if (!groupedData[key]) {
          groupedData[key] = {
            month: entry.month,
            account: entry.account,
            totalAmount: 0,
            count: 0,
            items: []
          };
        }
        
        groupedData[key].totalAmount += entry.amount;
        groupedData[key].count += 1;
        groupedData[key].items.push(entry);
      });
      
      // Convert grouped data to array format
      result = Object.keys(groupedData).map(key => {
        const group = groupedData[key];
        return {
          groupKey: key,
          month: group.month,
          account: group.account,
          totalAmount: group.totalAmount,
          count: group.count,
          items: group.items.sort((a, b) => new Date(b.date) - new Date(a.date))
        };
      }).sort((a, b) => {
        // Sort by month desc, then by account
        if (a.month !== b.month) {
          return b.month.localeCompare(a.month);
        }
        return a.account.localeCompare(b.account);
      });
    } else {
      // Sort individual items by date descending
      result = result.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    Logger.log("Returning expense history with " + result.length + " entries, groupBy: " + groupBy);
    Logger.log("=== FINAL EXPENSE FILTERING RESULTS ===");
    Logger.log("Total entries after filtering: " + result.length);
    Logger.log("User outlet: '" + userOutlet + "'");
    Logger.log("Total amount: " + history.reduce((sum, item) => sum + item.amount, 0));
    
    // Show sample results for debugging
    if (result.length > 0) {
      Logger.log("Sample filtered results:");
      result.slice(0, 3).forEach((item, index) => {
        if (groupBy === 'none') {
          Logger.log("Result " + index + ": " + item.date + ", " + item.account + ", " + item.amount);
        } else {
          Logger.log("Group " + index + ": " + item.groupKey + ", count: " + item.count + ", total: " + item.totalAmount);
        }
      });
    } else {
      Logger.log("No expenses found for user outlet: '" + userOutlet + "'");
    }

    return {
      success: true,
      data: result,
      count: result.length,
      groupBy: groupBy,
      totalAmount: history.reduce((sum, item) => sum + item.amount, 0)
    };

  } catch (error) {
    Logger.log("Error in getExpenseHistory: " + error);
    return {
      success: false,
      data: [],
      error: error.message
    };
  }
}

/**
 * SecurityWrapper-compatible version of recordExpense
 * Handles enhanced parameters from SecurityWrapper
 */
function recordExpenseSecure(params) {
  try {
    var authContext = params._authContext;
    if (!authContext || !authContext.deviceId || !authContext.username) {
      return apiFail('Invalid authentication context', 'EXPENSE_AUTH_INVALID');
    }
    // Only the checkout (discount) records expenses from the app.
    try {
      requirePermission_(params, 'orders');
    } catch (authErr) {
      return apiFail(authErr.message || String(authErr), 'EXPENSE_FORBIDDEN');
    }

    var expense = {
      amount: params.amount,
      account: params.account,
      payment: params.payment,
      note: params.note,
      deviceId: authContext.deviceId,
      username: authContext.username
    };

    return recordExpense(expense);
  } catch (error) {
    Logger.log("ERROR in recordExpenseSecure: " + error.toString());
    return apiFail(error.message || error, 'EXPENSE_SAVE_FAILED');
  }
}