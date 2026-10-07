import { Check, Clock3, Ellipsis, Lock, Play, Unlock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Assignment, TaskGroup } from '../types'
import { minutesText } from '../lib/date'
import { useApp } from '../AppContext'
import { useT } from '../lib/i18n'

export function nativeTaskDragAvailable(matchMedia: ((query: string) => MediaQueryList) | undefined = typeof window === 'undefined' ? undefined : window.matchMedia?.bind(window)) {
  if (!matchMedia) return false
  // HTML5 draggable 会在部分 Android Chromium / Edge（尤其桌面图标/PWA 模式）里抢占手指纵向滑动。
  // 触屏笔记本（Windows/Edge 常见）主指针是 fine 且支持 hover，但同时也存在 coarse 触摸指针，
  // 只判断 (hover:hover)+(pointer:fine) 会误放行，因此再排除 any-pointer: coarse。
  // 只有纯鼠标桌面环境（无任何粗指针）才启用原生拖拽；触屏仍保留点击/计时等全部操作。
  return matchMedia('(hover: hover) and (pointer: fine) and not (any-pointer: coarse)').matches
}

export function TaskCard({ assignment, group, onComplete, onOpenTimer, compact = false, tutorialTarget = false, tutorialLocked = false, tutorialDisabled = false, onTutorialBlocked }: { assignment: Assignment; group: TaskGroup; onComplete: (assignment: Assignment) => void; onOpenTimer: (assignment: Assignment) => void; compact?: boolean; tutorialTarget?: boolean; tutorialLocked?: boolean; tutorialDisabled?: boolean; onTutorialBlocked?: (message?: string) => void }) {
  const t = useT()
  const { state, updateAssignment, startTimer } = useApp()
  const [tick, setTick] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const timer = state.timer
  const active = timer.assignmentId === assignment.id
  const anotherTimerActive = Boolean(timer.assignmentId && !active)
  // HTML5 draggable 会在部分 Android Chromium / Edge（尤其桌面图标/PWA 模式）里抢占手指纵向滑动。
  // 只有明确支持鼠标悬停且主指针为 fine 的桌面环境才启用原生拖拽；触屏仍保留点击/计时等全部操作。
  const nativeDragEnabled = nativeTaskDragAvailable()

  useEffect(() => {
    if (!active || !timer.running) return
    const id = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => window.clearInterval(id)
  }, [active, timer.running])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  void tick
  const elapsed = active ? timer.accumulatedSeconds + (timer.running && timer.startedAt ? Math.floor((Date.now() - timer.startedAt) / 1000) : 0) : 0

  const complete = () => {
    if (tutorialDisabled) { onTutorialBlocked?.(t('taskCard.tutorialFirstFinishHighlighted')); return }
    if (assignment.status === 'done') return
    // 正在计时的任务必须回到统一的计时结束流程，避免首页勾选后丢失尚未结算的秒数。
    if (active) { onOpenTimer(assignment); return }
    onComplete(assignment)
  }

  const reopen = () => {
    setMenuOpen(false)
    const confirmed = window.confirm(t('taskCard.confirmReopen', { title: assignment.title }))
    if (!confirmed) return
    updateAssignment(assignment.id, { status: 'todo', progress: 0, completedAt: undefined, remainingMinutes: undefined })
  }

  return (
    <article
      data-assignment-id={assignment.id}
      className={`task-card ${assignment.status === 'done' ? 'task-done' : ''} ${compact ? 'task-compact' : ''}`}
      draggable={nativeDragEnabled && !tutorialLocked && !assignment.locked && assignment.status !== 'done'}
      onDragStart={event => {
        if (!nativeDragEnabled) { event.preventDefault(); return }
        event.dataTransfer.setData('text/assignment-id', assignment.id)
      }}
    >
      <button className={`check-button ${tutorialDisabled ? 'tutorial-disabled-control' : ''}`} data-tutorial-target={tutorialTarget ? 'tutorial-execute' : undefined} data-tutorial-action={tutorialTarget ? 'complete-tutorial-task' : undefined} onClick={complete} disabled={assignment.status === 'done'} aria-disabled={tutorialDisabled || undefined} aria-label={assignment.status === 'done' ? t('taskCard.taskDone') : t('taskCard.completeTask')} title={assignment.status === 'done' ? t('taskCard.completeTaskTitleDone') : tutorialDisabled ? t('taskCard.tutorialFirstFinishHighlighted') : t('taskCard.completeTask')}>
        {assignment.status === 'done' ? <Check size={18} /> : null}
      </button>
      <div className="task-main">
        <div className="task-title-row"><span className={`subject-pill subject-${group.subject}`}>{group.subject}</span><strong>{assignment.title}</strong>{assignment.intentStrength === 'manual' && !assignment.locked && <span className="task-intent-badge">{t('taskCard.manualPriority')}</span>}{assignment.locked && <span className="task-lock-badge">{t('taskCard.locked')}</span>}</div>
        <div className="task-meta">
          <span>{group.flexibleDuration && assignment.actualMinutes === 0 ? t('taskCard.referenceMinutes', { minutes: minutesText(assignment.estimatedMinutes) }) : t('taskCard.estimatedMinutes', { minutes: minutesText(assignment.estimatedMinutes) })}</span>
          {assignment.actualMinutes > 0 && <span>{t('taskCard.actualMinutes', { minutes: minutesText(assignment.actualMinutes) })}</span>}
          {assignment.status === 'partial' && <span>{t('taskCard.completedPercent', { percent: assignment.progress })}</span>}
          {assignment.status === 'partial' && assignment.remainingMinutes !== undefined && <span>{t('taskCard.remainingReference', { minutes: minutesText(assignment.remainingMinutes) })}</span>}
          {assignment.actualMinutes > 0 && assignment.status === 'done' && <span className={assignment.actualMinutes > assignment.estimatedMinutes ? 'diff-over' : 'diff-under'}>{assignment.actualMinutes - assignment.estimatedMinutes > 0 ? '+' : ''}{assignment.actualMinutes - assignment.estimatedMinutes}{t('taskCard.diffMinutesSuffix')}</span>}
        </div>
        {active && <div className="timer-strip"><Clock3 size={15}/><span>{String(Math.floor(elapsed / 3600)).padStart(2,'0')}:{String(Math.floor(elapsed % 3600 / 60)).padStart(2,'0')}:{String(elapsed % 60).padStart(2,'0')}</span></div>}
      </div>
      {!compact && <div className="task-actions">
        {assignment.status !== 'done' && (active
          ? <button className={`text-button timer-start-button ${tutorialLocked ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialLocked || undefined} onClick={() => tutorialLocked ? onTutorialBlocked?.(t('taskCard.tutorialNoTimerControl')) : onOpenTimer(assignment)}><Clock3 size={15}/>{t('taskCard.backToTimer')}</button>
          : anotherTimerActive
            ? <button className={`text-button timer-start-button ${tutorialLocked ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialLocked || undefined} onClick={() => tutorialLocked ? onTutorialBlocked?.(t('taskCard.tutorialNoTimerControl')) : onOpenTimer(assignment)} title={t('taskCard.finishCurrentTimerFirst')}><Clock3 size={15}/>{t('taskCard.viewCurrentTimer')}</button>
            : <button className={`text-button timer-start-button ${tutorialLocked ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialLocked || undefined} onClick={() => { if (tutorialLocked) { onTutorialBlocked?.(t('taskCard.tutorialNoTimerControl')); return }; startTimer(assignment.id); onOpenTimer(assignment) }}><Play size={15}/>{t('taskCard.startTimer')}</button>)}
        <button className={`icon-button subtle task-lock-action ${tutorialLocked ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialLocked || undefined} aria-label={assignment.locked ? t('taskCard.unlockTask') : t('taskCard.lockTask')} onClick={() => tutorialLocked ? onTutorialBlocked?.(t('taskCard.tutorialNoLockChange')) : updateAssignment(assignment.id, { locked: !assignment.locked })}>{assignment.locked ? <Lock size={16}/> : <Unlock size={16}/>}<span className="mobile-action-label">{assignment.locked ? t('taskCard.unlock') : t('taskCard.lock')}</span></button>
        {assignment.status === 'done' && <div className="task-more" ref={menuRef}>
          <button className={`icon-button subtle ${tutorialLocked ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialLocked || undefined} onClick={() => tutorialLocked ? onTutorialBlocked?.(t('taskCard.tutorialNoReopen')) : setMenuOpen(value => !value)} aria-label={t('taskCard.moreActions')} title={t('taskCard.more')}><Ellipsis size={18} aria-hidden="true"/></button>
          {menuOpen && <div className="task-more-menu"><button onClick={reopen}>{t('taskCard.reopenTask')}</button><small>{t('taskCard.reopenHint')}</small></div>}
        </div>}
      </div>}
    </article>
  )
}
