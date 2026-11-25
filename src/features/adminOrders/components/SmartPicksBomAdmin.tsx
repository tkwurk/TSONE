import { useCallback, useEffect, useState } from 'react'
import { fmtDateOnly, fmtDateTime } from '@/lib/dates'
import type { AuthContext } from '@/services/api'
import { Badge, Button, DataTable, Field, FormRow, Notice, Panel, Select, Stats, TextInput } from '@/components/ui'
import { useI18n } from '@/i18n'
import {
  fetchBom,
  fetchCookAlertStatus,
  fetchSmartPicksInfo,
  installCookAlerts,
  refreshSmartPicksNow,
  removeCookAlerts,
  removeSmartPicks,
  runCookAlertSweep,
  scheduleSmartPicks,
  fetchStockHistoryJobInfo,
  scheduleStockHistoryJob,
  type BomSummary,
  type CookAlertStatus,
  type StockHistoryJobInfo,
  type SmartPicksInfo,
  type SweepResult,
} from '../api'

type Msg = { tone: 'info' | 'error'; text: string }

/** Automation: Smart picks cache/trigger + cooking stock alert trigger. */
export function AutomationAdmin({ auth }: { auth: AuthContext }) {
  return (
    <>
      <CookAlertsAdmin auth={auth} />
      <SmartPicksAdmin auth={auth} />
      <StockHistoryAdmin auth={auth} />
    </>
  )
}

/** Cooking stock alerts (cookingAlerts.gs): a 5-minute server sweep that opens cook requests and emails chefs/managers. */
export function CookAlertsAdmin({ auth }: { auth: AuthContext }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<CookAlertStatus | null>(null)
  const [sweep, setSweep] = useState<SweepResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const load = useCallback(async () => {
    const r = await fetchCookAlertStatus(auth)
    if (r.ok) setStatus(r.data)
    else setMsg({ tone: 'error', text: r.error ?? '' })
  }, [auth])
  useEffect(() => {
    load()
  }, [load])

  const act = async (fn: () => Promise<{ ok: boolean; error: string | null }>, okText: string) => {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (r.ok) {
      setMsg({ tone: 'info', text: okText })
      load()
    } else setMsg({ tone: 'error', text: r.error ?? '' })
  }

  const sweepNow = async () => {
    setBusy(true)
    setSweep(null)
    const r = await runCookAlertSweep(auth)
    setBusy(false)
    if (r.ok) {
      setSweep(r.data)
      setMsg({ tone: 'info', text: t('adm.sweepDone') })
      load()
    } else setMsg({ tone: 'error', text: r.error ?? '' })
  }

  return (
    <Panel title={`🔔 ${t('adm.cookAlerts')}`}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="muted">{t('adm.cookAlertsHelp')}</p>
      {status && (
        <Stats
          items={[
            { label: t('adm.alertTrigger'), value: status.installed ? t('adm.active') : t('adm.inactive'), tone: status.installed ? 'ok' : 'bad' },
            { label: t('adm.sweepEvery'), value: `${status.sweepMinutes ?? 5} min` },
            { label: t('adm.remindEvery'), value: `${status.reminderMinutes ?? 30} min` },
            {
              label: t('adm.pushDevices'),
              value: status.pushConfigured ? String(status.pushDevices ?? 0) : t('adm.pushOff'),
              tone: status.pushConfigured && (status.pushDevices ?? 0) > 0 ? 'ok' : 'bad',
            },
          ]}
        />
      )}
      {status && !status.installed && <Notice tone="warn">{t('adm.cookAlertsOff')}</Notice>}
      {status && !status.pushConfigured && <Notice tone="warn">{t('adm.pushNotConfigured')}</Notice>}
      {status?.pushConfigured && !status.pushDevices && <Notice tone="warn">{t('adm.noPushDevices')}</Notice>}
      <div className="actions">
        {status?.installed ? (
          <Button variant="ghost" disabled={busy} onClick={() => act(() => removeCookAlerts(auth), t('adm.triggerRemoved'))}>
            🗑️ {t('adm.removeTrigger')}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => act(() => installCookAlerts(auth), t('adm.cookAlertsInstalled'))}>
            ✅ {t('adm.enableCookAlerts')}
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={sweepNow}>
          {busy ? t('common.loading') : `▶ ${t('adm.runSweepNow')}`}
        </Button>
      </div>
      {sweep?.summary && (
        <>
          <DataTable
            rows={(sweep.summary.outlets ?? []) as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.outlet || '(all)')}
            empty={t('adm.noOutletsSwept')}
            columns={[
              { key: 'outlet', label: t('checkout.outlet'), render: (r) => String(r.outlet || '(all)') },
              { key: 'products', label: t('kitchen.products'), align: 'right' },
              { key: 'below', label: t('kitchen.needRecook'), align: 'right' },
              { key: 'created', label: t('adm.requestsCreated'), align: 'right' },
              { key: 'updated', label: t('adm.requestsUpdated'), align: 'right' },
              {
                key: 'push',
                label: t('adm.pushSent'),
                align: 'right',
                render: (r) => (
                  <>
                    <Badge tone={Number(r.push) > 0 ? 'ok' : r.pushNote ? 'bad' : 'neutral'}>{String(r.push ?? 0)}</Badge>
                    {r.pushNote ? <div className="muted">{String(r.pushNote)}</div> : null}
                  </>
                ),
              },
            ]}
          />
          {(sweep.summary.errors ?? []).map((e, i) => (
            <Notice key={i} tone="error">
              {e.outlet}: {e.error}
            </Notice>
          ))}
        </>
      )}
    </Panel>
  )
}

/** Mirrors ui_adminOrders.html "Smart Picks" pane: cache status + daily trigger management. */
export function SmartPicksAdmin({ auth }: { auth: AuthContext }) {
  const { t, fmtNum } = useI18n()
  const [info, setInfo] = useState<SmartPicksInfo | null>(null)
  const [hour, setHour] = useState('0')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const load = useCallback(async () => {
    const r = await fetchSmartPicksInfo(auth)
    if (r.ok) setInfo(r.data)
    else setMsg({ tone: 'error', text: r.error ?? '' })
  }, [auth])
  useEffect(() => {
    load()
  }, [load])

  const run = async (fn: () => Promise<{ ok: boolean; error: string | null; data: unknown }>, okText: (d: unknown) => string) => {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (r.ok) {
      setMsg({ tone: 'info', text: okText(r.data) })
      load()
    } else setMsg({ tone: 'error', text: r.error ?? '' })
  }

  return (
    <Panel title={`⚡ ${t('adm.smartPicks')}`}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="muted">{t('adm.smartPicksHelp')}</p>
      {info && (
        <Stats
          items={[
            { label: t('adm.trigger'), value: info.triggerActive ? t('adm.active') : t('adm.inactive'), tone: info.triggerActive ? 'ok' : 'bad' },
            { label: t('adm.lastUpdated'), value: info.lastUpdated ? fmtDateTime(info.lastUpdated) : '—' },
            { label: t('adm.cachedRows'), value: fmtNum(Number(info.totalRows) || 0) },
          ]}
        />
      )}
      <FormRow>
        <Field label={t('adm.hour')}>
          <Select value={hour} onChange={(e) => setHour(e.target.value)}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        </Field>
        <div className="actions" style={{ alignSelf: 'end' }}>
          <Button disabled={busy} onClick={() => run(() => scheduleSmartPicks(Number(hour), auth), (d) => (d as { message?: string })?.message ?? t('common.saved'))}>
            ⏰ {t('adm.schedule')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => run(() => removeSmartPicks(auth), () => t('adm.triggerRemoved'))}>
            🗑️ {t('adm.removeTrigger')}
          </Button>
          <Button disabled={busy} onClick={() => run(() => refreshSmartPicksNow(auth), (d) => (d as { message?: string })?.message ?? t('adm.refreshed'))}>
            {busy ? t('common.loading') : `🔄 ${t('adm.refreshNow')}`}
          </Button>
        </div>
      </FormRow>
    </Panel>
  )
}

/** Daily Stock_History snapshot scheduling. */
export function StockHistoryAdmin({ auth }: { auth: AuthContext }) {
  const { t } = useI18n()
  const [info, setInfo] = useState<StockHistoryJobInfo | null>(null)
  const [hour, setHour] = useState('0')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const load = useCallback(async () => {
    const r = await fetchStockHistoryJobInfo(auth)
    if (!r.success || !r.data) {
      setMsg({ tone: 'error', text: r.error ?? '' })
      return
    }
    setInfo(r.data)
    if (r.data.scheduleHour != null) setHour(String(r.data.scheduleHour))
  }, [auth])

  useEffect(() => {
    let active = true
    fetchStockHistoryJobInfo(auth).then((r) => {
      if (!active) return
      if (!r.success || !r.data) {
        setMsg({ tone: 'error', text: r.error ?? '' })
        return
      }
      setInfo(r.data)
      if (r.data.scheduleHour != null) setHour(String(r.data.scheduleHour))
    })
    return () => {
      active = false
    }
  }, [auth])

  const schedule = async () => {
    setBusy(true)
    setMsg(null)
    const r = await scheduleStockHistoryJob(Number(hour), auth)
    setBusy(false)
    if (!r.success || !r.data) {
      setMsg({ tone: 'error', text: r.error ?? '' })
      return
    }
    setMsg({ tone: 'info', text: r.data.message ?? t('adm.stockHistoryScheduled') })
    await load()
  }

  return (
    <Panel title={`📦 ${t('adm.stockHistory')}`}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="muted">{t('adm.stockHistoryHelp')}</p>
      {info && (
        <Stats
          items={[
            { label: t('adm.trigger'), value: info.triggerActive ? t('adm.active') : t('adm.inactive'), tone: info.triggerActive ? 'ok' : 'bad' },
            { label: t('adm.hour'), value: info.scheduleHour == null ? '—' : `${String(info.scheduleHour).padStart(2, '0')}:00` },
            { label: t('adm.lastUpdated'), value: info.lastRun ? fmtDateTime(info.lastRun) : '—' },
            { label: t('adm.lastBusinessDate'), value: info.lastBusinessDate ? fmtDateOnly(info.lastBusinessDate) : '—' },
            { label: t('adm.timeZone'), value: info.timeZone || '—' },
          ]}
        />
      )}
      <FormRow>
        <Field label={t('adm.hour')}>
          <Select value={hour} onChange={(e) => setHour(e.target.value)}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        </Field>
        <div className="actions" style={{ alignSelf: 'end' }}>
          <Button disabled={busy} onClick={schedule}>
            {busy ? t('common.loading') : `⏰ ${t('adm.schedule')}`}
          </Button>
        </div>
      </FormRow>
    </Panel>
  )
}

/** Mirrors ui_adminOrders.html "BOM consumption" pane: read-only recipe summary. */
export function BomAdmin({ auth }: { auth: AuthContext }) {
  const { t, fmtNum } = useI18n()
  const [bom, setBom] = useState<BomSummary | null>(null)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchBom(auth)
    setLoading(false)
    if (r.ok) setBom(r.data)
    else setError(r.error)
  }, [auth])
  useEffect(() => {
    load()
  }, [load])

  const ql = q.trim().toLowerCase()
  const lines = (bom?.lines ?? []).filter((l) => !ql || l.unitProductCode.toLowerCase().includes(ql) || l.recipeItemCode.toLowerCase().includes(ql) || l.bomId.toLowerCase().includes(ql))

  return (
    <Panel title={`🧾 ${t('adm.bom')}`}>
      {error && <Notice tone="error">{error}</Notice>}
      <p className="muted">{t('adm.bomHelp')}</p>
      {bom && (
        <Stats
          items={[
            { label: t('adm.bomLines'), value: fmtNum(Number(bom.totalLines) || bom.lines.length) },
            { label: t('adm.unitProducts'), value: fmtNum(Number(bom.unitProductCount) || 0) },
            { label: t('adm.sheet'), value: bom.sheetName ?? '—' },
          ]}
        />
      )}
      <FormRow>
        <Field label={t('checkout.search')}>
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <div className="actions" style={{ alignSelf: 'end' }}>
          <Button variant="ghost" onClick={load} disabled={loading}>
            {loading ? t('common.loading') : '↻'}
          </Button>
        </div>
      </FormRow>
      <DataTable
        rows={lines as unknown as Record<string, unknown>[]}
        rowKey={(r, i) => `${r.bomId}-${i}`}
        empty={loading ? t('common.loading') : t('adm.noBom')}
        columns={[
          { key: 'bomId', label: 'BOM', render: (r) => <code>{String(r.bomId)}</code> },
          { key: 'unitProductCode', label: t('adm.unitProduct') },
          { key: 'recipeItemCode', label: t('adm.recipeItem') },
          { key: 'itemQuantity', label: t('purch.qty'), align: 'right', render: (r) => String(r.itemQuantityDisplay ?? r.itemQuantity ?? '') },
          { key: 'status', label: t('kitchen.status'), render: (r) => <Badge tone={String(r.status ?? 'Active').toLowerCase() === 'active' ? 'ok' : 'neutral'}>{String(r.status ?? '')}</Badge> },
        ]}
      />
    </Panel>
  )
}
