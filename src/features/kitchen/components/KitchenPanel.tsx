import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtDateTime, localDate, localDateTime } from '@/lib/dates'
import type { AuthContext } from '@/services/api'
import { Badge, Button, DataTable, Field, FormRow, Notice, Panel, Stats, SubTabs, TextArea, TextInput } from '@/components/ui'
import { useI18n } from '@/i18n'
import { useKitchenRequestFeed } from '@/features/notifications'
import { RequestDetails } from './RequestDetails'
import { CookingAudit } from './CookingAudit'
import {
  getCookingHistory,
  getCookingProducts,
  getCookingTodayReport,
  submitCookingBatch,
  type CookRequest,
  type CookingHistoryRow,
  type CookingProduct,
  type TodayReportItem,
} from '../api'

type Tab = 'cook' | 'requests' | 'today' | 'history' | 'audit'
type Msg = { tone: 'info' | 'error'; text: string }

const nowLocal = () => localDateTime()
const today = () => localDate()
const CACHE_MS = 30_000

/**
 * Kitchen tab — mirrors ui_kitchenCooking.html: log a cooking batch (shared
 * start/end time, qty per cooking product), handle cook requests from sales,
 * today's cooked-vs-sold report, and cooking history.
 */
export function KitchenPanel({ auth, focusRequest }: { auth: AuthContext; focusRequest?: { id: string; seq: number } | null }) {
  const { t, fmtNum } = useI18n()
  const [tab, setTab] = useState<Tab>('cook')
  const [msg, setMsg] = useState<Msg | null>(null)

  // ── Cook batch ──
  const [products, setProducts] = useState<CookingProduct[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [startTime, setStartTime] = useState(nowLocal)
  const [endTime, setEndTime] = useState(nowLocal)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true)
    const r = await getCookingProducts(auth)
    setLoadingProducts(false)
    if (r.ok) setProducts(r.data?.items ?? [])
    else setMsg({ tone: 'error', text: r.error ?? '' })
  }, [auth])

  const lines = useMemo(
    () =>
      products
        .map((p) => ({ productCode: p.productCode, qty: Number(qty[p.productCode]) || 0 }))
        .filter((l) => l.qty > 0),
    [products, qty],
  )

  const submit = async () => {
    if (!lines.length) return setMsg({ tone: 'error', text: t('kitchen.noLines') })
    setSubmitting(true)
    const r = await submitCookingBatch({ startTime, endTime, notes, lines }, auth)
    setSubmitting(false)
    if (r.ok) {
      const req = r.data?.requests
      const nameOf = (code: string) => products.find((p) => p.productCode.toUpperCase() === code.toUpperCase())?.name ?? code
      let text = `${t('kitchen.saved')} — ${lines.length} ${t('kitchen.lines')}`
      if (req?.done?.length) text += ` · ✅ ${t('kitchen.requestsClosed')}: ${req.done.map(nameOf).join(', ')}`
      if (req?.stillOpen?.length)
        text += ` · ⚠️ ${t('kitchen.requestsStillOpen')}: ${req.stillOpen.map((s) => `${nameOf(s.productCode)} (${fmtNum(s.remaining)}/${fmtNum(s.threshold)})`).join(', ')}`
      setMsg({ tone: 'info', text })
      setQty({})
      setNotes('')
      cache.current.clear()
      loadProducts()
      loadRequests()
    } else setMsg({ tone: 'error', text: r.error ?? '' })
  }

  // ── Requests (shared app-wide feed: same data as the 🔔 bell, one poll) ──
  const feed = useKitchenRequestFeed()
  const { open, recentDone, loading: loadingReq, reload: loadRequests, markRead } = feed
  const [selectedReqId, setSelectedReqId] = useState('')
  const detailsRef = useRef<HTMLDivElement>(null)

  // Set when a request is opened; the effect below moves focus once its card is rendered.
  const focusDetails = useRef(false)
  const selectRequest = useCallback(
    (id: string) => {
      setSelectedReqId(id)
      if (id) markRead([id])
      focusDetails.current = !!id
    },
    [markRead],
  )

  // Opened from a notification / the bell: show Requests and that request's details.
  const focusSeq = focusRequest?.seq
  const focusId = focusRequest?.id ?? ''
  useEffect(() => {
    if (!focusSeq) return
    setTab('requests')
    selectRequest(focusId)
    loadRequests()
    // Only react to a new focus request (seq), not to selectRequest/loadRequests identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq])

  useEffect(() => {
    if (!focusDetails.current || tab !== 'requests' || !detailsRef.current) return
    focusDetails.current = false
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    detailsRef.current.focus({ preventScroll: true })
    detailsRef.current.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }, [selectedReqId, tab, focusRequest?.seq])

  /** From a request: go to Cook with the requested quantity filled in. */
  const cookFor = (r: CookRequest) => {
    const code = String(r.productCode ?? '')
    const known = products.find((p) => p.productCode.toUpperCase() === code.toUpperCase())
    const key = known?.productCode ?? code
    if (r.requestedQty > 0) setQty((q) => (q[key] ? q : { ...q, [key]: String(r.requestedQty) }))
    setTab('cook')
    requestAnimationFrame(() => document.getElementById(`cook-qty-${key}`)?.focus())
  }

  const thresholdOf = (code: unknown) => products.find((p) => p.productCode.toUpperCase() === String(code ?? '').toUpperCase())?.recookThreshold

  // ── Today report ──
  const [reportDate, setReportDate] = useState(today)
  const [report, setReport] = useState<TodayReportItem[]>([])
  const [loadingReport, setLoadingReport] = useState(false)

  // Short-lived response cache so flipping between sub-tabs doesn't refetch; cleared after a cook is saved.
  const cache = useRef(new Map<string, { at: number; data: unknown }>())
  const fresh = (key: string) => {
    const hit = cache.current.get(key)
    return hit && Date.now() - hit.at < CACHE_MS ? hit.data : undefined
  }

  const loadReport = useCallback(
    async (force = false) => {
      const key = `today|${reportDate}`
      const hit = force ? undefined : (fresh(key) as TodayReportItem[] | undefined)
      if (hit) return setReport(hit)
      setLoadingReport(true)
      const r = await getCookingTodayReport(reportDate, auth)
      setLoadingReport(false)
      if (r.ok) {
        const items = r.data?.items ?? []
        cache.current.set(key, { at: Date.now(), data: items })
        setReport(items)
      } else setMsg({ tone: 'error', text: r.error ?? '' })
    },
    [auth, reportDate],
  )

  // ── History ──
  const [hStart, setHStart] = useState(today)
  const [hEnd, setHEnd] = useState(today)
  const [hProduct, setHProduct] = useState('')
  const [hGroup, setHGroup] = useState(false)
  const [history, setHistory] = useState<CookingHistoryRow[]>([])
  const [loadingHist, setLoadingHist] = useState(false)

  const loadHistory = useCallback(
    async (force = false) => {
      const key = `hist|${hStart}|${hEnd}|${hProduct}`
      const hit = force ? undefined : (fresh(key) as CookingHistoryRow[] | undefined)
      if (hit) return setHistory(hit)
      setLoadingHist(true)
      const r = await getCookingHistory({ startDate: hStart, endDate: hEnd, productFilter: hProduct }, auth)
      setLoadingHist(false)
      if (r.ok) {
        const rows = r.data?.rows ?? []
        cache.current.set(key, { at: Date.now(), data: rows })
        setHistory(rows)
      } else setMsg({ tone: 'error', text: r.error ?? '' })
    },
    [auth, hStart, hEnd, hProduct],
  )

  // Total cooked qty per product per business day.
  const grouped = useMemo(() => {
    const m = new Map<string, { day: string; productName: string; qty: number; batches: number }>()
    for (const h of history) {
      if (!h.startTime) continue
      const day = localDate(new Date(h.startTime))
      const key = `${day}|${h.productCode || h.productName}`
      const cur = m.get(key) ?? { day, productName: h.productName, qty: 0, batches: 0 }
      cur.qty += Number(h.qty) || 0
      cur.batches += 1
      m.set(key, cur)
    }
    return Array.from(m.values()).sort((a, b) => b.day.localeCompare(a.day) || a.productName.localeCompare(b.productName))
  }, [history])

  useEffect(() => {
    loadProducts()
  }, [loadProducts])

  // Auto-load the Today report / History when the tab opens or filters change (debounced for typing).
  useEffect(() => {
    if (tab !== 'today') return
    loadReport()
  }, [tab, loadReport])
  useEffect(() => {
    if (tab !== 'history') return
    const id = setTimeout(loadHistory, 350)
    return () => clearTimeout(id)
  }, [tab, loadHistory])

  const tabs = [
    { id: 'cook' as const, label: `🍳 ${t('kitchen.cook')}` },
    { id: 'requests' as const, label: `🔔 ${t('kitchen.requests')} (${open.length})` },
    { id: 'today' as const, label: `📊 ${t('kitchen.today')}` },
    { id: 'history' as const, label: `📜 ${t('kitchen.history')}` },
    { id: 'audit' as const, label: `⏱️ ${t('audit.tab')}` },
  ]

  return (
    <Panel title={`👨‍🍳 ${t('nav.kitchenCooking')}`}>
      <SubTabs tabs={tabs} active={tab} onChange={setTab} />
      {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Notice>}

      {tab === 'cook' && (
        <>
          <FormRow>
            <Field label={t('kitchen.start')}>
              <TextInput type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </Field>
            <Field label={t('kitchen.end')}>
              <TextInput type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </FormRow>
          {loadingProducts ? (
            <p className="muted">{t('common.loading')}</p>
          ) : (
            <DataTable
              rows={products as unknown as Record<string, unknown>[]}
              rowKey={(r) => String(r.productCode)}
              empty={t('kitchen.noProducts')}
              columns={[
                { sortable: true, key: 'name', label: t('kitchen.product') },
                { sortable: true, key: 'cookedToday', label: t('kitchen.cookedToday'), align: 'right', render: (r) => fmtNum(Number(r.cookedToday) || 0) },
                {
                  key: 'qty',
                  label: t('kitchen.qtyCooked'),
                  align: 'right',
                  render: (r) => (
                    <input
                      id={`cook-qty-${String(r.productCode)}`}
                      aria-label={`${t('kitchen.qtyCooked')} — ${String(r.name ?? r.productCode)}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      style={{ width: '6rem', textAlign: 'right' }}
                      value={qty[String(r.productCode)] ?? ''}
                      onChange={(e) => setQty((q) => ({ ...q, [String(r.productCode)]: e.target.value }))}
                      placeholder="0"
                    />
                  ),
                },
              ]}
            />
          )}
          <Field label={t('kitchen.notes')}>
            <TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="actions">
            <Button onClick={submit} disabled={submitting || !lines.length}>
              {submitting ? t('checkout.submitting') : `✅ ${t('kitchen.submit')} (${lines.length})`}
            </Button>
            <Button variant="ghost" onClick={loadProducts} disabled={loadingProducts}>
              ↻
            </Button>
          </div>
        </>
      )}

      {tab === 'requests' && (
        <>
          <div className="actions">
            <Button variant="ghost" onClick={loadRequests} disabled={loadingReq}>
              {loadingReq ? t('common.loading') : '↻'}
            </Button>
          </div>
          {selectedReqId && (
            <RequestDetails
              ref={detailsRef}
              auth={auth}
              request={open.find((r) => r.requestId === selectedReqId) ?? recentDone.find((r) => r.requestId === selectedReqId) ?? null}
              loaded={feed.loadedAt > 0 && !loadingReq}
              threshold={thresholdOf(open.find((r) => r.requestId === selectedReqId)?.productCode)}
              onCook={cookFor}
              onChanged={loadRequests}
              onClose={() => setSelectedReqId('')}
            />
          )}
          <h4 className="muted">{t('kitchen.openRequests')}</h4>
          <p className="muted">{t('kitchen.requestsHelp')}</p>
          <DataTable
            rows={open as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.requestId)}
            onRowClick={(r) => selectRequest(String(r.requestId))}
            activeRowKey={selectedReqId}
            empty={t('kitchen.noRequests')}
            columns={[
              { sortable: true, key: 'productName', label: t('kitchen.product'), render: (r) => <strong>{String(r.productName ?? r.productCode)}</strong> },
              {
                sortable: true, key: 'remaining',
                label: t('kitchen.remaining'),
                align: 'right',
                render: (r) => {
                  const th = thresholdOf(r.productCode)
                  const rem = r.remaining == null ? null : Number(r.remaining)
                  return (
                    <Badge tone={rem != null && rem <= 0 ? 'bad' : 'neutral'}>
                      {rem == null ? '—' : fmtNum(rem)}
                      {th != null ? ` / ${fmtNum(th)}` : ''}
                    </Badge>
                  )
                },
              },
              {
                sortable: true, key: 'createdAt',
                label: t('kitchen.requestedAt'),
                render: (r) => (
                  <>
                    <strong>{fmtDateTime(r.createdAt)}</strong>
                    <div className="muted">{String(r.requestedBy ?? '')}</div>
                  </>
                ),
              },
              {
                sortable: true, key: 'lastNotifiedAt',
                label: t('kitchen.remindedAt'),
                render: (r) =>
                  r.lastNotifiedAt ? (
                    <>
                      <strong>{fmtDateTime(r.lastNotifiedAt)}</strong>
                      <div className="muted">
                        {t('kitchen.reminders')}: {fmtNum(Number(r.notifyCount) || 0)}
                      </div>
                    </>
                  ) : (
                    <span className="muted">{t('kitchen.notYetReminded')}</span>
                  ),
              },
              {
                sortable: true, key: 'status',
                label: t('kitchen.status'),
                render: (r) => <Badge tone={r.status === 'COOKING' ? 'ok' : 'bad'}>{r.status === 'COOKING' ? t('kitchen.cookingInProgress') : t('kitchen.waiting')}</Badge>,
              },
            ]}
          />
          {recentDone.length > 0 && (
            <>
              <h4 className="muted">{t('kitchen.recentDone')}</h4>
              <DataTable
                rows={recentDone as unknown as Record<string, unknown>[]}
                rowKey={(r) => String(r.requestId)}
                onRowClick={(r) => selectRequest(String(r.requestId))}
                activeRowKey={selectedReqId}
                columns={[
                  { sortable: true, key: 'productName', label: t('kitchen.product') },
                  { sortable: true, key: 'createdAt', label: t('kitchen.requestedAt'), render: (r) => fmtDateTime(r.createdAt) },
                  { sortable: true, key: 'updatedAt', label: t('kitchen.completedAt'), render: (r) => fmtDateTime(r.updatedAt) },
                  { sortable: true, key: 'handledBy', label: t('kitchen.by') },
                ]}
              />
            </>
          )}
        </>
      )}

      {tab === 'today' && (
        <>
          <FormRow>
            <Field label={t('kitchen.date')}>
              <TextInput type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
            </Field>
            <div className="actions" style={{ alignSelf: 'end' }}>
              <Button variant="ghost" onClick={() => loadReport(true)} disabled={loadingReport} title={t('kitchen.loadReport')}>
                {loadingReport ? t('common.loading') : '↻'}
              </Button>
            </div>
          </FormRow>
          {report.length > 0 && (
            <Stats
              items={[
                { label: t('kitchen.products'), value: fmtNum(report.length) },
                { label: t('kitchen.needRecook'), value: fmtNum(report.filter((i) => i.needsRecook).length), tone: report.some((i) => i.needsRecook) ? 'bad' : 'ok' },
                { label: t('kitchen.cookedToday'), value: fmtNum(report.reduce((s, i) => s + (i.cookedToday ?? 0), 0)) },
                { label: t('kitchen.soldToday'), value: fmtNum(report.reduce((s, i) => s + (i.soldToday ?? 0), 0)) },
              ]}
            />
          )}
          <DataTable
            rows={report as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.productCode ?? r.name)}
            empty={loadingReport ? t('common.loading') : t('kitchen.noReport')}
            columns={[
              { sortable: true, key: 'name', label: t('kitchen.product') },
              { sortable: true, key: 'leftoverFromYesterday', label: t('kitchen.leftover'), align: 'right', render: (r) => fmtNum(Number(r.leftoverFromYesterday) || 0) },
              { sortable: true, key: 'cookedToday', label: t('kitchen.cooked'), align: 'right', render: (r) => fmtNum(Number(r.cookedToday) || 0) },
              { sortable: true, key: 'soldToday', label: t('kitchen.sold'), align: 'right', render: (r) => fmtNum(Number(r.soldToday) || 0) },
              {
                sortable: true, key: 'remaining',
                label: t('kitchen.remaining'),
                align: 'right',
                render: (r) => (
                  <Badge tone={r.needsRecook ? 'bad' : 'ok'}>
                    {fmtNum(Number(r.remaining) || 0)} / {fmtNum(Number(r.recookThreshold) || 0)}
                  </Badge>
                ),
              },
            ]}
          />
        </>
      )}

      {tab === 'history' && (
        <>
          <FormRow>
            <Field label={t('kitchen.from')}>
              <TextInput type="date" value={hStart} onChange={(e) => setHStart(e.target.value)} />
            </Field>
            <Field label={t('kitchen.to')}>
              <TextInput type="date" value={hEnd} onChange={(e) => setHEnd(e.target.value)} />
            </Field>
            <Field label={t('kitchen.product')}>
              <TextInput
                list="kitchen-history-products"
                type="search"
                value={hProduct}
                onChange={(e) => setHProduct(e.target.value)}
                placeholder={t('common.all')}
              />
              <datalist id="kitchen-history-products">
                {products.map((p) => (
                  <option key={p.productCode} value={p.name}>
                    {p.productCode}
                  </option>
                ))}
              </datalist>
            </Field>
            <div className="actions" style={{ alignSelf: 'end' }}>
              <Button variant="ghost" onClick={() => loadHistory(true)} disabled={loadingHist} title={t('kitchen.loadHistory')}>
                {loadingHist ? t('common.loading') : '↻'}
              </Button>
            </div>
          </FormRow>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.5rem 0' }}>
            <input type="checkbox" checked={hGroup} onChange={(e) => setHGroup(e.target.checked)} />
            {t('kitchen.groupByProduct')}
          </label>
          {hGroup ? (
            <DataTable
              rows={grouped as unknown as Record<string, unknown>[]}
              rowKey={(r, i) => `${r.day}-${r.productName}-${i}`}
              empty={loadingHist ? t('common.loading') : t('kitchen.noHistory')}
              columns={[
                { sortable: true, key: 'day', label: t('kitchen.date') },
                { sortable: true, key: 'productName', label: t('kitchen.product') },
                { sortable: true, key: 'batches', label: t('kitchen.batches'), align: 'right', render: (r) => fmtNum(Number(r.batches) || 0) },
                { sortable: true, key: 'qty', label: t('kitchen.totalQty'), align: 'right', render: (r) => <strong>{fmtNum(Number(r.qty) || 0)}</strong> },
              ]}
            />
          ) : (
            <DataTable
              rows={history as unknown as Record<string, unknown>[]}
              rowKey={(r, i) => `${r.cookingId}-${i}`}
              empty={loadingHist ? t('common.loading') : t('kitchen.noHistory')}
              columns={[
                { sortable: true, key: 'startTime', label: t('kitchen.start'), render: (r) => fmtDateTime(r.startTime) },
                { sortable: true, key: 'productName', label: t('kitchen.product') },
                { sortable: true, key: 'qty', label: t('kitchen.qty'), align: 'right' },
                { sortable: true, key: 'chef', label: t('kitchen.chef') },
                { sortable: true, key: 'notes', label: t('kitchen.notes') },
              ]}
            />
          )}
        </>
      )}
      {tab === 'audit' && <CookingAudit auth={auth} />}
    </Panel>
  )
}
