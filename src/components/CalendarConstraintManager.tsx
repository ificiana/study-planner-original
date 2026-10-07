import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { AppState, CalendarConstraint, CalendarConstraintKind, PlanChangeEvent } from '../types'
import { useApp } from '../AppContext'
import { uid } from '../lib/id'
import { fmtDate } from '../lib/date'
import { applyWeekdayWeekendCapacityTemplate } from '../lib/weekly-capacity'
import { useT } from '../lib/i18n'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'

export function CalendarConstraintManager({ onPrepared }: { onPrepared: (state: AppState, event: PlanChangeEvent) => void }) {
  const t = useT()
  const { state, prepareCalendarConstraintChange, updateCalendarConstraintMetadata } = useApp()
  const [editing, setEditing] = useState<CalendarConstraint | null | undefined>()
  const [weekdayMinutes, setWeekdayMinutes] = useState(state.settings.regularMinutes)
  const [weekendMinutes, setWeekendMinutes] = useState(state.settings.studyMinutes)

  useEffect(() => {
    setWeekdayMinutes(state.settings.regularMinutes)
    setWeekendMinutes(state.settings.studyMinutes)
  }, [state.settings.regularMinutes, state.settings.studyMinutes])

  const applyWeeklyTemplate = () => {
    const result = applyWeekdayWeekendCapacityTemplate(state, weekdayMinutes, weekendMinutes)
    if (!result.changedDates.length) {
      window.alert(t('calendarConstraintManager.weeklyTemplateAlreadyApplied'))
      return
    }
    const changedDateSet = new Set(result.changedDates)
    const hasIncrease = result.capacityDeltas.some(item => item.after > item.before)
    const hasDecrease = result.capacityDeltas.some(item => item.after < item.before)
    const pureIncrease = hasIncrease && !hasDecrease
    const firstChangedDate = result.changedDates[0]
    const affectedAssignments = pureIncrease
      ? result.state.assignments.filter(item => item.status !== 'done' && (!item.scheduledDate || !firstChangedDate || item.scheduledDate >= firstChangedDate))
      : result.state.assignments.filter(item => item.status !== 'done' && item.scheduledDate && changedDateSet.has(item.scheduledDate))
    const affectedGroupIds = Array.from(new Set(affectedAssignments.map(item => item.groupId)))
    const affectedGoalIds = result.state.goals.filter(goal => affectedAssignments.some(item =>
      goal.linkedAssignmentIds.includes(item.id)
      || goal.linkedTaskGroupIds.includes(item.groupId)
      || goal.completionConditions.some(condition => condition.groupId === item.groupId)
    )).map(goal => goal.id)
    const now = new Date().toISOString()
    const preservedText = result.preservedManualDates.length
      ? t('calendarConstraintManager.preservedManualDates', { count: result.preservedManualDates.length })
      : t('calendarConstraintManager.noPreservedManualDates')
    const event: PlanChangeEvent = {
      id: uid('event'),
      type: 'availability-change',
      action: pureIncrease ? 'optimize' : 'repair',
      title: t('calendarConstraintManager.weeklyTemplateEventTitle'),
      description: t('calendarConstraintManager.weeklyTemplateEventDescription', { weekday: Math.round(weekdayMinutes), weekend: Math.round(weekendMinutes), preserved: preservedText }),
      affectedGoalIds,
      affectedGroupIds,
      affectedAssignmentIds: affectedAssignments.map(item => item.id),
      affectedDates: result.changedDates,
      createdAt: now,
      metadata: {
        template: 'weekday-weekend-capacity',
        weekdayMinutes: Math.round(weekdayMinutes),
        weekendMinutes: Math.round(weekendMinutes),
        capacityDeltas: result.capacityDeltas,
        preservedManualDates: result.preservedManualDates,
        hasIncrease,
        hasDecrease,
        pureRelaxation: pureIncrease,
        preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'],
      },
    }
    result.state.changeEvents = [...result.state.changeEvents, event].slice(-100)
    result.state.updatedAt = now
    onPrepared(result.state, event)
  }

  const submit = (constraint: CalendarConstraint) => {
    const existing = state.calendarConstraints.find(item => item.id === constraint.id)
    const sameShape = Boolean(existing
      && existing.startDate === constraint.startDate
      && existing.endDate === constraint.endDate
      && existing.kind === constraint.kind
      && existing.capacityMinutes === constraint.capacityMinutes
      && existing.protected === constraint.protected)
    if (existing && sameShape) {
      // 仅备注名称变化属于纯展示元数据：直接保存，不触发调度/冲突/方案/版本；无变化则只关闭。
      if (existing.reason !== constraint.reason) updateCalendarConstraintMetadata(existing.id, constraint.reason ?? '')
      setEditing(undefined)
      return
    }
    const prepared = prepareCalendarConstraintChange(constraint)
    setEditing(undefined)
    onPrepared(prepared.state, prepared.event)
  }

  return <>
    <section className="settings-section constraint-manager"><div><h2>{t('calendarConstraintManager.sectionTitle')}</h2><p>{t('calendarConstraintManager.sectionBody')}</p></div><div>
      <div className="form-grid">
        <label className="field"><span>{t('calendarConstraintManager.weekdayMinutesLabel')}</span><NumericInput min={0} max={1440} value={weekdayMinutes} onValueChange={setWeekdayMinutes}/><small>{t('calendarConstraintManager.weekdayMinutesHint')}</small></label>
        <label className="field"><span>{t('calendarConstraintManager.weekendMinutesLabel')}</span><NumericInput min={0} max={1440} value={weekendMinutes} onValueChange={setWeekendMinutes}/><small>{t('calendarConstraintManager.weekendMinutesHint')}</small></label>
        <div className="form-note span-2">{t('calendarConstraintManager.templateNote')}</div>
      </div>
      <div className="button-wrap"><button className="primary-button" onClick={applyWeeklyTemplate}>{t('calendarConstraintManager.applyTemplate')}</button></div>
    </div></section>

    <section className="settings-section constraint-manager"><div><h2>{t('calendarConstraintManager.constraintsSectionTitle')}</h2><p>{t('calendarConstraintManager.constraintsSectionBody')}</p></div><div>
      <button className="primary-button" onClick={() => setEditing(null)}><Plus size={16}/>{t('calendarConstraintManager.addConstraint')}</button>
      <div className="constraint-list">{state.calendarConstraints.length === 0 ? <p className="muted-text">{t('calendarConstraintManager.noConstraints')}</p> : state.calendarConstraints.slice().sort((a,b) => a.startDate.localeCompare(b.startDate)).map(item => <article key={item.id}><div><strong>{item.reason || constraintLabel(item.kind, t)}</strong><span>{fmtDate(item.startDate)}{item.endDate !== item.startDate ? ` ${t('calendarConstraintManager.dateRangeTo', { date: fmtDate(item.endDate) })}` : ''}</span><small>{constraintLabel(item.kind, t)}{item.capacityMinutes != null ? ` · ${t('calendarConstraintManager.capacitySuffix', { minutes: item.capacityMinutes })}` : ''}{item.protected ? ` · ${t('calendarConstraintManager.protectedSuffix')}` : ''}</small></div><div className="row-actions"><button className="secondary-button" onClick={() => setEditing(item)}>{t('calendarConstraintManager.editConstraint')}</button><button className="icon-button danger" aria-label={t('calendarConstraintManager.removeConstraintLabel', { name: item.reason || constraintLabel(item.kind, t) })} onClick={() => { const prepared = prepareCalendarConstraintChange(undefined, item.id); onPrepared(prepared.state, prepared.event) }}><Trash2 size={16}/></button></div></article>)}</div>
      <ConstraintDialog open={editing !== undefined} initial={editing ?? undefined} state={state} onClose={() => setEditing(undefined)} onSave={submit}/>
    </div></section>
  </>
}

function ConstraintDialog({ open, initial, state, onClose, onSave }: { open: boolean; initial?: CalendarConstraint; state: AppState; onClose: () => void; onSave: (value: CalendarConstraint) => void }) {
  const t = useT()
  const [startDate, setStartDate] = useState(initial?.startDate ?? state.settings.startDate)
  const [endDate, setEndDate] = useState(initial?.endDate ?? initial?.startDate ?? state.settings.startDate)
  const [kind, setKind] = useState<CalendarConstraintKind>(initial?.kind ?? 'unavailable')
  const [capacity, setCapacity] = useState(initial?.capacityMinutes ?? 0)
  const [protectedDate, setProtectedDate] = useState(initial?.protected ?? true)
  const [reason, setReason] = useState(initial?.reason ?? '')
  const key = `${open}-${initial?.id ?? 'new'}`
  useEffect(() => {
    setStartDate(initial?.startDate ?? state.settings.startDate)
    setEndDate(initial?.endDate ?? initial?.startDate ?? state.settings.startDate)
    setKind(initial?.kind ?? 'unavailable')
    setCapacity(initial?.capacityMinutes ?? 0)
    setProtectedDate(initial?.protected ?? true)
    setReason(initial?.reason ?? '')
  }, [key, initial, state.settings.startDate])
  const needsCapacity = kind === 'reduced-capacity' || kind === 'special-capacity' || kind === 'protected-buffer'
  const submit = () => { if (!startDate || !endDate || startDate > endDate) return; const now = new Date().toISOString(); onSave({ id: initial?.id ?? uid('constraint'), startDate, endDate, kind, capacityMinutes: needsCapacity ? capacity : kind === 'unavailable' ? 0 : undefined, protected: protectedDate || kind === 'protected-buffer', reason: reason.trim() || constraintLabel(kind, t), preference: kind === 'protected-buffer' ? 'preserve' : undefined, createdAt: initial?.createdAt ?? now, updatedAt: now }) }
  return <Modal open={open} title={initial ? t('calendarConstraintManager.dialogTitleEdit') : t('calendarConstraintManager.dialogTitleAdd')} onClose={onClose} wide mobileFullscreen><div className="form-grid"><label className="field"><span>{t('calendarConstraintManager.startDate')}</span><input type="date" value={startDate} onChange={event => { setStartDate(event.target.value); if (endDate < event.target.value) setEndDate(event.target.value) }}/></label><label className="field"><span>{t('calendarConstraintManager.endDate')}</span><input type="date" value={endDate} min={startDate} onChange={event => setEndDate(event.target.value)}/></label><label className="field span-2"><span>{t('calendarConstraintManager.kindLabel')}</span><select value={kind} onChange={event => setKind(event.target.value as CalendarConstraintKind)}><option value="unavailable">{t('calendarConstraintManager.kindUnavailable')}</option><option value="reduced-capacity">{t('calendarConstraintManager.kindReducedCapacity')}</option><option value="special-capacity">{t('calendarConstraintManager.kindSpecialCapacity')}</option><option value="protected-buffer">{t('calendarConstraintManager.kindProtectedBuffer')}</option><option value="note">{t('calendarConstraintManager.kindNote')}</option></select></label>{needsCapacity && <label className="field"><span>{t('calendarConstraintManager.availableMinutes')}</span><NumericInput min={0} max={1440} value={capacity} onValueChange={setCapacity}/></label>}<label className="field checkbox-field"><input type="checkbox" checked={protectedDate} onChange={event => setProtectedDate(event.target.checked)}/><span>{t('calendarConstraintManager.protectDate')}</span></label><label className="field span-2"><span>{t('calendarConstraintManager.reason')}</span><input value={reason} onChange={event => setReason(event.target.value)} placeholder={t('calendarConstraintManager.reasonPlaceholder')} /></label><div className="form-note span-2">{t('calendarConstraintManager.dialogNote')}</div></div><div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" disabled={!startDate || !endDate || startDate > endDate} onClick={submit}>{t('calendarConstraintManager.previewImpact')}</button></div></Modal>
}
function constraintLabel(kind: CalendarConstraintKind, t: ReturnType<typeof useT>) { return kind === 'unavailable' ? t('calendarConstraintManager.labelUnavailable') : kind === 'reduced-capacity' ? t('calendarConstraintManager.labelReducedCapacity') : kind === 'special-capacity' ? t('calendarConstraintManager.labelSpecialCapacity') : kind === 'protected-buffer' ? t('calendarConstraintManager.labelProtectedBuffer') : t('calendarConstraintManager.labelNote') }
