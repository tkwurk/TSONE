import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import './kitchen.css'
import type { AuthContext } from '@/services/api'
import { Badge, Button, DataTable, Field, FormRow, Notice, Stats, TextInput } from '@/components/ui'
import type { Column } from '@/components/ui/DataTable'
import { useI18n } from '@/i18n'
import { addDays, fmtTimeOnly, localDate } from '@/lib/dates'
import { getCookingAudit, type CookingAudit as Audit, type CookingAuditEpisode, type CookingAuditProduct } from '../api'

type ProductRow = CookingAuditProduct & Record<string, unknown>
type EpisodeRow = CookingAuditEpisode & Record<string, unknown>

/**
 * Cooking audit: every time a cooked product sold out, how long until the
 * next batch was ready (customers' waiting time), how fast the kitchen started,
 * and customers turned away — plus a suggested recook threshold per product.
 * All figures come from the server (ReportingWorker.cookingAudit).
 */
export function CookingAudit({ auth }: { auth: AuthContext }) {
  const { t, fmtNum } = useI18n()
  const today = localDate()
  const [start, setStart] = useState(addDays(today, -6))
  const [end, setEnd] = useState(today)
  const [audit, setAudit] = useState<Audit | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [product, setProduct] = useState('') // filter sell-outs by product code

  const load = useCallback(async () => {
    if (!start || !end) return
    setLoading(true)
    setError('')
    const r = await getCookingAudit(start, end, auth)
    setLoading(false)
    if (!r.success || !r.data) return setError(String(r.error ?? '').replace(/^Pipeline failed at step "[^"]+": /, ''))
    setAudit(r.data)
  }, [start, end, auth])

  useEffect(() => {
    const id = setTimeout(load, 350)
    return () => clearTimeout(id)
  }, [load])

  const fmtMin = useCallback(
    (m: number | null | undefined) => {
      if (m == null) return '—'
      const sign = m < 0 ? '−' : ''
      const a = Math.abs(m)
      if (a < 60) return `${sign}${fmtNum(Math.round(a))} ${t('audit.min')}`
      const h = Math.floor(a / 60)
      const r = Math.round(a - h * 60)
      return `${sign}${h} ${t('audit.h')} ${String(r).padStart(2, '0')} ${t('audit.min')}`
    },
    [fmtNum, t],
  )

  // Guidance: products to change, worst first (most customers turned away, then longest waits).
  const advice = useMemo(() => {
    if (!audit) return []
    const out: ReactNode[] = []
    const ranked = [...audit.products].sort((a, b) => b.turnedAway - a.turnedAway || b.totalWaitMin - a.totalWaitMin)
    for (const p of ranked) {
      if (!p.sellOuts) continue
      const parts: string[] = []
      if (p.raiseThreshold && p.suggestedThreshold != null) {
        parts.push(
          [t('audit.adviceStartAt'), fmtNum(p.suggestedThreshold), t('audit.adviceLeft')].filter(Boolean).join(' ') +
            ` (${t('audit.adviceNow')} ${fmtNum(p.recookThreshold)})` +
            ` — ${t('audit.adviceSells')} ~${fmtNum(p.ratePerHour ?? 0)}/${t('audit.h')}, ${t('audit.adviceBatch')} ~${fmtMin(p.avgCookMin)}.`,
        )
      }
      if (p.avgReactionMin != null && p.avgReactionMin > 10) {
        parts.push(`${t('audit.adviceSlowStart')} ${fmtMin(p.avgReactionMin)} ${t('audit.adviceAfterSoldOut')}`)
      }
      if (p.notRestocked) parts.push(`${fmtNum(p.notRestocked)}× ${t('audit.adviceNotRecooked')}`)
      if (p.salesWhileOut) parts.push(`${fmtNum(p.salesWhileOut)} ${t('audit.adviceSalesWhileOut')}`)
      if (!parts.length) continue
      out.push(
        <li key={p.productCode}>
          <strong>{p.name}</strong>
          {p.turnedAway ? <Badge tone="bad">{`${fmtNum(p.turnedAway)} ${t('audit.turnedAwayShort')}`}</Badge> : null}
          <ul>
            {parts.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </li>,
      )
    }
    return out
  }, [audit, t, fmtNum, fmtMin])

  const productCols: Column<ProductRow>[] = [
    { key: 'name', label: t('kitchen.product'), sortable: true, render: (r) => <strong>{r.name}</strong> },
    { key: 'sellOuts', label: t('audit.sellOuts'), align: 'right', sortable: true },
    { key: 'avgWaitMin', label: t('audit.avgWait'), align: 'right', sortable: true, sortValue: (r) => r.avgWaitMin ?? -1, render: (r) => fmtMin(r.avgWaitMin) },
    { key: 'maxWaitMin', label: t('audit.maxWait'), align: 'right', sortable: true, sortValue: (r) => r.maxWaitMin ?? -1, render: (r) => fmtMin(r.maxWaitMin) },
    { key: 'avgReactionMin', label: t('audit.avgReaction'), align: 'right', sortable: true, sortValue: (r) => r.avgReactionMin ?? -999, render: (r) => fmtMin(r.avgReactionMin) },
    { key: 'avgCookMin', label: t('audit.avgCook'), align: 'right', sortable: true, sortValue: (r) => r.avgCookMin ?? -1, render: (r) => fmtMin(r.avgCookMin) },
    { key: 'turnedAway', label: t('audit.turnedAway'), align: 'right', sortable: true, render: (r) => (r.turnedAway ? <Badge tone="bad">{fmtNum(r.turnedAway)}</Badge> : '0') },
    { key: 'ratePerHour', label: t('audit.ratePerHour'), align: 'right', sortable: true, sortValue: (r) => r.ratePerHour ?? -1, render: (r) => (r.ratePerHour == null ? '—' : fmtNum(r.ratePerHour)) },
    {
      key: 'suggestedThreshold',
      label: t('audit.threshold'),
      align: 'right',
      sortable: true,
      sortValue: (r) => (r.suggestedThreshold ?? r.recookThreshold) - r.recookThreshold,
      render: (r) =>
        r.raiseThreshold ? (
          <Badge tone="bad">{`${fmtNum(r.recookThreshold)} → ${fmtNum(r.suggestedThreshold ?? 0)}`}</Badge>
        ) : (
          <span>{fmtNum(r.recookThreshold)}</span>
        ),
    },
  ]

  const episodeCols: Column<EpisodeRow>[] = [
    { key: 'day', label: t('kitchen.date'), sortable: true },
    { key: 'name', label: t('kitchen.product'), sortable: true },
    { key: 'soldOutAt', label: t('audit.soldOutAt'), sortable: true, render: (r) => fmtTimeOnly(r.soldOutAt) },
    { key: 'cookStartAt', label: t('audit.cookStart'), sortable: true, render: (r) => (r.cookStartAt ? fmtTimeOnly(r.cookStartAt) : '—') },
    {
      key: 'readyAt',
      label: t('audit.readyAt'),
      sortable: true,
      render: (r) => (r.restocked ? fmtTimeOnly(r.readyAt) : <Badge tone="bad">{t('audit.notRecooked')}</Badge>),
    },
    {
      key: 'waitMin',
      label: t('audit.waited'),
      align: 'right',
      sortable: true,
      sortValue: (r) => r.waitMin ?? Number.MAX_SAFE_INTEGER,
      render: (r) => <strong>{fmtMin(r.waitMin)}</strong>,
    },
    { key: 'reactionMin', label: t('audit.reaction'), align: 'right', sortable: true, sortValue: (r) => r.reactionMin ?? -999, render: (r) => fmtMin(r.reactionMin) },
    { key: 'cookMin', label: t('audit.cookTime'), align: 'right', sortable: true, sortValue: (r) => r.cookMin ?? -1, render: (r) => fmtMin(r.cookMin) },
    { key: 'turnedAway', label: t('audit.turnedAway'), align: 'right', sortable: true, render: (r) => (r.turnedAway ? <Badge tone="bad">{fmtNum(r.turnedAway)}</Badge> : '0') },
    { key: 'chef', label: t('kitchen.chef'), sortable: true },
  ]

  const episodes = (audit?.episodes ?? []).filter((e) => !product || e.productCode === product) as EpisodeRow[]
  const productName = audit?.products.find((p) => p.productCode === product)?.name

  return (
    <div className="cooking-audit">
      <p className="muted">{t('audit.help')}</p>
      <FormRow>
        <Field label={t('kitchen.from')}>
          <TextInput type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label={t('kitchen.to')}>
          <TextInput type="date" value={end} min={start} max={today} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <div className="actions" style={{ alignSelf: 'end' }}>
          <Button variant="ghost" onClick={load} disabled={loading}>
            {loading ? t('common.loading') : '↻'}
          </Button>
        </div>
      </FormRow>
      {error && <Notice tone="error">{error}</Notice>}
      {loading && !audit && <p className="muted">{t('common.loading')}</p>}

      {audit && (
        <>
          <Stats
            items={[
              { label: t('audit.sellOuts'), value: fmtNum(audit.totals.sellOuts), tone: audit.totals.sellOuts ? 'bad' : 'ok' },
              { label: t('audit.avgWait'), value: fmtMin(audit.totals.avgWaitMin) },
              { label: t('audit.maxWait'), value: fmtMin(audit.totals.maxWaitMin) },
              { label: t('audit.turnedAway'), value: fmtNum(audit.totals.turnedAway), tone: audit.totals.turnedAway ? 'bad' : 'ok' },
              { label: t('audit.notRecooked'), value: fmtNum(audit.totals.notRestocked), tone: audit.totals.notRestocked ? 'bad' : 'ok' },
            ]}
          />

          <h3>🧭 {t('audit.whatToDo')}</h3>
          {advice.length ? (
            <ul className="cooking-audit__advice">{advice}</ul>
          ) : (
            <p className="muted">{audit.totals.sellOuts ? t('audit.noAdvice') : t('audit.noSellOuts')}</p>
          )}
          <p className="muted">
            {t('audit.thresholdHow')} ({t('audit.bufferNote')} {fmtNum(audit.settings.bufferMin)} {t('audit.min')})
          </p>

          <h3>🍳 {t('audit.byProduct')}</h3>
          <p className="muted">{t('audit.byProductHint')}</p>
          <DataTable<ProductRow>
            columns={productCols}
            rows={audit.products as ProductRow[]}
            rowKey={(r) => r.productCode}
            defaultSort={{ key: 'turnedAway', dir: 'desc' }}
            filterable
            filterPlaceholder={t('audit.filter')}
            onRowClick={(r) => setProduct((cur) => (cur === r.productCode ? '' : r.productCode))}
            activeRowKey={product}
            empty={t('kitchen.noProducts')}
          />

          <div className="actions">
            <h3>⏱️ {t('audit.episodes')}{productName ? ` — ${productName}` : ''}</h3>
            {product && (
              <Button variant="ghost" onClick={() => setProduct('')}>
                {t('audit.showAll')}
              </Button>
            )}
          </div>
          <DataTable<EpisodeRow>
            columns={episodeCols}
            rows={episodes}
            rowKey={(r, i) => `${r.productCode}-${r.soldOutAt}-${i}`}
            defaultSort={{ key: 'soldOutAt', dir: 'desc' }}
            filterable
            filterPlaceholder={t('audit.filter')}
            empty={t('audit.noSellOuts')}
          />
        </>
      )}
    </div>
  )
}
