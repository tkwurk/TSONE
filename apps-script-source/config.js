/** Resolve spreadsheet ID for editor, triggers, and web app (active sheet may be null in /exec). */
function resolveSpreadsheetId_() {
  var props = PropertiesService.getScriptProperties();
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      var id = active.getId();
      // This runs at the start of EVERY execution: only write when it changed.
      if (props.getProperty('SPREADSHEET_ID') !== id) props.setProperty('SPREADSHEET_ID', id);
      return id;
    }
  } catch (e) {
    Logger.log('resolveSpreadsheetId_ active spreadsheet: ' + e.message);
  }
  return props.getProperty('SPREADSHEET_ID') || '';
}

var SPREADSHEET_ID = resolveSpreadsheetId_();

/** Bump when sheet layout or required headers change (Snowbee A2.4). */
var SCHEMA_VERSION = '2.4.0';

var SHEETS = {
  PRODUCTS: "Products",
  ORDERS: "Orders",
  DEPOSITS: "Deposits",
  EXPENSES: "Expenses",
  EXPENSE_ACCOUNTS: "ExpenseAccounts",
  PAYMENT_SOURCES: "PaymentSources",
  DEPOSIT_ACCOUNTS: "DepositAccounts",
  PURCHASES: "Purchases",
  SUPPLIERS: "Suppliers",
  INVESTMENTS: "Investments",
  ACCOUNTS: "Accounts",
  USERS: "Users",
  PEOPLE: "People",
  AUDIT_LOG: "AuditLog",
  INVENTORY_CONSUMPTION: "Inventory_Consumption",
  PRINTERS: "Printers",
  EMPLOYEES: "employees",
  ATTENDANCE: "attendance",
  SMART_PICKS: "SmartPicks",
  MISSED_ORDERS: "MissedOrders",
  CHECKLIST_MASTER: "CHECKLISTMASTER",
  CHECKLIST_RESPONSES: "CLRESPONSES",
  CHECKLIST_DEFS: "CHECKLISTDEFS",
  KITCHEN_COOKING: "Kitchen_Cooking",
  KITCHEN_COOK_REQUESTS: "Kitchen_CookRequests",
  PAYMENT_METHOD: "PaymentMethod",
  TAB_ACCESS: "TabAccess",
  TUTORIALS: "Tutorials",
  OUTLETS: "Outlets",
  BOM: "BOM",
  BOM_USAGE: "BOM_Usage",
  PRODUCT_OPTIONS: "ProductOptions",
  PROD_OPTIONS: "ProdOptions",
  PRODUCT_VARIANTS: "ProductVariants",
  CONSUMPTION_REPORT: "Consumption_Report",
  CONSUMPTION_REPORT_DETAIL: "Consumption_Report_Detail",
  CONSUMPTION_REPORT_BOM: "Consumption_Report_BOM",
  STOCK_HISTORY: "Stock_History"
};

/**
 * Shared header-matching patterns (Snowbee A3.2).
 * Used when sheet headers vary slightly across locales or legacy rows.
 */
var COLUMN_PATTERNS = {
  DATE: /timestamp|tanggal|waktu|date|time/i,
  TIMESTAMP: /Timestamp|tanggal|waktu|date|time/i,
  TOTAL: /total|amount|grand ?total|total sales|grand/i,
  PURCHASE_TOTAL: /amount|total|qty \* price|grand ?total/i,
  AMOUNT: /amount|total|jumlah/i,
  OUTLET: /outlet/i,
  CATEGORY: /category|kategori/i,
  PRODUCT_NAME: /product ?name|product|item|name/i,
  PRODUCT_CODE: /product ?code|^code$/i,
  SUPPLIER: /supplier|vendor/i,
  QTY: /qty|quantity|jumlah/i,
  ACCOUNT_NAME: /account\s*name/i,
  ACCOUNT_TYPE: /^type$/i
};

/**
 * Column definitions per sheet (Snowbee A3.2).
 * - col: fixed 0-based index (fallback when header row missing or stable layout)
 * - names: exact header labels to match (case-insensitive)
 * - pattern: regex from COLUMN_PATTERNS or custom
 */
var COLUMNS = {
  USERS: {
    USERNAME: { col: 0, names: ['username'] },
    CODE: { col: 1, names: ['code'] },
    OUTLET: { col: 2, names: ['outlet'] },
    ALLOWED_TABS: { col: 4, names: ['allowedTabs', 'allowed tabs'] }
  },
  PEOPLE: {
    PERSON_ID: { col: 0, names: ['person_id', 'Person ID'] },
    DISPLAY_NAME: { col: 1, names: ['display_name', 'Display Name'] },
    PIN_CODE: { col: 2, names: ['pin_code', 'PIN', 'pin', 'code'] },
    OUTLET: { col: 3, names: ['outlet'] },
    ROLE: { col: 4, names: ['role'] },
    EMAIL: { col: 5, names: ['email'] },
    DEPARTMENT: { col: 6, names: ['department'] },
    POSITION: { col: 7, names: ['position'] },
    EMPLOYMENT_TYPE: { col: 8, names: ['employment_type'] },
    ACTIVE: { col: 9, names: ['active'] },
    CAN_LOGIN: { col: 10, names: ['can_login'] },
    EXTRA_TABS: { col: 11, names: ['extra_tabs'] },
    DENIED_TABS: { col: 12, names: ['denied_tabs'] }
  },
  ORDERS: {
    TIMESTAMP: { col: 0, names: ['Timestamp', 'timestamp'] },
    ORDER_NUMBER: { col: 1, names: ['Order Number', 'OrderNumber'] },
    PRODUCT_NAME: { col: 2, names: ['Product Name', 'ProductName', 'Name'] },
    QTY: { col: 3, names: ['Quantity', 'Qty'] },
    PRICE: { col: 4, names: ['Price'] },
    PAYMENT: { col: 5, names: ['Payment', 'Payment Method'] },
    TOTAL: { col: 6, names: ['Total'] },
    CATEGORY: { col: 7, names: ['Category'] },
    OUTLET: { col: 8, names: ['Outlet'] },
    USERNAME: { col: 9, names: ['Username'] },
    PRODUCT_CODE: { col: 10, names: ['Product Code', 'ProductCode'] },
    NAV_CATEGORY: { col: 11, names: ['NavCategory', 'Nav Category'] }
  },
  DEPOSITS: {
    DATE: { col: 0, names: ['Date'] },
    AMOUNT: { col: 1, names: ['Amount'] },
    ACCOUNT: { col: 2, names: ['Account'] },
    NOTE: { col: 3, names: ['Note'] },
    USERNAME: { col: 4, names: ['Username'] },
    OUTLET: { col: 5, names: ['Outlet'] },
    PAYMENT_METHOD: { col: 6, names: ['PaymentMethod', 'Payment Method'] }
  },
  EXPENSES: {
    DATE: { col: 0, names: ['Date'] },
    AMOUNT: { col: 1, names: ['Amount'] },
    ACCOUNT: { col: 2, names: ['Account'] },
    PAYMENT: { col: 3, names: ['Payment'] },
    NOTE: { col: 4, names: ['Note'] },
    USERNAME: { col: 5, names: ['Username'] },
    OUTLET: { col: 6, names: ['Outlet'] }
  },
  ACCOUNTS: {
    NAME: { pattern: COLUMN_PATTERNS.ACCOUNT_NAME },
    TYPE: { pattern: COLUMN_PATTERNS.ACCOUNT_TYPE }
  },
  PAYMENT_SOURCES: {
    NAME: { col: 0, names: ['Payment Source', 'Source', 'Name'] }
  },
  PAYMENT_METHOD: {
    PN: { col: 0, names: ['PN'] },
    NAME: { col: 1, names: ['Payment Name'] },
    DESTINATION_ACCOUNT: { col: 2, names: ['Destination Account'] },
    STATUS: { col: 3, names: ['Status'] },
    OUTLET: { col: 4, names: ['Outlet'] },
    MODULE: { col: 5, names: ['Module'] },
    OPEN_DRAWER: { col: 6, names: ['Open Drawer', 'OpenDrawer', 'Cash Drawer'] },
    AUTO_DEPOSIT: { col: 7, names: ['Auto Deposit', 'AutoDeposit', 'Goes to Deposits'] }
  },
  CHECKLIST_DEFS: {
    ID: { col: 0, names: ['ID'] },
    NAME: { col: 1, names: ['Name'] },
    DESCRIPTION: { col: 2, names: ['Description'] },
    STATUS: { col: 3, names: ['Status'] },
    ASSIGNED_ROLES: { col: 4, names: ['Assigned Roles', 'AssignedRoles'] },
    REVIEWER_ROLES: { col: 5, names: ['Reviewer Roles', 'ReviewerRoles'] },
    OUTLETS: { col: 6, names: ['Outlets'] },
    SORT_ORDER: { col: 7, names: ['Sort Order', 'SortOrder', 'Order'] },
    CREATEDBY: { col: 8, names: ['CreatedBy', 'Created By'] },
    UPDATEDBY: { col: 9, names: ['UpdatedBy', 'Updated By'] },
    UPDATEDDATE: { col: 10, names: ['UpdatedDate', 'Updated Date'] }
  },
  EMPLOYEES: {
    EMPLOYEE_ID: { col: 0, names: ['employee_id'] },
    NAME: { col: 1, names: ['name'] },
    DEPARTMENT: { col: 2, names: ['department'] },
    POSITION: { col: 3, names: ['position'] },
    EMPLOYMENT_TYPE: { col: 4, names: ['employment_type'] },
    BASE_SALARY: { col: 5, names: ['base_salary'] },
    HOURLY_RATE: { col: 6, names: ['hourly_rate'] },
    INACTIVE_FLAG: { col: 8 }
  },
  TUTORIALS: {
    COURSE_ID: { col: 0, names: ['courseId', 'Course ID'] },
    DESCRIPTION: { col: 1, names: ['description', 'Description'] },
    CATEGORY: { col: 2, names: ['category', 'Category'] },
    SUPPLIER: { col: 3, names: ['supplier', 'Supplier'] },
    STATUS: { col: 4, names: ['status', 'Status'] },
    URL: { col: 5, names: ['url', 'URL'] }
  },
  PRINTERS: {
    OUTLET: { col: 0, names: ['Outlet'] },
    PRINTER_NAME: { col: 1, names: ['Printer Name', 'PrinterName'] },
    UPDATED_AT: { col: 4, names: ['Updated At', 'UpdatedAt'] },
    AUTO_PRINT: { col: 5, names: ['AutoPrint', 'Auto Print'] }
  },
  BOM: {
    BOM_ID: { col: 0, names: ['BOM Id', 'BOM ID', 'Bom Id'] },
    BOM_ITEM_ID: { col: 1, names: ['BOM Item Id', 'BOM Item ID', 'Bom Item Id'] },
    RECIPE_ITEM_CODE: { col: 2, names: ['Recipe Item Code', 'RecipeItemCode'] },
    ITEM_QUANTITY: { col: 3, names: ['Item Quantity', 'Item Qty', 'Quantity'] },
    UNIT_PRODUCT_CODE: { col: 4, names: ['Unit Product Code', 'UnitProductCode', 'Sell Product Code'] },
    STATUS: { col: 5, names: ['Status'] }
  }
};

/** Header row for empty-sheet bootstrap (order matches COLUMNS.*.col). */
var SHEET_HEADER_ROWS = {
  ORDERS: ['Timestamp', 'Order Number', 'Product Name', 'Quantity', 'Price', 'Payment', 'Total', 'Category', 'Outlet', 'Username', 'Product Code', 'NavCategory'],
  DEPOSITS: ['Date', 'Amount', 'Account', 'Note', 'Username', 'Outlet', 'PaymentMethod'],
  EXPENSES: ['Date', 'Amount', 'Account', 'Payment', 'Note', 'Username', 'Outlet'],
  EMPLOYEES: ['employee_id', 'name', 'department', 'position', 'employment_type', 'base_salary', 'hourly_rate'],
  PEOPLE: ['person_id', 'display_name', 'pin_code', 'outlet', 'role', 'email', 'department', 'position', 'employment_type', 'active', 'can_login', 'extra_tabs', 'denied_tabs'],
  ATTENDANCE: ['attendance_id', 'employee_id', 'date', 'start_time', 'end_time', 'work_hours', 'status'],
  BOM: ['BOM Id', 'BOM Item Id', 'Recipe Item Code', 'Item Quantity', 'Unit Product Code', 'Status'],
  BOM_USAGE: ['Base Unit Product Code', 'Flavor Unit Product Code', 'Recipe Item Code', 'Item Quantity', 'Status'],
  PRODUCT_OPTIONS: ['OptionCode', 'OptionGroupId', 'DisplayName', 'SortOrder', 'PriceAdjust', 'OptionType', 'Status'],
  PROD_OPTIONS: ['BaseProductCode', 'OptionGroupId', 'Required', 'SortOrder', 'Status'],
  PRODUCT_VARIANTS: ['VariantProductCode', 'BaseProductCode', 'OptionCode', 'DisplayName', 'Price', 'Status']
};

/**
 * Required column fields per sheet for startup validation (Snowbee A3.3).
 * Each field must resolve via COLUMNS + resolveColumnIndex on row 1.
 */
var SCHEMA_VALIDATION = {
  ORDERS: ['TIMESTAMP', 'ORDER_NUMBER', 'PRODUCT_NAME', 'QTY', 'PRICE', 'PAYMENT', 'TOTAL', 'OUTLET', 'USERNAME'],
  DEPOSITS: ['DATE', 'AMOUNT', 'ACCOUNT', 'USERNAME', 'OUTLET'],
  EXPENSES: ['DATE', 'AMOUNT', 'USERNAME', 'OUTLET'],
  USERS: ['USERNAME', 'CODE', 'OUTLET'],
  PEOPLE: ['PERSON_ID', 'PIN_CODE', 'OUTLET', 'ROLE'],
  ACCOUNTS: ['NAME', 'TYPE']
};

/** Sheets validated at startup: SHEETS key → COLUMNS key */
var VALIDATED_SHEETS = [
  { sheetKey: 'ORDERS', columnsKey: 'ORDERS' },
  { sheetKey: 'DEPOSITS', columnsKey: 'DEPOSITS' },
  { sheetKey: 'EXPENSES', columnsKey: 'EXPENSES' },
  { sheetKey: 'PEOPLE', columnsKey: 'PEOPLE' },
  { sheetKey: 'ACCOUNTS', columnsKey: 'ACCOUNTS' }
];