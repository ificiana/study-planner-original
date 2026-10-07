import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { deferPwaUpdate, installPwaUpdate, subscribePwaUpdate } from '../lib/pwa-update'
import { useT } from '../lib/i18n'

export function PwaUpdatePrompt() {
  const t = useT()
  const [available, setAvailable] = useState(false)
  const [installing, setInstalling] = useState(false)
  useEffect(() => {
    const unsubscribe = subscribePwaUpdate(setAvailable)
    return () => { unsubscribe() }
  }, [])
  if (!available) return null
  return <aside className="pwa-update-prompt" role="status" aria-live="polite">
    <RefreshCw size={20}/>
    <div><strong>{t('pwaUpdate.title')}</strong><span>{t('pwaUpdate.body')}</span></div>
    <button className="secondary-button" onClick={deferPwaUpdate}>{t('pwaUpdate.later')}</button>
    <button className="primary-button" disabled={installing} onClick={() => { setInstalling(true); void installPwaUpdate() }}>{installing ? t('pwaUpdate.updating') : t('pwaUpdate.updateNow')}</button>
  </aside>
}
