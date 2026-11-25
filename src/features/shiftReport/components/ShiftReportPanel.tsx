import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthContext } from '@/services/api'
import { Badge, Button, DataTable, Field, FormRow, Notice, Panel, Select, Stats, SubTabs, TextArea, TextInput } from '@/components/ui'
import { useI18n } from '@/i18n'
import { fmtTimeOnly } from '@/lib/dates'
import {
  getShiftReport,
  newShiftRequestId,
  submitShiftReport,
  type ShiftKitchenItem,
  type ShiftReportBundle,
  type ShiftReportRow,
  type ShiftReportSummary,
} from '../api'
import { ShiftHistory } from './ShiftHistory'
import { ShiftReportDetails } from './ShiftReportDetails'
import './shiftReport.css'

/** Shift report tab: submit a new handover report, or browse past ones. */
export function ShiftReportPanel({ auth }: { auth: AuthContext }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'new' | 'history'>('new')
  return (
    <Panel title={`🤝 ${t('nav.shiftReport')}`}>
      <SubTabs
        tabs={[
          { id: 'new', label: `📝 ${t('shift.newReport')}` },
          { id: 'history', label: `📜 ${t('shift.history')}` },
        ]}
        active={tab}
        onChange={setTab}
      />
      {/* The form stays mounted so typed counts survive a look at History. */}
      <div hidden={tab !== 'new'}>
        <ShiftReportForm auth={auth} />
      </div>
      {tab === 'history' && <ShiftHistory auth={auth} />}
    </Panel>
  )
}

/** Per kitchen item: confirmed as correct, or the real count typed in. */
type KitchenCheck = { confirmed: boolean; actual: string }

/**
 * Shift report — end-of-shift handover. Staff count the cash and pick who
 * receives it, then confirm (or correct) each kitchen item's remaining count.
 * Expected cash, kitchen counts and all differences come from the server
 * (ShiftWorker); this screen only collects what was counted.
 */
function ShiftReportForm({ auth }: { auth: AuthContext }) {
  const { t, fmtMoney, fmtNum } = useI18n()
  const [bundle, setBundle] = useState<ShiftReportBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [counted, setCounted] = useState('')
  const [receiverId, setReceiverId] = useState('')
  const [cashConfirmed, setCashConfirmed] = useState(false)
  const [checks, setChecks] = useState<Record<string, KitchenCheck>>({})
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<ShiftReportSummary | null>(null)
  const requestId = useRef(newShiftRequestId())

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const r = await getShiftReport(auth)
    setLoading(false)
    if (!r.success || !r.data) return setError(String(r.error ?? t('shift.loadFailed')))
    setBundle(r.data)
  }, [auth, t])

  useEffect(() => {
    load()
  }, [load])

  const check = (code: string): KitchenCheck => checks[code] ?? { confirmed: false, actual: '' }
  const setCheck = (code: string, patch: Partial<KitchenCheck>) =>
    setChecks((prev) => ({ ...prev, [code]: { ...check(code), ...patch } }))
  const markAllCorrect = () =>
    setChecks(Object.fromEntries((bundle?.kitchen ?? []).map((k) => [k.productCode, { confirmed: true, actual: '' }])))

  const kitchen = bundle?.kitchen ?? []
  const pendingKitchen = kitchen.filter((k) => {
    const c = check(k.productCode)
    return !c.confirmed && !(c.actual.trim() !== '' && Number(c.actual) >= 0)
  })
  const receiverName = bundle?.staff.find((s) => s.id === receiverId)?.name ?? ''

  const missing: string[] = []
  if (counted.trim() === '' || !(Number(counted) >= 0)) missing.push(t('shift.needCash'))
  if (!receiverId) missing.push(t('shift.needReceiver'))
  if (!cashConfirmed) missing.push(t('shift.needConfirm'))
  if (pendingKitchen.length) missing.push(`${t('shift.needKitchen')} (${pendingKitchen.length})`)

  const submit = async () => {
    if (!bundle || missing.length) return
    setSaving(true)
    setError('')
    const r = await submitShiftReport(
      {
        countedCash: Number(counted),
        cashConfirmed,
        receiverId,
        kitchen: kitchen.map((k) => {
          const c = check(k.productCode)
          return c.confirmed ? { productCode: k.productCode, confirmed: true } : { productCode: k.productCode, actual: Number(c.actual) }
        }),
        notes,
      },
      requestId.current,
      auth,
    )
    setSaving(false)
    if (!r.success || !r.data) return setError(String(r.error ?? t('shift.saveFailed')))
    setSaved(r.data)
    requestId.current = newShiftRequestId()
  }

  const startNew = () => {
    setSaved(null)
    setCounted('')
    setReceiverId('')
    setCashConfirmed(false)
    setChecks({})
    setNotes('')
    load()
  }

  if (saved) {
    return (
      <>
        <Notice tone="info">✅ {t('shift.saved')}</Notice>
        <ShiftReportDetails
          report={saved}
          actions={
            <Button variant="ghost" onClick={startNew}>
              {t('shift.newReport')}
            </Button>
          }
        />
      </>
    )
  }

  return (
    <>
      <div className="actions">
        <span className="muted">
          {bundle ? `${bundle.outlet} · ${t('shift.businessDate')} ${bundle.businessDate} · ${t('shift.asOf')} ${fmtTimeOnly(bundle.asOf)}` : ''}
        </span>
        <Button variant="ghost" onClick={load} disabled={loading || saving}>
          {loading ? t('common.loading') : '↻'}
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!bundle ? (
        <p className="muted">{loading ? t('common.loading') : ''}</p>
      ) : (
        <>
          <section className="shift__section">
            <h3>💵 {t('shift.cash')}</h3>
            <Stats items={[{ label: t('shift.expectedCash'), value: fmtMoney(bundle.expectedCash) }]} />
            <FormRow>
              <Field label={t('shift.countedCash')}>
                <TextInput
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1000}
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                />
              </Field>
              <Field label={t('shift.handedTo')}>
                <Select value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
                  <option value="">{t('shift.chooseReceiver')}</option>
                  {bundle.staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormRow>
            {bundle.staff.length === 0 && <Notice tone="error">{t('shift.noStaff')}</Notice>}
            <label className="shift__check">
              <input type="checkbox" checked={cashConfirmed} onChange={(e) => setCashConfirmed(e.target.checked)} />
              {receiverName ? `${t('shift.confirmCashTo')} ${receiverName}` : t('shift.confirmCash')}
            </label>
          </section>

          <section className="shift__section">
            <div className="actions">
              <h3>👨‍🍳 {t('shift.kitchen')}</h3>
              {kitchen.length > 0 && (
                <Button variant="ghost" onClick={markAllCorrect}>
                  ✓ {t('shift.markAllCorrect')}
                </Button>
              )}
            </div>
            {kitchen.length === 0 ? (
              <p className="muted">{t('shift.noKitchen')}</p>
            ) : (
              <ul className="shift__kitchen">
                {kitchen.map((k: ShiftKitchenItem) => {
                  const c = check(k.productCode)
                  return (
                    <li key={k.productCode} className={'shift__item' + (c.confirmed ? ' shift__item--ok' : '')}>
                      <div className="shift__item-name">
                        <strong>{k.name}</strong>
                        <span className="muted">
                          {t('shift.cooked')} {fmtNum(k.cookedToday)} · {t('shift.sold')} {fmtNum(k.soldToday)}
                          {k.leftoverFromYesterday ? ` · ${t('shift.leftover')} ${fmtNum(k.leftoverFromYesterday)}` : ''}
                        </span>
                      </div>
                      <div className="shift__item-count">
                        <span>
                          {t('shift.system')}: <strong>{fmtNum(k.remaining)}</strong>
                        </span>
                        <label className="shift__check">
                          <input
                            type="checkbox"
                            checked={c.confirmed}
                            onChange={(e) => setCheck(k.productCode, { confirmed: e.target.checked, actual: '' })}
                          />
                          {t('shift.correct')}
                        </label>
                        {!c.confirmed && (
                          <TextInput
                            type="number"
                            inputMode="decimal"
                            min={0}
                            placeholder={t('shift.actual')}
                            aria-label={`${t('shift.actual')} — ${k.name}`}
                            value={c.actual}
                            onChange={(e) => setCheck(k.productCode, { actual: e.target.value })}
                          />
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="shift__section">
            <Field label={t('shift.notes')}>
              <TextArea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </section>

          {missing.length > 0 && (
            <p className="muted">
              {t('shift.stillNeeded')}: {missing.join(' · ')}
            </p>
          )}
          <div className="actions">
            <Button onClick={submit} disabled={saving || missing.length > 0}>
              {saving ? t('shift.saving') : `📨 ${t('shift.submit')}`}
            </Button>
          </div>

          {bundle.todayReports.length > 0 && (
            <section className="shift__section">
              <h3>📜 {t('shift.todayReports')}</h3>
              <DataTable<ShiftReportRow & Record<string, unknown>>
                columns={[
                  { key: 'submittedAt', label: t('shift.time'), render: (r) => fmtTimeOnly(r.submittedAt) },
                  { key: 'submittedBy', label: t('shift.submittedBy') },
                  { key: 'handedTo', label: t('shift.handedTo') },
                  { key: 'countedCash', label: t('shift.countedCash'), align: 'right', render: (r) => fmtMoney(r.countedCash) },
                  {
                    key: 'cashVariance',
                    label: t('shift.variance'),
                    align: 'right',
                    render: (r) => <Badge tone={r.cashVariance === 0 ? 'ok' : 'bad'}>{fmtMoney(r.cashVariance)}</Badge>,
                  },
                  { key: 'kitchenMismatches', label: t('shift.kitchenDiffs'), align: 'right' },
                ]}
                rows={bundle.todayReports as (ShiftReportRow & Record<string, unknown>)[]}
                rowKey={(r) => r.reportId}
              />
            </section>
          )}
        </>
      )}
    </>
  )
}
