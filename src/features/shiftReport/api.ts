import { api } from '@/services/api'
import type { AuthContext } from '@/services/api'

export interface ShiftKitchenItem {
  productCode: string
  name: string
  leftoverFromYesterday: number
  cookedToday: number
  soldToday: number
  /** System count (server). */
  remaining: number
}

export interface ShiftStaff {
  id: string
  name: string
}

export interface ShiftReportRow {
  reportId: string
  submittedAt: string
  submittedBy: string
  handedTo: string
  expectedCash: number
  countedCash: number
  cashVariance: number
  kitchenMismatches: number
}

export interface ShiftReportBundle {
  outlet: string
  businessDate: string
  asOf: string
  expectedCash: number
  kitchen: ShiftKitchenItem[]
  staff: ShiftStaff[]
  todayReports: ShiftReportRow[]
}

export interface ShiftKitchenMismatch {
  productCode: string
  name: string
  system: number
  actual: number
  diff: number
}

/** Saved report as returned by the server (all figures server-computed). */
export interface ShiftReportSummary {
  reportId: string
  submittedAt: string
  businessDate: string
  outlet: string
  submittedBy: string
  handedTo: string
  expectedCash: number
  countedCash: number
  cashVariance: number
  kitchenItems: number
  kitchenMismatches: ShiftKitchenMismatch[]
  notes: string
}

export interface ShiftReportSubmission {
  countedCash: number
  cashConfirmed: boolean
  receiverId: string
  /** Each item is either confirmed as correct, or given the real count. */
  kitchen: { productCode: string; confirmed?: boolean; actual?: number }[]
  notes: string
}

export const getShiftReport = (auth: AuthContext) => api.shiftReport<ShiftReportBundle>(auth)

export const newShiftRequestId = () => `shift-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

/** Reuse the same `requestId` when retrying one submission, so it is saved once. */
export const submitShiftReport = (p: ShiftReportSubmission, requestId: string, auth: AuthContext) =>
  api.submitShiftReport<ShiftReportSummary>({ ...p, clientRequestId: requestId }, auth)

/** A saved report from history: the summary plus every kitchen line (matching or not). */
export interface ShiftReportDetail extends ShiftReportSummary {
  kitchenDetails: ShiftKitchenMismatch[]
}

export const getShiftHistory = (startDate: string, endDate: string, auth: AuthContext) =>
  api.shiftHistory<{ outlet: string; startDate: string; endDate: string; rows: ShiftReportDetail[] }>(startDate, endDate, auth)
