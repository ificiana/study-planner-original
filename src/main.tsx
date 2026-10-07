import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { AppProvider, useApp } from './AppContext'
import { I18nProvider } from './lib/i18n'
import { AnalyticsObserver } from './components/AnalyticsObserver'
import { AnalyticsExtensions } from './components/AnalyticsExtensions'
import { DataResetCompatibilityGuard } from './components/DataResetCompatibilityGuard'
import { EmailVerificationBanner } from './components/EmailVerificationBanner'
import { FeedbackNotificationObserver } from './components/FeedbackNotificationObserver'
import { PwaInstallPrompt } from './components/PwaInstallGuide'
import { TutorialRuntimeGuard } from './components/TutorialRuntimeGuard'
import { initializeAnalytics, installVisitLogRetry, recordPageVisit } from './lib/analytics'
import { announcePwaUpdate, configurePwaUpdater } from './lib/pwa-update'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import './analytics.css'
import './feedback-admin.css'

function LocalizedApp() {
  const { state } = useApp()
  return (
    <I18nProvider language={state.settings.language}>
      <TutorialRuntimeGuard />
      <AnalyticsObserver />
      <AnalyticsExtensions />
      <DataResetCompatibilityGuard />
      <EmailVerificationBanner />
      <FeedbackNotificationObserver />
      <PwaInstallPrompt />
      <App />
    </I18nProvider>
  )
}

const updateServiceWorker = registerSW({ immediate: true, onNeedRefresh: announcePwaUpdate })
configurePwaUpdater(updateServiceWorker)
initializeAnalytics()
installVisitLogRetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppProvider>
        <LocalizedApp />
      </AppProvider>
    </AppErrorBoundary>
  </StrictMode>
)

// Log shortly after the first paint. A deterministic timer is more reliable on
// mobile/PWA browsers than waiting indefinitely for an idle callback.
globalThis.setTimeout(() => { void recordPageVisit() }, 700)
