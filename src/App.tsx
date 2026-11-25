import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth, LoginPanel } from '@/features/auth'
import { clearProductsCache, prefetchProducts } from '@/features/catalog'
import { CheckoutPanel, clearPaymentMethodsCache, prefetchPaymentMethods } from '@/features/checkout'
import { AdminPanel } from '@/features/adminOrders'
import { PnlPanel, SalesReportPanel, UsagePanel } from '@/features/reports'
import { KitchenPanel } from '@/features/kitchen'
import { PurchasingPanel } from '@/features/purchasing'
import { StockPanel } from '@/features/stock'
import { ConsumptionPanel } from '@/features/consumption'
import { DepositsPanel } from '@/features/deposits'
import { InvestmentsPanel } from '@/features/investments'
import { AttendancePanel } from '@/features/attendance'
import { ChecklistPanel } from '@/features/checklist'
import { ShiftReportPanel } from '@/features/shiftReport'
import { ComingSoon, canAccess, visibleNavItems } from '@/features/navigation'
import {
  ArrivalToast,
  disablePush,
  KitchenRequestsProvider,
  NotificationBell,
  onNotificationOpen,
  takeDeepLink,
  type RequestLink,
} from '@/features/notifications'
import { Button, Sidebar } from '@/components/ui'
import { useI18n } from '@/i18n'
import './App.css'

function LanguageToggle() {
  const { lang, setLang } = useI18n()
  return (
    <span className="lang-toggle">
      <button
        type="button"
        className={'lang-opt' + (lang === 'id' ? ' lang-opt--active' : '')}
        onClick={() => setLang('id')}
      >
        ID
      </button>
      <button
        type="button"
        className={'lang-opt' + (lang === 'en' ? ' lang-opt--active' : '')}
        onClick={() => setLang('en')}
      >
        EN
      </button>
    </span>
  )
}

function App() {
  const { session, loading, error, login, logout } = useAuth()
  const { t } = useI18n()
  const [active, setActive] = useState('orders')
  const [navOpen, setNavOpen] = useState(false)
  // Kitchen request to show (from a notification, the bell or a deep link).
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null)
  // A notification deep link may arrive before sign-in; keep it until there is a session.
  const [pendingLink, setPendingLink] = useState<RequestLink | null>(() => takeDeepLink())

  const openRequest = useCallback((link: RequestLink) => {
    setActive('kitchenCooking')
    setNavOpen(false)
    setFocusRequest((prev) => ({ id: link.requestId, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  useEffect(() => onNotificationOpen((link) => setPendingLink(link)), [])

  const hasSession = !!session
  useEffect(() => {
    if (!hasSession || !pendingLink) return
    openRequest(pendingLink)
    setPendingLink(null)
  }, [hasSession, pendingLink, openRequest])

  const sessionUser = session?.username
  const sessionDevice = session?.deviceId
  const sessionOutlet = session?.outlet
  useEffect(() => {
    if (!sessionUser) {
      clearPaymentMethodsCache()
      clearProductsCache()
      return
    }
    prefetchPaymentMethods({ username: sessionUser, deviceId: sessionDevice, outlet: sessionOutlet })
    prefetchProducts(sessionOutlet)
  }, [sessionUser, sessionDevice, sessionOutlet])

  const navItems = useMemo(() => (session ? visibleNavItems(session) : []), [session])

  if (!session) {
    return (
      <main className="app">
        <header className="app__header">
          <h1>TSONE</h1>
          <p className="subtitle">{t('app.subtitle')}</p>
          <LanguageToggle />
        </header>
        <LoginPanel onLogin={login} loading={loading} error={error} />
      </main>
    )
  }

  const auth = { username: session.username, deviceId: session.deviceId, outlet: session.outlet }
  const currentId = navItems.some((i) => i.id === active) ? active : navItems[0]?.id
  const current = navItems.find((i) => i.id === currentId)

  const renderScreen = () => {
    switch (currentId) {
      case 'orders':
        return <CheckoutPanel session={session} />
      case 'adminOrders':
        return <AdminPanel auth={auth} />
      case 'salesSummary':
        return <SalesReportPanel auth={auth} />
      case 'kitchenCooking':
        return <KitchenPanel auth={auth} focusRequest={focusRequest} />
      case 'purchasing':
        return <PurchasingPanel auth={auth} mode="normal" />
      case 'purchasingReceive':
        return <PurchasingPanel auth={auth} mode="receive" />
      case 'purchasingLocal':
        return <PurchasingPanel auth={auth} mode="local" />
      case 'stockReport':
        return <StockPanel auth={auth} />
      case 'inventoryConsumption':
        return <ConsumptionPanel auth={auth} />
      case 'deposits':
        return <DepositsPanel auth={auth} />
      case 'investments':
        return <InvestmentsPanel auth={auth} />
      case 'profitLoss':
        return <PnlPanel auth={auth} />
      case 'usageReport':
        return <UsagePanel auth={auth} />
      case 'attendance':
        return <AttendancePanel auth={auth} />
      case 'checklist':
        return <ChecklistPanel auth={auth} />
      case 'shiftReport':
        return <ShiftReportPanel auth={auth} />
      default:
        return <ComingSoon title={current ? t(current.labelKey) : ''} />
    }
  }

  const kitchenAccess = canAccess(session, 'kitchenCooking')
  // Stop pushes to this device for this user first (shared devices), but never block sign-out on it.
  const signOut = async () => {
    await Promise.race([disablePush(auth), new Promise((r) => setTimeout(r, 3000))])
    logout()
  }

  return (
    <KitchenRequestsProvider
      key={`${session.backendOutlet ?? ''}|${session.username}`}
      auth={auth}
      backendOutlet={session.backendOutlet}
      enabled={kitchenAccess}
      onOpenRequest={openRequest}
    >
    <div className="shell">
      <header className="topbar">
        <button
          type="button"
          className="topbar__menu"
          aria-label={t('app.menu')}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((v) => !v)}
        >
          ☰
        </button>
        <h1 className="topbar__logo">TSONE</h1>
        <div className="actions">
          <NotificationBell
            onOpenRequest={(id) => openRequest({ requestId: id })}
            onViewAll={() => {
              setActive('kitchenCooking')
              setFocusRequest((prev) => ({ id: '', seq: (prev?.seq ?? 0) + 1 }))
            }}
          />
          <span className="status">
            {session.username}
            {session.outlet ? ` · ${session.outlet}` : ''} · {session.role}
          </span>
          <LanguageToggle />
          <Button variant="ghost" onClick={signOut}>
            {t('app.signOut')}
          </Button>
        </div>
      </header>

      <div className="shell__body">
        <Sidebar
          items={navItems.map((i) => ({ id: i.id, label: t(i.labelKey), icon: i.icon }))}
          active={currentId ?? ''}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          onChange={(id) => {
            setActive(id)
            setNavOpen(false)
          }}
        />
        <section className="content">{renderScreen()}</section>
      </div>
      {kitchenAccess && <ArrivalToast onOpenRequest={(id) => openRequest({ requestId: id })} />}
    </div>
    </KitchenRequestsProvider>
  )
}

export default App
