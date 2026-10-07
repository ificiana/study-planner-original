import { useEffect, useMemo, useState } from 'react'
import type { AppState, Priority, Subject, TaskActivityType, TaskGroup, TaskGroupDraft } from '../types'
import { fmtDate } from '../lib/date'
import { weeklyOccurrenceRange } from '../lib/frequency'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'
import { useT } from '../lib/i18n'

const presetSubjects: Subject[] = ['语文','数学','英语','物理','化学','生物','其他']
const priorities: Priority[] = [5,3,2,1,0]

function weekdayFor(date: string) {
  return new Date(`${date}T12:00:00`).getDay()
}

export function TaskGroupDialog({ open, onClose, state, initial, defaultDate, onCreate, onEdit }: {
  open: boolean
  onClose: () => void
  state: AppState
  initial?: TaskGroup
  defaultDate?: string
  onCreate: (draft: TaskGroupDraft, schedule: boolean) => void
  onEdit?: (group: TaskGroup, numberingChoice: 'preserve' | 'number-all') => void
}) {
  const t = useT()
  const weekdays = [t('taskGroupDialog.weekday.sun'), t('taskGroupDialog.weekday.mon'), t('taskGroupDialog.weekday.tue'), t('taskGroupDialog.weekday.wed'), t('taskGroupDialog.weekday.thu'), t('taskGroupDialog.weekday.fri'), t('taskGroupDialog.weekday.sat')]
  const activityOptions: { value: TaskActivityType; label: string }[] = [
    { value: 'normal', label: t('taskGroupDialog.activity.normal') }, { value: 'classical-study', label: t('taskGroupDialog.activity.classicalStudy') },
    { value: 'classical-dictation', label: t('taskGroupDialog.activity.classicalDictation') }, { value: 'recitation', label: t('taskGroupDialog.activity.recitation') },
    { value: 'chem-preview', label: t('taskGroupDialog.activity.chemPreview') }, { value: 'math-paper', label: t('taskGroupDialog.activity.mathPaper') },
  ]
  const priorityLabel = (value: Priority) => value === 5 ? t('priority.core') : value === 3 ? t('priority.high') : value === 2 ? t('priority.medium') : value === 1 ? t('priority.low') : t('priority.optional')
  const subjects = useMemo(() => Array.from(new Set([...presetSubjects, ...state.settings.customSubjects, ...state.taskGroups.map(group => group.subject)])), [state])
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState<Subject>('其他')
  const [priority, setPriority] = useState<Priority>(3)
  const [quantity, setQuantity] = useState(1)
  const [minutes, setMinutes] = useState(30)
  const [dailyMax, setDailyMax] = useState<number | undefined>()
  const [activityType, setActivityType] = useState<TaskActivityType>('normal')
  const [highIntensity, setHighIntensity] = useState(false)
  const [countInStats, setCountInStats] = useState(true)
  const [notes, setNotes] = useState('')
  const [goalIds, setGoalIds] = useState<string[]>([])
  const [customSubject, setCustomSubject] = useState('')
  const [numberingChoice, setNumberingChoice] = useState<'preserve' | 'number-all'>('preserve')
  const [weeklyFrequency, setWeeklyFrequency] = useState(false)
  const [weeklyStart, setWeeklyStart] = useState(state.settings.startDate)
  const [weeklyWeekday, setWeeklyWeekday] = useState(1)

  useEffect(() => {
    if (!open) return
    const frequencyStart = defaultDate ?? state.settings.startDate
    setTitle(initial?.title ?? '')
    setSubject(initial?.subject ?? '其他')
    setPriority(initial?.priority ?? 3)
    setQuantity(initial?.sourceQuantity ?? initial?.quantity ?? 1)
    setMinutes(initial?.unitMinutes ?? 30)
    setDailyMax(initial?.dailyMax)
    setActivityType(initial?.activityType ?? 'normal')
    setHighIntensity(Boolean(initial?.highIntensity))
    setCountInStats(initial?.countInStats ?? true)
    setNotes(initial?.notes ?? '')
    setGoalIds(state.goals.filter(goal => goal.linkedTaskGroupIds.includes(initial?.id ?? '')).map(goal => goal.id))
    setCustomSubject('')
    setNumberingChoice('preserve')
    setWeeklyFrequency(false)
    setWeeklyStart(frequencyStart)
    setWeeklyWeekday(weekdayFor(frequencyStart))
  }, [open, initial, state.goals, state.settings.startDate, defaultDate])

  const chosenSubject = customSubject.trim() || subject
  const initialItemCount = initial ? state.assignments.filter(item => item.groupId === initial.id).length : 0
  const becomesMultiItem = Boolean(initial && !initial.recurring && initialItemCount === 1 && quantity > 1)
  const weeklyRange = useMemo(() => weeklyOccurrenceRange(weeklyStart, weeklyWeekday, quantity), [weeklyStart, weeklyWeekday, quantity])
  const weeklyOutOfRange = weeklyFrequency && Boolean(
    !weeklyRange.firstDate
    || !weeklyRange.lastDate
    || weeklyRange.firstDate < state.settings.startDate
    || weeklyRange.lastDate > state.settings.endDate
  )
  const weeklyPreview = weeklyRange.dates.length <= 5
    ? weeklyRange.dates.map(date => fmtDate(date)).join('、')
    : `${weeklyRange.dates.slice(0, 3).map(date => fmtDate(date)).join('、')} … ${fmtDate(weeklyRange.dates.at(-1)!)}`

  const draft = (): TaskGroupDraft => weeklyFrequency ? {
    title: title.trim(), subject: chosenSubject, priority, unitMinutes: minutes,
    activityType: 'recurring', dailyMax: undefined, highIntensity, countInStats, quantity,
    notes: notes.trim() || undefined, goalIds, numberingChoice, recurring: true,
    recurrenceStart: weeklyRange.firstDate, recurrenceEnd: weeklyRange.lastDate,
    recurrenceWeekdays: [weeklyWeekday], allowSplit: false, preferredDate: undefined,
  } : {
    title: title.trim(), subject: chosenSubject, priority, unitMinutes: minutes, activityType, dailyMax,
    highIntensity, countInStats, quantity, notes: notes.trim() || undefined, goalIds, numberingChoice,
    preferredDate: initial ? undefined : defaultDate,
  }
  const create = () => { if (!title.trim() || weeklyOutOfRange) return; onCreate(draft(), true) }
  const edit = () => {
    if (!initial || !onEdit || !title.trim()) return
    onEdit({ ...initial, title: title.trim(), subject: chosenSubject, priority, quantity, unitMinutes: minutes, dailyMax, activityType, highIntensity, countInStats, notes: notes.trim() || undefined }, numberingChoice)
    onClose()
  }

  return <Modal open={open} title={initial ? t('taskGroupDialog.titleEdit') : t('taskGroupDialog.titleAdd')} onClose={onClose} wide mobileFullscreen>
    <div className="form-grid">
      <label className="field span-2"><span>{t('taskGroupDialog.nameLabel')}</span><input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder={t('taskGroupDialog.namePlaceholder')} /></label>
      <label className="field"><span>{t('taskGroupDialog.subjectLabel')}</span><select value={subject} onChange={event => { setSubject(event.target.value); setCustomSubject('') }}>{subjects.map(item => <option key={item}>{item}</option>)}</select></label>
      <label className="field"><span>{t('taskGroupDialog.newCustomSubjectLabel')}</span><input value={customSubject} onChange={event => setCustomSubject(event.target.value)} placeholder={t('taskGroupDialog.customSubjectPlaceholder')} /></label>
      <label className="field"><span>{t('taskGroupDialog.priorityLabel')}</span><select value={priority} onChange={event => setPriority(Number(event.target.value) as Priority)}>{priorities.map(item => <option key={item} value={item}>{priorityLabel(item)}</option>)}</select></label>
      <label className="field"><span>{weeklyFrequency ? t('taskGroupDialog.totalQuantityLabel') : t('taskGroupDialog.quantityLabel')}</span><NumericInput min={1} max={999} value={quantity} onValueChange={setQuantity}/></label>
      <label className="field"><span>{t('taskGroupDialog.unitMinutesLabel')}</span><NumericInput min={1} max={1440} value={minutes} onValueChange={setMinutes}/></label>

      {!initial && <fieldset className="field span-2 intake-rule-choice"><legend>{t('taskGroupDialog.frequencyLegend')}</legend>
        <label><input type="radio" name="task-group-frequency" checked={!weeklyFrequency} onChange={() => setWeeklyFrequency(false)}/><span><strong>{t('taskGroupDialog.normalGroupStrong')}</strong><small>{t('taskGroupDialog.normalGroupSmall')}</small></span></label>
        <label><input type="radio" name="task-group-frequency" checked={weeklyFrequency} onChange={() => setWeeklyFrequency(true)}/><span><strong>{t('taskGroupDialog.weeklyGroupStrong')}</strong><small>{t('taskGroupDialog.weeklyGroupSmall')}</small></span></label>
      </fieldset>}

      {!initial && weeklyFrequency && <div className="form-grid span-2">
        <label className="field"><span>{t('taskGroupDialog.weeklyStartLabel')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={weeklyStart} onChange={event => setWeeklyStart(event.target.value)}/><small>{t('taskGroupDialog.weeklyStartHint')}</small></label>
        <label className="field"><span>{t('taskGroupDialog.weeklyWeekdayLabel')}</span><select value={weeklyWeekday} onChange={event => setWeeklyWeekday(Number(event.target.value))}>{weekdays.map((label, day) => <option key={label} value={day}>{label}</option>)}</select></label>
        <div className={`form-note span-2 ${weeklyOutOfRange ? 'danger-text' : ''}`}>
          {weeklyOutOfRange
            ? t('taskGroupDialog.weeklyOutOfRange', { quantity, endDate: state.settings.endDate })
            : t('taskGroupDialog.weeklyInRange', { quantity, preview: weeklyPreview, weekday: weekdays[weeklyWeekday] })}
        </div>
      </div>}

      {!weeklyFrequency && <details className="form-advanced span-2"><summary>{t('taskGroupDialog.advancedRulesSummary')}</summary><div className="form-grid">
        <label className="field"><span>{t('taskGroupDialog.dailyMaxLabel')}</span><NumericInput min={1} max={99} value={dailyMax} placeholder={t('taskGroupDialog.dailyMaxPlaceholder')} onValueChange={setDailyMax} onEmpty={() => setDailyMax(undefined)}/></label>
        <label className="field"><span>{t('taskGroupDialog.activityTypeLabel')}</span><select value={activityType} onChange={event => setActivityType(event.target.value)}>{activityOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{t('taskGroupDialog.activityTypeHint')}</small></label>
        <label className="field checkbox-field"><input type="checkbox" checked={highIntensity} onChange={event => setHighIntensity(event.target.checked)}/><span>{t('taskGroupDialog.highIntensityLabel')}</span></label>
        <label className="field checkbox-field"><input type="checkbox" checked={countInStats} onChange={event => setCountInStats(event.target.checked)}/><span>{t('taskGroupDialog.countInStatsLabel')}</span></label>
      </div></details>}
      {weeklyFrequency && <label className="field span-2 checkbox-field"><input type="checkbox" checked={countInStats} onChange={event => setCountInStats(event.target.checked)}/><span>{t('taskGroupDialog.countInStatsLabel')}</span></label>}

      {becomesMultiItem && <fieldset className="field span-2 numbering-choice"><legend>{t('taskGroupDialog.becomesMultiItemLegend')}</legend>
        <label><input type="radio" name="group-edit-numbering" checked={numberingChoice === 'preserve'} onChange={() => setNumberingChoice('preserve')}/><span><strong>{t('taskGroupDialog.numberingPreserveStrong')}</strong><small>{t('taskGroupDialog.numberingPreserveSmallGroup')}</small></span></label>
        <label><input type="radio" name="group-edit-numbering" checked={numberingChoice === 'number-all'} onChange={() => setNumberingChoice('number-all')}/><span><strong>{t('taskGroupDialog.numberingAllStrong')}</strong><small>{t('taskGroupDialog.numberingAllSmallGroup')}</small></span></label>
      </fieldset>}
      {!initial && state.goals.length > 0 && <fieldset className="field span-2 goal-link-field"><legend>{t('taskGroupDialog.goalLinkLegend')}</legend><small>{t('taskGroupDialog.goalLinkHint')}</small>{state.goals.filter(goal => goal.status !== 'archived').map(goal => <label key={goal.id}><input type="checkbox" checked={goalIds.includes(goal.id)} onChange={event => setGoalIds(current => event.target.checked ? [...new Set([...current, goal.id])] : current.filter(id => id !== goal.id))}/><span>{goal.title} · {t('taskGroupDialog.goalLatest', { date: goal.latestDate })}</span></label>)}</fieldset>}
      <label className="field span-2"><span>{t('taskGroupDialog.notesLabel')}</span><textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)}/></label>
      {!initial && !weeklyFrequency && <div className="form-note span-2">{defaultDate ? t('taskGroupDialog.scheduleNotePrefix', { date: defaultDate }) : ''}{t('taskGroupDialog.scheduleNoteSuffix')}</div>}
      {!initial && weeklyFrequency && <div className="form-note span-2">{t('taskGroupDialog.weeklyNote')}</div>}
    </div>
    <div className="modal-actions">
      <button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
      {initial ? <button className="primary-button" onClick={edit}>{t('taskGroupDialog.saveGroup')}</button> : <button className="primary-button" disabled={weeklyOutOfRange} onClick={create}>{t('taskGroupDialog.submitSchedule')}</button>}
    </div>
  </Modal>
}
