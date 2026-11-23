function parsePurchaseDate(dateString) {
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

function purchaseColumnLetter_(index) {
  var letters = '';
  for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  }
  return letters;
}

function purchaseAccountType_(account) {
  var table = Repo.readTable('ACCOUNTS');
  var cols = buildColumnMap(table.headers, 'ACCOUNTS');
  if (cols.NAME < 0 || cols.TYPE < 0) throw new Error('Accounts sheet is missing name or type columns.');
  var nameHeader = table.headers[cols.NAME], typeHeader = table.headers[cols.TYPE];
  var key = normalizeAccountNameKey_(account), type = '';
  table.rows.forEach(function (row) {
    if (normalizeAccountNameKey_(row[nameHeader]) === key) type = String(row[typeHeader] || '').trim();
  });
  return type;
}

function validateMiscPurchaseItem_(item) {
  var name = typeof item.productName === 'string' ? item.productName.trim() : '';
  if (name.length < 2 || name.length > 50) throw new Error('Misc description must be 2 to 50 characters.');
  if (!isFinite(Number(item.qty)) || Number(item.qty) <= 0) throw new Error('Misc quantity must be greater than zero.');
  if (!isFinite(Number(item.price)) || Number(item.price) <= 0) throw new Error('Misc unit price must be greater than zero.');
  if (typeof item.category !== 'string' || !item.category.trim()) throw new Error('Misc category is required.');
  var expiry = item.expiryDate || '';
  if (expiry) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
    if (!match) throw new Error('Invalid misc expiry date.');
    var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) ||
        date.getUTCDate() !== Number(match[3])) throw new Error('Invalid misc expiry date.');
  }
}

function recordPurchase(purchase) {
  try {
    if (typeof purchase === 'string') purchase = JSON.parse(purchase);

    const { deviceId, username } = purchase;
    if (!deviceId || !username) {
      return apiFail('Device ID and username are required to record a purchase.', 'PURCHASE_AUTH_REQUIRED');
    }

    // recordPurchaseSecure already authenticated + refreshed this session.
    const session = getUserSessionEnhanced(deviceId, username, { skipPeopleRefresh: true }) || {};
    const timestamp = new Date();
    const purchaseId = purchase.id || (timestamp.getTime() + '_' + Math.random().toString(36).substr(2, 9));

    if (!Array.isArray(purchase.items) || !purchase.items.length) {
      return apiFail('No items in purchase', 'PURCHASE_EMPTY');
    }
    purchase.items.forEach(function (item) {
      if (!item || typeof item !== 'object') throw new Error('Invalid purchase item.');
      if (item.isMisc === true) validateMiscPurchaseItem_(item);
    });
    const isInvestment = purchaseAccountType_(purchase.account).toLowerCase() === 'investment';

    const rows = [];
    purchase.items.forEach((item) => {
      const purchaseOutlet = purchase.outlet || purchase.outletsString || purchase.outlets?.join(', ') || session.outlet || "";
      rows.push([
        formatTimestampForSheet(timestamp),
        item.supplier || "",
        item.productName || "",
        item.code || "",
        Number(item.qty) || 0,
        Number(item.price) || 0,
        item.category || "",
        item.buyUnit || "",
        item.buyUnitSize || "",
        Number(item.qty) * Number(item.price) || 0,
        purchase.account || "",
        purchaseOutlet,
        purchase.username || session.username || "",
        purchaseId,
        purchase.payment || "",
        item.expiryDate || "",
        item.mode || "",
        "",
        "ORDERED",
        ""
      ]);
    });

    // Duplicate guard: the client sends a fresh id per submit, so a duplicate can
    // only be the SAME request delivered twice (network retry) within minutes.
    // A short-lived cache entry catches that without scanning the whole
    // Purchases sheet (which grows forever) inside the lock.
    const idemKey = buildIdempotencyCacheKey_('purchase_', purchaseId);

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (idemKey && getIdempotentResult_(idemKey)) {
        return apiFail('Duplicate purchase detected. Please try again.', 'PURCHASE_DUPLICATE');
      }
      const headers = Repo.readHeaders('PURCHASES');
      if (!headers.length) return apiFail('Purchases sheet not found or has no headers.', 'PURCHASE_SHEET_MISSING');
      if (headers.length < 20) throw new Error('Purchases sheet requires at least 20 columns.');
      var investIdx = headers.findIndex(h => /is\s*investment/i.test(h));
      var sourceIdx = headers.findIndex(h => /source\s*account/i.test(h));
      const oldLength = headers.length;
      if (investIdx === -1) { investIdx = headers.length; headers.push('Is Investment'); }
      if (sourceIdx === -1) { sourceIdx = headers.length; headers.push('Source Account'); }
      if (headers.length !== oldLength) {
        Repo.updateRange('PURCHASES', purchaseColumnLetter_(oldLength) + '1:' + purchaseColumnLetter_(headers.length - 1) + '1',
          [headers.slice(oldLength)]);
      }
      const completeRows = rows.map(function (row) {
        while (row.length < headers.length) row.push('');
        row[investIdx] = isInvestment ? 'Y' : '';
        row[sourceIdx] = '';
        return row;
      });
      Repo.appendRows('PURCHASES', completeRows);
      if (idemKey) putIdempotentResult_(idemKey, { purchaseId: purchaseId }, 600);
    } finally {
      lock.releaseLock();
    }

    invalidatePnLCache_(session.outlet);
    return apiOk({ purchaseId: purchaseId, message: 'Purchase recorded successfully' }, 'PURCHASE_SAVED');
  } catch (error) {
    Logger.log('ERROR in recordPurchase: ' + error.toString());
    return apiFail(error.message || error, 'PURCHASE_SAVE_FAILED');
  }
}

function getPurchaseSummaryByOutlet(deviceId, username) {
  const session = getUserSessionEnhanced(deviceId, username) || {};
  const userOutlet = session.outlet;

  const sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.PURCHASES);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data.shift();

  const outletIdx = headers.findIndex(h => /outlet/i.test(h));
  const dateIdx = headers.findIndex(h => /timestamp|date/i.test(h));
  const supplierIdx = headers.findIndex(h => /supplier/i.test(h));
  const productIdx = headers.findIndex(h => /product|item|name/i.test(h));
  const qtyIdx = headers.findIndex(h => /qty|quantity/i.test(h));
  const priceIdx = headers.findIndex(h => /price/i.test(h));
  const totalIdx = headers.findIndex(h => /total|amount/i.test(h));

  // Filter for this outlet only
  const filtered = data.filter(row =>
    outletIdx === -1 || row[outletIdx] === userOutlet
  );

  // Summarize by product (or supplier, or both)
  const summary = {};
  filtered.forEach(row => {
    const product = row[productIdx] || 'Unknown';
    const supplier = row[supplierIdx] || 'Unknown';
    const qty = Number(row[qtyIdx]) || 0;
    const total = Number(row[totalIdx]) || 0;
    const key = product + "|" + supplier;
    if (!summary[key]) {
      summary[key] = {
        product,
        supplier,
        qty: 0,
        total: 0
      };
    }
    summary[key].qty += qty;
    summary[key].total += total;
  });

  return Object.values(summary);
}

function getPurchaseSummaryData(filterOptions, deviceId, username) {
  try {
    // Add session and userOutlet at the start
    const session = getUserSessionEnhanced(deviceId, username) || {};
    const userOutlet = session.outlet;

    const sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.PURCHASES);
    if (!sheet) {
      return {
        success: true,
        data: [],
        message: "Purchases sheet not found"
      };
    }

    const data = sheet.getDataRange().getValues();
    Logger.log("Raw data length: " + data.length);
    
    if (data.length < 2) {
      Logger.log("No purchase data found - sheet has " + data.length + " rows");
      return {
        success: true,
        data: [],
        message: "No purchase data found",
        groupBy: filters.groupBy || 'none',
        totalAmount: 0
      };
    }

    // Parse filter options
    const filters = filterOptions ? (typeof filterOptions === 'string' ? JSON.parse(filterOptions) : filterOptions) : {};
    Logger.log("Filter options: " + JSON.stringify(filters));
    const groupBy = filters.groupBy || 'none'; // 'month', 'product', 'both', 'none'
    const selectedMonth = filters.month; // Format: 'YYYY-MM'
    const selectedProduct = filters.product;
    const selectedOutlet = filters.outlet;
    const selectedMode = filters.mode; // Filter by mode (e.g. 'L,LO' for local purchases)

    const headers = data.shift();
    const outletIdx = headers.findIndex(h => /outlet/i.test(h));
    const dateIdx = headers.findIndex(h => /date|timestamp/i.test(h));
    const productIdx = headers.findIndex(h => /product|item/i.test(h));
    const supplierIdx = headers.findIndex(h => /supplier/i.test(h));
    const categoryIdx = headers.findIndex(h => /category/i.test(h));
    const qtyIdx = headers.findIndex(h => /qty|quantity/i.test(h));
    const unitIdx = headers.findIndex(h => /unit/i.test(h));
    const priceIdx = headers.findIndex(h => /price|cost/i.test(h));
    const totalIdx = headers.findIndex(h => /total|amount/i.test(h));
    const expiryIdx = headers.findIndex(h => /expiry/i.test(h));
    const modeIdx = headers.findIndex(h => /^mode$/i.test(h));

    Logger.log("Purchase Summary - Headers: " + JSON.stringify(headers));
    Logger.log("Column indices - Date: " + dateIdx + ", Product: " + productIdx + ", Supplier: " + supplierIdx + ", Category: " + categoryIdx + ", Qty: " + qtyIdx + ", Unit: " + unitIdx + ", Price: " + priceIdx + ", Total: " + totalIdx + ", Outlet: " + outletIdx);

    // Map data to structured format with filtering
    const purchases = data
      .filter(row => {
        if (!Array.isArray(row)) return false;
        
        // Temporarily disable outlet filtering for debugging
        // Filter by outlet
        // if (outletIdx !== -1 && userOutlet && row[outletIdx] !== userOutlet) {
        //   Logger.log("Filtered out row due to outlet mismatch: " + row[outletIdx] + " vs " + userOutlet);
        //   return false;
        // }
        
        // Filter by product if specified
        if (selectedProduct && row[productIdx] !== selectedProduct) return false;
        
        // Filter by outlet if specified
        if (selectedOutlet && row[outletIdx] !== selectedOutlet) return false;
        
        // Filter by mode if specified (e.g. 'L,LO')
        if (selectedMode && modeIdx !== -1) {
          const allowedModes = selectedMode.split(',').map(m => m.trim().toUpperCase());
          const rowMode = (row[modeIdx] || '').toString().trim().toUpperCase();
          if (!allowedModes.includes(rowMode)) return false;
        }
        
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
              Logger.log('Failed to parse date in purchases filter: ' + JSON.stringify(dateRaw));
              return false;
            }
            
            const rowMonth = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
            if (rowMonth !== selectedMonth) return false;
          } catch (e) {
            Logger.log('Error parsing date in purchases filter: ' + e + ', dateRaw: ' + JSON.stringify(row[dateIdx]));
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
              Logger.log('Failed to parse date in purchases map: ' + JSON.stringify(dateRaw));
            }
          } catch (e) {
            Logger.log('Error parsing date in purchases map: ' + e + ', dateRaw: ' + JSON.stringify(row[dateIdx]));
          }
          
          return {
            date: formatDateForJSON(row[dateIdx]),
            month: month,
            product: String(row[productIdx] || ""),
            supplier: String(row[supplierIdx] || ""),
            category: String(row[categoryIdx] || ""),
            outlet: String(row[outletIdx] || ""),
            qty: Number(row[qtyIdx]) || 0,
            buyUnit: String(row[unitIdx] || ""),
            unitPrice: Number(row[priceIdx]) || 0,
            total: Number(row[totalIdx]) || 0,
            expiryDate: expiryIdx !== -1 ? String(row[expiryIdx] || "") : ""
          };
        } catch (rowError) {
          Logger.log("Error processing purchase row: " + rowError + " Row data: " + JSON.stringify(row));
          return null;
        }
      })
      .filter(entry => entry !== null);

    Logger.log("Filtered purchases count: " + purchases.length);
    Logger.log("User outlet: " + userOutlet);
    Logger.log("Sample purchase entries: " + JSON.stringify(purchases.slice(0, 2)));

    // Group data based on groupBy option
    let result = purchases;
    if (groupBy !== 'none') {
      const groupedData = {};
      
      purchases.forEach(entry => {
        let key = '';
        if (groupBy === 'month') {
          key = entry.month;
        } else if (groupBy === 'product') {
          key = entry.product;
        } else if (groupBy === 'both') {
          key = entry.month + '||' + entry.product;
        }
        
        if (!groupedData[key]) {
          groupedData[key] = {
            month: entry.month,
            product: entry.product,
            category: entry.category,
            totalAmount: 0,
            count: 0,
            items: []
          };
        }
        
        groupedData[key].totalAmount += entry.total;
        groupedData[key].count += 1;
        groupedData[key].items.push(entry);
      });
      
      // Convert grouped data to array format
      result = Object.keys(groupedData).map(key => {
        const group = groupedData[key];
        return {
          groupKey: key,
          month: group.month,
          product: group.product,
          category: group.category,
          totalAmount: group.totalAmount,
          count: group.count,
          items: group.items.sort((a, b) => new Date(b.date) - new Date(a.date))
        };
      }).sort((a, b) => {
        // Sort by month desc, then by product
        if (a.month !== b.month) {
          return b.month.localeCompare(a.month);
        }
        return a.product.localeCompare(b.product);
      });
    } else {
      // Sort individual items by date descending
      result = result.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    Logger.log("Returning purchase summary with " + result.length + " entries, groupBy: " + groupBy);

    return {
      success: true,
      data: result,
      count: result.length,
      groupBy: groupBy,
      totalAmount: purchases.reduce((sum, item) => sum + item.total, 0)
    };

  } catch (error) {
    Logger.log("Error in getPurchaseSummaryData: " + error);
    return {
      success: false,
      data: [],
      error: error.message
    };
  }
}

/**
 * Updates existing purchases with product codes using generateProductCode helper
 * This function processes all purchases in the Purchases sheet and generates product codes
 * for rows that don't have them or have empty product codes
 * @param {boolean} forceUpdate - If true, regenerates product codes for all rows even if they exist
 * @returns {Object} - Result object with success status and update count
 */
function updatePurchasesWithProductCodes(forceUpdate) {
  try {
    Logger.log("=== UPDATING PURCHASES WITH PRODUCT CODES ===");
    Logger.log("Force update mode:", forceUpdate || false);
    
    const sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.PURCHASES);
    if (!sheet) {
      throw new Error('Purchases sheet not found');
    }
    
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    
    if (lastRow <= 1) {
      Logger.log("No data rows found in Purchases sheet");
      return { success: true, updatedCount: 0, message: "No data rows to update" };
    }
    
    // Get headers
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    Logger.log("Purchases headers: " + JSON.stringify(headers));
    
    // Define expected column positions
    const expectedColumns = {
      timestamp: 0,      // Column A: Timestamp
      supplier: 1,       // Column B: Supplier
      productName: 2,    // Column C: Product Name
      code: 3,          // Column D: Code (Product Code)
      qty: 4,           // Column E: Quantity
      price: 5,         // Column F: Price
      category: 6,      // Column G: Category
      buyUnit: 7,       // Column H: Buy Unit
      buyUnitSize: 8,   // Column I: Buy Unit Size
      total: 9,         // Column J: Total
      account: 10,      // Column K: Account
      outlet: 11,       // Column L: Outlet
      username: 12,     // Column M: Username
      purchaseId: 13,   // Column N: Purchase ID
      payment: 14,      // Column O: Payment
      expiry: 15,       // Column P: Expiry Date
      mode: 16,         // Column Q: Mode
      // Column R: reserved/existing column (index 17)
      pstatus: 18,      // Column S: PSTATUS
      rquantity: 19     // Column T: RQUANTITY
    };
    
    const productNameIdx = expectedColumns.productName;
    const codeIdx = expectedColumns.code;
    const categoryIdx = expectedColumns.category;
    
    let updatedCount = 0;
    
    // Process each purchase row
    for (let row = 2; row <= lastRow; row++) {
      const currentCode = sheet.getRange(row, codeIdx + 1).getValue() || '';
      const productName = sheet.getRange(row, productNameIdx + 1).getValue() || '';
      const category = sheet.getRange(row, categoryIdx + 1).getValue() || '';
      
      // Skip if no product name
      if (!productName.toString().trim()) {
        continue;
      }
      
      // Check if we should update this row
      const shouldUpdate = forceUpdate || !currentCode.toString().trim();
      
      if (shouldUpdate) {
        // Generate new product code using the same logic as orders
        const newCode = generateProductCode({
          name: productName.toString().trim(),
          category: category.toString().trim(),
          productCode: currentCode.toString().trim()
        });
        
        // Update the code column
        sheet.getRange(row, codeIdx + 1).setValue(newCode);
        updatedCount++;
        
        if (updatedCount <= 5) { // Log first few updates
          Logger.log(`Row ${row}: "${category}" + "${productName}" = "${newCode}"`);
        }
      }
    }
    
    Logger.log("=== PURCHASE PRODUCT CODE UPDATE COMPLETE ===");
    Logger.log(`Updated ${updatedCount} purchase rows`);
    
    return {
      success: true,
      updatedCount: updatedCount,
      message: `Updated ${updatedCount} purchase product codes`
    };
    
  } catch (error) {
    Logger.log("ERROR updating purchases with product codes:", error.toString());
    return {
      success: false,
      error: error.toString(),
      updatedCount: 0
    };
  }
}

/**
 * Convenience function to update only purchases missing product codes
 */
function updateMissingPurchaseProductCodes() {
  return updatePurchasesWithProductCodes(false);
}

/**
 * Convenience function to regenerate all purchase product codes (force update)
 */
function regenerateAllPurchaseProductCodes() {
  return updatePurchasesWithProductCodes(true);
}

/**
 * Returns all purchases with PSTATUS = "ORDERED" for the current user's outlet.
 * Used by the Receive tab so staff can mark items as received.
 */
function getOrderedPurchases(deviceId, username) {
  try {
    // No session → no data (it used to fall back to "no outlet" = every outlet's rows).
    const session = getUserSessionEnhanced(deviceId, username);
    if (!session || !session.username) return { success: false, data: [], error: 'Invalid or expired session' };
    const userOutlet = session.outlet;

    const sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.PURCHASES);
    if (!sheet) return { success: true, data: [] };

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: true, data: [] };

    const headers = data[0];
    const dateIdx      = headers.findIndex(h => /timestamp|date/i.test(h));
    const productIdx   = headers.findIndex(h => /product|item/i.test(h));
    const supplierIdx  = headers.findIndex(h => /supplier/i.test(h));
    const qtyIdx       = headers.findIndex(h => /^qty$|^quantity$/i.test(h));
    const outletIdx    = headers.findIndex(h => /outlet/i.test(h));
    const purchaseIdIdx = headers.findIndex(h => /purchase.*id/i.test(h));
    const pstatusIdx   = headers.findIndex(h => /pstatus/i.test(h));
    const rqtyIdx      = headers.findIndex(h => /rquantity/i.test(h));

    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      // Only include ORDERED rows for this outlet
      const rowOutlet = outletIdx !== -1 ? String(row[outletIdx] || "") : "";
      if (userOutlet && rowOutlet !== userOutlet) continue;
      const status = pstatusIdx !== -1 ? String(row[pstatusIdx] || "").toUpperCase() : "ORDERED";
      if (status !== "ORDERED") continue;

      rows.push({
        rowIndex: i + 1, // 1-based sheet row
        purchaseId: purchaseIdIdx !== -1 ? String(row[purchaseIdIdx] || "") : "",
        date: formatDateForJSON(row[dateIdx]),
        product: String(row[productIdx] || ""),
        supplier: String(row[supplierIdx] || ""),
        qty: Number(row[qtyIdx]) || 0,
        outlet: rowOutlet,
        pstatus: status,
        rquantity: rqtyIdx !== -1 ? (Number(row[rqtyIdx]) || 0) : 0
      });
    }

    return sanitizeForClient({ success: true, data: rows });
  } catch (e) {
    Logger.log("getOrderedPurchases error: " + e);
    return { success: false, data: [], error: e.message };
  }
}

/**
 * Marks a purchase row as RECEIVED and stores the received quantity.
 * Expects params: { rowIndex, rquantity, _authContext }
 */
function updateReceiveQuantitySecure(params) {
  try {
    // Real session check (it used to trust any username in the request).
    var session = requireAuth_(params);
    var tabs = resolveEffectiveTabsFromSession(session);
    if (tabs.indexOf('*') < 0 && tabs.indexOf('purchasingReceive') < 0 && tabs.indexOf('purchasing') < 0) {
      throw new Error("Permission denied: purchasingReceive");
    }

    var rowIndex    = parseInt(params.rowIndex, 10);
    var rquantity   = Number(params.rquantity);
    if (!rowIndex || rowIndex < 2) throw new Error("Invalid row index.");
    if (isNaN(rquantity) || rquantity < 0) throw new Error("Invalid received quantity.");

    const sheet = getGlobalSpreadsheet().getSheetByName(SHEETS.PURCHASES);
    if (!sheet) throw new Error("Purchases sheet not found.");
    if (rowIndex > sheet.getLastRow()) throw new Error("Invalid row index.");

    const width = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, width).getValues()[0];
    const pstatusIdx = headers.findIndex(h => /pstatus/i.test(h));
    const rqtyIdx    = headers.findIndex(h => /rquantity/i.test(h));
    const outletIdx  = headers.findIndex(h => /outlet/i.test(h));

    if (pstatusIdx === -1 || rqtyIdx === -1) {
      throw new Error("PSTATUS or RQUANTITY column not found in Purchases sheet. Please add the column headers.");
    }

    // Same outlet rule as getOrderedPurchases: only this outlet's rows.
    const row = sheet.getRange(rowIndex, 1, 1, width).getValues()[0];
    const userOutlet = String(session.outlet || '');
    if (userOutlet && outletIdx !== -1 && String(row[outletIdx] || '') !== userOutlet) {
      throw new Error("This purchase belongs to another outlet.");
    }

    // One write covering both cells (they are normally adjacent columns).
    const lo = Math.min(pstatusIdx, rqtyIdx);
    const hi = Math.max(pstatusIdx, rqtyIdx);
    row[pstatusIdx] = "RECEIVED";
    row[rqtyIdx] = rquantity;
    if (hi - lo <= 1) {
      sheet.getRange(rowIndex, lo + 1, 1, hi - lo + 1).setValues([row.slice(lo, hi + 1)]);
    } else {
      sheet.getRange(rowIndex, pstatusIdx + 1).setValue("RECEIVED");
      sheet.getRange(rowIndex, rqtyIdx + 1).setValue(rquantity);
    }

    Logger.log("Row " + rowIndex + " marked RECEIVED with rquantity=" + rquantity + " by " + session.username);
    return { success: true, message: "Marked as received." };
  } catch (e) {
    Logger.log("updateReceiveQuantitySecure error: " + e);
    return { success: false, error: e.message };
  }
}



/**
 * Helper function to generate a product code based on category and name
 * This uses the same logic as the orders sheet for consistency
 * @param {Object} item - The purchase item containing category, name, and optional productCode
 * @returns {string} - Generated product code in format CATEGORY_PRODUCT_NAME
 */
function generateProductCode(item) {
  // Return existing productCode if available
  if (item.productCode && item.productCode.trim() !== '') {
    return item.productCode.trim();
  }
  
  // Generate product code from category and name
  const category = (item.category || '').toString().trim();
  const name = (item.name || '').toString().trim();
  
  // Handle cases where category or name might be empty
  if (!category && !name) {
    return 'UNKNOWN_PRODUCT';
  }
  
  // Normalize strings for product code generation
  const normalizeForCode = (str) => {
    return str.toUpperCase()
              .replace(/[^A-Z0-9\s]/g, '') // Remove special characters
              .replace(/\s+/g, '_')        // Replace spaces with underscores
              .substring(0, 20);           // Limit length
  };
  
  const categoryCode = category ? normalizeForCode(category) : 'GENERAL';
  const nameCode = name ? normalizeForCode(name) : 'ITEM';
  
  const productCode = `${categoryCode}_${nameCode}`;
  
  return productCode || 'UNKNOWN_PRODUCT';
}

/**
 * SecurityWrapper-compatible purchase recording function
 * @param {Object} params - Parameters object from SecurityWrapper (contains _authContext and purchase data)
 * @returns {Object} Success response or throws error
 */
function recordPurchaseSecure(params) {
  return withAgentGuard_('purchase.record', params, function () {
    var purchase = params;
    var authContext = params._authContext;

    var session = requireAuth_(params);
    var tabs = resolveEffectiveTabsFromSession(session);
    if (tabs.indexOf('*') < 0 && tabs.indexOf('purchasing') < 0 && tabs.indexOf('purchasingLocal') < 0) {
      return apiFail('Permission denied: purchasing', 'PURCHASE_FORBIDDEN');
    }
    if (!session.outlet) return apiFail('Outlet is required to record a purchase.', 'PURCHASE_AUTH_INVALID');

    const purchaseWithAuth = {
      ...purchase,
      deviceId: authContext.deviceId,
      username: session.username,
      outlet: session.outlet
    };

    return recordPurchase(purchaseWithAuth);
  });
}