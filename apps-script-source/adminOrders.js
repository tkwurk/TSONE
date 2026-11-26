/**
 * ✅ ADMIN ORDERS BACKEND - Google Apps Script
 * Functions for admin users to view and update order data
 * Includes authentication checks and outlet filtering
 */

function requireAdminOrdersSession_(params) {
  var session = requireAdmin_(params);
  if (typeof resolveUserOutlet_ === 'function') {
    session.outlet = resolveUserOutlet_(session.username, session.outlet);
  }
  return session;
}

/**
 * Get orders with filtering by date range and outlet
 * Only accessible to admin users with proper authentication
 */
function getOrdersForAdmin(params) {
  try {
    const session = requireAdminOrdersSession_(params);
    const userOutlet = session.outlet;
    const isAdmin = true;

    Logger.log("getOrdersForAdmin: Admin access granted for user: " + params.username);

    // Get orders sheet
    const ordersSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ORDERS);
    if (!ordersSheet) {
      throw new Error('Orders sheet not found');
    }

    const ordersData = ordersSheet.getDataRange().getValues();
    const headers = ordersData[0];
    
    Logger.log("getOrdersForAdmin: Found headers:", headers);
    Logger.log("getOrdersForAdmin: Total rows in sheet:", ordersData.length);
    
    // Check if sheet has any data beyond headers
    if (ordersData.length <= 1) {
      Logger.log("getOrdersForAdmin: Sheet only has headers, no data rows");
      return {
        success: true,
        orders: JSON.stringify([]),
        userOutlet: userOutlet,
        isAdmin: isAdmin
      };
    }
    
    // Log first data row to see actual structure
    if (ordersData.length > 1) {
      Logger.log("getOrdersForAdmin: First data row:", ordersData[1]);
    }
    
    // Find column indices based on actual sheet structure from orders.js
    // Based on orders.js: Timestamp, Order Number, Product Name, Quantity, Price, Payment Method, Total, Category, Outlet, Username, Product Code
    const colIndices = {
      timestamp: 0,        // Column A: Timestamp
      orderNumber: 1,      // Column B: Order Number  
      productName: 2,      // Column C: Product Name
      quantity: 3,         // Column D: Quantity
      price: 4,            // Column E: Price
      paymentMethod: 5,    // Column F: Payment Method
      total: 6,            // Column G: Total
      category: 7,         // Column H: Category
      outlet: 8,           // Column I: Outlet
      username: 9,         // Column J: Username
      productCode: 10      // Column K: Product Code
    };
    
    // Verify with header-based lookup as backup
    const headerBasedIndices = {
      timestamp: headers.indexOf('Timestamp'),
      orderNumber: headers.indexOf('Order Number'),
      productName: headers.indexOf('Product Name'),
      quantity: headers.indexOf('Quantity'),
      price: headers.indexOf('Price'),
      paymentMethod: headers.indexOf('Payment Method'),
      total: headers.indexOf('Total'),
      category: headers.indexOf('Category'),
      outlet: headers.indexOf('Outlet'),
      username: headers.indexOf('Username'),
      productCode: headers.indexOf('Product Code')
    };
    
    Logger.log("getOrdersForAdmin: Fixed column indices:", colIndices);
    Logger.log("getOrdersForAdmin: Header-based indices:", headerBasedIndices);
    
    Logger.log("getOrdersForAdmin: Column indices:", colIndices);
    
    // Check for any missing critical columns
    const criticalColumns = ['timestamp', 'productName', 'quantity', 'price', 'total', 'outlet'];
    const missingColumns = criticalColumns.filter(col => colIndices[col] === -1);
    if (missingColumns.length > 0) {
      Logger.log("getOrdersForAdmin: WARNING - Missing critical columns:", missingColumns);
    }

    const orders = [];
    const fromDate = params.fromDate ? new Date(params.fromDate) : null;
    const toDate = params.toDate ? new Date(params.toDate) : null;

    Logger.log("getOrdersForAdmin: Filtering - fromDate: " + fromDate + ", toDate: " + toDate + ", outlet: '" + params.outlet + "'");
    Logger.log("getOrdersForAdmin: Starting to process " + (ordersData.length - 1) + " data rows");

    for (let i = 1; i < ordersData.length; i++) {
      const row = ordersData[i];
      
      // Log first few rows for debugging
      if (i <= 3) {
        Logger.log("getOrdersForAdmin: Row " + i + " data:", row);
      }
      
      const orderDate = new Date(row[colIndices.timestamp]);
      const orderOutlet = row[colIndices.outlet];

      // Skip invalid dates
      if (isNaN(orderDate.getTime())) {
        Logger.log("Invalid date at row " + i + ": " + row[colIndices.timestamp]);
        continue;
      }

      // Filter by outlet if specified
      if (params.outlet && params.outlet.trim() !== '') {
        // Filter by specific outlet if selected
        if (orderOutlet !== params.outlet) {
         // Logger.log("getOrdersForAdmin: Skipping row " + i + " - outlet mismatch: '" + orderOutlet + "' vs '" + params.outlet + "'");
          continue;
        }
       // Logger.log("getOrdersForAdmin: Including row " + i + " - outlet match: '" + orderOutlet + "'");
      }
      // If no outlet specified (All Outlets), show all orders (no filtering)

      // Filter by date range if specified (normalize dates for comparison)
      if (fromDate) {
        const normalizedFromDate = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
        const normalizedOrderDate = new Date(orderDate.getFullYear(), orderDate.getMonth(), orderDate.getDate());
        if (normalizedOrderDate < normalizedFromDate) continue;
      }
      
      if (toDate) {
        const normalizedToDate = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate(), 23, 59, 59);
        if (orderDate > normalizedToDate) continue;
      }

      // Create order item from current row (each row is one item in this structure)
      const itemName = row[colIndices.productName];
      const qty = row[colIndices.quantity];
      const price = row[colIndices.price];
      const total = row[colIndices.total];
      
      // Log data validation for first few rows
      if (i <= 5) {
        Logger.log("getOrdersForAdmin: Row " + i + " data check:");
        Logger.log("  - itemName (col " + colIndices.productName + "): '" + itemName + "'");
        Logger.log("  - qty (col " + colIndices.quantity + "): " + qty);
        Logger.log("  - price (col " + colIndices.price + "): " + price);
        Logger.log("  - outlet (col " + colIndices.outlet + "): '" + orderOutlet + "'");
        Logger.log("  - date (col " + colIndices.timestamp + "): " + orderDate);
      }
      
      // More lenient validation - just check for meaningful data
      if (!itemName || itemName.toString().trim() === '') {
        Logger.log("getOrdersForAdmin: Skipping row " + i + " - empty itemName");
        continue;
      }
      
      // Convert values to numbers for validation
      const qtyNum = parseFloat(qty);
      const priceNum = parseFloat(price);
      
      if (isNaN(qtyNum) || qtyNum <= 0) {
        Logger.log("getOrdersForAdmin: Skipping row " + i + " - invalid quantity: " + qty);
        continue;
      }
      
      if (isNaN(priceNum) || priceNum <= 0) {
        Logger.log("getOrdersForAdmin: Skipping row " + i + " - invalid price: " + price);
        continue;
      }

      orders.push({
        rowIndex: i + 1, // Excel row number (1-based)
        timestamp: orderDate,
        outlet: orderOutlet,
        username: row[colIndices.username],
        itemName: itemName,
        qty: qtyNum,
        price: priceNum,
        total: parseFloat(total) || (qtyNum * priceNum),
        payment: row[colIndices.paymentMethod] || '',
        orderNumber: row[colIndices.orderNumber] || '',
        category: row[colIndices.category] || '',
        productCode: row[colIndices.productCode] || ''
      });
      
      // Log successful addition for first few rows
      if (i <= 3) {
        Logger.log("getOrdersForAdmin: Successfully added row " + i + " - " + itemName);
      }
    }

    //Logger.log("getOrdersForAdmin: Retrieved " + orders.length + " orders");
    return {
      success: true,
      orders: JSON.stringify(orders.reverse()), // Stringify and reverse the orders
      userOutlet: userOutlet,
      isAdmin: isAdmin
    };

  } catch (error) {
    Logger.log("getOrdersForAdmin error: " + error.toString());
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Update order data - quantity, price, or payment type
 * Only accessible to admin users with proper authentication
 */
function updateOrderData(params) {
  try {
    requireAdminOrdersSession_(params);

    // Get orders sheet
    const ordersSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ORDERS);
    if (!ordersSheet) {
      throw new Error('Orders sheet not found');
    }

    const ordersData = ordersSheet.getDataRange().getValues();
    const headers = ordersData[0];
    
    Logger.log("updateOrderData: Found headers:", headers);
    
    // Use fixed column indices based on orders.js structure
    const colIndices = {
      timestamp: 0,        // Column A: Timestamp
      orderNumber: 1,      // Column B: Order Number  
      productName: 2,      // Column C: Product Name
      quantity: 3,         // Column D: Quantity
      price: 4,            // Column E: Price
      paymentMethod: 5,    // Column F: Payment Method
      total: 6,            // Column G: Total
      category: 7,         // Column H: Category
      outlet: 8,           // Column I: Outlet
      username: 9,         // Column J: Username
      productCode: 10      // Column K: Product Code
    };
    
    Logger.log("updateOrderData: Column indices:", colIndices);

    const rowIndex = params.rowIndex;
    if (rowIndex < 2 || rowIndex > ordersData.length) {
      throw new Error('Invalid row index');
    }

    // Validate that all column indices are valid
    const invalidColumns = [];
    Object.entries(colIndices).forEach(([key, index]) => {
      if (index === -1) {
        invalidColumns.push(key);
      }
    });
    
    if (invalidColumns.length > 0) {
      Logger.log("updateOrderData: Invalid columns found:", invalidColumns);
      throw new Error('Column mapping error: ' + invalidColumns.join(', ') + ' not found in sheet headers');
    }

    let updatesMade = false;
    let newTotal = 0;

    // Update individual fields for single row
    if (params.itemName !== undefined) {
      ordersSheet.getRange(rowIndex, colIndices.productName + 1).setValue(params.itemName);
      updatesMade = true;
    }

    if (params.qty !== undefined) {
      ordersSheet.getRange(rowIndex, colIndices.quantity + 1).setValue(params.qty);
      updatesMade = true;
    }

    if (params.price !== undefined) {
      ordersSheet.getRange(rowIndex, colIndices.price + 1).setValue(params.price);
      updatesMade = true;
    }

    if (params.total !== undefined) {
      ordersSheet.getRange(rowIndex, colIndices.total + 1).setValue(params.total);
      newTotal = params.total;
      updatesMade = true;
    }

    // Note: We don't need to update the Items column as it doesn't exist in this structure
    // The Orders sheet stores one row per item, not aggregated orders with item arrays

    if (!updatesMade) {
      throw new Error('No valid fields provided for update');
    }

    Logger.log("updateOrderData: Successfully updated single row " + rowIndex + " by admin " + params.username + 
               " - ItemName: " + params.itemName + ", Qty: " + params.qty + ", Price: " + params.price + 
               ", Total: " + params.total + ", Payment: " + params.payment);
    
    return {
      success: true,
      message: 'Single order row updated successfully',
      newTotal: newTotal || params.total,
      rowIndex: rowIndex,
      updatedFields: {
        itemName: params.itemName,
        qty: params.qty,
        price: params.price,
        total: params.total,
        payment: params.payment
      }
    };

  } catch (error) {
    Logger.log("updateOrderData error: " + error.toString());
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Delete order data - remove entire row
 * Only accessible to admin users with proper authentication
 */
function orderHasLinkedDeposit_(baseOrderNumber) {
  if (!baseOrderNumber) return false;
  var depositsSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.DEPOSITS);
  if (!depositsSheet) return false;
  var data = depositsSheet.getDataRange().getValues();
  if (data.length < 2) return false;
  var noteIdx = data[0].findIndex(function(h) { return /note/i.test(String(h || '')); });
  if (noteIdx < 0) return false;
  var base = baseOrderNumber.toString();
  for (var i = 1; i < data.length; i++) {
    if ((data[i][noteIdx] || '').toString().indexOf(base) >= 0) return true;
  }
  return false;
}

function deleteOrderData(params) {
  try {
    requireAdminOrdersSession_(params);

    // Get orders sheet
    const ordersSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ORDERS);
    if (!ordersSheet) {
      throw new Error('Orders sheet not found');
    }

    const rowIndex = params.rowIndex;
    if (rowIndex < 2) {
      throw new Error('Cannot delete header row');
    }

    const lastRow = ordersSheet.getLastRow();
    if (rowIndex > lastRow) {
      throw new Error('Invalid row index');
    }

    // Before deleting, read the order number from the row to clean up associated deposits
    const rowData = ordersSheet.getRange(rowIndex, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
    const orderNumber = rowData[1] || ''; // Column B = Order Number
    const paymentMethod = (rowData[5] || '').toString().toLowerCase(); // Column F = Payment Method

    // Extract base order number (e.g. ORD-20250817-001 from ORD-20250817-001-002)
    const baseOrderNumber = orderNumber.toString().replace(/-\d{3}$/, '');

    // Block deletion when order has linked deposit (partial-as-cash or full digital)
    if (paymentMethod === 'partial' || (typeof isPartialPaymentLabel_ === 'function' && isPartialPaymentLabel_(paymentMethod))) {
      throw new Error('Cannot delete items from a partial payment order. Partial payment orders have associated deposit records that cannot be partially removed.');
    }
    if (orderHasLinkedDeposit_(baseOrderNumber)) {
      throw new Error('Cannot delete items from an order with linked deposit records. Remove the deposit first or delete the full order.');
    }

    // Block deletion of items belonging to discounted orders
    const expensesSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.EXPENSES);
    if (expensesSheet && baseOrderNumber) {
      const expenseData = expensesSheet.getDataRange().getValues();
      for (let e = 1; e < expenseData.length; e++) {
        const note = (expenseData[e][4] || '').toString(); // Column E = Note
        if (note.indexOf(baseOrderNumber) !== -1) {
          throw new Error('Cannot delete items from a discounted order. Discounted orders have associated expense records that cannot be partially removed.');
        }
      }
    }

    // Delete the order row
    ordersSheet.deleteRow(rowIndex);

    // Cascade delete: remove associated deposit and discount expense when all items of the order are gone
    if (baseOrderNumber) {
      try {
        // Check if any other rows with the same base order number still exist
        const allOrders = ordersSheet.getDataRange().getValues();
        let hasRemainingItems = false;
        for (let i = 1; i < allOrders.length; i++) {
          const otherOrderNum = (allOrders[i][1] || '').toString();
          if (otherOrderNum.startsWith(baseOrderNumber)) {
            hasRemainingItems = true;
            break;
          }
        }

        // Only clean up deposit and expense when the last item of the order is deleted
        if (!hasRemainingItems) {
          // Delete matching deposit (note contains the base order number)
          const depositsSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.DEPOSITS);
          if (depositsSheet) {
            const depositData = depositsSheet.getDataRange().getValues();
            for (let d = depositData.length - 1; d >= 1; d--) {
              const note = (depositData[d][3] || '').toString(); // Column D = Note
              if (note.indexOf(baseOrderNumber) !== -1) {
                depositsSheet.deleteRow(d + 1);
                Logger.log('deleteOrderData: Deleted deposit for order ' + baseOrderNumber);
                break;
              }
            }
          }

          // Delete matching discount expense (note is 'Discount - <orderIds>' containing base order number)
          const expensesSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.EXPENSES);
          if (expensesSheet) {
            const expenseData = expensesSheet.getDataRange().getValues();
            for (let e = expenseData.length - 1; e >= 1; e--) {
              const note = (expenseData[e][4] || '').toString(); // Column E = Note
              if (note.indexOf(baseOrderNumber) !== -1) {
                expensesSheet.deleteRow(e + 1);
                Logger.log('deleteOrderData: Deleted discount expense for order ' + baseOrderNumber);
                break;
              }
            }
          }
        }
      } catch (cascadeError) {
        Logger.log('deleteOrderData: Warning - cascade delete failed: ' + cascadeError.toString());
      }
    }

    Logger.log("deleteOrderData: Successfully deleted row " + rowIndex + " by admin " + params.username + 
               " - Order: " + params.orderNumber);
    
    return {
      success: true,
      message: 'Order deleted successfully',
      deletedRowIndex: rowIndex,
      orderNumber: params.orderNumber
    };

  } catch (error) {
    Logger.log("deleteOrderData error: " + error.toString());
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Bulk update multiple order rows at once
 * changes: array of { rowIndex, qty, price, total, payment }
 */
function bulkUpdateOrders(params) {
  try {
    requireAdminOrdersSession_(params);

    var changes = params.changes;
    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      throw new Error('No changes provided');
    }

    var ordersSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ORDERS);
    if (!ordersSheet) {
      throw new Error('Orders sheet not found');
    }

    // Column indices (fixed)
    var COL_QTY = 4;       // D
    var COL_PRICE = 5;     // E
    var COL_PAYMENT = 6;   // F
    var COL_TOTAL = 7;     // G

    var updated = 0;
    var errors = [];

    for (var c = 0; c < changes.length; c++) {
      var ch = changes[c];
      try {
        var row = ch.rowIndex;
        if (row < 2) continue;

        if (ch.qty !== undefined) {
          ordersSheet.getRange(row, COL_QTY).setValue(ch.qty);
        }
        if (ch.price !== undefined) {
          ordersSheet.getRange(row, COL_PRICE).setValue(ch.price);
        }
        if (ch.total !== undefined) {
          ordersSheet.getRange(row, COL_TOTAL).setValue(ch.total);
        }
        updated++;
      } catch (rowErr) {
        errors.push('Row ' + ch.rowIndex + ': ' + rowErr.toString());
      }
    }

    return {
      success: true,
      updated: updated,
      total: changes.length,
      errors: errors
    };
  } catch (error) {
    Logger.log('bulkUpdateOrders error: ' + error.toString());
    return { success: false, error: error.message };
  }
}

function deleteOrderDataSecure(params) {
  // Extract original parameters from SecurityWrapper enhanced object
  const originalParams = extractOriginalParams(params);
  const result = deleteOrderData(originalParams);
  // Rows were removed from these sheets: the cash warehouse must re-read them.
  if (result && result.success && typeof CashWarehouse !== 'undefined') CashWarehouse.markForRebuild(['ORDERS', 'DEPOSITS', 'EXPENSES']);
  return result;
}

function bulkUpdateOrdersSecure(params) {
  const originalParams = extractOriginalParams(params);
  const result = bulkUpdateOrders(originalParams);
  if (result && result.success && typeof CashWarehouse !== 'undefined') CashWarehouse.markForRebuild(['ORDERS']);
  return result;
}

function getOutletsForAdmin(params) {
  try {
    if (!params.deviceId || !params.username) {
      throw new Error('Authentication parameters required');
    }

    const session = getUserSessionEnhanced(params.deviceId, params.username);
    if (!session || session.username !== params.username) {
      throw new Error('Invalid user session');
    }

    var outletSet = {};

    // Outlets master sheet
    try {
      var sheetOutlets = getOutlets();
      (sheetOutlets || []).forEach(function(o) {
        if (o && o.name) outletSet[String(o.name).trim()] = true;
      });
    } catch (sheetErr) {
      Logger.log('getOutletsForAdmin: Outlets sheet error: ' + sheetErr);
    }

    // Distinct outlets from Orders sheet
    const ordersSheet = getGlobalSpreadsheet().getSheetByName(SHEETS.ORDERS);
    if (ordersSheet && ordersSheet.getLastRow() > 1) {
      const ordersData = ordersSheet.getDataRange().getValues();
      const headers = ordersData[0].map(function(h) { return (h || '').toString().trim().toLowerCase(); });
      var outletColIndex = headers.findIndex(function(h) { return h === 'outlet'; });
      if (outletColIndex < 0) {
        outletColIndex = headers.findIndex(function(h) { return h.indexOf('outlet') >= 0; });
      }
      if (outletColIndex < 0) outletColIndex = 8;

      for (let i = 1; i < ordersData.length; i++) {
        const outlet = ordersData[i][outletColIndex];
        if (outlet) outletSet[String(outlet).trim()] = true;
      }
    }

    if (session.outlet) outletSet[String(session.outlet).trim()] = true;
    if (params.outlet) outletSet[String(params.outlet).trim()] = true;

    var list = Object.keys(outletSet).filter(Boolean).sort();
    return {
      success: true,
      outlets: list,
      data: list.map(function(name) { return { name: name }; })
    };

  } catch (error) {
    Logger.log("getOutletsForAdmin error: " + error.toString());
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Secure wrapper functions that use SecurityWrapper pattern
 */
function getOrdersForAdminSecure(params) {
  try {
    Logger.log("getOrdersForAdminSecure: Received params: " + JSON.stringify(params));
    
    // Extract original parameters from SecurityWrapper enhanced object
    const originalParams = extractOriginalParams(params);
    
    Logger.log("getOrdersForAdminSecure: Extracted original params: " + JSON.stringify(originalParams));
    
    const result = getOrdersForAdmin(originalParams);
    
    Logger.log("getOrdersForAdminSecure: Result: " + JSON.stringify(result));
    
    return result;
  } catch (error) {
    Logger.log("getOrdersForAdminSecure: Error: " + error.toString());
    return {
      success: false,
      error: error.message
    };
  }
}

function updateOrderDataSecure(params) {
  // Extract original parameters from SecurityWrapper enhanced object
  const originalParams = extractOriginalParams(params);
  return updateOrderData(originalParams);
}

function getOutletsForAdminSecure(params) {
  try {
    Logger.log("getOutletsForAdminSecure: Received params: " + JSON.stringify(params));
    
    // Extract original parameters from SecurityWrapper enhanced object
    const originalParams = extractOriginalParams(params);
    
    Logger.log("getOutletsForAdminSecure: Extracted original params: " + JSON.stringify(originalParams));
    
    const result = getOutletsForAdmin(originalParams);
    
    Logger.log("getOutletsForAdminSecure: Result: " + JSON.stringify(result));
    
    return result;
  } catch (error) {
    Logger.log("getOutletsForAdminSecure: Error: " + error.toString());
    return {
      success: false,
      error: error.message
    };
  }
}

// Test function to verify basic functionality
function testAdminConnection() {
  Logger.log("testAdminConnection: Function called successfully");
  return {
    success: true,
    message: "Test connection successful",
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// Printer Configuration (per-outlet)
// Sheet: Printers — Outlet | PrinterName | PrinterType | UpdatedBy | UpdatedAt | AutoPrint | DrawerPin | DrawerUnlockPin | DrawerPinActiveUntil
// ============================================================

var DRAWER_UNLOCK_MINUTES = 5;

function _parseSheetDate_(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  var d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function _findPrinterRowIndex_(sheet, outlet) {
  var data = sheet.getDataRange().getValues();
  var o = (outlet || '').toString().trim();
  for (var i = 1; i < data.length; i++) {
    if ((data[i][0] || '').toString().trim() === o) return i + 1;
  }
  return -1;
}

function _drawerUnlockCacheKey_(username, outlet) {
  return 'drawer_ul_' + (outlet || 'ALL').toString().trim().toUpperCase() + '_' + (username || '').toString().trim().toUpperCase();
}

/** One pending drawer open per outlet after PIN validation (single use). */
function _drawerPendingOpenKey_(outlet) {
  return 'drawer_pending_' + (outlet || 'ALL').toString().trim().toUpperCase();
}

function _deactivateDrawerPinWindow_(outlet) {
  var sheet = ensurePrintersSheet_();
  var rowNum = _findPrinterRowIndex_(sheet, outlet);
  if (rowNum > 1) {
    sheet.getRange(rowNum, 9).setValue('');
  }
}

function _assertDrawerPendingOpen_(username, outlet) {
  var pending = CacheService.getScriptCache().get(_drawerPendingOpenKey_(outlet));
  if (!pending || pending.toString().trim().toUpperCase() !== (username || '').toString().trim().toUpperCase()) {
    throw new Error('Not authorized. Enter the drawer PIN.');
  }
}

function _finalizeDrawerOpen_(username, outlet) {
  _assertDrawerPendingOpen_(username, outlet);
  CacheService.getScriptCache().remove(_drawerPendingOpenKey_(outlet));
  _deactivateDrawerPinWindow_(outlet);
}

function _resolveDrawerOutlet_(params, session) {
  var outlet = (params.outlet || session.outlet || '').toString().trim();
  if (typeof resolveUserOutlet_ === 'function' && session.username) {
    outlet = resolveUserOutlet_(session.username, outlet);
  }
  if (!outlet) throw new Error('Outlet is required');
  return outlet;
}

function _readDrawerUnlockFields_(sheet, rowNum) {
  if (rowNum < 2) {
    return { drawerUnlockPin: '', drawerPinActiveUntil: null };
  }
  var pin = sheet.getRange(rowNum, 8).getValue();
  var until = sheet.getRange(rowNum, 9).getValue();
  return {
    drawerUnlockPin: (pin == null ? '' : String(pin)).trim(),
    drawerPinActiveUntil: _parseSheetDate_(until)
  };
}

function _ensureDrawerUnlockRow_(sheet, outlet, username) {
  var rowNum = _findPrinterRowIndex_(sheet, outlet);
  var now = new Date();
  if (rowNum > 0) return rowNum;
  sheet.appendRow([outlet, '', 'bluetooth', username || '', now, 'N', 'both', '', '']);
  return sheet.getLastRow();
}

function parseAutoPrintFlag_(value) {
  var v = (value == null ? '' : String(value)).trim().toUpperCase();
  return v === 'Y' || v === 'YES' || v === 'TRUE' || v === '1';
}

/** Cash drawer RJ11 pin: '0' (pin 2), '1' (pin 5), or 'both'. */
function parseDrawerPinMode_(value) {
  var v = (value == null ? '' : String(value)).trim().toLowerCase();
  if (v === '0' || v === 'pin2' || v === 'pin 2' || v === '2') return '0';
  if (v === '1' || v === 'pin5' || v === 'pin 5' || v === '5') return '1';
  return 'both';
}

function ensurePrintersHeaders_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var hasAutoPrint = false;
  var hasDrawerPin = false;
  var hasDrawerUnlockPin = false;
  var hasDrawerPinActiveUntil = false;
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim().toLowerCase();
    if (h === 'autoprint') hasAutoPrint = true;
    if (h === 'drawerpin' || h === 'drawer pin' || h === 'cash drawer pin') hasDrawerPin = true;
    if (h === 'drawerunlockpin' || h === 'drawer unlock pin') hasDrawerUnlockPin = true;
    if (h === 'drawerpinactiveuntil' || h === 'drawer pin active until') hasDrawerPinActiveUntil = true;
  }
  if (!hasAutoPrint) {
    sheet.getRange(1, 6).setValue('AutoPrint');
    sheet.getRange(1, 6).setFontWeight('bold');
  }
  if (!hasDrawerPin) {
    var pinCol = hasAutoPrint ? 7 : 7;
    sheet.getRange(1, pinCol).setValue('DrawerPin');
    sheet.getRange(1, pinCol).setFontWeight('bold');
  }
  if (!hasDrawerUnlockPin) {
    sheet.getRange(1, 8).setValue('DrawerUnlockPin');
    sheet.getRange(1, 8).setFontWeight('bold');
  }
  if (!hasDrawerPinActiveUntil) {
    sheet.getRange(1, 9).setValue('DrawerPinActiveUntil');
    sheet.getRange(1, 9).setFontWeight('bold');
  }
}

function ensurePrintersSheet_() {
  var ss = getGlobalSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PRINTERS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.PRINTERS);
    sheet.appendRow(['Outlet', 'PrinterName', 'PrinterType', 'UpdatedBy', 'UpdatedAt', 'AutoPrint', 'DrawerPin']);
    sheet.getRange('1:1').setFontWeight('bold');
    Logger.log('Created Printers sheet');
  } else {
    ensurePrintersHeaders_(sheet);
  }
  return sheet;
}

/**
 * Get printer config for an outlet
 */
function getOutletPrinter(params) {
  try {
    var outlet = (params.outlet || '').toString().trim();
    if (!outlet) throw new Error('Outlet is required');

    var sheet = ensurePrintersSheet_();
    var data = sheet.getDataRange().getValues();
    Logger.log('getOutletPrinter: Looking for "' + outlet + '" in ' + (data.length - 1) + ' rows');

    for (var i = 1; i < data.length; i++) {
      var sheetOutlet = (data[i][0] || '').toString().trim();
      Logger.log('getOutletPrinter: Row ' + i + ' outlet="' + sheetOutlet + '" match=' + (sheetOutlet === outlet));
      if (sheetOutlet === outlet) {
        // Convert updatedAt to string to avoid GAS serialization issues with Date objects
        var updatedAt = data[i][4];
        if (updatedAt instanceof Date) updatedAt = updatedAt.toISOString();
        return {
          success: true,
          printer: {
            outlet: String(data[i][0]),
            printerName: String(data[i][1] || ''),
            printerType: String(data[i][2] || 'bluetooth'),
            updatedBy: String(data[i][3] || ''),
            updatedAt: String(updatedAt || ''),
            autoPrint: parseAutoPrintFlag_(data[i][5]),
            drawerPin: parseDrawerPinMode_(data[i][6])
          }
        };
      }
    }
    Logger.log('getOutletPrinter: No printer found for outlet "' + outlet + '"');
    return { success: true, printer: null };
  } catch (e) {
    Logger.log('getOutletPrinter error: ' + e.toString());
    return { success: false, error: e.message };
  }
}

function getOutletPrinterSecure(params) {
  try {
    var orig = extractOriginalParams(params);
    var result = getOutletPrinter(orig);
    Logger.log('getOutletPrinterSecure result: ' + JSON.stringify(result));
    return result || { success: false, error: 'No result from getOutletPrinter' };
  } catch (e) {
    Logger.log('getOutletPrinterSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/**
 * Save printer config for an outlet (admin only)
 */
function saveOutletPrinter(params) {
  try {
    if (!params.deviceId || !params.username) throw new Error('Authentication required');
    var session = getUserSessionEnhanced(params.deviceId, params.username);
    if (!session || session.username !== params.username) throw new Error('Invalid session');

    var outlet = params.outlet;
    var printerName = params.printerName;
    if (!outlet) throw new Error('Outlet is required');
    if (!printerName) throw new Error('Printer name is required');

    var sheet = ensurePrintersSheet_();
    var data = sheet.getDataRange().getValues();
    var existingRow = -1;

    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === outlet) {
        existingRow = i + 1; // 1-based for sheet
        break;
      }
    }

    var now = new Date();
    if (existingRow > 0) {
      sheet.getRange(existingRow, 2).setValue(printerName);
      sheet.getRange(existingRow, 3).setValue(params.printerType || 'bluetooth');
      sheet.getRange(existingRow, 4).setValue(params.username);
      sheet.getRange(existingRow, 5).setValue(now);
    } else {
      sheet.appendRow([outlet, printerName, params.printerType || 'bluetooth', params.username, now, 'N']);
    }

    Logger.log('Printer saved for outlet ' + outlet + ': ' + printerName);
    return { success: true, message: 'Printer saved for ' + outlet };
  } catch (e) {
    Logger.log('saveOutletPrinter error: ' + e.toString());
    return { success: false, error: e.message };
  }
}

function saveOutletPrinterSecure(params) {
  var orig = extractOriginalParams(params);
  return saveOutletPrinter(orig);
}

/**
 * Save auto-print setting for an outlet (admin only).
 */
function saveOutletAutoPrint(params) {
  try {
    if (!params.deviceId || !params.username) throw new Error('Authentication required');
    var session = getUserSessionEnhanced(params.deviceId, params.username);
    if (!session || session.username !== params.username) throw new Error('Invalid session');

    var outlet = (params.outlet || '').toString().trim();
    if (!outlet) throw new Error('Outlet is required');

    var sheet = ensurePrintersSheet_();
    var data = sheet.getDataRange().getValues();
    var existingRow = -1;
    for (var i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().trim() === outlet) {
        existingRow = i + 1;
        break;
      }
    }

    var autoPrintVal = params.autoPrint ? 'Y' : 'N';
    var now = new Date();
    if (existingRow > 0) {
      sheet.getRange(existingRow, 6).setValue(autoPrintVal);
      sheet.getRange(existingRow, 4).setValue(params.username);
      sheet.getRange(existingRow, 5).setValue(now);
    } else {
      sheet.appendRow([outlet, '', 'bluetooth', params.username, now, autoPrintVal]);
    }

    Logger.log('Auto-print ' + autoPrintVal + ' saved for outlet ' + outlet);
    return { success: true, autoPrint: params.autoPrint === true, message: 'Auto-print setting saved for ' + outlet };
  } catch (e) {
    Logger.log('saveOutletAutoPrint error: ' + e.toString());
    return { success: false, error: e.message };
  }
}

function saveOutletAutoPrintSecure(params) {
  var orig = extractOriginalParams(params);
  return saveOutletAutoPrint(orig);
}

/**
 * Save cash drawer pin mode for an outlet (admin only).
 * drawerPin: '0' | '1' | 'both'
 */
function saveOutletDrawerPin(params) {
  try {
    if (!params.deviceId || !params.username) throw new Error('Authentication required');
    var session = getUserSessionEnhanced(params.deviceId, params.username);
    if (!session || session.username !== params.username) throw new Error('Invalid session');

    var outlet = (params.outlet || '').toString().trim();
    if (!outlet) throw new Error('Outlet is required');

    var drawerPin = parseDrawerPinMode_(params.drawerPin);
    var sheet = ensurePrintersSheet_();
    var data = sheet.getDataRange().getValues();
    var existingRow = -1;
    for (var i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().trim() === outlet) {
        existingRow = i + 1;
        break;
      }
    }

    var now = new Date();
    if (existingRow > 0) {
      sheet.getRange(existingRow, 7).setValue(drawerPin);
      sheet.getRange(existingRow, 4).setValue(params.username);
      sheet.getRange(existingRow, 5).setValue(now);
    } else {
      sheet.appendRow([outlet, '', 'bluetooth', params.username, now, 'N', drawerPin]);
    }

    Logger.log('Drawer pin ' + drawerPin + ' saved for outlet ' + outlet);
    return { success: true, drawerPin: drawerPin, message: 'Drawer pin saved for ' + outlet };
  } catch (e) {
    Logger.log('saveOutletDrawerPin error: ' + e.toString());
    return { success: false, error: e.message };
  }
}

function saveOutletDrawerPinSecure(params) {
  var orig = extractOriginalParams(params);
  return saveOutletDrawerPin(orig);
}

/**
 * Admin: set staff PIN for manual cash drawer open (stored per outlet).
 */
function saveDrawerUnlockPinSecure(params) {
  try {
    var session = requireAdmin_(params);
    var orig = extractOriginalParams(params);
    var outlet = (orig.outlet || '').toString().trim();
    if (!outlet) throw new Error('Outlet is required');
    var pin = (orig.pin || '').toString().trim();
    if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4–8 digits');

    var sheet = ensurePrintersSheet_();
    var rowNum = _ensureDrawerUnlockRow_(sheet, outlet, session.username);
    var now = new Date();
    sheet.getRange(rowNum, 8).setValue(pin);
    sheet.getRange(rowNum, 4).setValue(session.username);
    sheet.getRange(rowNum, 5).setValue(now);

    writeAuditLog_(session.username, 'DRAWER_PIN_SET', outlet, JSON.stringify({ outlet: outlet }), outlet);
    return sanitizeForClient({ success: true, message: 'Drawer unlock PIN saved for ' + outlet });
  } catch (e) {
    Logger.log('saveDrawerUnlockPinSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/**
 * Admin: activate drawer unlock PIN window for 5 minutes.
 */
function activateDrawerUnlockPinSecure(params) {
  try {
    var session = requireAdmin_(params);
    var orig = extractOriginalParams(params);
    var outlet = (orig.outlet || '').toString().trim();
    if (!outlet) throw new Error('Outlet is required');

    var sheet = ensurePrintersSheet_();
    var rowNum = _findPrinterRowIndex_(sheet, outlet);
    if (rowNum < 2) throw new Error('Configure a printer row for this outlet first');

    var fields = _readDrawerUnlockFields_(sheet, rowNum);
    if (!fields.drawerUnlockPin) throw new Error('Set a drawer unlock PIN first');

    var activeUntil = new Date(Date.now() + DRAWER_UNLOCK_MINUTES * 60 * 1000);
    var now = new Date();
    sheet.getRange(rowNum, 9).setValue(activeUntil);
    sheet.getRange(rowNum, 4).setValue(session.username);
    sheet.getRange(rowNum, 5).setValue(now);

    writeAuditLog_(
      session.username,
      'DRAWER_PIN_ACTIVATED',
      outlet,
      JSON.stringify({ activeUntil: activeUntil.toISOString(), minutes: DRAWER_UNLOCK_MINUTES }),
      outlet
    );
    return sanitizeForClient({
      success: true,
      activeUntil: activeUntil.toISOString(),
      message: 'Drawer PIN active for one use within ' + DRAWER_UNLOCK_MINUTES + ' minutes'
    });
  } catch (e) {
    Logger.log('activateDrawerUnlockPinSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Admin: drawer unlock status for selected outlet (PIN never returned). */
function getDrawerUnlockAdminSecure(params) {
  try {
    requireAdmin_(params);
    var orig = extractOriginalParams(params);
    var outlet = (orig.outlet || '').toString().trim();
    if (!outlet) throw new Error('Outlet is required');

    var sheet = ensurePrintersSheet_();
    var rowNum = _findPrinterRowIndex_(sheet, outlet);
    var fields = _readDrawerUnlockFields_(sheet, rowNum);
    var activeUntil = fields.drawerPinActiveUntil;
    var pinWindowActive = !!(activeUntil && activeUntil.getTime() > Date.now());

    return sanitizeForClient({
      success: true,
      pinConfigured: !!fields.drawerUnlockPin,
      pinWindowActive: pinWindowActive,
      activeUntil: pinWindowActive ? activeUntil.toISOString() : null
    });
  } catch (e) {
    Logger.log('getDrawerUnlockAdminSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Staff: check whether admin activated PIN window (single use until opened). */
function getDrawerUnlockStatusSecure(params) {
  try {
    var session = requireAuth_(params);
    var orig = extractOriginalParams(params);
    var outlet = _resolveDrawerOutlet_(orig, session);

    var sheet = ensurePrintersSheet_();
    var rowNum = _findPrinterRowIndex_(sheet, outlet);
    var fields = _readDrawerUnlockFields_(sheet, rowNum);
    var activeUntil = fields.drawerPinActiveUntil;
    var pinWindowActive = !!(activeUntil && activeUntil.getTime() > Date.now());

    var pendingUser = CacheService.getScriptCache().get(_drawerPendingOpenKey_(outlet));
    var pendingOpen = !!pendingUser;
    var pendingForYou = pendingOpen &&
      pendingUser.toString().trim().toUpperCase() === session.username.toString().trim().toUpperCase();

    return sanitizeForClient({
      success: true,
      pinConfigured: !!fields.drawerUnlockPin,
      pinWindowActive: pinWindowActive,
      activeUntil: pinWindowActive ? activeUntil.toISOString() : null,
      pendingOpen: pendingOpen,
      pendingForYou: pendingForYou
    });
  } catch (e) {
    Logger.log('getDrawerUnlockStatusSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Staff: validate PIN once during active window; grants one pending open for this user. */
function validateDrawerUnlockPinSecure(params) {
  try {
    var session = requireAuth_(params);
    var orig = extractOriginalParams(params);
    var outlet = _resolveDrawerOutlet_(orig, session);
    var pin = (orig.pin || '').toString().trim();

    var sheet = ensurePrintersSheet_();
    var rowNum = _findPrinterRowIndex_(sheet, outlet);
    var fields = _readDrawerUnlockFields_(sheet, rowNum);
    if (!fields.drawerUnlockPin) throw new Error('Drawer unlock PIN is not configured');

    var activeUntil = fields.drawerPinActiveUntil;
    if (!activeUntil || activeUntil.getTime() <= Date.now()) {
      throw new Error('Drawer PIN is not active. Ask admin to activate it.');
    }
    if (pin !== fields.drawerUnlockPin) {
      writeAuditLog_(session.username, 'DRAWER_PIN_FAIL', outlet, JSON.stringify({ reason: 'invalid_pin' }), outlet);
      throw new Error('Invalid PIN');
    }

    var pendingKey = _drawerPendingOpenKey_(outlet);
    var cache = CacheService.getScriptCache();
    var pendingUser = cache.get(pendingKey);
    if (pendingUser &&
        pendingUser.toString().trim().toUpperCase() !== session.username.toString().trim().toUpperCase()) {
      throw new Error('Drawer open already in progress at this outlet.');
    }

    cache.put(pendingKey, session.username, 120);

    writeAuditLog_(
      session.username,
      'DRAWER_PIN_OK',
      outlet,
      JSON.stringify({ singleUse: true }),
      outlet
    );
    return sanitizeForClient({
      success: true,
      singleUse: true
    });
  } catch (e) {
    Logger.log('validateDrawerUnlockPinSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/** Staff: verify pending single-use authorization before opening drawer. */
function authorizeCashDrawerOpenSecure(params) {
  try {
    var session = requireAuth_(params);
    var orig = extractOriginalParams(params);
    var outlet = _resolveDrawerOutlet_(orig, session);
    _assertDrawerPendingOpen_(session.username, outlet);
    return sanitizeForClient({ success: true, authorized: true, singleUse: true });
  } catch (e) {
    Logger.log('authorizeCashDrawerOpenSecure error: ' + e.toString());
    return { success: false, error: e.message || e.toString() };
  }
}

/**
 * Delete printer config for an outlet (admin only)
 */
function deleteOutletPrinter(outlet) {
  if (!outlet) throw new Error('Outlet is required');

  var sheet = ensurePrintersSheet_();
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === outlet) {
      sheet.deleteRow(i + 1);
      Logger.log('Printer deleted for outlet: ' + outlet);
      return { success: true, message: 'Printer removed for ' + outlet };
    }
  }
  return { success: true, message: 'No printer was configured for ' + outlet };
}

function deleteOutletPrinterSecure(params) {
  try {
    var authContext = params._authContext;
    if (!authContext || !authContext.deviceId || !authContext.username) {
      return { success: false, error: 'Authentication required' };
    }
    var session = getUserSessionEnhanced(authContext.deviceId, authContext.username);
    if (!session || session.username !== authContext.username) {
      return { success: false, error: 'Invalid session' };
    }
    var orig = extractOriginalParams(params);
    return deleteOutletPrinter(orig.outlet);
  } catch (e) {
    Logger.log('deleteOutletPrinterSecure error: ' + e.toString());
    return { success: false, error: e.message };
  }
}

/**
 * Get all printer configs (admin view)
 */
function getAllPrinters() {
  var sheet = ensurePrintersSheet_();
  var data = sheet.getDataRange().getValues();
  var printers = [];

  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      printers.push({
        outlet: data[i][0],
        printerName: data[i][1],
        printerType: data[i][2] || 'bluetooth',
        updatedBy: data[i][3],
        updatedAt: data[i][4] ? new Date(data[i][4]).toLocaleString() : '',
        autoPrint: parseAutoPrintFlag_(data[i][5]),
        drawerPin: parseDrawerPinMode_(data[i][6]),
        drawerUnlockPinSet: !!(data[i][7] && String(data[i][7]).trim()),
        drawerPinActiveUntil: (function() {
          var d = _parseSheetDate_(data[i][8]);
          return d ? d.toISOString() : '';
        })()
      });
    }
  }
  return { success: true, printers: printers };
}

function getAllPrintersSecure(params) {
  try {
    var authContext = params._authContext;
    if (!authContext || !authContext.deviceId || !authContext.username) {
      return { success: false, error: 'Authentication required' };
    }
    var session = getUserSessionEnhanced(authContext.deviceId, authContext.username);
    if (!session || session.username !== authContext.username) {
      return { success: false, error: 'Invalid session' };
    }
    return getAllPrinters();
  } catch (e) {
    Logger.log('getAllPrintersSecure error: ' + e.toString());
    return { success: false, error: e.message };
  }
}

/**
 * Helper function to extract original parameters from SecurityWrapper enhanced object
 */
function extractOriginalParams(params) {
  Logger.log("extractOriginalParams: Input params type: " + typeof params);
  Logger.log("extractOriginalParams: Input params: " + JSON.stringify(params));
  
  if (typeof params === 'string') {
    // If it's a string, parse it (backward compatibility)
    try {
      const parsed = JSON.parse(params);
      Logger.log("extractOriginalParams: Parsed from string: " + JSON.stringify(parsed));
      return parsed;
    } catch (e) {
      Logger.log("extractOriginalParams: JSON parse error: " + e.toString());
      throw new Error('Invalid JSON parameters: ' + params);
    }
  } else if (typeof params === 'object' && params !== null) {
    // If it's an object (SecurityWrapper format), extract the original params
    const { _authContext, ...originalParams } = params;
    
    Logger.log("extractOriginalParams: Auth context: " + JSON.stringify(_authContext));
    Logger.log("extractOriginalParams: Original params before auth: " + JSON.stringify(originalParams));
    
    // Add authentication context to original params for the main functions
    if (_authContext) {
      originalParams.deviceId = _authContext.deviceId;
      originalParams.username = _authContext.username;
      if (!originalParams.outlet && _authContext.outlet) {
        originalParams.outlet = _authContext.outlet;
      }
    }
    
    Logger.log("extractOriginalParams: Final params: " + JSON.stringify(originalParams));
    return originalParams;
  } else {
    Logger.log("extractOriginalParams: Invalid params format, type: " + typeof params);
    throw new Error('Invalid parameters format');
  }
}
