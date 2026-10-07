import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, Download, RotateCcw } from 'lucide-react'
import { translate, type Language } from '../lib/i18n'

interface State { error?: Error }

/**
 * AppErrorBoundary wraps the whole app in main.tsx, including AppProvider and
 * I18nProvider (see LocalizedApp there) — so a crash can happen before those
 * providers ever mount, and this class component can't call the useT() hook
 * anyway. Rather than depend on React context or the app's IndexedDB-backed
 * settings (which can only be read asynchronously), the fallback below detects
 * language synchronously from navigator.language and calls the plain
 * `translate()` helper directly, reusing the same dictionaries as useT().
 */
function detectLanguage(): Language {
  if (typeof navigator === 'undefined') return 'zh'
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function ErrorBoundaryFallback({ error, onReload, onOpenRecovery, onDownloadDiagnostics }: {
  error: Error
  onReload: () => void
  onOpenRecovery: () => void
  onDownloadDiagnostics: () => void
}) {
  const language = detectLanguage()
  const t = (key: string) => translate(language, key)
  return <main className="fatal-error-page">
    <section>
      <AlertTriangle size={42}/>
      <span>{t('errorBoundary.badge')}</span>
      <h1>{t('errorBoundary.title')}</h1>
      <p>{t('errorBoundary.body')}</p>
      <details><summary>{t('errorBoundary.detailsSummary')}</summary><pre>{error.message}</pre></details>
      <div className="button-wrap">
        <button className="primary-button" onClick={onReload}><RotateCcw size={16}/>{t('errorBoundary.reload')}</button>
        <button className="secondary-button" onClick={onOpenRecovery}>{t('errorBoundary.openRecovery')}</button>
        <button className="secondary-button" onClick={onDownloadDiagnostics}><Download size={16}/>{t('errorBoundary.downloadDiagnostics')}</button>
      </div>
    </section>
  </main>
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      localStorage.setItem('study-planner:last-crash', JSON.stringify({ message: error.message, stack: error.stack, componentStack: info.componentStack, occurredAt: new Date().toISOString() }))
    } catch { /* Diagnostics must never cause a second crash. */ }
  }

  private downloadDiagnostics = () => {
    const content = localStorage.getItem('study-planner:last-crash') ?? JSON.stringify({ message: this.state.error?.message, occurredAt: new Date().toISOString() }, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `study-planner-error-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  private openRecovery = () => {
    sessionStorage.setItem('study-planner:open-recovery', '1')
    location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return <ErrorBoundaryFallback
      error={this.state.error}
      onReload={() => location.reload()}
      onOpenRecovery={this.openRecovery}
      onDownloadDiagnostics={this.downloadDiagnostics}
    />
  }
}
