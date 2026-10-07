import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarClock, Check, ChevronDown, ChevronUp, Lock,
  RefreshCw, RotateCcw, SlidersHorizontal, Undo2
} from 'lucide-react'
import type {
  AppState, Assignment, DayType, ReplanAudit, ReplanBundle, ReplanRequest,
  ReplanResult, ReplanStrategy, Subject
} from '../types'
import { dateRange, fmtDate, fmtWeekday, getCapacity, minutesText } from '../lib/date'
import { analyzePlan, effectiveMinutes, planningDayLoad } from '../lib/planner'
import { useT } from '../lib/i18n'
import { Drawer } from './Drawer'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'
import { nativeTaskDragAvailable } from './TaskCard'

type MoveDecision = {
  mode: 'accept' | 'keep' | 'custom'
  date?: string
  lock?: boolean
  previewFixed?: boolean
}

type DayTypeOverride = { type: DayType; customMinutes?: number }
type PreviewSnapshot = {
  decisions: Record<string, MoveDecision>
  acceptedDayTypes: Record<string, boolean>
  dayTypeOverrides: Record<string, DayTypeOverride>
}

type DiffKind = 'same' | 'added' | 'removed' | 'modified'

type DayDiffRow = {
  id: string
  before?: Assignment
  after?: Assignment
  kind: DiffKind
  sourceDate?: string
  destinationDate?: string
}

function assignmentMinutes(state: AppState, assignment: Assignment) {
  const group = state.taskGroups.find(item => item.id === assignment.groupId)
  return group && (group.countInStats || state.settings.countWordsTime) ? effectiveMinutes(assignment) : 0
}

function dayLoad(state: AppState, date: string) {
  return planningDayLoad(state, date)
}

function buildDayDiff(beforeState: AppState, afterState: AppState, date: string): DayDiffRow[] {
  const before = beforeState.assignments.filter(item => item.scheduledDate === date)
  const after = afterState.assignments.filter(item => item.scheduledDate === date)
  const beforeMap = new Map(before.map(item => [item.id, item]))
  const afterMap = new Map(after.map(item => [item.id, item]))
  const ordered = [...before.map(item => item.id), ...after.map(item => item.id).filter(id => !beforeMap.has(id))]

  return ordered.map(id => {
    const oldItem = beforeMap.get(id)
    const newItem = afterMap.get(id)
    if (oldItem && newItem) {
      const modified = oldItem.title !== newItem.title || oldItem.estimatedMinutes !== newItem.estimatedMinutes || oldItem.locked !== newItem.locked
      return { id, before: oldItem, after: newItem, kind: modified ? 'modified' : 'same' }
    }
    if (oldItem) {
      const destinationDate = afterState.assignments.find(item => item.id === id)?.scheduledDate
      return { id, before: oldItem, kind: 'removed', destinationDate }
    }
    const sourceDate = beforeState.assignments.find(item => item.id === id)?.scheduledDate
    return { id, after: newItem, kind: 'added', sourceDate }
  })
}

function taskSubject(state: AppState, assignment?: Assignment): Subject {
  if (!assignment) return '其他'
  return state.taskGroups.find(group => group.id === assignment.groupId)?.subject ?? '其他'
}

function DayDiffPanel({
  date,
  beforeState,
  afterState,
  onlyChanges,
  decisions,
  result,
  onDecision,
  onDragStart,
  compact = false
}: {
  date: string
  beforeState: AppState
  afterState: AppState
  onlyChanges: boolean
  decisions: Record<string, MoveDecision>
  result: ReplanResult
  onDecision: (assignmentId: string, decision: MoveDecision) => void
  onDragStart: (assignmentId: string, event: React.DragEvent) => void
  compact?: boolean
}) {
  const t = useT()
  const allRows = useMemo(() => buildDayDiff(beforeState, afterState, date), [beforeState, afterState, date])
  const rows = onlyChanges ? allRows.filter(row => row.kind !== 'same') : allRows
  const nativeDragEnabled = nativeTaskDragAvailable()

  const taskView = (assignment: Assignment | undefined, side: 'before' | 'after', row: DayDiffRow) => {
    if (!assignment) return <div className="diff-empty">—</div>
    const subject = taskSubject(side === 'before' ? beforeState : afterState, assignment)
    const changedClass = row.kind === 'added' && side === 'after' ? 'diff-added' : row.kind === 'removed' && side === 'before' ? 'diff-removed' : row.kind === 'modified' ? 'diff-modified' : ''
    return <div
      className={`diff-task ${changedClass}`}
      draggable={nativeDragEnabled && side === 'after' && !assignment.locked}
      onDragStart={event => nativeDragEnabled && side === 'after' && onDragStart(assignment.id, event)}
    >
      <div className="diff-task-main">
        <span className={`subject-dot subject-${subject}`}/>
        <div><strong>{assignment.title}</strong><span>{subject} · {minutesText(assignment.estimatedMinutes)}</span></div>
      </div>
      <div className="diff-task-meta">
        {row.kind === 'added' && side === 'after' && <em>{row.sourceDate ? t('replanDialog.addedFrom', { date: row.sourceDate }) : t('replanDialog.added')}</em>}
        {row.kind === 'removed' && side === 'before' && <em>{row.destinationDate ? t('replanDialog.removedTo', { date: row.destinationDate }) : t('replanDialog.removed')}</em>}
        {row.kind === 'modified' && <em>{t('replanDialog.modified')}</em>}
        {assignment.locked && <span><Lock size={12}/>{t('replanDialog.locked')}</span>}
        {assignment.intentStrength === 'manual' && <span>{t('replanDialog.manualIntent')}</span>}
      </div>
    </div>
  }

  return <div className={`day-diff-panel ${compact ? 'day-diff-compact' : ''}`}>
    <div className="day-diff-heading"><span>{t('replanDialog.before')}</span><span>{t('replanDialog.after')}</span></div>
    {rows.length === 0 && <p className="muted-text">{t('replanDialog.noChangesInFilter')}</p>}
    {rows.map(row => {
      const assignment = row.after ?? row.before
      if (!assignment) return null
      const move = result.moves.find(item => item.assignmentId === assignment.id)
      const decision = decisions[assignment.id] ?? { mode: 'accept' as const }
      const changed = row.kind !== 'same'
      return <article className={`day-diff-row diff-${row.kind}`} key={`${date}-${row.id}`}>
        <div>{taskView(row.before, 'before', row)}</div>
        <div>{taskView(row.after, 'after', row)}</div>
        {changed && <div className="diff-row-actions">
          {move && <div className="diff-reason-block"><div className="diff-reason"><span>{move.reason}</span>{move.impact && <span className="diff-impact">{move.impact}</span>}</div>{move.rejectedAlternatives && move.rejectedAlternatives.length > 0 && <details><summary>{t('replanDialog.rejectedAlternativesSummary')}</summary>{move.rejectedAlternatives.map(item => <div key={`${move.assignmentId}-${item.date}`}><strong>{item.date}</strong><span>{item.reasons.join('；')}</span></div>)}</details>}</div>}
          <button className={decision.mode === 'accept' ? 'choice-active' : ''} onClick={() => onDecision(assignment.id, { ...decision, mode: 'accept', date: undefined, previewFixed: true })}>{t('replanDialog.accept')}</button>
          <button className={decision.mode === 'keep' ? 'choice-active' : ''} onClick={() => onDecision(assignment.id, { ...decision, mode: 'keep', date: undefined, previewFixed: true })}>{t('replanDialog.keepOriginal')}</button>
          <label className="inline-date-choice"><span>{t('replanDialog.changeTo')}</span><input
            type="date"
            min={beforeState.settings.startDate}
            max={beforeState.settings.endDate}
            value={decision.mode === 'custom' ? decision.date ?? '' : ''}
            onChange={event => onDecision(assignment.id, { ...decision, mode: 'custom', date: event.target.value, previewFixed: true })}
          /></label>
          <label className="lock-choice"><input type="checkbox" checked={Boolean(decision.lock)} onChange={event => onDecision(assignment.id, { ...decision, lock: event.target.checked, previewFixed: true })}/><Lock size={14}/>{t('replanDialog.lockResult')}</label>
          {decision.previewFixed && <><span className="preview-fixed-badge">{t('replanDialog.previewFixedBadge')}</span><button onClick={() => onDecision(assignment.id, { ...decision, previewFixed: false })}>{t('replanDialog.unfix')}</button></>}
        </div>}
      </article>
    })}
  </div>
}

export function ReplanDialog({
  bundle, currentState, open, request, onRequestChange, onRegenerate, onClose, onApply
}: {
  bundle?: ReplanBundle
  currentState: AppState
  open: boolean
  request: ReplanRequest
  onRequestChange: (request: ReplanRequest) => void
  onRegenerate: (request?: ReplanRequest) => void
  onClose: () => void
  onApply: (result: ReplanResult, state: AppState, audit: ReplanAudit) => void
}) {
  const t = useT()
  const [strategy, setStrategy] = useState<ReplanStrategy>('balanced')
  const [decisions, setDecisions] = useState<Record<string, MoveDecision>>({})
  const [acceptedDayTypes, setAcceptedDayTypes] = useState<Record<string, boolean>>({})
  const [dayTypeOverrides, setDayTypeOverrides] = useState<Record<string, DayTypeOverride>>({})
  const [undoStack, setUndoStack] = useState<PreviewSnapshot[]>([])
  const [loadCompareDate, setLoadCompareDate] = useState<string>()
  const [onlyChanges, setOnlyChanges] = useState(false)
  const [expandedDates, setExpandedDates] = useState<string[]>([])
  const [detailDate, setDetailDate] = useState<string>()
  const [debouncedIssues, setDebouncedIssues] = useState<ReturnType<typeof analyzePlan>>([])
  const [dragTargetDate, setDragTargetDate] = useState<string>()
  const [limitDrafts, setLimitDrafts] = useState<Record<string, number>>({})

  const activeBundleId = bundle?.scenarios[0]?.id
  const previousBundleId = useRef<string>()
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (!bundle) return
    const firstOpen = !wasOpen.current
    const regenerated = wasOpen.current && previousBundleId.current && previousBundleId.current !== activeBundleId
    wasOpen.current = true
    previousBundleId.current = activeBundleId

    if (firstOpen) {
      setDecisions({})
      setAcceptedDayTypes({})
      setDayTypeOverrides({})
      setUndoStack([])
      setExpandedDates([])
      setDetailDate(undefined)
      setLoadCompareDate(undefined)
      setLimitDrafts({})
    } else if (regenerated) {
      setDecisions(previous => Object.fromEntries(Object.entries(previous).filter(([, decision]) => decision.previewFixed)))
      setUndoStack([])
    }

    const modeDefault: ReplanStrategy = currentState.settings.planningMode === 'sprint' ? 'goal' : currentState.settings.planningMode === 'relaxed' ? 'preserve' : 'balanced'
    const preferred = request.strategy ?? modeDefault
    setStrategy(bundle.scenarios.some(item => item.strategy === preferred) ? preferred : bundle.scenarios[0]?.strategy ?? 'balanced')
  }, [activeBundleId, bundle, currentState.settings.planningMode, open, request.strategy])

  const result = bundle?.scenarios.find(item => item.strategy === strategy) ?? bundle?.scenarios[0]
  const protectedBufferDates = useMemo(() => dateRange(currentState.settings.startDate, currentState.settings.endDate)
    .filter(date => date >= request.fromDate)
    .filter(date => {
      const config = currentState.dayConfigs[date]
      return Boolean(config?.isBufferDay && (config.bufferProtected ?? config.userSet))
    }), [currentState.dayConfigs, currentState.settings.endDate, currentState.settings.startDate, request.fromDate])

  const regenerateWith = (patch: Partial<ReplanRequest>) => {
    const nextRequest = { ...request, ...patch }
    onRequestChange(nextRequest)
    onRegenerate(nextRequest)
  }

  const allowConstraintOnce = (date: string, key: string, limit: number, affectedAssignmentIds?: string[]) => {
    const overrides = [...(request.limitOverrides ?? []).filter(item => !(item.date === date && item.key === key)), { date, key, limit, affectedAssignmentIds }]
    regenerateWith({ limitOverrides: overrides })
  }

  const toggleBufferUse = (date: string) => {
    const current = request.allowBufferUseDates ?? []
    const next = current.includes(date) ? current.filter(item => item !== date) : [...current, date]
    regenerateWith({ allowBufferUseDates: next })
  }

  const pushSnapshot = () => setUndoStack(previous => [...previous.slice(-29), {
    decisions: structuredClone(decisions),
    acceptedDayTypes: structuredClone(acceptedDayTypes),
    dayTypeOverrides: structuredClone(dayTypeOverrides)
  }])

  const changeDecision = (assignmentId: string, decision: MoveDecision) => {
    pushSnapshot()
    setDecisions(previous => ({ ...previous, [assignmentId]: decision }))
  }

  const changeDayType = (date: string, override?: DayTypeOverride) => {
    pushSnapshot()
    setDayTypeOverrides(previous => {
      const next = { ...previous }
      if (override) next[date] = override
      else delete next[date]
      return next
    })
  }

  const toggleSuggestedDayType = (date: string, checked: boolean) => {
    pushSnapshot()
    setAcceptedDayTypes(previous => ({ ...previous, [date]: checked }))
  }

  const undoPreview = () => {
    const snapshot = undoStack.at(-1)
    if (!snapshot) return
    setDecisions(snapshot.decisions)
    setAcceptedDayTypes(snapshot.acceptedDayTypes)
    setDayTypeOverrides(snapshot.dayTypeOverrides)
    setUndoStack(previous => previous.slice(0, -1))
  }

  const editedState = useMemo(() => {
    if (!result) return undefined
    const next = structuredClone(result.nextState)
    for (const [assignmentId, decision] of Object.entries(decisions)) {
      const assignment = next.assignments.find(item => item.id === assignmentId)
      const original = currentState.assignments.find(item => item.id === assignmentId)
      if (!assignment) continue
      if (decision.mode === 'keep') {
        assignment.scheduledDate = original?.scheduledDate
        if (original) {
          assignment.scheduleSource = original.scheduleSource
          assignment.intentStrength = original.intentStrength
          assignment.previousDate = original.previousDate
          assignment.lastManualMoveAt = original.lastManualMoveAt
          assignment.locked = original.locked
        }
      } else if (decision.mode === 'custom' && decision.date) {
        assignment.previousDate = original?.scheduledDate
        assignment.scheduledDate = decision.date
        assignment.scheduleSource = 'manual'
        assignment.intentStrength = decision.lock ? 'locked' : 'manual'
        assignment.lastManualMoveAt = new Date().toISOString()
      }
      if (decision.lock) {
        assignment.locked = true
        assignment.intentStrength = 'locked'
      }
    }
    for (const suggestion of result.dayTypeSuggestions) {
      if (!acceptedDayTypes[suggestion.date]) continue
      next.dayConfigs[suggestion.date] = {
        ...(next.dayConfigs[suggestion.date] ?? { date: suggestion.date, type: suggestion.from }),
        type: suggestion.to,
        userSet: true
      }
    }
    for (const [date, override] of Object.entries(dayTypeOverrides)) {
      next.dayConfigs[date] = {
        ...(next.dayConfigs[date] ?? { date, type: 'regular' as DayType }),
        date,
        type: override.type,
        customMinutes: override.type === 'custom' ? override.customMinutes ?? next.settings.regularMinutes : undefined,
        userSet: true
      }
    }
    next.updatedAt = new Date().toISOString()
    return next
  }, [result, decisions, acceptedDayTypes, dayTypeOverrides, currentState])

  useEffect(() => {
    if (!editedState) {
      setDebouncedIssues([])
      return
    }
    const timer = window.setTimeout(() => setDebouncedIssues(analyzePlan(editedState, request.fromDate).slice(0, 12)), 450)
    return () => window.clearTimeout(timer)
  }, [editedState, request.fromDate])

  const liveLoadChanges = useMemo(() => {
    if (!editedState) return []
    const dates = new Set<string>([
      ...dateRange(currentState.settings.startDate, currentState.settings.endDate),
      ...currentState.assignments.map(item => item.scheduledDate).filter(Boolean) as string[],
      ...editedState.assignments.map(item => item.scheduledDate).filter(Boolean) as string[]
    ])
    return [...dates].map(date => ({
      date,
      beforeMinutes: dayLoad(currentState, date),
      afterMinutes: dayLoad(editedState, date),
      beforeCapacity: getCapacity(currentState, date),
      afterCapacity: getCapacity(editedState, date)
    })).filter(change => change.beforeMinutes !== change.afterMinutes || change.beforeCapacity !== change.afterCapacity)
      .sort((a, b) => Math.abs(b.afterMinutes - b.beforeMinutes) - Math.abs(a.afterMinutes - a.beforeMinutes))
  }, [currentState, editedState])

  const changedLoads = liveLoadChanges

  const microDates = useMemo(() => {
    if (!result) return []
    const dates = new Set<string>()
    result.moves.forEach(move => { if (move.from) dates.add(move.from); if (move.to) dates.add(move.to) })
    liveLoadChanges.forEach(change => dates.add(change.date))
    return [...dates].sort()
  }, [result, liveLoadChanges])

  const toggleExpandedDate = (date: string) => setExpandedDates(previous => {
    if (previous.includes(date)) return previous.filter(item => item !== date)
    return [...previous.slice(-2), date]
  })

  const handlePreviewDragStart = (assignmentId: string, event: React.DragEvent) => {
    event.stopPropagation()
    event.dataTransfer.setData('text/replan-assignment-id', assignmentId)
    event.dataTransfer.effectAllowed = 'move'
  }

  const dropPreviewTask = (date: string, event: React.DragEvent) => {
    event.preventDefault()
    const assignmentId = event.dataTransfer.getData('text/replan-assignment-id')
    if (!assignmentId || !editedState) return
    const assignment = editedState.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.locked || assignment.scheduledDate === date) return
    changeDecision(assignmentId, { ...(decisions[assignmentId] ?? { mode: 'accept' }), mode: 'custom', date, previewFixed: true })
    setDragTargetDate(undefined)
  }

  const restoreDayType = (date: string) => {
    pushSnapshot()
    setDayTypeOverrides(previous => { const next = { ...previous }; delete next[date]; return next })
    setAcceptedDayTypes(previous => ({ ...previous, [date]: false }))
  }

  const detailOverride = detailDate ? dayTypeOverrides[detailDate] : undefined
  const detailType = detailDate && editedState ? detailOverride?.type ?? editedState.dayConfigs[detailDate]?.type ?? 'regular' : 'regular'

  return <>
    <Modal open={open} title={t('replanDialog.modalTitle')} onClose={onClose} wide mobileFullscreen>
      <div className="replan-controls">
        <div className="segmented-control">
          <button className={request.mode === 'repair' ? 'active' : ''} onClick={() => onRequestChange({ ...request, mode: 'repair' })}>{t('replanDialog.modePartialRepair')}</button>
          <button className={request.mode === 'full' ? 'active' : ''} onClick={() => onRequestChange({ ...request, mode: 'full' })}>{t('replanDialog.modeFullReplan')}</button>
        </div>
        <label className="field compact-field"><span>{t('replanDialog.fromDateLabel')}</span><input type="date" value={request.fromDate} onChange={event => onRequestChange({ ...request, fromDate: event.target.value })}/></label>
        <label className="field compact-field"><span>{t('replanDialog.freezeDaysLabel')}</span><NumericInput min={0} max={7} value={request.freezeDays ?? 2} onValueChange={value => onRequestChange({ ...request, freezeDays: value })}/></label>
        <button className="secondary-button" onClick={() => onRegenerate(request)}><RefreshCw size={16}/>{t('replanDialog.recalculate')}</button>
        <button className="secondary-button" disabled={!undoStack.length} onClick={undoPreview}><Undo2 size={16}/>{t('replanDialog.undoPreview')}</button>
        <p className="replan-control-note">{t('replanDialog.controlNote')}</p>
      </div>

      {bundle?.todaySnapshot && <section className="today-replan-snapshot">
        <div><strong>{t('replanDialog.snapshotTitle')}</strong><span>{bundle.todaySnapshot.message}</span></div>
        <div className="today-snapshot-values">
          <span>{t('replanDialog.actualTiming', { minutes: minutesText(bundle.todaySnapshot.actualMinutes) })}</span>
          {bundle.todaySnapshot.inferredMinutes > 0 && <span>{t('replanDialog.inferredUsage', { minutes: minutesText(bundle.todaySnapshot.inferredMinutes) })}</span>}
          <span>{t('replanDialog.completedCount', { count: bundle.todaySnapshot.completedCount })}</span>
          <span>{t('replanDialog.autoRemaining', { minutes: minutesText(bundle.todaySnapshot.remainingCapacity) })}</span>
        </div>
        <div className="today-extra-control">
          <span>{t('replanDialog.todayExtraLabel')}</span>
          {[0, 30, 60].map(minutes => <button key={minutes} className={(request.todayExtraMinutes ?? 0) === minutes ? 'choice-active' : ''} onClick={() => regenerateWith({ todayExtraMinutes: minutes })}>{minutes === 0 ? t('replanDialog.todayNoMore') : t('replanDialog.todayCanStudy', { minutes })}</button>)}
          <label><span>{t('replanDialog.customLabel')}</span><NumericInput min={0} max={1440} step={10} value={![0, 30, 60].includes(request.todayExtraMinutes ?? 0) ? request.todayExtraMinutes : undefined} placeholder={t('replanDialog.minutesPlaceholder')} onValueChange={value => onRequestChange({ ...request, todayExtraMinutes: value })} onEmpty={() => onRequestChange({ ...request, todayExtraMinutes: 0 })}/></label>
        </div>
      </section>}

      {!result || !editedState ? <p>{t('replanDialog.calculating')}</p> : <>
        <div className="scenario-tabs">
          {bundle?.scenarios.map(item => <button key={item.strategy} className={strategy === item.strategy ? 'active' : ''} onClick={() => {
            setStrategy(item.strategy)
            onRequestChange({ ...request, strategy: item.strategy })
            setDecisions({})
            setAcceptedDayTypes({})
            setDayTypeOverrides({})
            setUndoStack([])
          }}>
            <strong>{item.title}</strong><span>{item.description}</span>
          </button>)}
        </div>

        {bundle && bundle.issues.length > 0 && <section className="replan-section detected-section">
          <div className="replan-section-title"><AlertTriangle size={18}/><div><h3>{t('replanDialog.detectedIssuesTitle')}</h3><p>{t('replanDialog.detectedIssuesBody')}</p></div></div>
          <div className="detected-issue-list">{bundle.issues.slice(0, 16).map((issue, index) => <div key={index}>{issue}</div>)}</div>
        </section>}

        <div className="summary-grid replan-summary-grid">
          <div className="metric-card"><span>{t('replanDialog.metricMoved')}</span><strong>{result.summary.moved}</strong><small>{t('replanDialog.metricMovedUnit')}</small></div>
          <div className="metric-card"><span>{t('replanDialog.metricChangedDays')}</span><strong>{result.disturbance.changedDays}</strong><small>{t('replanDialog.metricChangedDaysUnit')}</small></div>
          <div className="metric-card"><span>{t('replanDialog.metricRetentionRate')}</span><strong>{Math.round(result.disturbance.originalDateRetentionRate * 100)}%</strong><small>{t('replanDialog.metricRetentionRateUnit')}</small></div>
          <div className="metric-card"><span>{t('replanDialog.metricUnresolved')}</span><strong>{result.summary.unresolved}</strong><small>{t('replanDialog.metricUnresolvedUnit')}</small></div>
          <div className="metric-card"><span>{t('replanDialog.metricPreservedManual')}</span><strong>{result.summary.preservedManual}</strong><small>{t('replanDialog.metricPreservedManualUnit')}</small></div>
          <div className="metric-card"><span>{t('replanDialog.metricCoreEstimate')}</span><strong>{result.summary.coreAfter ?? t('replanDialog.metricCoreUnknown')}</strong><small>{t('replanDialog.metricCoreBefore', { value: result.summary.coreBefore ?? t('replanDialog.metricCoreBeforeUnknown') })}</small></div>
        </div>

        <section className="replan-section">
          <div className="replan-section-title"><SlidersHorizontal size={18}/><div><h3>{t('replanDialog.consequenceSectionTitle')}</h3><p>{t('replanDialog.consequenceSectionBody')}</p></div></div>
          <div className="consequence-detail-list">
            <details>
              <summary><div><strong>{t('replanDialog.issuesDetectedSummary', { count: bundle?.issues.length ?? 0 })}</strong><span>{t('replanDialog.issuesDetectedHint')}</span></div><ChevronDown size={17}/></summary>
              <div className="consequence-detail-body issue-detail-body">
                {(bundle?.issues.length ?? 0) === 0 ? <p className="muted-text">{t('replanDialog.noIssuesDetected')}</p> : bundle?.issues.map((issue, index) => <article key={index}><strong>{t('replanDialog.issueLabel', { index: index + 1 })}</strong><p>{issue}</p></article>)}
              </div>
            </details>
            <details>
              <summary><div><strong>{t('replanDialog.movesSummary', { count: result.moves.length, days: result.disturbance.changedDays })}</strong><span>{t('replanDialog.movesHint')}</span></div><ChevronDown size={17}/></summary>
              <div className="consequence-detail-body move-detail-body">
                {result.moves.length === 0 ? <p className="muted-text">{t('replanDialog.noMovesNeeded')}</p> : result.moves.map(move => <article key={move.assignmentId}>
                  <div className="move-detail-title"><strong>{move.title}</strong><span>{move.subject}</span></div>
                  <div className="move-date-route"><span>{move.from ? fmtDate(move.from) : t('replanDialog.unscheduledLabel')}</span><b>→</b><span>{move.to ? fmtDate(move.to) : t('replanDialog.notYetScheduledLabel')}</span></div>
                  <p><strong>{t('replanDialog.reasonLabel')}</strong>{move.reason}</p>
                  <p><strong>{t('replanDialog.impactLabel')}</strong>{move.impact}</p>
                </article>)}
              </div>
            </details>
            <details>
              <summary><div><strong>{t('replanDialog.disturbanceSummary')}</strong><span>{t('replanDialog.disturbanceHint', { rate: Math.round(result.disturbance.originalDateRetentionRate * 100), minutes: minutesText(result.disturbance.averageLoadDelta) })}</span></div><ChevronDown size={17}/></summary>
              <div className="consequence-detail-body disturbance-detail-body">
                <article><strong>{t('replanDialog.originalRetentionRate')}</strong><span>{Math.round(result.disturbance.originalDateRetentionRate * 100)}%</span></article>
                <article><strong>{t('replanDialog.changedDaysLabel')}</strong><span>{t('replanDialog.changedDaysUnit', { count: result.disturbance.changedDays })}</span></article>
                <article><strong>{t('replanDialog.averageLoadDelta')}</strong><span>{minutesText(result.disturbance.averageLoadDelta)}</span></article>
                <article><strong>{t('replanDialog.maxLoadDelta')}</strong><span>{minutesText(result.disturbance.maximumLoadDelta)}</span></article>
                <article><strong>{t('replanDialog.preservedBundles')}</strong><span>{t('replanDialog.preservedBundlesUnit', { count: result.disturbance.preservedDailyBundles })}</span></article>
              </div>
            </details>
          </div>
          {result.consequences.length > 0 && <div className="consequence-list consequence-full-text">{result.consequences.map((item, index) => <div key={index}>{item}</div>)}</div>}
        </section>

        {result.constraintConflicts.length > 0 && <section className="replan-section constraint-conflict-section">
          <div className="replan-section-title"><AlertTriangle size={18}/><div><h3>{t('replanDialog.conflictSectionTitle')}</h3><p>{t('replanDialog.conflictSectionBody')}</p></div></div>
          <div className="constraint-conflict-list">{result.constraintConflicts.map(conflict => {
            const conflictId = `${conflict.date}:${conflict.key}`
            const limit = limitDrafts[conflictId] ?? conflict.minimumFeasibleLimit
            const extra = Math.max(0, limit - conflict.limit)
            return <article key={conflictId}>
              <div><strong>{conflict.date} · {conflict.label}</strong><span>{t('replanDialog.conflictSummary', { current: Math.round(conflict.current), limit: Math.round(conflict.limit), count: conflict.affectedAssignmentIds.length })}</span></div>
              <div className="quantified-negotiation"><strong>{t('replanDialog.negotiationTitle')}</strong><span>{t('replanDialog.negotiationBody', { deficit: Math.round(conflict.deficit), limit: Math.round(limit), extra: Math.round(extra) })}</span><label><span>{t('replanDialog.onceLimitLabel')}</span><NumericInput min={Math.ceil(conflict.limit)} max={Math.max(Math.ceil(conflict.current) + 999, Math.ceil(conflict.limit) + 1)} value={limit} onValueChange={value => setLimitDrafts(previous => ({ ...previous, [conflictId]: value }))}/></label></div>
              <ul>{conflict.options.map(option => <li key={option}>{option}</li>)}</ul>
              <button className="secondary-button" disabled={limit < conflict.minimumFeasibleLimit} onClick={() => allowConstraintOnce(conflict.date, conflict.key, limit, conflict.affectedAssignmentIds)}>{t('replanDialog.allowOnceButton', { limit: Math.round(limit) })}</button>
            </article>
          })}</div>
        </section>}

        {protectedBufferDates.length > 0 && <section className="replan-section buffer-use-section">
          <div className="replan-section-title"><CalendarClock size={18}/><div><h3>{t('replanDialog.bufferSectionTitle')}</h3><p>{t('replanDialog.bufferSectionBody')}</p></div></div>
          <div className="buffer-use-list">{protectedBufferDates.map(date => {
            const config = currentState.dayConfigs[date]
            const allowed = request.allowBufferUseDates?.includes(date) ?? false
            return <article className={allowed ? 'buffer-use-active' : ''} key={date}>
              <div><strong>{fmtDate(date)} · {fmtWeekday(date)}</strong><span>{config?.availableMinutes === 0 ? t('replanDialog.bufferFullRest') : t('replanDialog.bufferMax', { minutes: minutesText(getCapacity(currentState, date)) })} · {config?.bufferReason || t('replanDialog.bufferManualReason')}</span></div>
              <button className={allowed ? 'secondary-button choice-active' : 'secondary-button'} onClick={() => toggleBufferUse(date)}>{allowed ? t('replanDialog.restoreProtection') : t('replanDialog.allowOnceOnly')}</button>
            </article>
          })}</div>
          {(request.allowBufferUseDates?.length ?? 0) > 0 && <p className="buffer-use-warning">{t('replanDialog.bufferWarning')}</p>}
        </section>}

        {changedLoads.length > 0 && <section className="replan-section">
          <div className="replan-section-title section-title-with-actions"><CalendarClock size={18}/><div><h3>{t('replanDialog.loadCompareTitle')}</h3><p>{t('replanDialog.loadCompareBody')}</p></div><div className="segmented-control small"><button className={!onlyChanges ? 'active' : ''} onClick={() => setOnlyChanges(false)}>{t('replanDialog.allTasks')}</button><button className={onlyChanges ? 'active' : ''} onClick={() => setOnlyChanges(true)}>{t('replanDialog.onlyChanges')}</button></div></div>
          <div className="load-compare-list">{changedLoads.map(change => {
            const beforeRatio = change.beforeCapacity ? change.beforeMinutes / change.beforeCapacity : 0
            const afterRatio = change.afterCapacity ? change.afterMinutes / change.afterCapacity : 0
            const expanded = loadCompareDate === change.date
            return <div className={`load-compare-item ${expanded ? 'expanded' : ''}`} key={change.date}>
              <button className="load-compare-row" onClick={() => setLoadCompareDate(expanded ? undefined : change.date)}>
                <strong>{fmtDate(change.date)} · {fmtWeekday(change.date)}</strong>
                <div><span>{t('replanDialog.loadBefore', { minutes: minutesText(change.beforeMinutes) })}</span><i style={{ width: `${Math.min(100, beforeRatio * 100)}%` }}/></div>
                <b>→</b>
                <div><span>{t('replanDialog.loadAfter', { minutes: minutesText(change.afterMinutes) })}</span><i className={afterRatio > 1 ? 'over' : ''} style={{ width: `${Math.min(100, afterRatio * 100)}%` }}/></div>
                <small>{t('replanDialog.capacityLabel', { minutes: minutesText(change.afterCapacity) })}</small>
                {expanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
              </button>
              {expanded && <DayDiffPanel
                date={change.date}
                beforeState={currentState}
                afterState={editedState}
                onlyChanges={onlyChanges}
                decisions={decisions}
                result={result}
                onDecision={changeDecision}
                onDragStart={handlePreviewDragStart}
              />}
            </div>
          })}</div>
        </section>}

        {result.dayTypeSuggestions.length > 0 && <section className="replan-section">
          <div className="replan-section-title"><CalendarClock size={18}/><div><h3>{t('replanDialog.dayTypeSuggestionTitle')}</h3><p>{t('replanDialog.dayTypeSuggestionBody')}</p></div></div>
          <div className="suggestion-list">{result.dayTypeSuggestions.map(suggestion => <label key={suggestion.date} className="suggestion-row">
            <input type="checkbox" checked={Boolean(acceptedDayTypes[suggestion.date])} onChange={event => toggleSuggestedDayType(suggestion.date, event.target.checked)}/>
            <div><strong>{t('replanDialog.dayTypeSuggestionRow', { date: suggestion.date, from: t(`dayType.${suggestion.from}`), to: t(`dayType.${suggestion.to}`) })}</strong><span>{t('replanDialog.dayTypeSuggestionReason', { reason: suggestion.reason, minutes: minutesText(suggestion.capacityGain) })}</span></div>
          </label>)}</div>
        </section>}

        <section className="replan-section">
          <div className="replan-section-title"><Check size={18}/><div><h3>{t('replanDialog.microTuneTitle')}</h3><p>{t('replanDialog.microTuneBody')}</p></div></div>
          <div className="micro-day-list">
            {microDates.length === 0 && <p className="muted-text">{t('replanDialog.noMovesNeededMicro')}</p>}
            {microDates.map(date => {
              const expanded = expandedDates.includes(date)
              const beforeMinutes = dayLoad(currentState, date)
              const afterMinutes = dayLoad(editedState, date)
              const changeCount = buildDayDiff(currentState, editedState, date).filter(row => row.kind !== 'same').length
              return <article
                className={`micro-day-card ${expanded ? 'expanded' : ''} ${dragTargetDate === date ? 'drag-target' : ''}`}
                key={date}
                onDragOver={event => { event.preventDefault(); setDragTargetDate(date) }}
                onDrop={event => dropPreviewTask(date, event)}
              >
                <button className="micro-day-head" onClick={() => toggleExpandedDate(date)}>
                  <div><strong>{fmtDate(date)} · {fmtWeekday(date)}</strong><span>{t('replanDialog.microDayChangeCount', { before: minutesText(beforeMinutes), after: minutesText(afterMinutes), count: changeCount })}</span></div>
                  {expanded ? <ChevronUp size={17}/> : <ChevronDown size={17}/>}
                </button>
                {expanded && <>
                  <DayDiffPanel
                    date={date}
                    beforeState={currentState}
                    afterState={editedState}
                    onlyChanges={false}
                    decisions={decisions}
                    result={result}
                    onDecision={changeDecision}
                    onDragStart={handlePreviewDragStart}
                    compact
                  />
                  <div className="micro-day-footer"><button className="secondary-button" onClick={() => setDetailDate(date)}>{t('replanDialog.detailAdjust')}</button></div>
                </>}
              </article>
            })}
          </div>
        </section>

        {debouncedIssues.length > 0 && <section className="replan-section warning-section">
          <div className="replan-section-title"><AlertTriangle size={18}/><div><h3>{t('replanDialog.microCheckTitle')}</h3><p>{t('replanDialog.microCheckBody')}</p></div></div>
          <div className="warning-list">{debouncedIssues.map((issue, index) => <div key={`${issue.date ?? 'all'}-${index}`} className={`warning-item issue-${issue.level}`}>{issue.message}</div>)}</div>
        </section>}

        {result.warnings.length > 0 && <section className="replan-section warning-section">
          <div className="replan-section-title"><AlertTriangle size={18}/><div><h3>{t('replanDialog.warningSectionTitle')}</h3><p>{t('replanDialog.warningSectionBody')}</p></div></div>
          <div className="warning-list">{result.warnings.slice(0, 20).map((warning, index) => <div key={index} className="warning-item">{warning}</div>)}</div>
        </section>}

        <div className="modal-actions sticky-actions"><button className="secondary-button" onClick={onClose}>{t('replanDialog.discardReplan')}</button><button className="primary-button" onClick={() => {
          const auditDates = dateRange(currentState.settings.startDate, currentState.settings.endDate).filter(date => {
            const before = currentState.dayConfigs[date]
            const after = editedState.dayConfigs[date]
            return before?.type !== after?.type || before?.customMinutes !== after?.customMinutes || before?.isBufferDay !== after?.isBufferDay || before?.availableMinutes !== after?.availableMinutes || before?.bufferReason !== after?.bufferReason || before?.bufferPreference !== after?.bufferPreference || before?.bufferProtected !== after?.bufferProtected
          })
          const audit: ReplanAudit = {
            strategy,
            decisions: Object.entries(decisions).map(([assignmentId, decision]) => ({ assignmentId, ...decision })),
            dayTypes: auditDates.map(date => ({
              date,
              type: editedState.dayConfigs[date]?.type ?? 'regular',
              customMinutes: editedState.dayConfigs[date]?.customMinutes,
              isBufferDay: editedState.dayConfigs[date]?.isBufferDay,
              availableMinutes: editedState.dayConfigs[date]?.availableMinutes,
              bufferReason: editedState.dayConfigs[date]?.bufferReason,
              bufferPreference: editedState.dayConfigs[date]?.bufferPreference,
              bufferProtected: editedState.dayConfigs[date]?.bufferProtected
            })),
            limitOverrides: request.limitOverrides,
            todayExtraMinutes: request.todayExtraMinutes,
            allowBufferUseDates: request.allowBufferUseDates
          }
          onApply(result, editedState, audit)
        }}>{t('replanDialog.applyAllAccepted')}</button></div>
      </>}
    </Modal>

    <Drawer
      open={Boolean(open && detailDate && result && editedState)}
      title={detailDate ? `${fmtDate(detailDate)} · ${fmtWeekday(detailDate)}` : t('replanDialog.drawerDefaultTitle')}
      subtitle={t('replanDialog.drawerSubtitle')}
      onClose={() => setDetailDate(undefined)}
      wide
    >
      {detailDate && result && editedState && <>
        <div className="drawer-day-controls">
          <label className="field"><span>{t('replanDialog.dayTypeLabel')}</span><select value={detailType} onChange={event => changeDayType(detailDate, { type: event.target.value as DayType, customMinutes: dayTypeOverrides[detailDate]?.customMinutes })}>{(['regular', 'study', 'travel', 'custom'] as DayType[]).map(type => <option value={type} key={type}>{t(`dayType.${type}`)}</option>)}</select></label>
          {detailType === 'custom' && <label className="field"><span>{t('replanDialog.customCapacityLabel')}</span><NumericInput min={0} max={1440} value={dayTypeOverrides[detailDate]?.customMinutes ?? getCapacity(editedState, detailDate)} onValueChange={value => changeDayType(detailDate, { type: 'custom', customMinutes: value })}/></label>}
          <div className="day-type-impact">
            <span>{t('replanDialog.originalCapacity', { minutes: minutesText(getCapacity(currentState, detailDate)) })}</span>
            <b>→</b>
            <span>{t('replanDialog.currentCapacity', { minutes: minutesText(getCapacity(editedState, detailDate)) })}</span>
            <em>{dayLoad(editedState, detailDate) > getCapacity(editedState, detailDate) ? t('replanDialog.overloadedBy', { minutes: minutesText(dayLoad(editedState, detailDate) - getCapacity(editedState, detailDate)) }) : t('replanDialog.notOverloaded')}</em>
          </div>
        </div>
        <DayDiffPanel
          date={detailDate}
          beforeState={currentState}
          afterState={editedState}
          onlyChanges={onlyChanges}
          decisions={decisions}
          result={result}
          onDecision={changeDecision}
          onDragStart={handlePreviewDragStart}
        />
        <div className="drawer-actions"><button className="secondary-button" onClick={() => restoreDayType(detailDate)}><RotateCcw size={15}/>{t('replanDialog.restoreDayType')}</button><button className="primary-button" onClick={() => setDetailDate(undefined)}>{t('replanDialog.finishDayTuning')}</button></div>
      </>}
    </Drawer>
  </>
}
