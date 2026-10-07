import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LogOut, RotateCcw, X } from 'lucide-react'
import type { TutorialStep } from '../lib/tutorial'
import { useT, variantsOfZh } from '../lib/i18n'
import type { Primitive } from '../lib/i18n/types'
import '../tutorial-polish.css'

type Translate = (key: string, vars?: Record<string, Primitive>) => string

export interface TutorialCoachmarkConfig {
  target?: string
  text: string
  eyebrow?: string
  headline?: string
  actionLabel?: string
  onAction?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}

function tutorialCopyOverrides(t: Translate): Partial<Record<TutorialStep, string>> {
  return {
    'repair-entry': t('tutorialCoachmark.step.repairEntry'),
    'repair-action': t('tutorialCoachmark.step.repairAction'),
    'repair-calendar': t('tutorialCoachmark.step.repairCalendar'),
    'goal-existing': t('tutorialCoachmark.step.goalExisting'),
    'intake-entry': t('tutorialCoachmark.step.intakeEntry'),
    'intake-source': t('tutorialCoachmark.step.intakeSource'),
    'intake-parse': t('tutorialCoachmark.step.intakeParse'),
    'intake-schedule': t('tutorialCoachmark.step.intakeSchedule'),
    'intake-preview': t('tutorialCoachmark.step.intakePreview'),
    'intake-calendar': t('tutorialCoachmark.step.intakeCalendar'),
    'execute-complete': t('tutorialCoachmark.step.executeComplete'),
    'execute-partial': t('tutorialCoachmark.step.executePartial'),
    'review-entry': t('tutorialCoachmark.step.reviewEntry'),
    'review-carry': t('tutorialCoachmark.step.reviewCarry'),
    'review-preview': t('tutorialCoachmark.step.reviewPreview'),
    'review-calendar': t('tutorialCoachmark.step.reviewCalendar'),
    stats: t('tutorialCoachmark.step.stats'),
    'stats-detail': t('tutorialCoachmark.step.statsDetail'),
    'future-entry': t('tutorialCoachmark.step.futureEntry'),
    'future-action': t('tutorialCoachmark.step.futureAction'),
    'future-preview': t('tutorialCoachmark.step.futurePreview'),
    'future-calendar': t('tutorialCoachmark.step.futureCalendar'),
    complete: t('tutorialCoachmark.step.complete'),
  }
}

function proposalMovesTarget() {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('.proposal-summary-grid button'))
  return buttons.find(element => variantsOfZh('移动任务').some(label => element.textContent?.includes(label)) && element.getBoundingClientRect().width > 0)
}

function findTarget(target?: string) {
  if (!target) return undefined
  for (const name of target.split('|').map(item => item.trim()).filter(Boolean)) {
    if (name === 'proposal-moves') {
      const proposalTarget = proposalMovesTarget()
      if (proposalTarget) return proposalTarget
      continue
    }
    const matches = Array.from(document.querySelectorAll<HTMLElement>(`[data-tutorial-target="${name}"]`))
    const visible = matches.find(element => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    if (visible) return visible
  }
  return undefined
}

function isProposalMovesTarget(element?: HTMLElement) {
  return Boolean(element?.closest('.proposal-summary-grid') && variantsOfZh('移动任务').some(label => element.textContent?.includes(label)))
}

function renderEmphasized(text: string): ReactNode[] {
  return text.split(/([“”「」][^“”「」]+[“”「」])/g).filter(Boolean).map((part, index) => {
    if (/^[“「].+[”」]$/.test(part)) return <strong className="tutorial-inline-emphasis" key={`${part}-${index}`}>{part}</strong>
    return <span key={`${part}-${index}`}>{part}</span>
  })
}

function visibleViewport() {
  const viewport = window.visualViewport
  return {
    top: viewport?.offsetTop ?? 0,
    height: viewport?.height ?? window.innerHeight,
  }
}

type PortalPlacement = {
  targetKey: string
  host: HTMLElement
}

export function TutorialCoachmark({ step, config, onRestart, onExit }: {
  step: TutorialStep
  config?: TutorialCoachmarkConfig
  onRestart: () => void
  onExit: () => void
}) {
  const t = useT()
  const [collapsed, setCollapsed] = useState(false)
  const [portalPlacement, setPortalPlacement] = useState<PortalPlacement | null>(null)
  const [repairMovesInspected, setRepairMovesInspected] = useState(false)

  useEffect(() => {
    setCollapsed(false)
    setRepairMovesInspected(false)
  }, [step])

  const effectiveConfig = useMemo(() => {
    if (!config) return undefined
    if (step === 'repair-preview') {
      return {
        ...config,
        target: repairMovesInspected ? 'proposal-primary' : 'proposal-moves|proposal-primary',
        text: repairMovesInspected
          ? t('tutorialCoachmark.step.repairPreviewAfter')
          : t('tutorialCoachmark.step.repairPreviewBefore'),
      }
    }
    return { ...config, text: tutorialCopyOverrides(t)[step] ?? config.text }
  }, [config, repairMovesInspected, step, t])

  useEffect(() => {
    let target: HTMLElement | undefined
    let cancelled = false
    let removeInteractionListener: (() => void) | undefined
    let mutationObserver: MutationObserver | undefined
    let locateFrame: number | undefined
    const timers: number[] = []
    const targetKey = effectiveConfig?.target ?? ''

    if (!targetKey) setPortalPlacement(null)

    const locate = () => {
      if (cancelled) return
      const found = findTarget(effectiveConfig?.target)
      if (!found) {
        target?.classList.remove('tutorial-highlight')
        target = undefined
        removeInteractionListener?.()
        removeInteractionListener = undefined
        setPortalPlacement(current => current?.targetKey === targetKey ? null : current)
        return
      }
      if (target && target !== found) target.classList.remove('tutorial-highlight')
      target = found
      if (!collapsed) found.classList.add('tutorial-highlight')

      removeInteractionListener?.()
      removeInteractionListener = undefined
      if (step === 'repair-preview' && !repairMovesInspected && isProposalMovesTarget(found)) {
        const handleInspect = () => setRepairMovesInspected(true)
        found.addEventListener('click', handleInspect, { once: true })
        removeInteractionListener = () => found.removeEventListener('click', handleInspect)
      }

      const modalCard = found.closest<HTMLElement>('.modal-card')
      const modalSlot = modalCard?.querySelector<HTMLElement>('.tutorial-modal-coachmark-slot') ?? null
      setPortalPlacement(current => {
        if (!modalSlot || !modalSlot.isConnected) return current?.targetKey === targetKey ? null : current
        if (current?.targetKey === targetKey && current.host === modalSlot) return current
        return { targetKey, host: modalSlot }
      })

      if (collapsed) return
      const rect = found.getBoundingClientRect()
      const viewport = visibleViewport()
      const safeTop = viewport.top + 72
      const safeBottom = viewport.top + viewport.height - 24
      if (rect.top < safeTop || rect.bottom > safeBottom) {
        found.scrollIntoView({ behavior: 'smooth', block: modalCard ? 'nearest' : 'center', inline: 'nearest' })
      }
    }

    const scheduleLocate = () => {
      if (cancelled) return
      if (locateFrame !== undefined) window.cancelAnimationFrame(locateFrame)
      locateFrame = window.requestAnimationFrame(() => {
        locateFrame = undefined
        locate()
      })
    }

    locate()
    for (const delay of [80, 220, 520, 900]) timers.push(window.setTimeout(locate, delay))

    // 同一个教程步骤里也可能打开/关闭真实业务弹窗。目标节点因此会在不切换 step 的情况下
    // 从页面按钮变成弹窗字段。持续观察 DOM，让高亮和提示自动跟随当前实际可操作控件。
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(scheduleLocate)
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-tutorial-target', 'hidden', 'aria-hidden', 'open'],
      })
    }
    window.addEventListener('resize', scheduleLocate)
    window.visualViewport?.addEventListener('resize', scheduleLocate)

    return () => {
      cancelled = true
      timers.forEach(window.clearTimeout)
      if (locateFrame !== undefined) window.cancelAnimationFrame(locateFrame)
      mutationObserver?.disconnect()
      window.removeEventListener('resize', scheduleLocate)
      window.visualViewport?.removeEventListener('resize', scheduleLocate)
      removeInteractionListener?.()
      target?.classList.remove('tutorial-highlight')
    }
  }, [step, effectiveConfig?.target, collapsed, repairMovesInspected])

  if (!effectiveConfig) return null

  const content = collapsed ? (
    <div className="tutorial-coachmark-collapsed">
      <button className="primary-button" onClick={() => setCollapsed(false)}>{t('tutorialCoachmark.reopen')}</button>
      <button className="text-button" onClick={onExit}>{t('tutorialCoachmark.exit')}</button>
    </div>
  ) : (
    <div className="tutorial-coachmark" role="status" aria-live="polite">
      <div className="tutorial-coachmark-head">
        <span>{effectiveConfig.eyebrow ?? t('tutorialCoachmark.eyebrow')}</span>
        <div>
          <button className="tutorial-icon-button" onClick={onRestart} title={t('tutorialCoachmark.restartTitle')} aria-label={t('tutorialCoachmark.restartTitle')}><RotateCcw size={14}/></button>
          <button className="tutorial-icon-button" onClick={() => setCollapsed(true)} title={t('tutorialCoachmark.collapseTitle')} aria-label={t('tutorialCoachmark.collapseTitle')}><X size={15}/></button>
        </div>
      </div>
      <div className="tutorial-coachmark-copy">
        {effectiveConfig.headline && <strong className="tutorial-coachmark-title">{effectiveConfig.headline}</strong>}
        <p>{renderEmphasized(effectiveConfig.text)}</p>
      </div>
      {(effectiveConfig.secondaryLabel || effectiveConfig.actionLabel) && <div className="tutorial-coachmark-actions">
        {effectiveConfig.secondaryLabel && <button className="secondary-button" onClick={effectiveConfig.onSecondary}>{effectiveConfig.secondaryLabel}</button>}
        {effectiveConfig.actionLabel && <button className="primary-button" onClick={effectiveConfig.onAction}>{effectiveConfig.actionLabel}</button>}
      </div>}
      <div className="tutorial-coachmark-footer">
        <button className="tutorial-exit-button" onClick={onExit}><LogOut size={13}/>{t('tutorialCoachmark.exit')}</button>
      </div>
    </div>
  )

  const activePortalHost = portalPlacement
    && portalPlacement.targetKey === (effectiveConfig.target ?? '')
    && portalPlacement.host.isConnected
      ? portalPlacement.host
      : null

  return activePortalHost ? createPortal(content, activePortalHost) : content
}
