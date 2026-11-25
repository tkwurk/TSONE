import { useState, type ReactNode } from 'react'
import { Badge, Button, DataTable, Notice, Stats } from '@/components/ui'
import { useI18n } from '@/i18n'
import { fmtDateTime } from '@/lib/dates'
import type { ShiftKitchenMismatch, ShiftReportSummary } from '../api'

type KitchenRow = ShiftKitchenMismatch & Record<string, unknown>

/**
 * One saved shift report: cash figures, receiver, kitchen lines, notes and a
 * Share button. All figures are as saved by the server. With `kitchenDetails`
 * every kitchen line is listed; otherwise only the mismatches.
 */
export function ShiftReportDetails({
  report,
  actions,
}: {
  report: ShiftReportSummary & { kitchenDetails?: ShiftKitchenMismatch[] }
  actions?: ReactNode
}) {
  const { t, fmtMoney, fmtNum } = useI18n()
  const [shareMsg, setShareMsg] = useState('')
  const signed = (n: number) => `${n > 0 ? '+' : ''}${fmtNum(n)}`
  const kitchenRows = (report.kitchenDetails ?? report.kitchenMismatches) as KitchenRow[]

  const summaryText = () =>
    [
      `${t('nav.shiftReport')} — ${report.outlet} · ${report.businessDate}`,
      `${t('shift.submittedBy')}: ${report.submittedBy} → ${t('shift.handedTo')}: ${report.handedTo}`,
      `${t('shift.expectedCash')}: ${fmtMoney(report.expectedCash)}`,
      `${t('shift.countedCash')}: ${fmtMoney(report.countedCash)}`,
      `${t('shift.variance')}: ${fmtMoney(report.cashVariance)}`,
      report.kitchenMismatches.length
        ? `${t('shift.kitchenDiffs')}:\n` +
          report.kitchenMismatches.map((m) => `• ${m.name}: ${fmtNum(m.system)} → ${fmtNum(m.actual)} (${signed(m.diff)})`).join('\n')
        : `${t('shift.kitchenAllCorrect')} (${report.kitchenItems})`,
      report.notes ? `${t('shift.notes')}: ${report.notes}` : '',
      fmtDateTime(report.submittedAt),
    ]
      .filter(Boolean)
      .join('\n')

  const share = async () => {
    const text = summaryText()
    try {
      if (navigator.share) {
        await navigator.share({ title: t('nav.shiftReport'), text })
        return
      }
      await navigator.clipboard.writeText(text)
      setShareMsg(t('shift.copied'))
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setShareMsg(t('shift.shareFailed'))
    }
  }

  return (
    <div className="shift__details">
      <p className="muted">
        {report.outlet} · {t('shift.businessDate')} {report.businessDate} · {report.submittedBy} · {fmtDateTime(report.submittedAt)}
      </p>
      <Stats
        items={[
          { label: t('shift.expectedCash'), value: fmtMoney(report.expectedCash) },
          { label: t('shift.countedCash'), value: fmtMoney(report.countedCash) },
          { label: t('shift.variance'), value: fmtMoney(report.cashVariance), tone: report.cashVariance === 0 ? 'ok' : 'bad' },
          { label: t('shift.handedTo'), value: report.handedTo },
        ]}
      />
      <h4>👨‍🍳 {t('shift.kitchen')}</h4>
      {kitchenRows.length ? (
        <>
          {!report.kitchenMismatches.length && <p className="muted">{t('shift.kitchenAllCorrect')}</p>}
          <DataTable<KitchenRow>
            columns={[
              { key: 'name', label: t('shift.item') },
              { key: 'system', label: t('shift.system'), align: 'right', render: (m) => fmtNum(m.system) },
              { key: 'actual', label: t('shift.actual'), align: 'right', render: (m) => fmtNum(m.actual) },
              {
                key: 'diff',
                label: t('shift.diff'),
                align: 'right',
                render: (m) => (m.diff === 0 ? <Badge tone="ok">✓</Badge> : <Badge tone="bad">{signed(m.diff)}</Badge>),
              },
            ]}
            rows={kitchenRows}
            rowKey={(m) => String(m.productCode)}
          />
        </>
      ) : (
        <p className="muted">
          {report.kitchenItems ? `${t('shift.kitchenAllCorrect')} (${report.kitchenItems})` : t('shift.noKitchen')}
        </p>
      )}
      {report.notes && (
        <p>
          <strong>{t('shift.notes')}:</strong> {report.notes}
        </p>
      )}
      <p className="muted">{report.reportId}</p>
      {shareMsg && <Notice tone="info">{shareMsg}</Notice>}
      <div className="actions">
        <Button onClick={share}>📤 {t('shift.share')}</Button>
        {actions}
      </div>
    </div>
  )
}
