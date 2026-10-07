import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight, CalendarDays, CheckCircle2, ChevronLeft, Clock3, ListChecks,
  RefreshCw, SlidersHorizontal, Sparkles,
} from 'lucide-react'
import type { AppState, DurationSuggestion, PlanChangeEvent, SchedulingPreference } from '../types'
import { analyzePlan, allDurationSuggestions } from '../lib/planner'
import { cloneActiveState } from '../lib/state'
import { dateRange, getCapacity, shiftDate, todayISO } from '../lib/date'
import { uid } from '../lib/id'
import { useT } from '../lib/i18n'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'

export type AdjustmentReason = 'current-conflicts' | 'too-tiring' | 'future-replan' | 'execution-difference'
type ActiveAction = 'center' | 'availability' | 'deadline' | 'bulk-move' | 'current-conflicts' | 'duration' | 'load' | 'replan'

/**
 * “修复当前计划问题”的任务范围：逾期任务 + 危险问题日期上的已排任务 + 全部仍未安排的
 * 未完成任务。未安排任务若不进入该集合，重排中心将永远无法为它们找到日期。
 */
export function currentConflictsScope(state: AppState): string[] {
  const today = todayISO()
  const affectedDates = analyzePlan(state, today)
    .filter(issue => issue.level === 'danger')
    .flatMap(issue => issue.date ? [issue.date] : [])
    .filter((date, index, values) => values.indexOf(date) === index)
  return Array.from(new Set([
    ...state.assignments.filter(item => item.status !== 'done' && item.scheduledDate && item.scheduledDate < today).map(item => item.id),
    ...state.assignments.filter(item => item.status !== 'done' && item.scheduledDate && affectedDates.includes(item.scheduledDate)).map(item => item.id),
    ...state.assignments.filter(item => item.status !== 'done' && !item.scheduledDate).map(item => item.id),
  ]))
}
type LoadPreference = 'preserve' | 'balanced' | 'goal' | 'rest'
type ReplanOutcome = 'preserve' | 'balanced' | 'goal' | 'rest'

function usePreferenceCopy(t: ReturnType<typeof useT>): Record<LoadPreference, { title: string; description: string }> {
  return {
    preserve: { title: t('adjustmentIntentDialog.preservePreferenceTitle'), description: t('adjustmentIntentDialog.preservePreferenceDescription') },
    balanced: { title: t('adjustmentIntentDialog.balancedPreferenceTitle'), description: t('adjustmentIntentDialog.balancedPreferenceDescription') },
    goal: { title: t('adjustmentIntentDialog.goalPreferenceTitle'), description: t('adjustmentIntentDialog.goalPreferenceDescription') },
    rest: { title: t('adjustmentIntentDialog.restPreferenceTitle'), description: t('adjustmentIntentDialog.restPreferenceDescription') },
  }
}

function useActionGroups(t: ReturnType<typeof useT>): Array<{ title: string; description: string; items: Array<{ id: Exclude<ActiveAction, 'center'>; title: string; description: string; tone?: 'attention' | 'secondary' }> }> {
  return [
    {
      title: t('adjustmentIntentDialog.groupConditionsTitle'),
      description: t('adjustmentIntentDialog.groupConditionsDescription'),
      items: [
        { id: 'availability', title: t('adjustmentIntentDialog.availabilityTitle'), description: t('adjustmentIntentDialog.availabilityDescription') },
        { id: 'deadline', title: t('adjustmentIntentDialog.deadlineTitle'), description: t('adjustmentIntentDialog.deadlineDescription') },
        { id: 'bulk-move', title: t('adjustmentIntentDialog.bulkMoveTitle'), description: t('adjustmentIntentDialog.bulkMoveDescription') },
      ],
    },
    {
      title: t('adjustmentIntentDialog.groupStatusTitle'),
      description: t('adjustmentIntentDialog.groupStatusDescription'),
      items: [
        { id: 'current-conflicts', title: t('adjustmentIntentDialog.currentConflictsTitle'), description: t('adjustmentIntentDialog.currentConflictsDescription'), tone: 'attention' },
        { id: 'duration', title: t('adjustmentIntentDialog.durationTitle'), description: t('adjustmentIntentDialog.durationDescription') },
        { id: 'load', title: t('adjustmentIntentDialog.loadTitle'), description: t('adjustmentIntentDialog.loadDescription') },
        { id: 'replan', title: t('adjustmentIntentDialog.replanTitle'), description: t('adjustmentIntentDialog.replanDescription') },
      ],
    },
  ]
}

function inPlanDate(date: string, state: AppState) {
  return date < state.settings.startDate ? state.settings.startDate : date > state.settings.endDate ? state.settings.endDate : date
}

function ActionCard({ actionId, title, description, tone, blocked = false, onClick }: { actionId: string; title: string; description: string; tone?: 'attention' | 'secondary'; blocked?: boolean; onClick: () => void }) {
  const tutorialTarget = actionId === 'current-conflicts' ? 'repair-current' : actionId === 'replan' ? 'future-replan' : undefined
  return <button type="button" data-tutorial-target={tutorialTarget} data-tutorial-action={actionId} aria-disabled={blocked || undefined} className={`adjustment-action-card ${tone ?? ''} ${blocked ? 'tutorial-disabled-control' : ''}`} onClick={onClick}>
    <span className="adjustment-action-copy"><strong>{title}</strong><span>{description}</span></span>
    <ArrowUpRight size={18} aria-hidden="true" />
  </button>
}

function ActionHeader({ title, description, onBack }: { title: string; description: string; onBack: () => void }) {
  const t = useT()
  return <>
    <button type="button" className="adjustment-back-button" onClick={onBack}><ChevronLeft size={17} />{t('adjustmentIntentDialog.backToCenter')}</button>
    <section className="adjustment-action-header">
      <div className="adjustment-action-icon"><SlidersHorizontal size={21} /></div>
      <div><strong>{title}</strong><p>{description}</p></div>
    </section>
  </>
}

export function AdjustmentIntentDialog({
  open, state, initialDate, initialReason = 'current-conflicts', onClose, onPrepared,
  onOpenIntake, onOpenDeadline, onOpenBulkMove, onDurationSuggestion, tutorialMode, onTutorialBlocked,
}: {
  open: boolean
  state: AppState
  initialDate?: string
  initialReason?: AdjustmentReason
  onClose: () => void
  onPrepared: (prepared: AppState, event: PlanChangeEvent) => void
  onOpenIntake?: () => void
  onOpenDeadline?: () => void
  onOpenBulkMove?: () => void
  onDurationSuggestion?: (suggestion: DurationSuggestion) => void
  tutorialMode?: 'repair' | 'future'
  onTutorialBlocked?: (message?: string) => void
}) {
  const t = useT()
  const preferenceCopy = usePreferenceCopy(t)
  const actionGroups = useActionGroups(t)
  const today = todayISO()
  const defaultDate = inPlanDate(initialDate ?? today, state)
  const [activeAction, setActiveAction] = useState<ActiveAction>('center')
  const [availabilityStart, setAvailabilityStart] = useState(defaultDate)
  const [availabilityEnd, setAvailabilityEnd] = useState(defaultDate)
  const [availabilityMode, setAvailabilityMode] = useState<'unavailable' | 'reduced'>('unavailable')
  const [availableMinutes, setAvailableMinutes] = useState(60)
  const [availabilityReason, setAvailabilityReason] = useState(t('adjustmentIntentDialog.defaultAvailabilityReason'))
  const [loadStart, setLoadStart] = useState(defaultDate)
  const [loadEnd, setLoadEnd] = useState(inPlanDate(shiftDate(defaultDate, 6), state))
  const [loadDailyMax, setLoadDailyMax] = useState(Math.max(30, Math.round(getCapacity(state, defaultDate) * 0.8)))
  const [lightDaysPerWeek, setLightDaysPerWeek] = useState(1)
  const [maxHighLoadStreak, setMaxHighLoadStreak] = useState(2)
  const [maxLongHighPerDay, setMaxLongHighPerDay] = useState(1)
  const [loadPreference, setLoadPreference] = useState<LoadPreference>('rest')
  const [replanStart, setReplanStart] = useState(defaultDate)
  const [includeToday, setIncludeToday] = useState(false)
  const [replanSubject, setReplanSubject] = useState('all')
  const [replanOutcome, setReplanOutcome] = useState<ReplanOutcome>('balanced')
  const [todayMode, setTodayMode] = useState<'none' | '30' | '60' | 'custom'>('none')
  const [customMinutes, setCustomMinutes] = useState(30)

  const overdueAssignments = useMemo(() => state.assignments
    .filter(item => item.status !== 'done' && item.scheduledDate && item.scheduledDate < today), [state.assignments, today])
  const unscheduledCount = useMemo(() => state.assignments.filter(item => item.status !== 'done' && !item.scheduledDate).length, [state.assignments])
  const currentIssues = useMemo(() => {
    const hard = analyzePlan(state, today).filter(issue => issue.level === 'danger')
    const overdue = overdueAssignments
      .map(item => ({ level: 'danger' as const, date: item.scheduledDate, message: t('adjustmentIntentDialog.overdueMessage', { title: item.title }) }))
    return [...overdue, ...hard]
  }, [state, today, overdueAssignments, t])
  const durationSuggestions = useMemo(() => allDurationSuggestions(state), [state])
  const subjects = useMemo(() => Array.from(new Set(state.taskGroups.map(group => group.subject))).sort(), [state.taskGroups])
  const initialAction: ActiveAction = tutorialMode ? 'center' : initialReason === 'too-tiring' ? 'load' : initialReason === 'future-replan' ? 'replan' : initialDate ? 'current-conflicts' : 'center'

  useEffect(() => {
    if (!open) return
    setActiveAction(initialAction)
    setAvailabilityStart(defaultDate)
    setAvailabilityEnd(defaultDate)
    setAvailabilityMode('unavailable')
    setAvailableMinutes(60)
    setAvailabilityReason(t('adjustmentIntentDialog.defaultAvailabilityReason'))
    setLoadStart(defaultDate)
    setLoadEnd(inPlanDate(shiftDate(defaultDate, 6), state))
    setLoadDailyMax(Math.max(30, Math.round(getCapacity(state, defaultDate) * 0.8)))
    setLightDaysPerWeek(1)
    setMaxHighLoadStreak(2)
    setMaxLongHighPerDay(1)
    setLoadPreference('rest')
    setReplanStart(defaultDate)
    setIncludeToday(false)
    setReplanSubject('all')
    setReplanOutcome(tutorialMode === 'future' ? 'goal' : 'balanced')
    setTodayMode('none')
    setCustomMinutes(30)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAction, defaultDate, state, tutorialMode])

  const backToCenter = () => setActiveAction('center')
  const todayExtraMinutes = todayMode === '30' ? 30 : todayMode === '60' ? 60 : todayMode === 'custom' ? Math.max(0, customMinutes) : 0

  const submit = () => {
    const now = new Date().toISOString()
    const prepared = cloneActiveState(state)
    let event: PlanChangeEvent

    if (activeAction === 'availability') {
      if (!availabilityStart || !availabilityEnd || availabilityStart > availabilityEnd) return
      const dates = dateRange(availabilityStart, availabilityEnd)
      prepared.calendarConstraints.push({
        id: uid('constraint'), startDate: availabilityStart, endDate: availabilityEnd,
        kind: availabilityMode === 'unavailable' ? 'unavailable' : 'reduced-capacity',
        capacityMinutes: availabilityMode === 'unavailable' ? 0 : Math.max(0, Math.min(1440, availableMinutes)),
        protected: true, reason: availabilityReason.trim() || t('adjustmentIntentDialog.availabilityChangeReason'), createdAt: now, updatedAt: now,
      })
      const modeText = availabilityMode === 'unavailable' ? t('adjustmentIntentDialog.availabilityModeUnavailable') : t('adjustmentIntentDialog.availabilityModeReduced', { minutes: Math.max(0, Math.min(1440, availableMinutes)) })
      event = {
        id: uid('event'), type: 'availability-change', action: 'repair', title: t('adjustmentIntentDialog.availabilityChangeReason'),
        description: t('adjustmentIntentDialog.availabilityChangeDescription', { start: availabilityStart, end: availabilityEnd, modeText }),
        affectedGoalIds: [], affectedGroupIds: [], affectedAssignmentIds: [], affectedDates: dates, createdAt: now,
        metadata: { availabilityMode, capacityMinutes: availabilityMode === 'unavailable' ? 0 : availableMinutes, preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'] },
      }
    } else if (activeAction === 'current-conflicts') {
      const affectedAssignmentIds = currentConflictsScope(state)
      const unscheduledCount = state.assignments.filter(item => item.status !== 'done' && !item.scheduledDate).length
      const affectedGroupIds = Array.from(new Set(state.assignments.filter(item => affectedAssignmentIds.includes(item.id)).map(item => item.groupId)))
      const affectedGoalIds = state.goals.filter(goal => goal.linkedAssignmentIds.some(id => affectedAssignmentIds.includes(id)) || goal.linkedTaskGroupIds.some(id => affectedGroupIds.includes(id)) || goal.completionConditions.some(condition => affectedGroupIds.includes(condition.groupId))).map(goal => goal.id)
      const affectedDates = currentIssues.flatMap(issue => issue.date ? [issue.date] : []).filter((date, index, values) => values.indexOf(date) === index)
      event = {
        id: uid('event'), type: 'execution-difference', action: 'repair', title: t('adjustmentIntentDialog.currentConflictsEventTitle'),
        description: unscheduledCount > 0
          ? t('adjustmentIntentDialog.currentConflictsWithUnscheduled', { issueCount: currentIssues.length, unscheduledCount })
          : t('adjustmentIntentDialog.currentConflictsWithoutUnscheduled', { issueCount: currentIssues.length }),
        affectedGoalIds, affectedGroupIds, affectedAssignmentIds,
        affectedDates, createdAt: now,
        metadata: { preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'], requestedOutcome: 'fix-current', sourceDate: initialDate ?? today },
      }
    } else if (activeAction === 'load') {
      const start = loadStart <= loadEnd ? loadStart : loadEnd
      const end = loadStart <= loadEnd ? loadEnd : loadStart
      const loadConstraints = {
        startDate: start, endDate: end,
        maxMinutesPerDay: Math.max(30, Math.min(1440, Math.round(loadDailyMax))),
        lightDaysPerWeek: Math.max(0, Math.min(7, Math.round(lightDaysPerWeek))),
        maxHighLoadStreak: Math.max(0, Math.min(14, Math.round(maxHighLoadStreak))),
        maxLongHighPerDay: Math.max(0, Math.min(10, Math.round(maxLongHighPerDay))),
      }
      event = {
        id: uid('event'), type: 'load-preference-change', action: 'optimize', title: t('adjustmentIntentDialog.loadEventTitle'),
        description: t('adjustmentIntentDialog.loadEventDescription', { start, end, maxMinutes: loadConstraints.maxMinutesPerDay, lightDays: loadConstraints.lightDaysPerWeek, maxStreak: loadConstraints.maxHighLoadStreak, maxLongHigh: loadConstraints.maxLongHighPerDay }),
        affectedGoalIds: [], affectedGroupIds: [], affectedAssignmentIds: [], affectedDates: dateRange(start, end), createdAt: now,
        metadata: {
          preferredPreference: loadPreference, preferredPreferences: [loadPreference, ...(['preserve', 'balanced', 'goal', 'rest'] as SchedulingPreference[]).filter(item => item !== loadPreference)],
          loadConstraints, requestedOutcome: 'reduce-load', sourceDate: start,
        },
      }
    } else if (activeAction === 'replan') {
      const candidates = state.assignments.filter(item => {
        if (item.status === 'done' || state.timer.assignmentId === item.id) return false
        if (replanSubject === 'all') return true
        return state.taskGroups.find(group => group.id === item.groupId)?.subject === replanSubject
      })
      const fixedAssignmentIds = replanSubject === 'all'
        ? []
        : state.assignments.filter(item => !candidates.some(candidate => candidate.id === item.id) && item.status !== 'done').map(item => item.id)
      const preferences: SchedulingPreference[] = [replanOutcome, ...(['preserve', 'balanced', 'goal', 'rest'] as SchedulingPreference[]).filter(item => item !== replanOutcome)]
      const todaySuffix = includeToday ? t('adjustmentIntentDialog.replanIncludeToday') : t('adjustmentIntentDialog.replanExcludeToday')
      const subjectSuffix = replanSubject === 'all' ? t('adjustmentIntentDialog.replanAllSubjects') : t('adjustmentIntentDialog.replanOneSubject', { subject: replanSubject })
      event = {
        id: uid('event'), type: 'future-replanning', action: 'rebuild', title: t('adjustmentIntentDialog.replanEventTitle'),
        description: t('adjustmentIntentDialog.replanEventDescription', { start: replanStart, todaySuffix, subjectSuffix, preferenceDescription: preferenceCopy[replanOutcome].description }),
        affectedGoalIds: [], affectedGroupIds: [], affectedAssignmentIds: candidates.map(item => item.id),
        affectedDates: [replanStart], createdAt: now,
        metadata: {
          preferredPreference: replanOutcome, preferredPreferences: preferences, requestedOutcome: replanOutcome,
          fromDate: replanStart, includeToday, fixedAssignmentIds: fixedAssignmentIds.length ? fixedAssignmentIds : undefined,
          scopeSubject: replanSubject, todayExtraMinutes,
        },
      }
    } else {
      return
    }

    prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
    prepared.updatedAt = now
    onPrepared(prepared, event)
  }

  const renderCenter = () => <>
    <section className="adjustment-intro">
      <div>
        <span className="adjustment-eyebrow">{t('adjustmentIntentDialog.centerEyebrow')}</span>
        <strong>{t('adjustmentIntentDialog.centerHeading')}</strong>
        <p>{t('adjustmentIntentDialog.centerBody')}</p>
      </div>
      <div className="adjustment-intro-badges"><span>{t('adjustmentIntentDialog.badgePreview')}</span><span>{t('adjustmentIntentDialog.badgeHistory')}</span><span>{t('adjustmentIntentDialog.badgeUndo')}</span></div>
    </section>
    <div className="adjustment-action-groups">
      {actionGroups.map(group => <section className="adjustment-action-group" key={group.title}>
        <header><div><strong>{group.title}</strong><span>{group.description}</span></div></header>
        <div className="adjustment-action-grid">
          {group.items.map(item => {
            const allowedTutorialAction = !tutorialMode || item.id === (tutorialMode === 'repair' ? 'current-conflicts' : 'replan')
            const unscheduledSuffix = unscheduledCount ? t('adjustmentIntentDialog.unscheduledSuffix', { count: unscheduledCount }) : ''
            return <ActionCard key={item.id} actionId={item.id} title={item.title} description={item.id === 'current-conflicts' ? `${item.description} ${t('adjustmentIntentDialog.currentConflictsSuffix', { issueCount: currentIssues.length, unscheduledSuffix })}` : item.description} tone={item.tone} blocked={!allowedTutorialAction} onClick={() => {
              if (!allowedTutorialAction) { onTutorialBlocked?.(t('adjustmentIntentDialog.tutorialBlockedAction')); return }
              if (item.id === 'deadline') { onClose(); onOpenDeadline?.(); return }
              if (item.id === 'bulk-move') { onClose(); onOpenBulkMove?.(); return }
              setActiveAction(item.id)
            }} />
          })}
        </div>
      </section>)}
    </div>
    <section className="adjustment-related-entry">
      <div><strong>{t('adjustmentIntentDialog.newTaskEntryTitle')}</strong><span>{t('adjustmentIntentDialog.newTaskEntryBody')}</span></div>
      <button type="button" className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={Boolean(tutorialMode) || undefined} onClick={() => { if (tutorialMode) { onTutorialBlocked?.(t('adjustmentIntentDialog.tutorialBlockedIntake')); return }; onClose(); onOpenIntake?.() }}>{t('adjustmentIntentDialog.openIntake')} <ArrowUpRight size={15} /></button>
    </section>
  </>

  const renderAvailability = () => <>
    <ActionHeader title={t('adjustmentIntentDialog.availabilityTitle')} description={t('adjustmentIntentDialog.availabilityDescription')} onBack={backToCenter} />
    <section className="adjustment-form-section">
      <div className="adjustment-form-grid">
        <label className="field"><span>{t('adjustmentIntentDialog.startDate')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={availabilityStart} onChange={event => { setAvailabilityStart(event.target.value); if (availabilityEnd < event.target.value) setAvailabilityEnd(event.target.value) }} /></label>
        <label className="field"><span>{t('adjustmentIntentDialog.endDate')}</span><input type="date" min={availabilityStart} max={state.settings.endDate} value={availabilityEnd} onChange={event => setAvailabilityEnd(event.target.value)} /></label>
        <fieldset className="field span-2"><legend>{t('adjustmentIntentDialog.availabilityLegend')}</legend><div className="segmented-control"><button type="button" className={availabilityMode === 'unavailable' ? 'active' : ''} onClick={() => setAvailabilityMode('unavailable')}>{t('adjustmentIntentDialog.availabilityFullyUnavailable')}</button><button type="button" className={availabilityMode === 'reduced' ? 'active' : ''} onClick={() => setAvailabilityMode('reduced')}>{t('adjustmentIntentDialog.availabilityReduced')}</button></div></fieldset>
        {availabilityMode === 'reduced' && <label className="field"><span>{t('adjustmentIntentDialog.maxMinutesPerDay')}</span><NumericInput min={0} max={1440} value={availableMinutes} onValueChange={setAvailableMinutes} /></label>}
        <label className={`field ${availabilityMode === 'unavailable' ? 'span-2' : ''}`}><span>{t('adjustmentIntentDialog.reasonOptional')}</span><input value={availabilityReason} onChange={event => setAvailabilityReason(event.target.value)} placeholder={t('adjustmentIntentDialog.reasonPlaceholder')} /></label>
      </div>
      <div className="adjustment-form-note"><CalendarDays size={17} /><span>{t('adjustmentIntentDialog.availabilityNote')}</span></div>
    </section>
  </>

  const renderCurrentConflicts = () => <>
    <ActionHeader title={t('adjustmentIntentDialog.currentConflictsHeaderTitle')} description={t('adjustmentIntentDialog.currentConflictsHeaderDescription')} onBack={backToCenter} />
    <section className="adjustment-form-section">
      <div className={`adjustment-issue-summary ${currentIssues.length ? 'has-issues' : 'clear'}`}>
        {currentIssues.length ? <RefreshCw size={20} /> : <CheckCircle2 size={20} />}
        <div><strong>{currentIssues.length ? t('adjustmentIntentDialog.issuesPendingTitle', { count: currentIssues.length }) : t('adjustmentIntentDialog.noHardConflictsTitle')}</strong><span>{currentIssues.length ? t('adjustmentIntentDialog.issuesPendingBody') : t('adjustmentIntentDialog.noHardConflictsBody')}</span></div>
      </div>
      {currentIssues.length > 0 && <ul className="adjustment-issue-list">{currentIssues.slice(0, 8).map((issue, index) => <li key={`${issue.date ?? 'all'}-${index}`}><span>{issue.date ?? t('adjustmentIntentDialog.planRangeLabel')}</span>{issue.message}</li>)}</ul>}
    </section>
  </>

  const renderDuration = () => <>
    <ActionHeader title={t('adjustmentIntentDialog.durationHeaderTitle')} description={t('adjustmentIntentDialog.durationHeaderDescription')} onBack={backToCenter} />
    <section className="adjustment-form-section">
      {durationSuggestions.length ? <div className="duration-calibration-list">{durationSuggestions.map(suggestion => {
        const group = state.taskGroups.find(item => item.id === suggestion.groupId)
        return <article key={suggestion.groupId} className="duration-calibration-card"><div><strong>{group?.title ?? t('adjustmentIntentDialog.taskGroupFallback')}</strong><span>{t('adjustmentIntentDialog.durationCurrentSample', { current: suggestion.currentEstimate, sample: suggestion.sampleCount, average: Math.round(suggestion.recentAverage) })}</span><small>{t('adjustmentIntentDialog.durationSuggestedNote', { suggested: suggestion.suggestedEstimate })}</small></div><button type="button" className="secondary-button" onClick={() => { onClose(); onDurationSuggestion?.(suggestion) }}>{t('adjustmentIntentDialog.previewUpdateImpact')}</button></article>
      })}</div> : <div className="adjustment-empty-state"><Clock3 size={23} /><strong>{t('adjustmentIntentDialog.noCalibrationTitle')}</strong><span>{t('adjustmentIntentDialog.noCalibrationBody')}</span></div>}
    </section>
  </>

  const renderLoad = () => <>
    <ActionHeader title={t('adjustmentIntentDialog.loadHeaderTitle')} description={t('adjustmentIntentDialog.loadHeaderDescription')} onBack={backToCenter} />
    <section className="adjustment-form-section">
      <div className="adjustment-form-grid">
        <label className="field"><span>{t('adjustmentIntentDialog.startDate')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={loadStart} onChange={event => setLoadStart(event.target.value)} /></label>
        <label className="field"><span>{t('adjustmentIntentDialog.endDate')}</span><input type="date" min={loadStart} max={state.settings.endDate} value={loadEnd} onChange={event => setLoadEnd(event.target.value)} /></label>
        <label className="field"><span>{t('adjustmentIntentDialog.maxMinutesPerDayLabel')}</span><NumericInput min={30} max={1440} step={10} value={loadDailyMax} onValueChange={setLoadDailyMax} /></label>
        <label className="field"><span>{t('adjustmentIntentDialog.lightDaysPerWeekLabel')}</span><NumericInput min={0} max={7} value={lightDaysPerWeek} onValueChange={setLightDaysPerWeek} /></label>
        <label className="field"><span>{t('adjustmentIntentDialog.maxHighLoadStreakLabel')}</span><NumericInput min={0} max={14} value={maxHighLoadStreak} onValueChange={setMaxHighLoadStreak} /></label>
        <label className="field"><span>{t('adjustmentIntentDialog.maxLongHighPerDayLabel')}</span><NumericInput min={0} max={10} value={maxLongHighPerDay} onValueChange={setMaxLongHighPerDay} /></label>
      </div>
      <fieldset className="adjustment-choice-fieldset"><legend>{t('adjustmentIntentDialog.loadPreferenceLegend')}</legend><div className="adjustment-preference-options">{(['rest', 'balanced', 'preserve', 'goal'] as LoadPreference[]).map(item => { const selected = loadPreference === item; return <button type="button" key={item} aria-pressed={selected} className={selected ? 'selected' : ''} onClick={() => setLoadPreference(item)}><span className="choice-indicator">{selected ? t('adjustmentIntentDialog.selectedBadge') : t('adjustmentIntentDialog.selectableBadge')}</span><strong>{preferenceCopy[item].title}</strong><span>{preferenceCopy[item].description}</span></button> })}</div></fieldset>
      <div className="adjustment-form-note"><Sparkles size={17} /><span>{t('adjustmentIntentDialog.loadNote')}</span></div>
    </section>
  </>

  const renderReplan = () => {
    const canIncludeToday = replanStart <= today
    return <>
      <ActionHeader title={t('adjustmentIntentDialog.replanHeaderTitle')} description={t('adjustmentIntentDialog.replanHeaderDescription')} onBack={backToCenter} />
      <section className="adjustment-form-section">
        <div className="adjustment-form-grid">
          <label className="field"><span>{t('adjustmentIntentDialog.replanStartLabel')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={replanStart} disabled={tutorialMode === 'future'} onChange={event => setReplanStart(event.target.value)} /></label>
          <label className="field"><span>{t('adjustmentIntentDialog.replanSubjectLabel')}</span><select value={replanSubject} disabled={tutorialMode === 'future'} onChange={event => setReplanSubject(event.target.value)}><option value="all">{t('adjustmentIntentDialog.replanSubjectAll')}</option>{subjects.map(subject => <option value={subject} key={subject}>{t('adjustmentIntentDialog.replanSubjectOption', { subject })}</option>)}</select></label>
        </div>
        <label className="adjustment-check-row"><input type="checkbox" checked={includeToday && canIncludeToday} onChange={event => setIncludeToday(event.target.checked)} disabled={!canIncludeToday || tutorialMode === 'future'} /><span><strong>{t('adjustmentIntentDialog.includeTodayTitle')}</strong><small>{t('adjustmentIntentDialog.includeTodayBody')}</small></span></label>
        {includeToday && canIncludeToday && <div className="adjustment-today-control compact">{(['none', '30', '60', 'custom'] as const).map(item => <button type="button" key={item} className={todayMode === item ? 'active' : ''} onClick={() => setTodayMode(item)}><strong>{item === 'none' ? t('adjustmentIntentDialog.todayModeNoneTitle') : item === 'custom' ? t('adjustmentIntentDialog.todayModeCustomTitle') : t('adjustmentIntentDialog.todayModeMinutesTitle', { minutes: item })}</strong><span>{item === 'none' ? t('adjustmentIntentDialog.todayModeNoneBody') : t('adjustmentIntentDialog.todayModeOtherBody')}</span></button>)}</div>}
        {includeToday && todayMode === 'custom' && <label className="field compact-field"><span>{t('adjustmentIntentDialog.todayExtraMinutesLabel')}</span><NumericInput min={0} max={720} value={customMinutes} onValueChange={setCustomMinutes} /></label>}
        <fieldset className="adjustment-choice-fieldset"><legend>{t('adjustmentIntentDialog.replanOutcomeLegend')}</legend><div className="adjustment-preference-options">{(['preserve', 'balanced', 'goal', 'rest'] as ReplanOutcome[]).map(item => { const selected = replanOutcome === item; return <button type="button" key={item} aria-pressed={selected} className={selected ? 'selected' : ''} onClick={() => setReplanOutcome(item)}><span className="choice-indicator">{selected ? t('adjustmentIntentDialog.selectedBadge') : t('adjustmentIntentDialog.selectableBadge')}</span><strong>{preferenceCopy[item].title}</strong><span>{preferenceCopy[item].description}</span></button> })}</div></fieldset>
        <div className="adjustment-form-note"><ListChecks size={17} /><span>{t('adjustmentIntentDialog.replanProtectionNote')}</span></div>
      </section>
    </>
  }

  const isCenter = activeAction === 'center'
  const submitLabel = activeAction === 'availability' ? t('adjustmentIntentDialog.submitAvailability') : activeAction === 'current-conflicts' ? t('adjustmentIntentDialog.submitCurrentConflicts') : activeAction === 'load' ? t('adjustmentIntentDialog.submitLoad') : activeAction === 'replan' ? t('adjustmentIntentDialog.submitReplan') : ''
  const canSubmit = activeAction === 'availability'
    ? Boolean(availabilityStart && availabilityEnd && availabilityStart <= availabilityEnd)
    : activeAction === 'load'
      ? Boolean(loadStart && loadEnd && loadStart <= loadEnd)
      : activeAction === 'replan'
        ? Boolean(replanStart)
        : activeAction === 'current-conflicts'

  return <Modal open={open} title={t('adjustmentIntentDialog.modalTitle')} onClose={onClose} wide mobileFullscreen className="adjustment-modal">
    <div className="adjustment-dialog-shell">
      {isCenter ? renderCenter() : activeAction === 'availability' ? renderAvailability() : activeAction === 'current-conflicts' ? renderCurrentConflicts() : activeAction === 'duration' ? renderDuration() : activeAction === 'load' ? renderLoad() : activeAction === 'replan' ? renderReplan() : renderCenter()}
      {!isCenter && activeAction !== 'duration' && <div className="adjustment-guarantees"><strong>{t('adjustmentIntentDialog.guaranteesTitle')}</strong><span>{t('adjustmentIntentDialog.guaranteesBody')}</span></div>}
      {!isCenter && activeAction !== 'duration' && <div className="modal-actions adjustment-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" data-tutorial-target={activeAction === 'current-conflicts' ? 'repair-submit' : activeAction === 'replan' ? 'future-submit' : undefined} data-tutorial-action={activeAction === 'current-conflicts' ? 'submit-repair' : activeAction === 'replan' ? 'submit-future' : undefined} disabled={!canSubmit} onClick={submit}>{submitLabel}</button></div>}
    </div>
  </Modal>
}
