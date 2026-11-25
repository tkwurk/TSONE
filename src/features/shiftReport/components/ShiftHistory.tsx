import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AuthContext } from '@/services/api'
import { Badge, Button, DataTable, Field, FormRow, Notice, Select, Stats, TextInput } from '@/components/ui'
import type { Column } from '@/components/ui/DataTable'
import { useI18n } from '@/i18n'
import { addDays, fmtDateTime, fmtTimeOnly, localDate } from '@/lib/dates'
import { getShiftHistory, type ShiftReportDetail } from '../api'
import { ShiftReportDetails } from './ShiftReportDetails'

type Row = ShiftReportDetail & Record<string, unknown>
type Show = 'all' | 'cash' | 'kitchen' | 'any'

/**
 * Shift history: saved reports for a date range in a sortable table with
 * per-column filters. Clicking (or Enter on) a row opens its full details.
 * Filtering here only hides rows already returned by the server.
 */
export function ShiftHistory({ auth }: { auth: AuthContext }) {
  const { t, fmtMoney, fmtNum } = useI18n()
  const today = localDate()
  const [start, setStart] = useState(addDays(today, -30))
  const [end, setEnd] = useState(today)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [show, setShow] = useState<Show>('all')
  const [selectedId, setSelectedId] = useState('')
  const detailsRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const r = await getShiftHistory(start, end, auth)
    setLoading(false)
    if (!r.success || !r.data) return setError(String(r.error ?? t('shift.loadFailed')))
    setRows(r.data.rows as Row[])
    setSelectedId('')
  }, [start, end, auth, t])

  // Reloads when the date range changes.
  useEffect(() => {
    load()
  }, [load])

  const signedMoney = useCallback((n: number) => `${n > 0 ? '+' : ''}${fmtMoney(n)}`, [fmtMoney])

  const visible = useMemo(() => {
    // Text a column shows, used for the column filters.
    const shown: Record<string, (r: Row) => string> = {
      businessDate: (r) => r.businessDate,
      submittedAt: (r) => fmtDateTime(r.submittedAt),
      submittedBy: (r) => r.submittedBy,
      handedTo: (r) => r.handedTo,
      expectedCash: (r) => `${fmtMoney(r.expectedCash)} ${r.expectedCash}`,
      countedCash: (r) => `${fmtMoney(r.countedCash)} ${r.countedCash}`,
      cashVariance: (r) => `${signedMoney(r.cashVariance)} ${r.cashVariance}`,
      kitchen: (r) => `${r.kitchenMismatches.length} ${r.kitchenMismatches.map((m) => m.name).join(' ')}`,
      notes: (r) => r.notes,
    }
    const active = Object.entries(filters)
      .map(([k, v]) => [k, v.trim().toLowerCase()] as const)
      .filter(([, v]) => v)
    return rows.filter((r) => {
      const cashDiff = r.cashVariance !== 0
      const kitchenDiff = r.kitchenMismatches.length > 0
      if (show === 'cash' && !cashDiff) return false
      if (show === 'kitchen' && !kitchenDiff) return false
      if (show === 'any' && !cashDiff && !kitchenDiff) return false
      return active.every(([k, q]) => (shown[k]?.(r) ?? '').toLowerCase().includes(q))
    })
  }, [rows, filters, show, signedMoney, fmtMoney])

  const selected = rows.find((r) => r.reportId === selectedId) ?? null

  const open = (r: Row) => {
    setSelectedId(r.reportId)
    requestAnimationFrame(() => {
      detailsRef.current?.focus({ preventScroll: true })
      detailsRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  const columns: Column<Row>[] = [
    { key: 'businessDate', label: t('shift.businessDate'), sortable: true },
    {
      key: 'submittedAt',
      label: t('shift.time'),
      sortable: true,
      render: (r) => fmtTimeOnly(r.submittedAt),
      sortValue: (r) => new Date(r.submittedAt).getTime() || 0,
    },
    { key: 'submittedBy', label: t('shift.submittedBy'), sortable: true },
    { key: 'handedTo', label: t('shift.handedTo'), sortable: true },
    { key: 'expectedCash', label: t('shift.expectedCash'), align: 'right', sortable: true, render: (r) => fmtMoney(r.expectedCash) },
    { key: 'countedCash', label: t('shift.countedCash'), align: 'right', sortable: true, render: (r) => fmtMoney(r.countedCash) },
    {
      key: 'cashVariance',
      label: t('shift.variance'),
      align: 'right',
      sortable: true,
      render: (r) => <Badge tone={r.cashVariance === 0 ? 'ok' : 'bad'}>{signedMoney(r.cashVariance)}</Badge>,
    },
    {
      key: 'kitchen',
      label: t('shift.kitchenDiffs'),
      align: 'right',
      sortable: true,
      sortValue: (r) => r.kitchenMismatches.length,
      render: (r) =>
        r.kitchenMismatches.length ? <Badge tone="bad">{fmtNum(r.kitchenMismatches.length)}</Badge> : <Badge tone="ok">✓</Badge>,
    },
  ]

  return (
    <div className="shift__history">
      <FormRow>
        <Field label={t('shift.from')}>
          <TextInput type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label={t('shift.to')}>
          <TextInput type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label={t('shift.show')}>
          <Select value={show} onChange={(e) => setShow(e.target.value as Show)}>
            <option value="all">{t('shift.showAll')}</option>
            <option value="any">{t('shift.showAnyDiff')}</option>
            <option value="cash">{t('shift.showCashDiff')}</option>
            <option value="kitchen">{t('shift.showKitchenDiff')}</option>
          </Select>
        </Field>
      </FormRow>
      <div className="actions">
        <Button onClick={load} disabled={loading || !start || !end}>
          {loading ? t('common.loading') : '↻'}
        </Button>
        <Button variant="ghost" onClick={() => { setFilters({}); setShow('all') }} disabled={!Object.values(filters).some(Boolean) && show === 'all'}>
          {t('shift.clearFilters')}
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      {selected && (
        <section className="shift__section shift__detail-card" ref={detailsRef} tabIndex={-1} aria-label={t('shift.details')}>
          <div className="actions">
            <h3>🔎 {t('shift.details')}</h3>
            <Button variant="ghost" onClick={() => setSelectedId('')} aria-label={t('shift.closeDetails')}>
              ✕
            </Button>
          </div>
          <ShiftReportDetails report={selected} />
        </section>
      )}

      <Stats
        items={[
          { label: t('shift.reports'), value: fmtNum(visible.length) },
          { label: t('shift.withCashDiff'), value: fmtNum(visible.filter((r) => r.cashVariance !== 0).length) },
          { label: t('shift.withKitchenDiff'), value: fmtNum(visible.filter((r) => r.kitchenMismatches.length).length) },
        ]}
      />
      <p className="muted">{t('shift.historyHint')}</p>
      <DataTable<Row>
        columns={columns}
        rows={visible}
        rowKey={(r) => r.reportId}
        defaultSort={{ key: 'submittedAt', dir: 'desc' }}
        columnFilters={{
          values: filters,
          onChange: (key, value) => setFilters((prev) => ({ ...prev, [key]: value })),
          label: (label: ReactNode) => `${t('shift.filterColumn')} ${String(label)}`,
        }}
        onRowClick={open}
        activeRowKey={selectedId}
        empty={loading ? t('common.loading') : t('shift.noHistory')}
      />
    </div>
  )
}
