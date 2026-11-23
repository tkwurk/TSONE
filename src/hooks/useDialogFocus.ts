import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && el.getClientRects().length > 0,
  )
}

/**
 * Keyboard focus management for a dialog-like container:
 * - on open, moves focus to `[data-dialog-initial]` inside it (else the container,
 *   which should have tabIndex={-1}), scrolling the container into view if needed;
 * - Tab / Shift+Tab cycle within the container;
 * - Esc calls `onClose`;
 * - on close, returns focus to `returnFocusRef` (the trigger) if focus was still
 *   inside the container (so we never steal focus the user moved elsewhere).
 */
export function useDialogFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  { onClose, returnFocusRef }: { onClose: () => void; returnFocusRef?: RefObject<HTMLElement | null> },
) {
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const container = containerRef.current
    if (!open || !container) return
    const trigger = returnFocusRef?.current ?? null

    const initial = container.querySelector<HTMLElement>('[data-dialog-initial]')
    ;(initial && initial.getClientRects().length ? initial : container).focus({ preventScroll: true })
    // In-flow dialogs (e.g. the cart stacked under the menu on phones) may open
    // off-screen: bring the top of the container into view. Side panels already
    // in view don't move.
    const top = container.getBoundingClientRect().top
    if (top < 0 || top > window.innerHeight * 0.75) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      container.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusableIn(container)
      if (!items.length) {
        e.preventDefault()
        container.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === container)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    container.addEventListener('keydown', onKeyDown)

    return () => {
      container.removeEventListener('keydown', onKeyDown)
      const active = document.activeElement
      const focusWasInside = !active || active === document.body || container.contains(active)
      // No preventScroll: if the trigger scrolled away, the page follows focus back.
      if (trigger && focusWasInside) trigger.focus()
    }
  }, [open, containerRef, returnFocusRef])
}
