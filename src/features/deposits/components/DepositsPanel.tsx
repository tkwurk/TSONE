import { useCallback, useEffect, useState } from 'react'
import type { AuthContext } from '@/services/api'
import { Button, DataTable, Field, FormRow, Notice, Panel, Select, Stats, SubTabs, TextArea, TextInput } from '@/components/ui'
import { useI18n } from '@/i18n'
import { fetchPaymentMethodsForModule, paymentIcon } from '@/features/checkout'
import type { PaymentMethod } from '@/features/checkout'
import { DailyCashReport } from './DailyCashReport'
import { fetchCashSummary, fetchDepositAccounts, fetchDepositHistory, recordDeposit, type Account, type CashSummary, type DepositRow } from '../api'

type Tab = 'cash' | 'daily' | 'deposit' | 'history'
type Msg = { tone: 'info' | 'error'; text: string }

/**
 * Deposits tab — mirrors ui_deposits.html: cash position (getCashSummary),
 * make a deposit (amount, account, payment method from the deposits module,
 * note) via recordDepositSecure, and the deposit history for this outlet.
 */
export function DepositsPanel({ auth }: { auth: AuthContext }) {
  const { t, fmtMoney } = useI18n()
  const [tab, setTab] = useState<Tab>('cash')
  const [msg, setMsg] = useState<Msg | null>(null)

  const [summary, setSummary] = useState<CashSummary | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const loadSummary = useCallback(async () => {
    setLoadingSummary(true)
    setSummary(await fetchCashSummary(auth))
    setLoadingSummary(false)
  }, [auth])

  const [accounts, setAccounts] = useState<Account[]>([])
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [amount, setAmount] = useState('')
  const [account, setAccount] = useState('')
  const [method, setMethod] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const loadForm = useCallback(async () => {
    const [accs, ms] = await Promise.all([fetchDepositAccounts(auth), fetchPaymentMethodsForModule(auth, 'deposits')])
    setAccounts(accs)
    setMethods(ms)
    if (accs.length && !account) setAccount(accs[0].name)
    if (ms.length && !method) setMethod(ms[0].name)
  }, [auth, account, method])

  const [history, setHistory] = useState<DepositRow[]>([])
  const [loadingHist, setLoadingHist] = useState(false)
  const loadHistory = useCallback(async () => {
    setLoadingHist(true)
    setHistory(await fetchDepositHistory(auth))
    setLoadingHist(false)
  }, [auth])

  useEffect(() => {
    loadSummary()
    loadForm()
    loadHistory()
  }, [loadSummary, loadForm, loadHistory])

  const submit = async () => {
    const amt = Number(amount)
    if (!(amt > 0)) return setMsg({ tone: 'error', text: t('dep.invalidAmount') })
    if (!account) return setMsg({ tone: 'error', text: t('dep.noAccount') })
    setSaving(true)
    const r = await recordDeposit({ amount: amt, account, note, paymentMethod: method || 'Dana' }, auth)
    setSaving(false)
    if (r.ok) {
      setMsg({ tone: 'info', text: `${t('dep.saved')} — ${fmtMoney(amt)} → ${account}` })
      setAmount('')
      setNote('')
      loadSummary()
      loadHistory()
    } else setMsg({ tone: 'error', text: r.error ?? '' })
  }

  return (
    <Panel title={`💰 ${t('nav.deposits')}`}>
      <SubTabs
        tabs={[
          { id: 'cash', label: `💵 ${t('dep.cashPosition')}` },
          { id: 'daily', label: `📅 ${t('cashDaily.tab')}` },
          { id: 'deposit', label: `➕ ${t('dep.make')}` },
          { id: 'history', label: `📜 ${t('dep.history')}` },
        ]}
        active={tab}
        onChange={setTab}
      />
      {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Notice>}

      {tab === 'cash' && (
        <>
          <div className="actions">
            <Button variant="ghost" onClick={loadSummary} disabled={loadingSummary}>
              {loadingSummary ? t('common.loading') : '↻'}
            </Button>
            <Button variant="ghost" onClick={() => setTab('daily')}>📅 {t('cashDaily.tab')}</Button>
            <Button onClick={() => setTab('deposit')}>➕ {t('dep.make')}</Button>
          </div>
          {summary ? (
            <>
              <Stats
                items={[
                  { label: t('dep.cashInHand'), value: fmtMoney(summary.cashInHand), tone: summary.cashInHand >= 0 ? 'ok' : 'bad' },
                  { label: t('dep.thisMonth'), value: fmtMoney(summary.currentMonthCashInHand ?? 0) },
                  { label: t('dep.totalSales'), value: fmtMoney(summary.totalSales) },
                  { label: t('dep.cashSales'), value: fmtMoney(summary.totalSalesByCash) },
                  { label: t('dep.nonCashSales'), value: fmtMoney(summary.totalSalesByNonCash) },
                  { label: t('dep.totalDeposits'), value: fmtMoney(summary.totalDeposits) },
                  { label: t('dep.expenses'), value: fmtMoney(summary.totalDeductibleExpenses) },
                  { label: t('dep.cashPurchases'), value: fmtMoney(summary.totalCashPurchases) },
                ]}
              />
              <p className="muted">
                {t('dep.formula')} · {summary.lastUpdated}
              </p>
            </>
          ) : (
            <p className="muted">{loadingSummary ? t('common.loading') : t('dep.noSummary')}</p>
          )}
        </>
      )}

      {tab === 'daily' && <DailyCashReport auth={auth} />}

      {tab === 'deposit' && (
        <>
          <FormRow>
            <Field label={t('dep.amount')}>
              <TextInput type="number" inputMode="numeric" min={0} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label={t('dep.account')}>
              <Select value={account} onChange={(e) => setAccount(e.target.value)}>
                {accounts.length === 0 && <option value="">—</option>}
                {accounts.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <h4 className="muted">💳 {t('pay.method')}</h4>
          <div className="pay__methods">
            {methods.map((m) => (
              <button key={m.pn || m.name} type="button" className={'pay__method' + (method === m.name ? ' pay__method--active' : '')} onClick={() => setMethod(m.name)}>
                <span className="pay__method-icon">{paymentIcon(m.name)}</span>
                <span>{m.name}</span>
              </button>
            ))}
          </div>
          <Field label={t('dep.note')}>
            <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="actions">
            <Button onClick={submit} disabled={saving}>
              {saving ? t('checkout.submitting') : `💾 ${t('dep.record')}`}
            </Button>
            <Button variant="ghost" onClick={() => { setAmount(''); setNote('') }}>
              {t('checkout.clear')}
            </Button>
          </div>
        </>
      )}

      {tab === 'history' && (
        <>
          <div className="actions">
            <Button variant="ghost" onClick={loadHistory} disabled={loadingHist}>
              {loadingHist ? t('common.loading') : '↻'}
            </Button>
          </div>
          <DataTable
            rows={history as unknown as Record<string, unknown>[]}
            rowKey={(_, i) => String(i)}
            empty={t('dep.noHistory')}
            columns={[
              { key: 'date', label: t('kitchen.date') },
              { key: 'amount', label: t('dep.amount'), align: 'right', render: (r) => fmtMoney(Number(r.amount) || 0) },
              { key: 'account', label: t('dep.account') },
              { key: 'paymentMethod', label: t('checkout.payment') },
              { key: 'note', label: t('dep.note') },
              { key: 'user', label: t('kitchen.by') },
            ]}
          />
        </>
      )}
    </Panel>
  )
}
