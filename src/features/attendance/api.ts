import { callPositional } from '@/services/api'
import type { AuthContext } from '@/services/api'

export interface Employee {
  employee_id: string
  name: string
  department?: string
  position?: string
}
export interface AttendanceRow {
  employee_id: string
  date: string
  start_time: string
  end_time: string
  work_hours: string | number
  status: string
}

export async function fetchEmployees(auth: AuthContext): Promise<Employee[]> {
  const r = await callPositional<unknown>('getEmployeeList', [auth.deviceId, auth.username])
  return Array.isArray(r.data) ? (r.data as Employee[]) : []
}
export async function fetchAttendanceForDate(date: string, auth: AuthContext): Promise<AttendanceRow[]> {
  const r = await callPositional<unknown>('getAttendanceForDate', [date, auth.deviceId, auth.username])
  return Array.isArray(r.data) ? (r.data as AttendanceRow[]) : []
}
export async function fetchAttendanceSummary(start: string, end: string, auth: AuthContext): Promise<AttendanceRow[]> {
  const r = await callPositional<unknown>('getAttendanceSummary', [start, end, auth.deviceId, auth.username])
  return Array.isArray(r.data) ? (r.data as AttendanceRow[]) : []
}
export const recordMorning = (
  date: string,
  supervisor: string,
  entries: { employee_id: string; start_time: string; status?: string }[],
  auth: AuthContext,
) =>
  callPositional<{ recorded?: number; skipped?: number }>('recordMorningAttendance', [
    JSON.stringify({ date, supervisor, entries }),
    auth.deviceId,
    auth.username,
  ])
export const recordEvening = (
  date: string,
  supervisor: string,
  entries: { employee_id: string; end_time: string; status?: string }[],
  auth: AuthContext,
) =>
  callPositional<{ updated?: number }>('recordEveningAttendance', [
    JSON.stringify({ date, supervisor, entries }),
    auth.deviceId,
    auth.username,
  ])
