/**
 * Default tab sets per role (Snowbee B1).
 * Fallback only when TabAccess sheet is missing or a role row is absent.
 * Live mapping: edit TabAccess sheet (Role | Tabs | Description).
 */
var ROLE_DEFAULT_TABS = {  cashier: [
    'orders', 'salesSummary', 'stockReport', 'deposits',
    'inventoryConsumption', 'shiftReport', 'tutorials'
  ],
  supervisor: [
    'orders', 'salesSummary', 'stockReport', 'purchasing', 'purchasingReceive',
    'purchasingLocal', 'deposits', 'profitLoss', 'usageReport',
    'monthlySalesReport', 'inventoryConsumption', 'attendance', 'checklist', 'kitchenCooking', 'drawerTest', 'shiftReport', 'tutorials'
  ],
  manager: [
    'orders', 'salesSummary', 'stockReport', 'purchasing', 'purchasingReceive',
    'purchasingLocal', 'deposits', 'profitLoss', 'usageReport',
    'monthlySalesReport', 'inventoryConsumption', 'investments', 'attendance',
    'checklist', 'kitchenCooking', 'drawerTest', 'shiftReport', 'tutorials'
  ],
  admin: ['*'],
  chef: ['stockReport', 'inventoryConsumption', 'usageReport', 'kitchenCooking', 'tutorials'],
  readonly: [
    'salesSummary', 'profitLoss', 'usageReport', 'monthlySalesReport', 'tutorials'
  ]
};

var ALL_TAB_IDS = [
  'orders', 'salesSummary', 'stockReport', 'purchasing', 'purchasingReceive',
  'purchasingLocal', 'deposits', 'profitLoss', 'usageReport',
  'monthlySalesReport', 'inventoryConsumption', 'investments', 'tutorials',
  'adminOrders', 'attendance', 'checklist', 'kitchenCooking', 'drawerTest', 'shiftReport'
];

function normalizeRole_(role) {
  var r = (role || 'cashier').toString().trim().toLowerCase();
  if (r === 'kitchen') r = 'chef';
  var known = typeof getKnownRolesFromSheet_ === 'function'
    ? getKnownRolesFromSheet_()
    : Object.keys(ROLE_DEFAULT_TABS);
  if (known.indexOf(r) >= 0) return r;
  if (ROLE_DEFAULT_TABS[r]) return r;
  return 'cashier';
}

function getRoleDisplayKey_(role) {
  return 'role_' + normalizeRole_(role);
}