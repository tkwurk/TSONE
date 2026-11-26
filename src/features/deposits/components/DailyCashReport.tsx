import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { AuthContext } from '@/services/api'
import { Button, Field, FormRow, Notice, Select } from '@/components/ui'
import { useI18n } from '@/i18n'
import { fetchCashDailyReport, type CashDailyDay, type CashDailyReport } from '../api'
import './dailyCash.css'

type Amounts = Omit<CashDailyDay, 'date' | 'month' | 'dailyNet'>

/**
 * Deposits ▸ Daily — cash in hand day by day (the HTML app's "Daily Summary").
 * Every amount, subtotal and total comes from the server (cash.daily.requested);
 * this view only filters, groups and formats.
 */
export function DailyCashReport({ auth }: { auth: AuthContext }) {
  const { t, lang, fmtNum } = useI18n()
  const [report, setReport] = useState<CashDailyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [month, setMonth] = useState('all')
  const [group, setGroup] = useState(true)
  const [more, setMore] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const r = await fetchCashDailyReport(auth)
    setLoading(false)
    if (!r.success || !r.data) return setError(String(r.error ?? t('cashDaily.failed')).replace(/^Pipeline failed at step "[^"]+": /, ''))
    setReport(r.data)
  }, [auth, t])

  useEffect(() => {
    load()
  }, [load])

  const locale = lang === 'id' ? 'id-ID' : 'en-GB'
  // Date keys are calendar dates (no time): format them as UTC so the device zone can't shift them.
  const fmtDay = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }), [locale])
  const fmtMonth = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }), [locale])
  // Year hidden on phones (the month row already shows it).
  const dayLabel = (key: string) => (
    <>
      {fmtDay.format(new Date(`${key}T00:00:00Z`))}
      <span className="cd-year"> {key.slice(0, 4)}</span>
    </>
  )
  const monthLabel = (key: string) => fmtMonth.format(new Date(`${key}-01T00:00:00Z`))

  const num = (v: number) => fmtNum(Math.abs(Math.round(v || 0)))
  const pos = (v: number) => (v ? <span className="cd-pos">{num(v)}</span> : <span className="cd-zero">—</span>)
  const neg = (v: number) => (v ? <span className="cd-neg">{num(v)}</span> : <span className="cd-zero">—</span>)
  const net = (v: number) =>
    v ? <span className={v > 0 ? 'cd-net-pos' : 'cd-net-neg'}>{(v > 0 ? '+' : '−') + num(v)}</span> : <span className="cd-zero">0</span>
  const cih = (v: number) => <span className={v >= 0 ? 'cd-cih-pos' : 'cd-cih-neg'}>{(v < 0 ? '−' : '') + num(v)}</span>

  const salesMethods = report?.salesMethods ?? []
  const depositMethods = report?.depositMethods ?? []

  const header = (
    <tr>
      <th className="cd-date">{t('kitchen.date')}</th>
      {more ? (
        <>
          {salesMethods.map((k) => (
            <th key={`s-${k}`}>{k}</th>
          ))}
          <th>{t('dep.totalSales')}</th>
        </>
      ) : (
        <th>{t('dep.cashSales')}</th>
      )}
      <th>{t('cashDaily.allExpenses')}</th>
      <th>{t('cashDaily.cashExpenses')}</th>
      <th>{t('cashDaily.cashPurchases')}</th>
      {more ? (
        depositMethods.length ? (
          depositMethods.map((k) => <th key={`d-${k}`}>{`${k} ${t('cashDaily.dep')}`}</th>)
        ) : (
          <>
            <th>{`QRIS ${t('cashDaily.dep')}`}</th>
            <th>{`Transfer ${t('cashDaily.dep')}`}</th>
          </>
        )
      ) : (
        <th>{t('cashDaily.transferDeposits')}</th>
      )}
      <th>{t('cashDaily.dailyNet')}</th>
      <th>{t('dep.cashInHand')}</th>
    </tr>
  )

  const cells = (d: Amounts, netValue: number) => (
    <>
      {more ? (
        <>
          {salesMethods.map((k) => (
            <td key={`s-${k}`}>{pos(d.salesByPaymentMethod?.[k] ?? 0)}</td>
          ))}
          <td>{pos(d.totalSales)}</td>
        </>
      ) : (
        <td>{pos(d.cashSales)}</td>
      )}
      <td>{neg(d.deductibleExpenses)}</td>
      <td>{neg(d.cashExpenses)}</td>
      <td>{neg(d.cashPurchases)}</td>
      {more ? (
        depositMethods.length ? (
          depositMethods.map((k) => <td key={`d-${k}`}>{neg(d.depositsByPaymentMethod?.[k] ?? 0)}</td>)
        ) : (
          <>
            <td>{neg(d.depositsQris)}</td>
            <td>{neg(d.depositsTransfer)}</td>
          </>
        )
      ) : (
        <td>{neg(d.depositsTransfer)}</td>
      )}
      <td>{net(netValue)}</td>
      <td>{cih(d.cashInHand)}</td>
    </>
  )

  const dayRow = (d: CashDailyDay, indent: boolean) => {
    const isToday = d.date === report?.today
    return (
      <tr key={d.date} className={isToday ? 'cd-today' : undefined}>
        <td className={'cd-date' + (indent ? ' cd-indent' : '')}>
          {dayLabel(d.date)}
          {isToday && <span className="cd-today-tag">{t('cashDaily.today')}</span>}
        </td>
        {cells(d, d.dailyNet)}
      </tr>
    )
  }

  const days = (report?.days ?? []).filter((d) => month === 'all' || d.month === month)
  const selectedMonth = report?.months.find((m) => m.month === month)
  const grouped = group && month === 'all'

  return (
    <div className="cash-daily">
      <FormRow>
        <Field label={t('cashDaily.month')}>
          <Select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">{t('cashDaily.allMonths')}</option>
            {(report?.months ?? []).map((m) => (
              <option key={m.month} value={m.month}>
                {monthLabel(m.month)}
              </option>
            ))}
          </Select>
        </Field>
      </FormRow>
      <div className="actions">
        <Button variant={grouped ? 'primary' : 'ghost'} aria-pressed={group} onClick={() => setGroup((g) => !g)} disabled={month !== 'all'}>
          ⊞ {t('cashDaily.groupByMonth')}
        </Button>
        <Button variant={more ? 'primary' : 'ghost'} aria-pressed={more} onClick={() => setMore((m) => !m)}>
          {more ? `✕ ${t('cashDaily.lessColumns')}` : `⊕ ${t('cashDaily.moreColumns')}`}
        </Button>
        <Button variant="ghost" onClick={load} disabled={loading}>
          {loading ? t('common.loading') : '↻'}
        </Button>
      </div>
      <p className="muted">{t('cashDaily.formula')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {report?.stale && <Notice tone="info">{t('cashDaily.stale')}</Notice>}
      {loading && !report && <p className="muted">{t('common.loading')}</p>}

      {report && (
        <div className="cd-wrap">
          <table className="cd-table">
            <thead>{header}</thead>
            <tbody>
              {days.length === 0 && (
                <tr>
                  <td colSpan={99} className="muted">
                    {t('cashDaily.noData')}
                  </td>
                </tr>
              )}
              {grouped
                ? report.months.map((m) => (
                    <Fragment key={m.month}>
                      <tr className="cd-sub">
                        <td className="cd-date">📅 {monthLabel(m.month)}</td>
                        {cells(m, m.net)}
                      </tr>
                      {report.days.filter((d) => d.month === m.month).map((d) => dayRow(d, true))}
                    </Fragment>
                  ))
                : days.map((d) => dayRow(d, false))}
              {days.length > 0 && (
                <tr className="cd-total">
                  <td className="cd-date">
                    {month === 'all' ? t('cashDaily.allTimeTotal') : `${monthLabel(month)} ${t('cashDaily.total')}`}
                  </td>
                  {month === 'all' ? cells(report.total, report.total.net) : selectedMonth ? cells(selectedMonth, selectedMonth.net) : null}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
