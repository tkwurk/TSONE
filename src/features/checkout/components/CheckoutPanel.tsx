import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiConfig } from '@/services/api'
import { Badge, Button, Notice, Panel } from '@/components/ui'
import { fetchProducts, productName, type ProductRow } from '@/features/catalog'
import type { Session } from '@/features/auth'
import { useI18n } from '@/i18n'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { useCart } from '../hooks/useCart'
import { useParkedOrders } from '../hooks/useParkedOrders'
import { useLastReceipt } from '../hooks/useLastReceipt'
import { ReceiptModal } from './ReceiptModal'
import { PaymentScreen } from './PaymentScreen'
import { DrawerPinModal, useDrawerOpen } from './DrawerOpen'
import { RecookPanel, useRecookAlerts } from './RecookPanel'
import {
  isVariableQuantityProduct,
  missedItems,
  orderNumberOf,
  productCategory,
  productImage,
  productKey,
  productPrice,
  productSupplier,
  productType,
  type PaymentDecision,
  type PaymentMethod,
} from '../types'
import { fetchPaymentMethods, recordDiscountExpense, saveMissedOrders, submitCheckout } from '../api'
import { isAutoPrintEnabled, setAutoPrintEnabled } from '../printSettings'
import './checkout.css'

type Msg = { tone: 'info' | 'error'; text: string }
type Step = 'cart' | 'payment'

/**
 * Checkout screen — builds a cart from products and submits an order through the
 * Seam 1 API (api.checkout → Orchestrator checkout.completed pipeline). It never
 * touches Sheets directly. The operator identity comes from the signed-in
 * session and is sent as _authContext, matching the saveOrderSecure contract.
 */
export function CheckoutPanel({ session }: { session: Session }) {
  const { t, fmtMoney } = useI18n()
  const configured = Boolean(apiConfig.appsScriptUrl)
  const cart = useCart()

  const [products, setProducts] = useState<ProductRow[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [step, setStep] = useState<Step>('cart')
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [loadingMethods, setLoadingMethods] = useState(false)
  const [methodsError, setMethodsError] = useState<string | null>(null)
  const [supplier, setSupplier] = useState('')
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [cartOpen, setCartOpen] = useState(false)
  const [parkedOpen, setParkedOpen] = useState(false)
  const [parkPromptOpen, setParkPromptOpen] = useState(false)
  const [parkIdentifier, setParkIdentifier] = useState('')
  const [showReceipt, setShowReceipt] = useState(false)
  const [autoPrint, setAutoPrint] = useState(() => isAutoPrintEnabled(session.outlet))
  const [submitting, setSubmitting] = useState(false)

  // Cart panel = dialog: focus moves in on open, Tab is trapped, Esc closes,
  // focus returns to the 🛒 trigger. Not closable mid-submit.
  const cartRef = useRef<HTMLElement>(null)
  const cartTriggerRef = useRef<HTMLButtonElement>(null)
  const closeCart = useCallback(() => {
    if (!submitting) setCartOpen(false)
  }, [submitting])
  useDialogFocus(cartOpen, cartRef, { onClose: closeCart, returnFocusRef: cartTriggerRef })
  const [message, setMessage] = useState<Msg | null>(null)
  const [recookOpen, setRecookOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customPrice, setCustomPrice] = useState('')

  const parked = useParkedOrders(session.username)
  const { receipt, remember } = useLastReceipt()

  const outlet = session.outlet
  const { clear: clearCart } = cart
  const auth = useMemo(
    () => ({ username: session.username, deviceId: session.deviceId, outlet }),
    [session.username, session.deviceId, outlet],
  )

  const drawer = useDrawerOpen(auth)
  const recook = useRecookAlerts(auth, configured)

  const loadProducts = useCallback(
    async (force = false) => {
      setLoadingProducts(true)
      setMessage(null)
      const res = await fetchProducts(outlet ? { outlet } : {}, undefined, force)
      setLoadingProducts(false)
      if (res.success && res.data) setProducts(res.data.products ?? [])
      else setMessage({ tone: 'error', text: res.error ?? 'Failed to load products' })
    },
    [outlet],
  )

  useEffect(() => {
    clearCart()
  }, [session.username, clearCart])

  // Auto-load the menu once when the screen opens.
  const didLoad = useRef(false)
  useEffect(() => {
    if (configured && !didLoad.current) {
      didLoad.current = true
      loadProducts()
    }
  }, [configured, loadProducts])

  // Sellable items grouped Supplier → Category → Products.
  const bySupplier = useMemo(() => {
    const sellable = products.filter((p) => productType(p).toLowerCase() !== 'buy')
    const suppliers = new Map<string, Map<string, ProductRow[]>>()
    for (const p of sellable) {
      const sup = productSupplier(p)
      const cat = productCategory(p)
      if (!suppliers.has(sup)) suppliers.set(sup, new Map())
      const cats = suppliers.get(sup)!
      if (!cats.has(cat)) cats.set(cat, [])
      cats.get(cat)!.push(p)
    }
    return Array.from(suppliers.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, cats]) => ({
        supplier: name,
        categories: Array.from(cats.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([category, items]) => ({ category, items })),
      }))
  }, [products])

  // Default the supplier tab to the first available (derived, no effect needed).
  const activeSupplier = bySupplier.find((s) => s.supplier === supplier) ?? bySupplier[0]
  const categories = activeSupplier?.categories ?? []
  const activeCategory = categories.find((c) => c.category === category) ?? categories[0]

  // Keep the selected supplier tab / category chip visible when the rows scroll sideways (phones).
  const navRef = useRef<HTMLDivElement>(null)
  const activeSupplierName = activeSupplier?.supplier
  const activeCategoryName = activeCategory?.category
  useEffect(() => {
    navRef.current
      ?.querySelectorAll<HTMLElement>('.supplier-tab--active, .category-chip--active')
      .forEach((el) => {
        const row = el.parentElement
        if (!row) return
        const left = el.offsetLeft - row.offsetLeft
        if (left < row.scrollLeft || left + el.offsetWidth > row.scrollLeft + row.clientWidth) {
          row.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' })
        }
      })
  }, [activeSupplierName, activeCategoryName])

  // Search spans all sellable products (ignores supplier/category when active).
  const query = search.trim().toLowerCase()
  const visibleItems = useMemo(() => {
    if (!query) return activeCategory?.items ?? []
    return products.filter(
      (p) => productType(p).toLowerCase() !== 'buy' && productName(p).toLowerCase().includes(query),
    )
  }, [query, activeCategory, products])

  // "Submit order" → open the payment step (loads payment methods from the sheet).
  const onProceed = useCallback(async () => {
    if (!cart.items.length) return setMessage({ tone: 'error', text: t('checkout.cartEmptyError') })
    setMessage(null)
    setCartOpen(true)
    setStep('payment')
    if (!methods.length) {
      setLoadingMethods(true)
      setMethodsError(null)
      const list = await fetchPaymentMethods(auth)
      setLoadingMethods(false)
      if (list === null) setMethodsError(t('pay.methodsError'))
      else setMethods(list)
    }
  }, [cart.items.length, methods.length, auth, t])

  // Payment confirmed → save order, record discount expense, remember + auto-print receipt.
  const onConfirmPayment = useCallback(
    async (decision: PaymentDecision) => {
      setSubmitting(true)
      setMessage(null)
      const res = await submitCheckout(cart.items, decision, auth)
      setSubmitting(false)
      if (!res.success) {
        setMessage({ tone: 'error', text: res.error ?? t('checkout.failed') })
        return
      }
      const num = orderNumberOf(res.data)
      if (decision.discount > 0) {
        // Mirrors the original: discount recorded as an expense, non-blocking.
        recordDiscountExpense(decision.discount, decision.payment, num ?? '', auth).catch(() => undefined)
      }
      // Mirrors submitOrderDirectly(): sold-out lines go to Missed Orders (non-blocking).
      const missed = missedItems(cart.items)
      if (missed.length) saveMissedOrders(missed, num ?? '', auth).catch(() => undefined)
      remember({
        orderNumber: num ?? '—',
        items: cart.items.filter((i) => !i.isSoldOut).map((i) => ({ ...i })),
        payment: decision.payment,
        total: decision.total,
        subtotal: decision.subtotal,
        discount: decision.discount,
        paymentSplits: decision.paymentSplits?.map((s) => ({ method: s.method, amount: s.amount })),
        cashTendered: decision.cashTendered,
        changeAmount: decision.changeAmount,
        openCashDrawer: decision.openCashDrawer,
        operator: session.username,
        outlet,
        at: new Date().toISOString(),
      })
      cart.clear()
      setStep('cart')
      const changeNote =
        decision.changeAmount && decision.changeAmount > 0 ? ` · ${t('pay.change')}: ${fmtMoney(decision.changeAmount)}` : ''
      const missedNote = missed.length ? ` · ${missed.length} ${t('cart.missedNote')}` : ''
      setMessage({ tone: 'info', text: t('checkout.submitted') + (num ? ` — ${num}` : '') + changeNote + missedNote })
      // Auto-print (per-outlet setting, same key as the original app).
      if (autoPrint) setShowReceipt(true)
      // Mirrors the original: refresh kitchen alerts after a sale.
      recook.refresh()
    },
    [cart, auth, t, remember, session.username, outlet, autoPrint, fmtMoney, recook],
  )

  const onAddCustom = useCallback(() => {
    const name = customName.trim()
    const price = parseFloat(customPrice) || 0
    if (name.length < 2) return setMessage({ tone: 'error', text: t('custom.invalidName') })
    if (price <= 0) return setMessage({ tone: 'error', text: t('custom.invalidPrice') })
    cart.addCustom(name, price)
    setCustomName('')
    setCustomPrice('')
    setMessage(null)
  }, [cart, customName, customPrice, t])

  // Cart holds only sold-out items: the customer leaves without buying. There is
  // nothing to pay, but the turn-away must still be recorded (MissedOrders), so the
  // kitchen audit can count it.
  const onlySoldOut = cart.items.length > 0 && cart.items.every((i) => i.isSoldOut)
  const onRecordSoldOut = useCallback(async () => {
    const missed = missedItems(cart.items)
    if (!missed.length) return
    setSubmitting(true)
    setMessage(null)
    const res = await saveMissedOrders(missed, `SOLDOUT-${Date.now()}`, auth)
    setSubmitting(false)
    if (!res.success) {
      setMessage({ tone: 'error', text: res.error ?? t('checkout.failed') })
      return
    }
    cart.clear()
    setMessage({ tone: 'info', text: `🚫 ${t('checkout.soldOutRecorded')}: ${missed.map((i) => `${i.qty}× ${i.name}`).join(', ')}` })
  }, [cart, auth, t])

  const onPark = useCallback(() => {
    if (!cart.items.length) return setMessage({ tone: 'error', text: t('checkout.cartEmptyError') })
    setParkIdentifier('')
    setParkPromptOpen(true)
  }, [cart.items.length, t])

  const confirmPark = useCallback(() => {
    const identifier = parkIdentifier.trim()
    parked.park(identifier, cart.items, '')
    cart.clear()
    setParkPromptOpen(false)
    setMessage({ tone: 'info', text: t('checkout.parkedOk') + (identifier ? ` — ${identifier}` : '') })
  }, [cart, parkIdentifier, parked, t])

  const onRetrieve = useCallback(
    (id: string) => {
      const order = parked.retrieve(id)
      if (!order) return
      // Mirror the original: if the current cart has items, park it automatically.
      if (cart.items.length) parked.park('Auto Parked', cart.items, '')
      cart.load(order.items)
      setParkedOpen(false)
      setMessage({ tone: 'info', text: t('checkout.retrievedOk') })
    },
    [cart, parked, t],
  )

  const onReprint = useCallback(() => {
    if (!receipt) return setMessage({ tone: 'error', text: t('checkout.noReceipt') })
    setShowReceipt(true)
  }, [receipt, t])

  return (
    <Panel title={t('checkout.title')}>
      {!configured && (
        <Notice tone="warn">
          <strong>{t('common.setupRequired')}</strong> {t('checkout.setup')}
        </Notice>
      )}

      <div className="pos">
        {/* ── Left: menu ── */}
        <div className="pos__menu">
          <div className="pos__toolbar">
            <input
              className="pos__search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('checkout.search')}
              aria-label={t('checkout.search')}
            />
            <Button variant="ghost" onClick={() => loadProducts(true)} disabled={!configured || loadingProducts}>
              {loadingProducts ? t('common.loading') : t('checkout.reloadMenu')}
            </Button>
            <button
              type="button"
              className="cart-toggle"
              onClick={() => setRecookOpen((o) => !o)}
              aria-expanded={recookOpen}
              title={t('recook.title')}
            >
              👨‍🍳 <Badge tone={recook.alerts.length ? 'bad' : 'neutral'}>{recook.alerts.length}</Badge>
            </button>
            <button
              type="button"
              className="cart-toggle"
              onClick={drawer.start}
              disabled={!configured || drawer.phase !== 'idle'}
              title={t('drawer.title')}
            >
              {drawer.phase === 'done' ? '✅' : '🗄️'}
            </button>
            <button
              ref={cartTriggerRef}
              type="button"
              className="cart-toggle"
              onClick={() => setCartOpen((o) => !o)}
              aria-expanded={cartOpen}
              aria-controls="pos-cart"
              aria-haspopup="dialog"
              aria-label={`${t('checkout.cart')} (${cart.count})`}
            >
              🛒 <Badge tone={cart.count ? 'ok' : 'neutral'}>{cart.count}</Badge>
            </button>
          </div>

          {drawer.error && <Notice tone="error">{drawer.error}</Notice>}

          {recookOpen && (
            <RecookPanel
              alerts={recook.alerts}
              items={recook.items}
              loading={recook.loading}
              failed={recook.failed}
              onRefresh={recook.refresh}
              onClose={() => setRecookOpen(false)}
            />
          )}

          <div ref={navRef}>
          {/* Suppliers = tabs (top level); hidden when there is only one to choose. */}
          {!query && bySupplier.length > 1 && (
            <div className="supplier-nav" role="tablist" aria-label={t('checkout.suppliers')}>
              {bySupplier.map((s) => {
                const active = activeSupplier?.supplier === s.supplier
                return (
                  <button
                    key={s.supplier}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={'supplier-tab' + (active ? ' supplier-tab--active' : '')}
                    onClick={() => setSupplier(s.supplier)}
                  >
                    <span aria-hidden="true">🏪</span> {s.supplier}
                  </button>
                )
              })}
            </div>
          )}

          {/* Categories = small chips with item counts, one scrollable line. */}
          {!query && categories.length > 0 && (
            <div className="category-nav" role="group" aria-label={t('checkout.categories')}>
              <span className="category-nav__label" aria-hidden="true">
                🏷️
              </span>
              {categories.map((c) => {
                const active = activeCategory?.category === c.category
                return (
                  <button
                    key={c.category}
                    type="button"
                    aria-pressed={active}
                    className={'category-chip' + (active ? ' category-chip--active' : '')}
                    onClick={() => setCategory(c.category)}
                  >
                    {c.category}{' '}
                    <span className="category-chip__count">{c.items.length}</span>
                  </button>
                )
              })}
            </div>
          )}
          </div>

          <div className="menu">
            {products.length === 0 ? (
              <p className="muted">{loadingProducts ? t('checkout.loadingMenu') : t('checkout.noProducts')}</p>
            ) : visibleItems.length === 0 ? (
              <p className="muted">{t('checkout.noMatch')}</p>
            ) : (
              <div className="menu-grid">
                {visibleItems.map((p) => {
                  const key = productKey(p)
                  const name = productName(p)
                  const price = productPrice(p)
                  const category = productCategory(p)
                  const img = productImage(p)
                  const qty = cart.qtyOf(key)
                  const isVar = isVariableQuantityProduct(p)
                  const leftover = cart.isLeftover(key)
                  const base = { key, name, price, category }
                  const linePrice = cart.priceOf(key) ?? price
                  return (
                    <div
                      key={key}
                      className={'menu-tile' + (qty || leftover ? ' menu-tile--in-cart' : '') + (leftover ? ' menu-tile--leftover' : '')}
                    >
                      <div className="menu-tile__media">
                        {img ? (
                          <img
                            className="menu-tile__img"
                            src={img}
                            alt={name}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none'
                            }}
                          />
                        ) : (
                          <span className="menu-tile__placeholder">🍽️</span>
                        )}
                      </div>
                      <span className="menu-tile__name">{name}</span>
                      <span className="menu-tile__price">
                        {leftover ? t('cart.leftoverFree') : fmtMoney(isVar ? linePrice : price)}
                      </span>

                      {isVar ? (
                        // Variable-quantity product: qty in 0.1 steps, price in ±1000 steps.
                        <div className="menu-tile__var">
                          <div className="menu-tile__qty">
                            <button type="button" className="qty-btn" onClick={() => cart.adjustVariableQty(base, -0.1)} disabled={qty === 0}>
                              −
                            </button>
                            <span className="qty-val">{qty}</span>
                            <button type="button" className="qty-btn" onClick={() => cart.adjustVariableQty(base, 0.1)}>
                              +
                            </button>
                          </div>
                          <div className="menu-tile__qty menu-tile__pricectl">
                            <button type="button" className="qty-btn" onClick={() => cart.adjustVariablePrice(base, -1000)}>
                              −1k
                            </button>
                            <span className="muted">{t('variable.price')}</span>
                            <button type="button" className="qty-btn" onClick={() => cart.adjustVariablePrice(base, 1000)}>
                              +1k
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="menu-tile__qty">
                            <button
                              type="button"
                              className="qty-btn"
                              onClick={() => cart.setQty(key, qty - 1)}
                              disabled={qty === 0 || leftover}
                            >
                              −
                            </button>
                            <span className="qty-val">{leftover ? 1 : qty}</span>
                            <button type="button" className="qty-btn" onClick={() => cart.add(base)} disabled={leftover}>
                              +
                            </button>
                          </div>
                          <button
                            type="button"
                            className={'leftover-btn' + (leftover ? ' leftover-btn--active' : '')}
                            onClick={() => cart.toggleLeftover(base)}
                            title={t('cart.markLeftover')}
                          >
                            🗑️ {t('cart.leftover')}
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Custom item — the original shows this under the MISC category. */}
            {!query && activeCategory?.category?.toUpperCase() === 'MISC' && (
              <form
                className="custom-item"
                onSubmit={(e) => {
                  e.preventDefault()
                  onAddCustom()
                }}
              >
                <h4 className="menu-cat">✏️ {t('custom.title')}</h4>
                <div className="custom-item__row">
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder={t('custom.name')}
                    maxLength={50}
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1000}
                    value={customPrice}
                    onChange={(e) => setCustomPrice(e.target.value)}
                    placeholder={t('custom.price')}
                  />
                  <Button type="submit">＋ {t('custom.add')}</Button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* ── Right: collapsible cart / payment step ── */}
        <aside
          id="pos-cart"
          ref={cartRef}
          className={'pos__cart' + (cartOpen ? '' : ' pos__cart--collapsed') + (step === 'payment' ? ' pos__cart--wide' : '')}
          role="dialog"
          aria-modal="true"
          aria-label={t('checkout.cart')}
          tabIndex={-1}
          // Collapsed: out of the tab order and hidden from screen readers.
          inert={!cartOpen}
        >
          {step === 'payment' ? (
            <PaymentScreen
              items={cart.items}
              methods={methods}
              loadingMethods={loadingMethods}
              methodsError={methodsError}
              submitting={submitting}
              onConfirm={onConfirmPayment}
              onBack={() => setStep('cart')}
            />
          ) : (
            <>
          <div className="pos__cart-head">
            <h3>
              {t('checkout.cart')} ({cart.count})
            </h3>
            <button type="button" className="cart-collapse" onClick={closeCart} aria-label={t('receipt.close')} data-dialog-initial>
              ›
            </button>
          </div>

          {cart.items.length === 0 ? (
            <p className="muted">{t('checkout.cartEmpty')}</p>
          ) : (
            <ul className="cart">
              {cart.items.map((i) => {
                const step = i.isVariableQuantity ? 0.1 : 1
                return (
                  <li key={i.key} className={(i.isSoldOut ? 'cart-line--soldout' : '') + (i.isLeftover ? ' cart-line--leftover' : '')}>
                    <span className="name">
                      {i.name}
                      {i.isLeftover && <span className="cart-tag">🗑️ {t('cart.leftover')}</span>}
                      {i.isCustom && <span className="cart-tag">✏️</span>}
                      {i.isSoldOut && <span className="cart-tag cart-tag--bad">🚫 {t('cart.soldOut')}</span>}
                    </span>
                    <span className="qty">
                      <button type="button" onClick={() => cart.setQty(i.key, parseFloat((i.qty - step).toFixed(1)))} disabled={i.isLeftover}>
                        −
                      </button>
                      {i.qty}
                      <button type="button" onClick={() => cart.setQty(i.key, parseFloat((i.qty + step).toFixed(1)))} disabled={i.isLeftover}>
                        +
                      </button>
                    </span>
                    <span className="muted cart-line__amt">{fmtMoney(i.price * i.qty)}</span>
                    <button
                      type="button"
                      className={'soldout-btn' + (i.isSoldOut ? ' soldout-btn--active' : '')}
                      onClick={() => cart.toggleSoldOut(i.key)}
                      title={i.isSoldOut ? t('cart.unmarkSoldOut') : t('cart.markSoldOut')}
                      aria-label={i.isSoldOut ? t('cart.unmarkSoldOut') : t('cart.markSoldOut')}
                    >
                      🚫
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {onlySoldOut && <p className="muted">{t('checkout.soldOutOnlyHint')}</p>}
          <div className="checkout-total">
            <span>{t('checkout.total')}</span>
            <span>{fmtMoney(cart.total)}</span>
          </div>

          <div className="actions">
            {onlySoldOut ? (
              <Button onClick={onRecordSoldOut} disabled={!configured || submitting} title={t('checkout.soldOutOnlyHint')}>
                {submitting ? t('checkout.submitting') : `🚫 ${t('checkout.recordSoldOut')}`}
              </Button>
            ) : (
              <Button onClick={onProceed} disabled={!configured || submitting || cart.items.length === 0}>
                💳 {t('checkout.proceed')}
              </Button>
            )}
            {cart.items.length > 0 && (
              <Button variant="ghost" onClick={cart.clear}>
                {t('checkout.clear')}
              </Button>
            )}
          </div>

          <div className="actions cart-tools">
            <Button variant="ghost" onClick={onPark} disabled={cart.items.length === 0}>
              🅿️ {t('checkout.park')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setParkedOpen((o) => !o)}
              aria-expanded={parkedOpen}
            >
              📂 {t('checkout.parked')} <Badge tone={parked.orders.length ? 'ok' : 'neutral'}>{parked.orders.length}</Badge>
            </Button>
            <Button variant="ghost" onClick={onReprint} disabled={!receipt}>
              🖨️ {t('checkout.reprint')}
            </Button>
            <label className="auto-print">
              <input
                type="checkbox"
                checked={autoPrint}
                onChange={(e) => {
                  setAutoPrint(e.target.checked)
                  setAutoPrintEnabled(outlet, e.target.checked)
                }}
              />
              {t('settings.autoPrint')}
            </label>
          </div>

          {parkPromptOpen && (
            <form
              className="park-form"
              onSubmit={(e) => {
                e.preventDefault()
                confirmPark()
              }}
            >
              <label className="checkout-field">
                {t('checkout.parkPrompt')}
                <input
                  autoFocus
                  value={parkIdentifier}
                  onChange={(e) => setParkIdentifier(e.target.value)}
                  placeholder="Table 7 / Budi"
                />
              </label>
              <div className="actions">
                <Button type="submit">🅿️ {t('checkout.park')}</Button>
                <Button variant="ghost" type="button" onClick={() => setParkPromptOpen(false)}>
                  {t('receipt.close')}
                </Button>
              </div>
            </form>
          )}

          {parkedOpen && (
            <div className="parked-list">
              {parked.orders.length === 0 ? (
                <p className="muted">{t('checkout.noParked')}</p>
              ) : (
                <ul className="cart">
                  {parked.orders.map((o) => (
                    <li key={o.id}>
                      <span className="name">
                        <strong>{o.identifier || '—'}</strong>
                        <span className="muted"> · {o.items.reduce((s, i) => s + i.qty, 0)} · {fmtMoney(o.total)}</span>
                      </span>
                      <span className="qty">
                        <Button onClick={() => onRetrieve(o.id)}>{t('checkout.retrieve')}</Button>
                        <button type="button" onClick={() => parked.remove(o.id)} aria-label="Delete">
                          ✕
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="muted pos__who">
            {t('checkout.operator')}: <strong>{session.username}</strong> · {t('checkout.outlet')}:{' '}
            {outlet || t('common.all')}
          </p>

          {message && <Notice tone={message.tone === 'error' ? 'error' : 'info'}>{message.text}</Notice>}
            </>
          )}
        </aside>
      </div>

      {showReceipt && receipt && <ReceiptModal receipt={receipt} onClose={() => setShowReceipt(false)} />}
      {drawer.phase === 'pin' && (
        <DrawerPinModal onSubmit={drawer.submitPin} onCancel={drawer.cancel} busy={false} error={drawer.error} />
      )}
    </Panel>
  )
}
