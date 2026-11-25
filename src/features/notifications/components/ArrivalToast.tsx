import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { useI18n } from '@/i18n'
import { isReminder, useKitchenRequestFeed } from '../feedContext'

const SHOW_MS = 12_000

/**
 * In-app alert for kitchen requests that arrive while the app is on screen
 * (system notifications are only used when it's in the background). Polite
 * live region; stays while hovered or focused; the bell keeps the request.
 */
export function ArrivalToast({ onOpenRequest }: { onOpenRequest: (requestId: string) => void }) {
  const { t } = useI18n()
  const { arrival, dismissArrival, markRead } = useKitchenRequestFeed()
  const [hold, setHold] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!arrival || hold) return
    const id = window.setTimeout(dismissArrival, SHOW_MS)
    return () => window.clearTimeout(id)
  }, [arrival, hold, dismissArrival])

  const r = arrival?.request
  const name = r ? r.productName || r.productCode : ''
  const text = !r
    ? ''
    : `${isReminder(r) ? `⏰ ${t('notify.reminderTitle')}` : `🍳 ${t('notify.newTitle')}`}: ${name}` +
      (arrival && arrival.count > 1 ? ` (+${arrival.count - 1} ${t('notify.more')})` : '')

  return (
    // The live region stays mounted so screen readers announce new text.
    <div className="notify-toast-region" role="status" aria-live="polite">
      {r && (
        <div
          ref={ref}
          className="notify-toast"
          onMouseEnter={() => setHold(true)}
          onMouseLeave={() => setHold(false)}
          onFocus={() => setHold(true)}
          onBlur={(e) => {
            if (!ref.current?.contains(e.relatedTarget as Node)) setHold(false)
          }}
        >
          <span>{text}</span>
          <Button
            onClick={() => {
              markRead([r.requestId])
              dismissArrival()
              onOpenRequest(r.requestId)
            }}
          >
            {t('notify.view')}
          </Button>
          <Button variant="ghost" aria-label={t('notify.dismiss')} onClick={dismissArrival}>
            ✕
          </Button>
        </div>
      )}
    </div>
  )
}
