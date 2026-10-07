import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CheckCircle2, Download, X } from 'lucide-react'
import {
  PWA_INSTALL_EVENT,
  installPlatform,
  isIosSafari,
  isStandaloneMode,
  neverShowInstallPrompt,
  recordBrowserVisit,
  shouldAutoOfferInstall,
  snoozeInstallPrompt,
  type BeforeInstallPromptEvent,
  type InstallPlatform,
} from '../pwa-install'
import '../pwa-install.css'
import { useT, variantsOfZh } from '../lib/i18n'
import type { Primitive } from '../lib/i18n/types'

type Translate = (key: string, vars?: Record<string, Primitive>) => string

// 优先选择能把关键菜单项完整展示出来的中文截图；若第三方图片失效，下面还有
// 内置中文示意图兜底，避免用户只看到“图片加载失败”。
const IOS_GUIDE_IMAGE = 'https://d1.faiusr.com/4/AAEIABAEGAAgs_3c-gUo1Z7IpQcwrgU4pwU.png'
const ANDROID_GUIDE_IMAGE = 'https://meta.appinn.net/uploads/default/original/2X/6/601259bd6228c0b470ad5c29f3084f8e6ae216ea.jpeg'
const DESKTOP_GUIDE_IMAGE = 'https://i-blog.csdnimg.cn/direct/c84b48283e5a477fb3545d2201ee50d0.png'

const APPLE_SUPPORT_URL = 'https://support.apple.com/zh-cn/guide/iphone/iph42ab2f3a7/ios'
const CHROME_SUPPORT_URL = 'https://support.google.com/chrome/answer/9658361?hl=zh-Hans'

type InstallRequestDetail = { open?: boolean; install?: boolean }

function platformLabel(platform: InstallPlatform, t: Translate) {
  if (platform === 'ios') return t('pwaInstall.platformIos')
  if (platform === 'android') return t('pwaInstall.platformAndroid')
  if (platform === 'desktop') return t('pwaInstall.platformDesktop')
  return t('pwaInstall.platformUnknown')
}

function platformSummary(platform: InstallPlatform, t: Translate) {
  if (platform === 'ios') return t('pwaInstall.summaryIos')
  if (platform === 'android') return t('pwaInstall.summaryAndroid')
  if (platform === 'desktop') return t('pwaInstall.summaryDesktop')
  return t('pwaInstall.summaryDefault')
}

function GuideDiagramFallback({ platform, alt }: { platform: InstallPlatform; alt: string }) {
  const t = useT()
  if (platform === 'ios') {
    return <div className="pwa-guide-visual-fallback pwa-guide-diagram" role="img" aria-label={alt}>
      <div className="pwa-diagram-browser-bar"><span>Safari</span><b>{t('pwaInstall.iosDiagramShare')}</b></div>
      <div className="pwa-diagram-menu"><span>{t('pwaInstall.iosDiagramMenu1')}</span><span>{t('pwaInstall.iosDiagramMenu2')}</span><strong>{t('pwaInstall.iosDiagramMenu3')}</strong><span>{t('pwaInstall.iosDiagramMenu4')}</span></div>
      <small>{t('pwaInstall.iosDiagramHint')}</small>
    </div>
  }
  if (platform === 'android') {
    return <div className="pwa-guide-visual-fallback pwa-guide-diagram" role="img" aria-label={alt}>
      <div className="pwa-diagram-browser-bar"><span>Chrome</span><b>⋮</b></div>
      <div className="pwa-diagram-menu"><span>{t('pwaInstall.androidDiagramMenu1')}</span><span>{t('pwaInstall.androidDiagramMenu2')}</span><strong>{t('pwaInstall.androidDiagramMenu3')}</strong><span>{t('pwaInstall.androidDiagramMenu4')}</span></div>
      <small>{t('pwaInstall.androidDiagramHint')}</small>
    </div>
  }
  return <div className="pwa-guide-visual-fallback pwa-guide-diagram" role="img" aria-label={alt}>
    <div className="pwa-diagram-browser-bar"><span>Chrome / Edge</span><b>⋮</b></div>
    <div className="pwa-diagram-menu"><span>{t('pwaInstall.desktopDiagramMenu1')}</span><span>{t('pwaInstall.desktopDiagramMenu2')}</span><strong>{t('pwaInstall.desktopDiagramMenu3')}</strong><span>{t('pwaInstall.desktopDiagramMenu4')}</span></div>
    <small>{t('pwaInstall.desktopDiagramHint')}</small>
  </div>
}

function GuideVisual({ src, alt, platform }: { src: string; alt: string; platform: InstallPlatform }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <GuideDiagramFallback platform={platform} alt={alt}/>
  return <img className={`pwa-guide-visual pwa-guide-visual-${platform}`} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)}/>
}

function PlatformIcon() {
  return <span className="pwa-guide-platform-icon" aria-hidden="true"><Download size={17}/></span>
}

export function PwaInstallGuideContent({ platform = installPlatform(), compact = false }: { platform?: InstallPlatform; compact?: boolean }) {
  const t = useT()
  const standalone = isStandaloneMode()
  const iosSafari = platform !== 'ios' || isIosSafari()

  if (standalone) {
    return <div className="pwa-installed-state"><CheckCircle2 size={22}/><div><strong>{t('pwaInstall.installedTitle')}</strong><p>{t('pwaInstall.installedBody')}</p></div></div>
  }

  return <div className={`pwa-guide-content ${compact ? 'is-compact' : ''}`}>
    <div className="pwa-guide-current">
      <span>{platformLabel(platform, t)}</span>
      <strong>{platformSummary(platform, t)}</strong>
      {platform === 'ios' && !iosSafari && <p>{t('pwaInstall.notSafariNote')}</p>}
    </div>

    <div className="pwa-guide-platforms">
      <article className={`pwa-guide-platform ${platform === 'ios' ? 'is-current' : ''}`}>
        <div className="pwa-guide-platform-title"><PlatformIcon/><div><strong>iPhone / iPad</strong><span>Safari</span></div></div>
        <ol>
          <li><b>1</b><span>{t('pwaInstall.iosStep1')}</span></li>
          <li><b>2</b><span>{t('pwaInstall.iosStep2')}</span></li>
          <li><b>3</b><span>{t('pwaInstall.iosStep3')}</span></li>
        </ol>
        {!compact && <GuideVisual platform="ios" src={IOS_GUIDE_IMAGE} alt={t('pwaInstall.iosImageAlt')}/>}
        <small className="pwa-guide-image-note">{t('pwaInstall.iosImageNote')}</small>
        <a href={APPLE_SUPPORT_URL} target="_blank" rel="noreferrer">{t('pwaInstall.appleSupportLink')}<ArrowUpRight size={13}/></a>
      </article>

      <article className={`pwa-guide-platform ${platform === 'android' ? 'is-current' : ''}`}>
        <div className="pwa-guide-platform-title"><PlatformIcon/><div><strong>Android</strong><span>Chrome</span></div></div>
        <ol>
          <li><b>1</b><span>{t('pwaInstall.androidStep1')}</span></li>
          <li><b>2</b><span>{t('pwaInstall.androidStep2')}</span></li>
          <li><b>3</b><span>{t('pwaInstall.androidStep3')}</span></li>
        </ol>
        {!compact && <GuideVisual platform="android" src={ANDROID_GUIDE_IMAGE} alt={t('pwaInstall.androidImageAlt')}/>}
        <a href={CHROME_SUPPORT_URL} target="_blank" rel="noreferrer">{t('pwaInstall.chromeSupportLink')}<ArrowUpRight size={13}/></a>
      </article>

      <article className={`pwa-guide-platform ${platform === 'desktop' ? 'is-current' : ''}`}>
        <div className="pwa-guide-platform-title"><PlatformIcon/><div><strong>Windows / Mac</strong><span>Chrome / Edge</span></div></div>
        <ol>
          <li><b>1</b><span>{t('pwaInstall.desktopStep1')}</span></li>
          <li><b>2</b><span>{t('pwaInstall.desktopStep2')}</span></li>
          <li><b>3</b><span>{t('pwaInstall.desktopStep3')}</span></li>
        </ol>
        {!compact && <GuideVisual platform="desktop" src={DESKTOP_GUIDE_IMAGE} alt={t('pwaInstall.desktopImageAlt')}/>}
        <small className="pwa-guide-image-note">{t('pwaInstall.desktopImageNote')}</small>
        <a href={CHROME_SUPPORT_URL} target="_blank" rel="noreferrer">{t('pwaInstall.chromeSupportLink')}<ArrowUpRight size={13}/></a>
      </article>
    </div>
  </div>
}

export function PwaInstallGuideSection() {
  const t = useT()
  const platform = useMemo(() => installPlatform(), [])
  return <section className="guide-section pwa-guide-section" id="install-app">
    <div className="guide-section-heading"><div><span className="guide-eyebrow">{t('pwaInstall.sectionEyebrow')}</span><h3>{t('pwaInstall.sectionTitle')}</h3><p>{t('pwaInstall.sectionBody')}</p></div></div>
    <PwaInstallGuideContent platform={platform}/>
  </section>
}

export function PwaInstallPrompt() {
  const t = useT()
  const [visible, setVisible] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent>()
  const deferredPromptRef = useRef<BeforeInstallPromptEvent>()
  const [installing, setInstalling] = useState(false)
  const [platform] = useState<InstallPlatform>(() => installPlatform())

  useEffect(() => {
    if (isStandaloneMode()) return
    const visitCount = recordBrowserVisit()
    const timers = new Set<number>()
    let interactionTimer: number | undefined

    const schedule = (callback: () => void, delay: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id)
        callback()
      }, delay)
      timers.add(id)
      return id
    }

    const busyWithAnotherFlow = () => Boolean(document.querySelector(
      '.guide-page, .tutorial-coachmark, .tutorial-offer-copy, .modal-backdrop, .drawer-backdrop, .pwa-guide-modal-backdrop'
    ))

    const showIfUseful = () => {
      if (!shouldAutoOfferInstall(visitCount) || busyWithAnotherFlow()) return
      setVisible(true)
    }

    const showGuideAfterTutorial = (attempt = 0) => {
      if (!shouldAutoOfferInstall(visitCount)) return
      if (busyWithAnotherFlow()) {
        if (attempt < 8) schedule(() => showGuideAfterTutorial(attempt + 1), 350)
        return
      }
      setVisible(false)
      setGuideOpen(true)
    }

    // 首次访问也应有机会看到安装提示，但先留足时间给注册、首次建档或教程选择。
    schedule(showIfUseful, 6500)

    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined
      const button = target?.closest('button')
      const finishingTutorial = Boolean(button?.closest('.tutorial-coachmark') && variantsOfZh('开始我的计划').includes(button.textContent?.trim() ?? ''))
      if (finishingTutorial) {
        // 完整互动教程结束后直接接图文 PWA 教程，而不是再等下一次访问。
        schedule(() => showGuideAfterTutorial(), 700)
        return
      }
      if (interactionTimer !== undefined) {
        window.clearTimeout(interactionTimer)
        timers.delete(interactionTimer)
      }
      // 新用户关闭首次引导、直接开始空白计划等场景，在原弹窗真正消失后再轻提示。
      interactionTimer = schedule(showIfUseful, 1000)
    }

    const onBeforeInstall = (event: Event) => {
      event.preventDefault()
      const prompt = event as BeforeInstallPromptEvent
      deferredPromptRef.current = prompt
      setDeferredPrompt(prompt)
    }
    const onInstalled = () => {
      deferredPromptRef.current = undefined
      setVisible(false)
      setGuideOpen(false)
      setDeferredPrompt(undefined)
    }
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<InstallRequestDetail>).detail
      setVisible(false)
      const prompt = deferredPromptRef.current
      if (detail?.install && prompt) {
        void runNativeInstall(prompt, setInstalling, next => {
          deferredPromptRef.current = next
          setDeferredPrompt(next)
        }, setGuideOpen)
      } else {
        setGuideOpen(true)
      }
    }

    document.addEventListener('click', onDocumentClick, true)
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    window.addEventListener(PWA_INSTALL_EVENT, onRequest)
    return () => {
      timers.forEach(id => window.clearTimeout(id))
      document.removeEventListener('click', onDocumentClick, true)
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      window.removeEventListener(PWA_INSTALL_EVENT, onRequest)
    }
  }, [])

  if (isStandaloneMode()) return null

  const updateDeferredPrompt = (next: BeforeInstallPromptEvent | undefined) => {
    deferredPromptRef.current = next
    setDeferredPrompt(next)
  }

  const install = async () => {
    const prompt = deferredPromptRef.current ?? deferredPrompt
    if (!prompt) { setVisible(false); setGuideOpen(true); return }
    await runNativeInstall(prompt, setInstalling, updateDeferredPrompt, setGuideOpen)
    setVisible(false)
  }

  const later = () => {
    snoozeInstallPrompt()
    setVisible(false)
  }

  const never = () => {
    neverShowInstallPrompt()
    setVisible(false)
    setGuideOpen(false)
  }

  return <>
    {visible && <aside className="pwa-install-nudge" role="status" aria-live="polite">
      <button type="button" className="pwa-install-close" aria-label={t('pwaInstall.nudgeCloseAriaLabel')} onClick={later}><X size={17}/></button>
      <div className="pwa-install-nudge-icon"><Download size={20}/></div>
      <div className="pwa-install-nudge-copy"><strong>{t('pwaInstall.nudgeTitle')}</strong><p>{platformSummary(platform, t)}</p></div>
      <div className="pwa-install-nudge-actions">
        <button type="button" className="primary-button" disabled={installing} onClick={() => void install()}>{installing ? t('pwaInstall.opening') : deferredPrompt ? t('pwaInstall.installButton') : t('pwaInstall.viewMethod')}</button>
        <button type="button" className="text-button" onClick={later}>{t('pwaInstall.remindLater')}</button>
        <button type="button" className="text-button pwa-install-never" onClick={never}>{t('pwaInstall.neverRemind')}</button>
      </div>
    </aside>}

    {guideOpen && <div className="pwa-guide-modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) setGuideOpen(false) }}>
      <section className="pwa-guide-modal" role="dialog" aria-modal="true" aria-label={t('pwaInstall.modalAriaLabel')}>
        <div className="pwa-guide-modal-head"><div><span>{t('pwaInstall.modalEyebrow')}</span><strong>{t('pwaInstall.modalHeadline')}</strong></div><button type="button" aria-label={t('pwaInstall.closeModalAriaLabel')} onClick={() => setGuideOpen(false)}><X size={19}/></button></div>
        <PwaInstallGuideContent platform={platform}/>
        <div className="pwa-guide-modal-actions">
          {deferredPrompt && <button type="button" className="primary-button" disabled={installing} onClick={() => void install()}><Download size={15}/>{installing ? t('pwaInstall.opening') : t('pwaInstall.installButton')}</button>}
          <button type="button" className="secondary-button" onClick={() => setGuideOpen(false)}>{t('pwaInstall.gotIt')}</button>
        </div>
      </section>
    </div>}
  </>
}

async function runNativeInstall(
  prompt: BeforeInstallPromptEvent,
  setInstalling: (value: boolean) => void,
  setDeferredPrompt: (value: BeforeInstallPromptEvent | undefined) => void,
  setGuideOpen: (value: boolean) => void,
) {
  setInstalling(true)
  try {
    await prompt.prompt()
    const choice = await prompt.userChoice
    setDeferredPrompt(undefined)
    if (choice.outcome === 'accepted') setGuideOpen(false)
    else snoozeInstallPrompt()
  } catch {
    setGuideOpen(true)
  } finally {
    setInstalling(false)
  }
}
