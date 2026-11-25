import { api, callPositional, callSecure } from '@/services/api'
import type { AuthContext } from '@/services/api'

// ---------- Products ----------
export type AdminProduct = Record<string, unknown>
export interface ProductsBundle {
  products: AdminProduct[]
  categories: string[]
  navCategories: string[]
  suppliers: string[]
}
export const fetchAdminProducts = async (auth: AuthContext): Promise<ProductsBundle> => {
  const r = await callSecure<Partial<ProductsBundle>>('getProductsForAdminSecure', {}, auth)
  const d = r.data ?? {}
  return {
    products: Array.isArray(d.products) ? d.products : [],
    categories: d.categories ?? [],
    navCategories: d.navCategories ?? [],
    suppliers: d.suppliers ?? [],
  }
}
export const saveProduct = (product: Record<string, string>, auth: AuthContext) =>
  callSecure<{ productCode?: string }>('saveProductSecure', { product }, auth)
export const updateProductFields = (
  p: { productCode: string; type: string; name?: string; price?: number | string; active?: 'Y' | 'N' },
  auth: AuthContext,
) => callSecure('updateProductFieldsSecure', p, auth)

// ---------- Checklist admin ----------
export interface ChecklistDefAdmin {
  id: string
  name: string
  description?: string
  status?: string
  assignedRoles?: string
  reviewerRoles?: string
  outlets?: string
  sortOrder?: number | string
}
export interface ChecklistQuestionAdmin {
  sn: string
  checklistId: string
  question: string
  questionType: string
  dropdownValues?: string
  status?: string
  outlet?: string
  category?: string
  mandatory?: boolean | string
  order?: number | string
}
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
export const fetchAllDefs = async (auth: AuthContext) =>
  arr<ChecklistDefAdmin>((await callPositional('getAllChecklistDefinitions', [auth.deviceId, auth.username])).data)
export const fetchRoleOptions = async (auth: AuthContext) =>
  arr<string>((await callPositional('getChecklistRoleOptions', [auth.deviceId, auth.username])).data)
export const saveDef = (payload: Partial<ChecklistDefAdmin>, auth: AuthContext) =>
  callPositional<{ id?: string; action?: string }>('saveChecklistDefinition', [JSON.stringify(payload), auth.deviceId, auth.username])
export const fetchAllQuestions = async (auth: AuthContext, checklistId: string) =>
  arr<ChecklistQuestionAdmin>((await callPositional('getAllChecklistQuestions', [auth.deviceId, auth.username, checklistId])).data)
export const saveQuestion = (payload: Partial<ChecklistQuestionAdmin>, auth: AuthContext) =>
  callPositional<{ sn?: string; action?: string }>('saveChecklistQuestion', [JSON.stringify(payload), auth.deviceId, auth.username])

// ---------- Smart picks ----------
export interface SmartPicksInfo {
  triggerActive?: boolean
  lastUpdated?: string
  totalRows?: number
  hour?: number
}
export const fetchSmartPicksInfo = (auth: AuthContext) => callSecure<SmartPicksInfo>('getSmartPicksTriggerInfoSecure', {}, auth)
export const scheduleSmartPicks = (hour: number, auth: AuthContext) =>
  callSecure<{ message?: string }>('scheduleSmartPicksTriggerSecure', { hour }, auth)
export const removeSmartPicks = (auth: AuthContext) => callSecure<{ removed?: number }>('removeSmartPicksTriggerSecure', {}, auth)
export const refreshSmartPicksNow = (auth: AuthContext) =>
  callSecure<{ message?: string; totalRows?: number; updatedAt?: string }>('refreshSmartPicksSecure', {}, auth)

// ---------- Stock history batch ----------
export interface StockHistoryJobInfo {
  triggerActive: boolean
  scheduleHour?: number | null
  timeZone?: string
  lastRun?: string | null
  lastBusinessDate?: string | null
  sheetName?: string
}
export const fetchStockHistoryJobInfo = (auth: AuthContext) =>
  api.stockHistoryStatus<StockHistoryJobInfo>(auth)
export const scheduleStockHistoryJob = (hour: number, auth: AuthContext) =>
  api.scheduleStockHistory<{ message?: string }>(hour, auth)

// ---------- Cooking stock alerts (auto cook requests + push notifications) ----------
export interface CookAlertStatus {
  installed?: boolean
  sweepMinutes?: number
  reminderMinutes?: number
  /** FIREBASE_SERVICE_ACCOUNT is set on this outlet. */
  pushConfigured?: boolean
  /** Devices of this outlet registered for push. */
  pushDevices?: number
}
export interface SweepOutletResult {
  outlet: string
  products: number
  below: number
  created: number
  updated: number
  /** Pushes delivered by this check. */
  push: number
  /** Why nothing was pushed (not-configured, no-devices) or the error. */
  pushNote: string
}
export interface SweepResult {
  summary?: { outlets?: SweepOutletResult[]; errors?: { outlet: string; error: string }[] }
}
export const fetchCookAlertStatus = (auth: AuthContext) => callSecure<CookAlertStatus>('getCookingAlertStatusSecure', {}, auth)
export const installCookAlerts = (auth: AuthContext) => callSecure('installCookingAlertTriggerSecure', {}, auth)
export const removeCookAlerts = (auth: AuthContext) => callSecure('removeCookingAlertTriggerSecure', {}, auth)
export const runCookAlertSweep = (auth: AuthContext) => callSecure<SweepResult>('runCookingAlertSweepNowSecure', {}, auth)

// ---------- BOM ----------
export interface BomLine {
  bomId: string
  unitProductCode: string
  recipeItemCode: string
  itemQuantity?: number | string
  itemQuantityDisplay?: string
  status?: string
}
export interface BomSummary {
  sheetName?: string
  totalLines?: number
  unitProductCount?: number
  lines: BomLine[]
}
export const fetchBom = async (auth: AuthContext) => {
  const r = await callSecure<BomSummary>('getBomForAdminSecure', {}, auth)
  return { ok: r.ok, error: r.error, data: r.data ? { ...r.data, lines: arr<BomLine>(r.data.lines) } : null }
}

// ---------- People ----------
export interface Person {
  person_id: string
  display_name: string
  role: string
  outlet: string
  email?: string
  pin_code?: string
  active?: string | boolean
  can_login?: string | boolean
  extra_tabs?: string
  denied_tabs?: string
  department?: string
  position?: string
}
export const fetchPeople = async (auth: AuthContext) => {
  const r = await callSecure<{ people?: Person[] }>('getPeopleForAdminSecure', {}, auth)
  return { ok: r.ok, error: r.error, people: arr<Person>(r.data?.people) }
}
export const savePerson = (person: Partial<Person>, auth: AuthContext) => callSecure('savePersonSecure', { person }, auth)
export const clearUsersCache = (auth: AuthContext) => callSecure('clearAllUsersCacheSecure', {}, auth)

// ---------- Printers ----------
export interface PrinterCfg {
  outlet: string
  printerName?: string
  printerType?: string
  updatedBy?: string
  updatedAt?: string
  autoPrint?: boolean
  drawerPin?: string
}
export const fetchOutlets = async (auth: AuthContext): Promise<string[]> => {
  const r = await callSecure<{ outlets?: string[] } | Array<string | { name: string }>>(
    'getOutletsForAdminSecure',
    { deviceId: auth.deviceId, username: auth.username },
    auth,
  )
  const d = r.data
  const list = Array.isArray(d) ? d.map((o) => (typeof o === 'string' ? o : o.name)) : (d?.outlets ?? [])
  return list.filter(Boolean)
}
export const fetchAllPrinters = async (auth: AuthContext) => {
  const r = await callSecure<{ printers?: PrinterCfg[] } | PrinterCfg[]>('getAllPrintersSecure', {}, auth)
  const d = r.data
  return Array.isArray(d) ? d : arr<PrinterCfg>(d?.printers)
}
export const fetchOutletPrinter = async (outlet: string, auth: AuthContext) =>
  (await callSecure<{ printer?: PrinterCfg | null }>('getOutletPrinterSecure', { outlet }, auth)).data?.printer ?? null
export const savePrinter = (p: { outlet: string; printerName: string; printerType: string }, auth: AuthContext) =>
  callSecure<{ message?: string }>('saveOutletPrinterSecure', p, auth)
export const deletePrinter = (outlet: string, auth: AuthContext) => callSecure('deleteOutletPrinterSecure', { outlet }, auth)
export const saveAutoPrint = (outlet: string, autoPrint: boolean, auth: AuthContext) =>
  callSecure('saveOutletAutoPrintSecure', { outlet, autoPrint }, auth)
export const saveDrawerPinMode = (outlet: string, drawerPin: string, auth: AuthContext) =>
  callSecure('saveOutletDrawerPinSecure', { outlet, drawerPin }, auth)
export const saveUnlockPin = (outlet: string, pin: string, auth: AuthContext) =>
  callSecure('saveDrawerUnlockPinSecure', { outlet, pin }, auth)
export const activateUnlockPin = (outlet: string, auth: AuthContext) => callSecure('activateDrawerUnlockPinSecure', { outlet }, auth)
export const fetchUnlockStatus = (outlet: string, auth: AuthContext) =>
  callSecure<{ pinConfigured?: boolean; pinWindowActive?: boolean; activeUntil?: string | null }>('getDrawerUnlockAdminSecure', { outlet }, auth)

export const yn = (v: unknown) => {
  const s = String(v ?? '').trim().toUpperCase()
  return v === true || s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1'
}
