import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { AppState, DurationSuggestion, PlanChangeEvent } from '../types'
import { useApp } from '../AppContext'
import { actualMinutesForAssignmentOnDate, allDurationSuggestions, effectiveMinutes, reviewDaySnapshot, suggestMoveDates } from '../lib/planner'
import { fmtDate, getCapacity, minutesText, shiftDate, todayISO } from '../lib/date'
import { useT } from '../lib/i18n'
import { Modal } from './Modal'

export function ReviewDialog({ open, date, onClose, onPreparedDuration, onApplyCurrentPlan, onRequestMorePlans, tutorialMode = false, onTutorialBlocked }: {
  open: boolean
  date: string
  onClose: () => void
  onPreparedDuration: (state: AppState, event: PlanChangeEvent) => void
  onApplyCurrentPlan: (state: AppState, event: PlanChangeEvent) => void
  onRequestMorePlans: (state: AppState, event: PlanChangeEvent) => void
  tutorialMode?: boolean
  onTutorialBlocked?: (message?: string) => void
}) {
  const t = useT()
  const { state, completeReview, prepareDurationChange, prepareReviewCompletion } = useApp()
  const snapshot = useMemo(() => reviewDaySnapshot(state, date), [state, date])
  const savedRecord = useMemo(() => state.reviewRecords.find(item => item.date === date), [state.reviewRecords, date])
  const useSavedHistory = Boolean(savedRecord && date < todayISO())
  const plannedIds = useSavedHistory && savedRecord?.plannedAssignmentIds ? savedRecord.plannedAssignmentIds : snapshot.plannedAssignmentIds
  const executedIds = useSavedHistory && savedRecord?.executedAssignmentIds ? savedRecord.executedAssignmentIds : snapshot.executedAssignmentIds
  const unionIds = Array.from(new Set([...plannedIds, ...executedIds]))
  const assignmentMap = useMemo(() => new Map(state.assignments.map(item => [item.id, item])), [state.assignments])
  const plannedTasks = useMemo(() => plannedIds.flatMap(id => assignmentMap.get(id) ? [assignmentMap.get(id)!] : []), [plannedIds.join('|'), assignmentMap])
  const tasks = useMemo(() => unionIds.flatMap(id => assignmentMap.get(id) ? [assignmentMap.get(id)!] : []), [unionIds.join('|'), assignmentMap])
  const groups = useMemo(() => new Map(state.taskGroups.map(item => [item.id, item])), [state.taskGroups])
  const reviewedGroupIds = useMemo(() => new Set(tasks.map(item => item.groupId)), [tasks])
  const suggestions = useMemo(() => allDurationSuggestions(state).filter(item => reviewedGroupIds.has(item.groupId)), [state, reviewedGroupIds])
  const [chartsOpen, setChartsOpen] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(false)
  const [carryDates, setCarryDates] = useState<Record<string, string>>({})

  const completedIds = useSavedHistory && savedRecord?.completedAssignmentIds ? savedRecord.completedAssignmentIds : snapshot.completedAssignmentIds
  const completedSet = useMemo(() => new Set(completedIds), [completedIds.join('|')])
  const plannedSet = useMemo(() => new Set(plannedIds), [plannedIds.join('|')])
  const completed = plannedTasks.filter(item => completedSet.has(item.id))
  const completedDetails = tasks.filter(item => completedSet.has(item.id))
  const unfinishedIds = useSavedHistory && savedRecord ? savedRecord.unfinishedAssignmentIds : snapshot.unfinishedAssignmentIds
  const unfinished = unfinishedIds.flatMap(id => assignmentMap.get(id) ? [assignmentMap.get(id)!] : [])
  const recurringUnfinished = useSavedHistory ? [] : snapshot.recurringUnfinishedAssignmentIds.flatMap(id => assignmentMap.get(id) ? [assignmentMap.get(id)!] : [])
  const executedOutsidePlan = executedIds.filter(id => !plannedIds.includes(id)).length
  const planned = useSavedHistory && savedRecord ? savedRecord.plannedMinutes : snapshot.plannedMinutes
  const actual = useSavedHistory && savedRecord ? savedRecord.actualMinutes : snapshot.actualMinutes
  const inferred = useSavedHistory && savedRecord ? savedRecord.inferredMinutes ?? 0 : snapshot.inferredMinutes
  const actualByTask = useMemo(() => new Map(tasks.map(item => [item.id, actualMinutesForAssignmentOnDate(state, item, date)])), [state, tasks, date])
  const difference = actual - planned
  const displayCompletedCount = useSavedHistory && savedRecord ? savedRecord.completedCount : completed.length
  const displayTotalCount = useSavedHistory && savedRecord ? savedRecord.totalCount : plannedTasks.length
  const completionRate = displayTotalCount ? Math.round(displayCompletedCount / displayTotalCount * 100) : 100
  const selectedCarryCount = Object.values(carryDates).filter(Boolean).length
  const selectedCarryDates = Array.from(new Set(Object.values(carryDates).filter(Boolean))).sort()

  useEffect(() => {
    if (!open) return
    const initial: Record<string, string> = {}
    for (const assignment of unfinished) {
      if (assignment.locked || state.timer.assignmentId === assignment.id) {
        initial[assignment.id] = ''
        continue
      }
      initial[assignment.id] = suggestMoveDates(state, assignment.id, 8).find(candidate => candidate > date) ?? ''
    }
    setCarryDates(initial)
    setChartsOpen(false)
    setCompletedOpen(false)
  }, [open, date])

  const recentRecords = useMemo(() => {
    const current = { date, plannedMinutes: planned, actualMinutes: actual, totalCount: displayTotalCount, completedCount: displayCompletedCount }
    return [...state.reviewRecords.filter(record => record.date !== date && record.date <= date), current]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-7)
  }, [state.reviewRecords, date, planned, actual, displayTotalCount, displayCompletedCount])
  const todayGroupRows = useMemo(() => {
    const rows = new Map<string, { label: string; first: number; second: number }>()
    for (const task of tasks) {
      const group = groups.get(task.groupId)
      const current = rows.get(task.groupId) ?? { label: group?.title ?? task.groupId, first: 0, second: 0 }
      if (plannedSet.has(task.id)) current.first += task.estimatedMinutes
      current.second += actualByTask.get(task.id) ?? 0
      rows.set(task.groupId, current)
    }
    return [...rows.values()]
  }, [groups, tasks, actualByTask, plannedSet])
  const groupAverageRows = useMemo(() => state.taskGroups.flatMap(group => {
    const completedItems = state.assignments
      .filter(item => item.groupId === group.id && item.status === 'done' && item.actualMinutes > 0)
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      .slice(0, 10)
    if (!completedItems.length) return []
    return [{ label: group.title, first: group.unitMinutes, second: Math.round(completedItems.reduce((sum, item) => sum + item.actualMinutes, 0) / completedItems.length) }]
  }), [state.assignments, state.taskGroups])

  const projectedLabel = (assignmentId: string, targetDate: string) => {
    const assignment = state.assignments.find(item => item.id === assignmentId)
    if (!assignment) return targetDate
    const targetLoad = state.assignments
      .filter(item => item.id !== assignment.id && item.scheduledDate === targetDate)
      .reduce((sum, item) => sum + effectiveMinutes(item), 0)
    const projected = targetLoad + effectiveMinutes(assignment)
    const capacity = getCapacity(state, targetDate)
    return `${fmtDate(targetDate)} · ${minutesText(projected)} / ${minutesText(capacity)}${projected > capacity ? t('reviewDialog.projectedOverload') : ''}`
  }

  const applyCurrentReviewPlan = () => {
    if (selectedCarryCount <= 0) {
      completeReview(date)
      onClose()
      return
    }
    const prepared = prepareReviewCompletion(date, carryDates)
    onApplyCurrentPlan(prepared.state, prepared.event)
    onClose()
  }
  const requestMoreReviewPlans = () => {
    const prepared = prepareReviewCompletion(date, carryDates)
    onRequestMorePlans(prepared.state, prepared.event)
    onClose()
  }
  const closeAndRecord = () => {
    completeReview(date)
    onClose()
  }
  const acceptSuggestion = (suggestion: DurationSuggestion) => {
    const prepared = prepareDurationChange(suggestion, suggestion.suggestedEstimate, date)
    onPreparedDuration(prepared.state, prepared.event)
    onClose()
  }
  const openReviewSection = (id: string, expand?: 'completed' | 'charts') => {
    if (expand === 'completed') setCompletedOpen(true)
    if (expand === 'charts') setChartsOpen(true)
    window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return <Modal open={open} title={t('reviewDialog.title', { date: fmtDate(date) })} onClose={onClose} wide mobileFullscreen className="review-modal">
    <div className="review-dialog-shell">
    <section className="review-hero">
      <div className="review-progress-ring" style={{ '--review-progress': `${completionRate * 3.6}deg` } as CSSProperties}>
        <div><strong>{completionRate}%</strong><span>{t('reviewDialog.completionRate')}</span></div>
      </div>
      <div className="review-hero-copy">
        <span className="review-eyebrow">{t('reviewDialog.eyebrow')}</span>
        <h2>{t('reviewDialog.heading', { completed: displayCompletedCount, total: displayTotalCount })}</h2>
        <p>{unfinished.length > 0 ? t('reviewDialog.unfinishedNote', { count: unfinished.length }) : t('reviewDialog.allDoneNote')}{recurringUnfinished.length > 0 ? t('reviewDialog.recurringUnfinishedNote', { count: recurringUnfinished.length }) : ''}{executedOutsidePlan > 0 ? t('reviewDialog.executedOutsidePlanNote', { count: executedOutsidePlan }) : ''}{useSavedHistory ? t('reviewDialog.savedSnapshotNote') : ''}</p>
        <div className="review-time-compare"><span>{t('reviewDialog.planned')} <strong>{minutesText(planned)}</strong></span><b>→</b><span>{t('reviewDialog.actual')} <strong>{minutesText(actual)}</strong></span><em className={difference > 0 ? 'over' : difference < 0 ? 'under' : 'exact'}>{difference === 0 ? t('reviewDialog.exactMatch') : t(difference > 0 ? 'reviewDialog.moreThan' : 'reviewDialog.lessThan', { minutes: minutesText(Math.abs(difference)) })}</em></div>
      </div>
    </section>

    <div className="review-summary-grid">
      <ReviewMetric label={t('reviewDialog.metricCompletedLabel')} value={`${displayCompletedCount} / ${displayTotalCount}`} detail={t('reviewDialog.metricCompletedDetail', { rate: completionRate })} onClick={() => openReviewSection('review-completed', 'completed')}/>
      <ReviewMetric label={t('reviewDialog.metricPlannedLabel')} value={minutesText(planned)} detail={t('reviewDialog.metricPlannedDetail')} onClick={() => openReviewSection('review-charts', 'charts')}/>
      <ReviewMetric label={t('reviewDialog.metricActualLabel')} value={minutesText(actual)} detail={inferred > 0 ? t('reviewDialog.metricActualDetailInferred', { minutes: minutesText(inferred) }) : t('reviewDialog.metricActualDetail')} onClick={() => openReviewSection('review-charts', 'charts')}/>
      <ReviewMetric label={t('reviewDialog.metricDifferenceLabel')} value={`${difference > 0 ? '+' : difference < 0 ? '−' : ''}${minutesText(Math.abs(difference))}`} detail={t('reviewDialog.metricDifferenceDetail')} onClick={() => openReviewSection('review-charts', 'charts')}/>
      <ReviewMetric label={t('reviewDialog.metricPendingLabel')} value={String(unfinished.length)} detail={t('reviewDialog.metricPendingDetail')} onClick={() => openReviewSection('review-unfinished')}/>
      <ReviewMetric label={t('reviewDialog.metricDurationSuggestionLabel')} value={String(suggestions.length)} detail={t('reviewDialog.metricDurationSuggestionDetail')} onClick={() => openReviewSection('review-duration')}/>
    </div>

    <section id="review-unfinished" className="review-section review-unfinished-section">
      <header><div><span className="review-section-index">01</span><div><h3>{t('reviewDialog.section1Title')}</h3><p>{t('reviewDialog.section1Body')}</p></div></div><strong>{t('reviewDialog.itemsCount', { count: unfinished.length })}</strong></header>
      {unfinished.length === 0 ? <div className="review-empty-success"><strong>{t('reviewDialog.noCarryTitle')}</strong><span>{t('reviewDialog.noCarryBody')}</span></div> : <div className="review-task-decision-list">{unfinished.map(item => {
        const group = groups.get(item.groupId)
        const legalOptions = suggestMoveDates(state, item.id, 8).filter(candidate => candidate > date)
        const tutorialPreferredTarget = shiftDate(date, 1)
        const tutorialOptions = legalOptions.includes(tutorialPreferredTarget) ? [tutorialPreferredTarget] : legalOptions.slice(0, 1)
        const options = tutorialMode ? tutorialOptions : legalOptions.slice(0, 5)
        const movable = !item.locked && state.timer.assignmentId !== item.id
        return <article key={item.id} className="review-task-decision">
          <div className="review-task-decision-main">
            <div className="review-task-title"><span className={`subject-pill subject-${group?.subject ?? '其他'}`}>{group?.subject ?? '其他'}</span><strong>{item.title}</strong>{item.locked && <em>{t('reviewDialog.taskLocked')}</em>}{state.timer.assignmentId === item.id && <em>{t('reviewDialog.taskTiming')}</em>}</div>
            <div className="review-task-progress"><div><i style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }}/></div><span>{t('reviewDialog.progressRemaining', { progress: item.progress, minutes: minutesText(item.remainingMinutes ?? Math.max(0, item.estimatedMinutes - item.actualMinutes)) })}</span></div>
          </div>
          <label className="review-carry-choice"><span>{t('reviewDialog.carryChoiceLabel')}</span><select data-tutorial-target={tutorialMode ? 'review-carry-date' : undefined} data-tutorial-action="review-carry-date" disabled={!movable} value={carryDates[item.id] ?? ''} onChange={event => setCarryDates(current => ({ ...current, [item.id]: event.target.value }))}><option value="" disabled={tutorialMode}>{t('reviewDialog.keepOverdueOption', { date: fmtDate(date) })}</option>{options.map(target => <option key={target} value={target}>{projectedLabel(item.id, target)}</option>)}</select>{!movable && <small>{t('reviewDialog.movableNote')}</small>}</label>
        </article>
      })}</div>}
    </section>

    <section id="review-completed" className="review-section">
      <button className="review-section-toggle" onClick={() => setCompletedOpen(value => !value)}><div><span className="review-section-index">02</span><div><h3>{t('reviewDialog.section2Title')}</h3><p>{t('reviewDialog.section2Body')}</p></div></div><strong>{t('reviewDialog.itemsCount', { count: completedDetails.length })} · {completedOpen ? t('reviewDialog.collapse') : t('reviewDialog.expand')}</strong></button>
      {completedOpen && <div className="review-completed-grid">{completedDetails.map(item => {
        const taskActual = actualByTask.get(item.id) ?? 0
        const delta = taskActual - item.estimatedMinutes
        return <article key={item.id}><div><strong>{item.title}</strong><span>{groups.get(item.groupId)?.subject ?? '其他'}</span></div><div className="review-completed-times"><span>{t('reviewDialog.completedPlanned', { minutes: minutesText(item.estimatedMinutes) })}</span><span>{t('reviewDialog.completedActual', { minutes: minutesText(taskActual) })}</span><em className={delta > 0 ? 'over' : delta < 0 ? 'under' : 'exact'}>{delta === 0 ? t('reviewDialog.deltaExact') : t(delta > 0 ? 'reviewDialog.deltaOver' : 'reviewDialog.deltaUnder', { minutes: minutesText(Math.abs(delta)) })}</em></div></article>
      })}{completedDetails.length === 0 && <p className="muted-text">{t('reviewDialog.noCompletedTasks')}</p>}</div>}
    </section>

    <section id="review-duration" className="review-section review-duration-section">
      <header><div><span className="review-section-index">03</span><div><h3>{t('reviewDialog.section3Title')}</h3><p>{t('reviewDialog.section3Body')}</p></div></div><strong>{t('reviewDialog.itemsCount', { count: suggestions.length })}</strong></header>
      {suggestions.length === 0 ? <div className="review-empty-neutral"><strong>{t('reviewDialog.noDeviationTitle')}</strong><span>{t('reviewDialog.noDeviationBody')}</span></div> : <div className="duration-suggestion-list">{suggestions.map(item => {
        const title = groups.get(item.groupId)?.title ?? item.groupId
        const change = item.suggestedEstimate - item.currentEstimate
        return <article key={item.groupId}>
          <div><strong>{title}</strong><span>{t('reviewDialog.durationCurrentSample', { current: item.currentEstimate, sample: item.sampleCount, average: Math.round(item.recentAverage) })}</span><small>{t('reviewDialog.durationDeviation', { ratio: Math.round(item.deviationRatio * 100), suggested: item.suggestedEstimate })}</small><div className="duration-delta-track"><i style={{ width: `${Math.min(100, item.currentEstimate / Math.max(item.currentEstimate, item.suggestedEstimate, 1) * 100)}%` }}/><b style={{ width: `${Math.min(100, item.suggestedEstimate / Math.max(item.currentEstimate, item.suggestedEstimate, 1) * 100)}%` }}/></div><em className={change > 0 ? 'over' : 'under'}>{change > 0 ? t('reviewDialog.durationIncrease', { minutes: change }) : t('reviewDialog.durationDecrease', { minutes: Math.abs(change) })}</em></div>
          <div><button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('reviewDialog.tutorialBlockedDuration')) : acceptSuggestion(item)}>{t('reviewDialog.previewUpdateImpact')}</button></div>
          <details><summary>{t('reviewDialog.viewSamples', { count: item.samples.length })}</summary><div className="review-sample-grid">{item.samples.map(sample => <div key={sample.assignmentId}><strong>{state.assignments.find(task => task.id === sample.assignmentId)?.title ?? sample.assignmentId}</strong><span>{t('reviewDialog.samplePlannedActual', { estimated: sample.estimatedMinutes, actual: sample.actualMinutes })}</span></div>)}</div></details>
        </article>
      })}</div>}
      <p className="review-rule-note">{t('reviewDialog.qualityRuleNote')}</p>
    </section>

    <section id="review-charts" className="review-section review-chart-section">
      <button className="review-section-toggle" onClick={() => setChartsOpen(value => !value)}><div><span className="review-section-index">04</span><div><h3>{t('reviewDialog.section4Title')}</h3><p>{t('reviewDialog.section4Body')}</p></div></div><strong>{chartsOpen ? t('reviewDialog.collapseCharts') : t('reviewDialog.expandCharts')}</strong></button>
      {chartsOpen && <div className="review-charts">
        <SimpleBars title={t('reviewDialog.chartTasksToday')} rows={tasks.map(item => ({ label: item.title, first: plannedSet.has(item.id) ? item.estimatedMinutes : 0, second: actualByTask.get(item.id) ?? 0 }))} firstLabel={t('reviewDialog.labelPlan')} secondLabel={t('reviewDialog.labelActual')}/>
        <SimpleBars title={t('reviewDialog.chartGroupsToday')} rows={todayGroupRows} firstLabel={t('reviewDialog.labelPlan')} secondLabel={t('reviewDialog.labelActual')}/>
        <SimpleBars title={t('reviewDialog.chartRecentTrend')} rows={recentRecords.map(record => ({ label: record.date.slice(5), first: record.plannedMinutes, second: record.actualMinutes }))} firstLabel={t('reviewDialog.labelPlan')} secondLabel={t('reviewDialog.labelActual')}/>
        <SimpleBars title={t('reviewDialog.chartCompletionTrend')} rows={recentRecords.map(record => ({ label: record.date.slice(5), first: record.totalCount, second: record.completedCount }))} firstLabel={t('reviewDialog.labelTotal')} secondLabel={t('reviewDialog.labelCompleted')}/>
        <SimpleBars title={t('reviewDialog.chartErrorTrend')} rows={recentRecords.map(record => ({ label: record.date.slice(5), first: 0, second: Math.abs(record.actualMinutes - record.plannedMinutes) }))} firstLabel={t('reviewDialog.labelBaseline')} secondLabel={t('reviewDialog.labelAbsoluteError')}/>
        <SimpleBars title={t('reviewDialog.chartGroupAverage')} rows={groupAverageRows} firstLabel={t('reviewDialog.labelDefaultEstimate')} secondLabel={t('reviewDialog.labelRecentAverage')}/>
      </div>}
    </section>

    <section className="review-finish-plan">
      <div className="review-finish-plan-summary"><span>{t('reviewDialog.finishPlanCurrentLabel')}</span><strong>{selectedCarryCount > 0 ? t('reviewDialog.finishPlanMoveCount', { count: selectedCarryCount }) : t('reviewDialog.finishPlanNoMove')}</strong><p>{selectedCarryCount > 0 ? t('reviewDialog.finishPlanMoveDetail', { count: selectedCarryDates.length }) : t('reviewDialog.finishPlanNoMoveDetail')}</p></div>
      <div className="review-finish-options">
        <button className="review-finish-option primary-option" data-tutorial-target="review-carry" data-tutorial-action="review-carry" disabled={tutorialMode && selectedCarryCount <= 0} onClick={applyCurrentReviewPlan}><strong>{selectedCarryCount > 0 ? t('reviewDialog.finishReviewCarry', { count: selectedCarryCount }) : t('reviewDialog.finishReviewOnly')}</strong><span>{selectedCarryCount > 0 ? t('reviewDialog.finishReviewCarryDetail') : t('reviewDialog.finishReviewOnlyDetail')}</span></button>
        <button className={`review-finish-option ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} data-tutorial-action="review-more" onClick={() => tutorialMode ? onTutorialBlocked?.(t('reviewDialog.tutorialBlockedUseCurrentCarry')) : requestMoreReviewPlans()} disabled={!tutorialMode && unfinished.length === 0}><strong>{t('reviewDialog.getMorePlans')}</strong><span>{t('reviewDialog.getMorePlansDetail')}</span></button>
        <button className={`review-finish-option quiet-option ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} data-tutorial-action="review-save-only" onClick={() => tutorialMode ? onTutorialBlocked?.(t('reviewDialog.tutorialBlockedCarryFirst')) : closeAndRecord()}><strong>{t('reviewDialog.saveOnlyNoCarry')}</strong><span>{t('reviewDialog.saveOnlyNoCarryDetail')}</span></button>
      </div>
    </section>
    </div>
  </Modal>
}

function ReviewMetric({ label, value, detail, onClick }: { label: string; value: string; detail: string; onClick: () => void }) {
  return <button type="button" onClick={onClick}><strong>{value}</strong><span>{label}</span><small>{detail}</small></button>
}

function SimpleBars({ title, rows, firstLabel, secondLabel }: { title: string; rows: Array<{ label: string; first: number; second: number }>; firstLabel?: string; secondLabel?: string }) {
  const t = useT()
  const max = Math.max(1, ...rows.flatMap(item => [item.first, item.second]))
  return <section className="simple-chart"><header><h3>{title}</h3><div><span><i/>{firstLabel ?? t('reviewDialog.labelPlan')}</span><span><b/>{secondLabel ?? t('reviewDialog.labelActual')}</span></div></header>{rows.length === 0 ? <p className="muted-text">{t('reviewDialog.noEnoughData')}</p> : <div className="simple-chart-rows">{rows.slice(-12).map((row, index) => <div className="simple-chart-row" key={`${row.label}-${index}`}><span title={row.label}>{row.label}</span><div><i style={{ width: `${row.first / max * 100}%` }}/><b style={{ width: `${row.second / max * 100}%` }}/></div><small>{row.first} / {row.second}</small></div>)}</div>}</section>
}
