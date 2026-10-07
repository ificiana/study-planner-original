import { useEffect, useState } from 'react'
import { pendingSignupInfo, recordSignupConfirmedIfPending, subscribePendingSignup } from '../lib/analytics'
import { resendSignupConfirmation, supabase } from '../lib/supabase'
import { useT } from '../lib/i18n'

const PENDING_SIGNUP_KEY = 'study-planner:pending-signup-v1'

export function EmailVerificationBanner() {
  const t = useT()
  const [pending, setPending] = useState(() => pendingSignupInfo())
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const syncPending = () => {
      setPending(pendingSignupInfo())
      setDismissed(false)
    }
    const unsubscribe = subscribePendingSignup(syncPending)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PENDING_SIGNUP_KEY) return
      // 邮箱确认通常在另一个标签页完成；那个标签页会清掉 pending-signup。
      // 旧标签页此前只缓存内存状态，因此需要显式响应跨标签页的 storage 事件。
      if (event.newValue === null) {
        setPending(undefined)
        return
      }
      syncPending()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      unsubscribe()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    const client = supabase
    if (!pending?.email || !client) return
    let disposed = false

    const reconcileSession = async () => {
      try {
        const { data } = await client.auth.getSession()
        const user = data.session?.user
        if (!user) return
        await recordSignupConfirmedIfPending(user.id, user.email)
        if (!disposed) setPending(pendingSignupInfo())
      } catch {
        // 状态核对只是修复提示展示，不应影响注册、登录或页面使用。
      }
    }
    const onFocus = () => { void reconcileSession() }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void reconcileSession()
    }

    void reconcileSession()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pending?.email])

  if (!pending?.email || dismissed) return null

  const resend = async () => {
    try {
      setSending(true)
      setMessage('')
      await resendSignupConfirmation(pending.email)
      setMessage(t('emailBanner.resendSuccess'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('emailBanner.resendError'))
    } finally {
      setSending(false)
    }
  }

  return <aside className="email-verification-banner" role="status" aria-live="polite">
    <button
      type="button"
      className="email-verification-dismiss"
      aria-label={t('emailBanner.closeAriaLabel')}
      title={t('emailBanner.closeTitle')}
      onClick={() => setDismissed(true)}
    >×</button>
    <div>
      <strong>{t('emailBanner.title')}</strong>
      <p>{t('emailBanner.body', { email: pending.email })}</p>
      <small>{t('emailBanner.note')}</small>
      {message && <p className="email-verification-message">{message}</p>}
    </div>
    <button type="button" className="secondary-button" disabled={sending} onClick={() => void resend()}>{sending ? t('emailBanner.resending') : t('emailBanner.resendButton')}</button>
  </aside>
}
