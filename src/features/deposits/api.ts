import { api, callPositional, callSecure } from '@/services/api'
import type { AuthContext } from '@/services/api'

export interface CashSummary {
  totalSales: number
  totalSalesByCash: number
  totalSalesByNonCash: number
  salesByPaymentMethod?: Record<string, number>
  totalDeposits: number
  depositsByPaymentMethod?: Record<string, number>
  totalCashExpenses: number
  totalDeductibleExpenses: number
  totalCashPurchases: number
  cashInHand: number
  currentMonthCashInHand?: number
  lastUpdated?: string
}

export interface DepositRow {
  date: string
  amount: number | string
  account: string
  note: string
  user: string
  outlet: string
  paymentMethod: string
}

export interface Account {
  name: string
  type?: string
  [k: string]: unknown
}

const toAccounts = (d: unknown): Account[] =>
  Array.isArray(d) ? d.map((a) => (typeof a === 'string' ? { name: a } : (a as Account))) : []

export async function fetchDepositAccounts(auth: AuthContext): Promise<Account[]> {
  const r = await callPositional<unknown>('getDepositAccounts', [auth.deviceId, auth.username])
  return toAccounts(r.data)
}

export async function fetchCashSummary(auth: AuthContext): Promise<CashSummary | null> {
  const r = await callPositional<unknown>('getCashSummary', [auth.deviceId, auth.username])
  if (!r.ok) return null
  const d = r.data
  try {
    return (typeof d === 'string' ? JSON.parse(d) : d) as CashSummary
  } catch {
    return null
  }
}

export async function fetchDepositHistory(auth: AuthContext): Promise<DepositRow[]> {
  const r = await callPositional<unknown>('getDepositHistory', [auth.deviceId, auth.username])
  return Array.isArray(r.data) ? (r.data as DepositRow[]) : []
}

export const recordDeposit = (
  p: { amount: number; account: string; note: string; paymentMethod: string },
  auth: AuthContext,
) => callSecure<{ message?: string }>('recordDepositSecure', p, auth)

// ---------- Daily cash report (all totals computed by the server) ----------
interface CashDailyAmounts {
  totalSales: number
  cashSales: number
  cashExpenses: number
  deductibleExpenses: number
  cashPurchases: number
  deposits: number
  depositsQris: number
  depositsTransfer: number
  salesByPaymentMethod: Record<string, number>
  depositsByPaymentMethod: Record<string, number>
  cashInHand: number
}

export interface CashDailyDay extends CashDailyAmounts {
  date: string
  month: string
  dailyNet: number
}

export interface CashDailyMonth extends CashDailyAmounts {
  month: string
  days: number
  net: number
}

export interface CashDailyReport {
  outlet: string
  today: string
  days: CashDailyDay[]
  months: CashDailyMonth[]
  total: CashDailyAmounts & { net: number }
  salesMethods: string[]
  depositMethods: string[]
  /** The incremental sync was skipped (another one was running): numbers may lag a little. */
  stale?: boolean
}

export const fetchCashDailyReport = (auth: AuthContext) => api.cashDaily<CashDailyReport>(auth)
