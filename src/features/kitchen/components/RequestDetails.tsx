import { useState, type Ref } from 'react'
import type { AuthContext } from '@/services/api'
import { Badge, Button, Notice, Stats } from '@/components/ui'
import { useI18n } from '@/i18n'
import { fmtDateTime } from '@/lib/dates'
import { updateCookRequestStatus, type CookRequest } from '../api'
import './kitchen.css'

/**
 * One kitchen request, opened from a notification, the bell or the Requests
 * table — with the actions the kitchen can take. Status changes go through
 * updateCookRequestStatusSecure (the server checks Kitchen permission).
 */
export function RequestDetails({
  ref,
  auth,
  request,
  loaded,
  threshold,
  onCook,
  onChanged,
  onClose,
}: {
  ref?: Ref<HTMLDivElement>
  auth: AuthContext
  request: CookRequest | null
  /** True once the feed has loaded, so "not found" is real. */
  loaded: boolean
  threshold?: number
  onCook: (r: CookRequest) => void
  onChanged: () => Promise<void> | void
  onClose: () => void
}) {
  const { t, fmtNum } = useI18n()
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)

  const setStatus = async (status: 'COOKING' | 'DONE' | 'CANCELLED') => {
    if (!request) return
    if (status === 'CANCELLED' && !window.confirm(`${t('kitchen.confirmCancel')}\n${request.productName || request.productCode}`)) return
    setBusy(status)
    setMsg(null)
    const r = await updateCookRequestStatus(request.requestId, status, auth)
    setBusy('')
    if (!r.ok) return setMsg({ tone: 'error', text: r.error ?? '' })
    setMsg({ tone: 'info', text: t(`kitchen.status.${status}`) })
    await onChanged()
  }

  const status = request?.status ?? ''
  const isOpen = status === 'REQUESTED' || status === 'COOKING'

  return (
    <section ref={ref} className="kitchen-request" tabIndex={-1} aria-label={t('kitchen.requestDetails')}>
      <div className="kitchen-request__head">
        <h3>🔔 {request ? request.productName || request.productCode : t('kitchen.requestDetails')}</h3>
        <Button variant="ghost" onClick={onClose} aria-label={t('kitchen.closeDetails')}>
          ✕
        </Button>
      </div>

      {!request ? (
        <p className="muted">{loaded ? t('kitchen.requestGone') : t('common.loading')}</p>
      ) : (
        <>
          <div className="actions">
            <Badge tone={status === 'COOKING' ? 'ok' : isOpen ? 'bad' : 'neutral'}>
              {status === 'COOKING'
                ? t('kitchen.cookingInProgress')
                : status === 'REQUESTED'
                  ? t('kitchen.waiting')
                  : t(`kitchen.status.${status}`)}
            </Badge>
            {request.source && <span className="muted">{t('kitchen.source')}: {request.source}</span>}
          </div>
          <Stats
            items={[
              {
                label: t('kitchen.remaining'),
                value: `${request.remaining == null ? '—' : fmtNum(request.remaining)}${threshold != null ? ` / ${fmtNum(threshold)}` : ''}`,
                tone: request.remaining != null && request.remaining <= 0 ? 'bad' : undefined,
              },
              { label: t('kitchen.requestedQty'), value: request.requestedQty ? fmtNum(request.requestedQty) : '—' },
              { label: t('kitchen.requestedAt'), value: fmtDateTime(request.createdAt) },
              { label: t('kitchen.requestedBy'), value: request.requestedBy || '—' },
            ]}
          />
          <p className="muted">
            {request.lastNotifiedAt
              ? `${t('kitchen.remindedAt')}: ${fmtDateTime(request.lastNotifiedAt)} · ${t('kitchen.reminders')}: ${fmtNum(Number(request.notifyCount) || 0)}`
              : `${t('kitchen.remindedAt')}: ${t('kitchen.notYetReminded')}`}
            {request.handledBy ? ` · ${t('kitchen.by')}: ${request.handledBy} (${fmtDateTime(request.updatedAt)})` : ''}
          </p>
          {request.notes && (
            <p>
              <strong>{t('kitchen.notes')}:</strong> {request.notes}
            </p>
          )}
          {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Notice>}
          {isOpen ? (
            <>
              <p className="muted">{t('kitchen.requestActionsHelp')}</p>
              <div className="actions">
                <Button onClick={() => onCook(request)} disabled={!!busy}>
                  🍳 {t('kitchen.logCooked')}
                </Button>
                {status === 'REQUESTED' && (
                  <Button variant="ghost" onClick={() => setStatus('COOKING')} disabled={!!busy}>
                    {busy === 'COOKING' ? t('common.loading') : `▶ ${t('kitchen.startCooking')}`}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setStatus('DONE')} disabled={!!busy}>
                  {busy === 'DONE' ? t('common.loading') : `✓ ${t('kitchen.markDone')}`}
                </Button>
                <Button variant="ghost" onClick={() => setStatus('CANCELLED')} disabled={!!busy}>
                  {busy === 'CANCELLED' ? t('common.loading') : t('kitchen.cancelRequest')}
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  )
}
