import { Check, Clock3, Pause, Play, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { minutesText, timestampForDate, todayISO } from '../lib/date'
import { uid } from '../lib/id'
import { appendStatusEvent } from '../lib/execution'
import { getTimerElapsedSeconds } from '../lib/timer'
import { useT } from '../lib/i18n'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'

function formatElapsed(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

export function FocusTimerPage({ onExit }: { onExit: () => void }) {
  const t = useT()
  const {
    state, commit, startTimer, pauseTimer, stopTimer, addTime, finishAssignment
  } = useApp()
  const [tick, setTick] = useState(0)
  const [finishOpen, setFinishOpen] = useState(false)
  const [sessionMinutes, setSessionMinutes] = useState('')
  const [progress, setProgress] = useState(50)
  const [wasRunningBeforeFinish, setWasRunningBeforeFinish] = useState(false)

  const timer = state.timer
  const assignment = state.assignments.find(item => item.id === timer.assignmentId)
  const group = assignment ? state.taskGroups.find(item => item.id === assignment.groupId) : undefined

  useEffect(() => {
    if (!timer.running) return
    const id = window.setInterval(() => setTick(value => value + 1), 250)
    return () => window.clearInterval(id)
  }, [timer.running])
  void tick

  const elapsedSeconds = getTimerElapsedSeconds(timer)
  const elapsedText = formatElapsed(elapsedSeconds)
  const expectedSeconds = Math.max(60, (assignment?.estimatedMinutes ?? 1) * 60)
  const progressRatio = Math.min(1, elapsedSeconds / expectedSeconds)
  const progressDegrees = Math.round(progressRatio * 360)
  const overtimeSeconds = Math.max(0, elapsedSeconds - expectedSeconds)

  useEffect(() => {
    if (!assignment) return
    const previous = document.title
    document.title = `${elapsedText} · ${assignment.title}`
    return () => { document.title = previous }
  }, [assignment, elapsedText])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (finishOpen || !assignment) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (timer.running) pauseTimer()
        else startTimer(assignment.id)
      }
      if (event.key === 'Escape') onExit()
      if (event.key === 'Enter') openFinish()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const openFinish = () => {
    if (!assignment) return
    const running = timer.running
    setWasRunningBeforeFinish(running)
    if (running) pauseTimer()
    const roundedMinutes = Math.max(1, Math.round(elapsedSeconds / 60))
    setSessionMinutes(String(roundedMinutes))
    setProgress(assignment.status === 'partial' ? Math.max(1, Math.min(99, assignment.progress)) : 50)
    setFinishOpen(true)
  }

  const closeFinish = () => {
    setFinishOpen(false)
    if (assignment && wasRunningBeforeFinish) startTimer(assignment.id)
  }

  const commitSession = (mode: 'time' | 'partial' | 'done') => {
    if (!assignment) return
    const minutes = Math.max(1, Math.round(Number(sessionMinutes) || 1))
    // Reset the running session first. The chosen minute value below is authoritative.
    stopTimer()
    if (mode === 'time') addTime(assignment.id, minutes, 'timer')
    if (mode === 'done') finishAssignment(assignment.id, minutes, 'timer')
    if (mode === 'partial') {
      commit(draft => {
        const item = draft.assignments.find(candidate => candidate.id === assignment.id)
        if (!item) return
        item.actualMinutes += minutes
        const date = todayISO()
        const changedAt = new Date().toISOString()
        item.timeEntries.push({ id: uid('time'), minutes, date, createdAt: changedAt, source: 'timer' })
        item.progress = Math.max(1, Math.min(99, progress))
        item.remainingMinutes = Math.max(1, Math.round(item.estimatedMinutes * (1 - item.progress / 100)))
        item.status = 'partial'
        item.completedAt = undefined
        appendStatusEvent(item, 'partial', item.progress, date, 'partial', changedAt)
        draft.timer = { accumulatedSeconds: 0, running: false }
      })
    }
    setFinishOpen(false)
    onExit()
  }

  const stateLabel = timer.running ? t('focusTimerPage.running') : t('focusTimerPage.paused')
  const remainingLabel = overtimeSeconds > 0
    ? t('focusTimerPage.overtimeBy', { minutes: minutesText(Math.ceil(overtimeSeconds / 60)) })
    : t('focusTimerPage.remainingUntil', { minutes: minutesText(Math.ceil((expectedSeconds - elapsedSeconds) / 60)) })

  if (!assignment || !group) {
    return (
      <main className="focus-timer-page focus-timer-empty">
        <div className="focus-empty-card">
          <Clock3 size={42}/>
          <h1>{t('focusTimerPage.noActiveTask')}</h1>
          <p>{t('focusTimerPage.noActiveTaskHint')}</p>
          <button className="primary-button" onClick={onExit}>{t('focusTimerPage.backToToday')}</button>
        </div>
      </main>
    )
  }

  return (
    <main className={`focus-timer-page ${timer.running ? 'is-running' : 'is-paused'}`}>
      <button className="focus-exit-button" onClick={onExit} aria-label={t('focusTimerPage.exitAriaLabel')}><X size={22}/><span>{t('focusTimerPage.exit')}</span></button>

      <section className="focus-timer-stage">
        <div className="focus-task-heading">
          <span className={`subject-pill subject-${group.subject}`}>{group.subject}</span>
          <h1>{assignment.title}</h1>
          <p>{stateLabel} · {t('focusTimerPage.expectedPrefix', { minutes: minutesText(assignment.estimatedMinutes) })}</p>
        </div>

        <div className="focus-clock-wrap" style={{ '--timer-progress': `${progressDegrees}deg` } as any}>
          <div className="focus-clock-inner">
            <span className="focus-clock-status">{stateLabel}</span>
            <strong>{elapsedText}</strong>
            <small>{remainingLabel}</small>
          </div>
        </div>

        <div className="focus-primary-controls">
          <button
            className={`focus-control-button ${timer.running ? 'pause' : 'play'}`}
            onClick={() => timer.running ? pauseTimer() : startTimer(assignment.id)}
          >
            {timer.running ? <Pause size={28}/> : <Play size={28}/>}<span>{timer.running ? t('focusTimerPage.pause') : t('focusTimerPage.resume')}</span>
          </button>
          <button className="focus-finish-button" onClick={openFinish}><Check size={22}/><span>{t('focusTimerPage.finishTimer')}</span></button>
        </div>

        <div className="focus-shortcuts"><span>{t('focusTimerPage.shortcutSpace')}</span><span>{t('focusTimerPage.shortcutEnter')}</span><span>{t('focusTimerPage.shortcutEsc')}</span></div>
      </section>

      <Modal open={finishOpen} title={t('focusTimerPage.finishModalTitle')} onClose={closeFinish}>
        <div className="focus-finish-summary">
          <Clock3 size={22}/>
          <div><strong>{assignment.title}</strong><span>{t('focusTimerPage.thisSessionDuration', { elapsed: elapsedText })}</span></div>
        </div>
        <div className="form-stack">
          <label className="field"><span>{t('focusTimerPage.recordActualMinutes')}</span><NumericInput min={1} max={1440} step={1} value={sessionMinutes === '' ? undefined : Number(sessionMinutes)} onValueChange={value => setSessionMinutes(String(value))} onEmpty={() => setSessionMinutes('')} autoFocus/></label>
          <label className="field"><span>{t('focusTimerPage.saveAsPartialProgress')}</span><NumericInput min={1} max={99} value={progress} onValueChange={setProgress}/></label>
        </div>
        <p className="focus-finish-tip">{t('focusTimerPage.finishTip')}</p>
        <div className="modal-actions focus-finish-actions">
          <button className="secondary-button" onClick={() => commitSession('time')}>{t('focusTimerPage.recordTimeOnly')}</button>
          <button className="secondary-button" onClick={() => commitSession('partial')}>{t('focusTimerPage.saveAsPartial')}</button>
          <button className="primary-button" onClick={() => commitSession('done')}>{t('focusTimerPage.markDone')}</button>
        </div>
      </Modal>
    </main>
  )
}
