import { useCallback, useEffect, useMemo, useState } from 'react'
import { localDate } from '@/lib/dates'
import type { AuthContext } from '@/services/api'
import { Badge, Button, DataTable, Field, FormRow, Notice, Panel, SubTabs, TextInput } from '@/components/ui'
import { useI18n } from '@/i18n'
import { fetchAttendanceForDate, fetchAttendanceSummary, fetchEmployees, recordEvening, recordMorning, type AttendanceRow, type Employee } from '../api'

type Tab = 'morning' | 'evening' | 'day' | 'summary'
type Msg = { tone: 'info' | 'error'; text: string }
const today = () => localDate()
const nowHM = () => new Date().toTimeString().slice(0, 5)
const STATUSES = ['Present', 'Late', 'Half Day', 'Absent']

/** Attendance — mirrors ui_attendance.html: morning check-in, evening check-out, day view, range summary. */
export function AttendancePanel({ auth }: { auth: AuthContext }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('morning')
  const [msg, setMsg] = useState<Msg | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [date, setDate] = useState(today)
  const [rows, setRows] = useState<AttendanceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<Record<string, { on: boolean; time: string; status: string }>>({})
  const [rangeStart, setRangeStart] = useState(today)
  const [rangeEnd, setRangeEnd] = useState(today)
  const [summary, setSummary] = useState<AttendanceRow[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const [emps, day] = await Promise.all([fetchEmployees(auth), fetchAttendanceForDate(date, auth)])
    setLoading(false)
    setEmployees(emps)
    setRows(day)
    setSel(Object.fromEntries(emps.map((e) => [e.employee_id, { on: false, time: nowHM(), status: 'Present' }])))
  }, [auth, date])

  useEffect(() => {
    load()
  }, [load])

  const nameOf = (id: string) => employees.find((e) => e.employee_id === id)?.name ?? id
  const checkedIn = useMemo(() => new Set(rows.map((r) => r.employee_id)), [rows])
  const openRows = useMemo(() => rows.filter((r) => !r.end_time), [rows])

  const toggleAll = (on: boolean, ids: string[]) =>
    setSel((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, { ...(s[id] ?? { time: nowHM(), status: 'Present' }), on }])) }))

  const submitMorning = async () => {
    const entries = employees
      .filter((e) => sel[e.employee_id]?.on && !checkedIn.has(e.employee_id))
      .map((e) => ({ employee_id: e.employee_id, start_time: sel[e.employee_id].time, status: sel[e.employee_id].status }))
    if (!entries.length) return setMsg({ tone: 'error', text: t('att.noneSelected') })
    const r = await recordMorning(date, auth.username, entries, auth)
    if (r.ok) {
      setMsg({ tone: 'info', text: `${t('att.recorded')}: ${r.data?.recorded ?? entries.length}` })
      load()
    } else setMsg({ tone: 'error', text: r.error ?? '' })
  }

  const submitEvening = async () => {
    const entries = openRows
      .filter((r) => sel[r.employee_id]?.on)
      .map((r) => ({ employee_id: r.employee_id, end_time: sel[r.employee_id].time, status: sel[r.employee_id].status }))
    if (!entries.length) return setMsg({ tone: 'error', text: t('att.noneSelected') })
    const r = await recordEvening(date, auth.username, entries, auth)
    if (r.ok) {
      setMsg({ tone: 'info', text: `${t('att.updated')}: ${r.data?.updated ?? entries.length}` })
      load()
    } else setMsg({ tone: 'error', text: r.error ?? '' })
  }

  const loadSummary = async () => {
    setLoading(true)
    setSummary(await fetchAttendanceSummary(rangeStart, rangeEnd, auth))
    setLoading(false)
  }

  const entryTable = (list: { employee_id: string; name: string }[], disabled: (id: string) => boolean) => (
    <DataTable
      rows={list as unknown as Record<string, unknown>[]}
      rowKey={(r) => String(r.employee_id)}
      empty={loading ? t('common.loading') : t('att.noEmployees')}
      columns={[
        {
          key: 'on',
          label: (
            <input type="checkbox" onChange={(e) => toggleAll(e.target.checked, list.filter((x) => !disabled(x.employee_id)).map((x) => x.employee_id))} />
          ),
          render: (r) => (
            <input
              type="checkbox"
              disabled={disabled(String(r.employee_id))}
              checked={Boolean(sel[String(r.employee_id)]?.on)}
              onChange={(e) => setSel((s) => ({ ...s, [String(r.employee_id)]: { ...s[String(r.employee_id)], on: e.target.checked } }))}
            />
          ),
        },
        { key: 'name', label: t('att.employee'), render: (r) => <>{String(r.name)}{disabled(String(r.employee_id)) && <Badge tone="ok"> ✓</Badge>}</> },
        {
          key: 'time',
          label: t('att.time'),
          render: (r) => (
            <input type="time" value={sel[String(r.employee_id)]?.time ?? nowHM()} disabled={disabled(String(r.employee_id))} onChange={(e) => setSel((s) => ({ ...s, [String(r.employee_id)]: { ...s[String(r.employee_id)], time: e.target.value } }))} />
          ),
        },
        {
          key: 'status',
          label: t('kitchen.status'),
          render: (r) => (
            <select value={sel[String(r.employee_id)]?.status ?? 'Present'} disabled={disabled(String(r.employee_id))} onChange={(e) => setSel((s) => ({ ...s, [String(r.employee_id)]: { ...s[String(r.employee_id)], status: e.target.value } }))}>
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          ),
        },
      ]}
    />
  )

  return (
    <Panel title={`🕒 ${t('nav.attendance')}`}>
      <SubTabs
        tabs={[
          { id: 'morning', label: `🌅 ${t('att.morning')}` },
          { id: 'evening', label: `🌙 ${t('att.evening')}` },
          { id: 'day', label: `📋 ${t('att.day')}` },
          { id: 'summary', label: `📊 ${t('att.summary')}` },
        ]}
        active={tab}
        onChange={setTab}
      />
      {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Notice>}

      {tab !== 'summary' && (
        <FormRow>
          <Field label={t('kitchen.date')}>
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="actions" style={{ alignSelf: 'end' }}>
            <Button variant="ghost" onClick={load} disabled={loading}>
              {loading ? t('common.loading') : '↻'}
            </Button>
          </div>
        </FormRow>
      )}

      {tab === 'morning' && (
        <>
          {entryTable(employees, (id) => checkedIn.has(id))}
          <div className="actions">
            <Button onClick={submitMorning}>✅ {t('att.checkIn')}</Button>
          </div>
        </>
      )}
      {tab === 'evening' && (
        <>
          {entryTable(openRows.map((r) => ({ employee_id: r.employee_id, name: nameOf(r.employee_id) })), () => false)}
          <div className="actions">
            <Button onClick={submitEvening}>✅ {t('att.checkOut')}</Button>
          </div>
        </>
      )}
      {tab === 'day' && (
        <DataTable
          rows={rows as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.employee_id)}
          empty={loading ? t('common.loading') : t('att.none')}
          columns={[
            { key: 'employee_id', label: t('att.employee'), render: (r) => nameOf(String(r.employee_id)) },
            { key: 'start_time', label: t('att.in') },
            { key: 'end_time', label: t('att.out') },
            { key: 'work_hours', label: t('att.hours'), align: 'right' },
            { key: 'status', label: t('kitchen.status') },
          ]}
        />
      )}
      {tab === 'summary' && (
        <>
          <FormRow>
            <Field label={t('kitchen.from')}>
              <TextInput type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
            </Field>
            <Field label={t('kitchen.to')}>
              <TextInput type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
            </Field>
            <div className="actions" style={{ alignSelf: 'end' }}>
              <Button onClick={loadSummary} disabled={loading}>
                {loading ? t('common.loading') : t('att.load')}
              </Button>
            </div>
          </FormRow>
          <DataTable
            rows={summary as unknown as Record<string, unknown>[]}
            rowKey={(r, i) => `${r.employee_id}-${r.date}-${i}`}
            empty={t('att.none')}
            columns={[
              { key: 'date', label: t('kitchen.date') },
              { key: 'employee_id', label: t('att.employee'), render: (r) => nameOf(String(r.employee_id)) },
              { key: 'start_time', label: t('att.in') },
              { key: 'end_time', label: t('att.out') },
              { key: 'work_hours', label: t('att.hours'), align: 'right' },
              { key: 'status', label: t('kitchen.status') },
            ]}
          />
        </>
      )}
    </Panel>
  )
}
