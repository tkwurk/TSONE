/**
 * App navigation model — mirrors the original ui_navigation.html tab set and
 * permission names (allowedTabs). `id` is the permission key used for role
 * gating; `ready` marks screens already migrated to the PWA.
 */
export interface NavItem {
  id: string
  labelKey: string
  icon: string
  ready?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'orders', labelKey: 'nav.orders', icon: '🧾', ready: true },
  { id: 'adminOrders', labelKey: 'nav.adminOrders', icon: '📋', ready: true },
  { id: 'salesSummary', labelKey: 'nav.salesSummary', icon: '💹', ready: true },
  { id: 'kitchenCooking', labelKey: 'nav.kitchenCooking', icon: '👨‍🍳', ready: true },
  { id: 'purchasing', labelKey: 'nav.purchasing', icon: '📦', ready: true },
  { id: 'purchasingReceive', labelKey: 'nav.purchasingReceive', icon: '📥', ready: true },
  { id: 'purchasingLocal', labelKey: 'nav.purchasingLocal', icon: '🏪', ready: true },
  { id: 'stockReport', labelKey: 'nav.stockReport', icon: '📊', ready: true },
  { id: 'inventoryConsumption', labelKey: 'nav.inventoryConsumption', icon: '🧮', ready: true },
  { id: 'deposits', labelKey: 'nav.deposits', icon: '💰', ready: true },
  { id: 'investments', labelKey: 'nav.investments', icon: '💎', ready: true },
  { id: 'profitLoss', labelKey: 'nav.profitLoss', icon: '📈', ready: true },
  { id: 'usageReport', labelKey: 'nav.usageReport', icon: '📉', ready: true },
  { id: 'attendance', labelKey: 'nav.attendance', icon: '🕒', ready: true },
  { id: 'checklist', labelKey: 'nav.checklist', icon: '✅', ready: true },
  { id: 'shiftReport', labelKey: 'nav.shiftReport', icon: '🤝', ready: true },
]
