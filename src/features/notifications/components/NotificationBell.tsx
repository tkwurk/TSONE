import { useEffect, useRef, useState } from 'react'
import { Badge, Button } from '@/components/ui'
import { useI18n } from '@/i18n'
import { fmtTimeOnly } from '@/lib/dates'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { isReminder, useKitchenRequestFeed } from '../feedContext'
import {
  isMuted,
  notifyPermission,
  notifySupport,
  requestNotifyPermission,
  setMuted,
  type NotifyPermission,
} from '../systemNotify'
import './notifications.css'

/**
 * Top-bar bell for kitchen requests: unread count, a panel listing open
 * requests (tap one to open its details in Kitchen → Requests), and the
 * per-device switch for phone/desktop notifications.
 */
export function NotificationBell({ onOpenRequest, onViewAll }: { onOpenRequest: (requestId: string) => void; onViewAll: () => void }) {
  const { t, fmtNum } = useI18n()
  const feed = useKitchenRequestFeed()
  const [open, setOpen] = useState(false)
  const [permission, setPermission] = useState<NotifyPermission>(notifyPermission)
  const [muted, setMutedState] = useState(isMuted)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useDialogFocus(open, panelRef, { onClose: () => setOpen(false), returnFocusRef: triggerRef })

  // Close when tapping outside the bell + panel.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  if (!feed.enabled) return null

  const unread = feed.unreadCount
  const { needsInstall } = notifySupport()
  const label = unread ? `${t('notify.bell')} — ${fmtNum(unread)} ${t('notify.unread')}` : t('notify.bell')

  const enable = async () => {
    const p = await requestNotifyPermission()
    setPermission(p)
    setMutedState(isMuted())
    if (p === 'granted') await feed.setPush(true)
  }
  const toggleMute = async () => {
    setMuted(!muted)
    setMutedState(!muted)
    await feed.setPush(muted) // was muted → turning on
  }
  const openRequest = (id: string) => {
    feed.markRead([id])
    setOpen(false)
    onOpenRequest(id)
  }

  return (
    <div className="notify" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={'notify__bell' + (unread ? ' notify__bell--unread' : '')}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notify-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span className="notify__count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div id="notify-panel" ref={panelRef} className="notify__panel" role="dialog" aria-modal="false" aria-label={t('notify.panelTitle')} tabIndex={-1}>
          <div className="notify__head">
            <h2>{t('notify.panelTitle')}</h2>
            <Button variant="ghost" onClick={() => feed.markRead()} disabled={!unread} data-dialog-initial={unread ? true : undefined}>
              {t('notify.markAllRead')}
            </Button>
          </div>

          {feed.error && <p className="notify__error">{feed.error}</p>}
          {feed.open.length === 0 ? (
            <p className="muted notify__empty">{feed.loading && !feed.loadedAt ? t('common.loading') : t('notify.none')}</p>
          ) : (
            <ul className="notify__list">
              {feed.open.map((r) => {
                const isNew = feed.isUnread(r)
                return (
                  <li key={r.requestId}>
                    <button type="button" className={'notify__item' + (isNew ? ' notify__item--unread' : '')} onClick={() => openRequest(r.requestId)}>
                      <span className="notify__dot" aria-hidden="true" />
                      <span className="notify__text">
                        <strong>
                          {isReminder(r) ? '⏰ ' : ''}
                          {r.productName || r.productCode}
                        </strong>
                        <span className="muted">
                          {r.remaining != null ? `${t('kitchen.remaining')} ${fmtNum(r.remaining)} · ` : ''}
                          {r.requestedBy ? `${t('notify.by')} ${r.requestedBy} · ` : ''}
                          {fmtTimeOnly(r.lastNotifiedAt || r.createdAt)}
                        </span>
                      </span>
                      <Badge tone={r.status === 'COOKING' ? 'ok' : 'bad'}>
                        {r.status === 'COOKING' ? t('kitchen.cookingInProgress') : t('kitchen.waiting')}
                      </Badge>
                      {isNew && <span className="sr-only">{t('notify.unreadItem')}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="notify__foot">
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false)
                onViewAll()
              }}
            >
              {t('notify.viewAll')}
            </Button>
          </div>

          <div className="notify__settings">
            {permission === 'unsupported' || needsInstall ? (
              <p className="muted">{needsInstall ? t('notify.needsInstall') : t('notify.unsupported')}</p>
            ) : permission === 'default' ? (
              <>
                <p className="muted">{t('notify.whyEnable')}</p>
                <Button onClick={enable}>🔔 {t('notify.enable')}</Button>
              </>
            ) : permission === 'denied' ? (
              <p className="muted">{t('notify.denied')}</p>
            ) : (
              <>
                <label className="notify__toggle">
                  <input type="checkbox" checked={!muted} onChange={toggleMute} />
                  {t('notify.onThisDevice')}
                </label>
                {!muted && (
                  <p className="muted" aria-live="polite">
                    {feed.push === 'on'
                      ? `✓ ${t('notify.pushOn')}`
                      : feed.push === 'checking'
                        ? t('notify.pushChecking')
                        : feed.push === 'error'
                          ? t('notify.pushError')
                          : t('notify.pushOpenOnly')}
                  </p>
                )}
                {!muted && feed.push === 'error' && (
                  <Button variant="ghost" onClick={() => feed.setPush(true)}>
                    {t('notify.retry')}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
