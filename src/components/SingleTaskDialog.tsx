import { useEffect, useMemo, useState } from 'react'
import type { AppState, NewTaskDraft, Priority, SchedulingIntent, Subject } from '../types'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'
import type { TaskCreationMode } from './AddTaskDialog'
import { useT } from '../lib/i18n'

const presetSubjects: Subject[] = ['语文', '数学', '英语', '物理', '化学', '生物', '其他']

export function SingleTaskDialog({ open, state, defaultDate, defaultIntent, initial, creationMode = 'schedule', onClose, onSubmit }: {
  open: boolean
  state: AppState
  defaultDate?: string
  defaultIntent?: SchedulingIntent
  initial?: NewTaskDraft
  creationMode?: TaskCreationMode
  onClose: () => void
  onSubmit: (draft: NewTaskDraft, schedule: boolean) => void
}) {
  const t = useT()
  const priorities: Array<{ value: Priority; label: string }> = [
    { value: 5, label: t('priority.core') },
    { value: 3, label: t('priority.high') },
    { value: 2, label: t('priority.medium') },
    { value: 1, label: t('priority.low') },
    { value: 0, label: t('priority.optional') },
  ]
  const subjects = useMemo(() => Array.from(new Set([...presetSubjects, ...state.settings.customSubjects, ...state.taskGroups.map(group => group.subject)])), [state.settings.customSubjects, state.taskGroups])
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState<Subject>('其他')
  const [customSubject, setCustomSubject] = useState('')
  const [priority, setPriority] = useState<Priority>(3)
  const [minutes, setMinutes] = useState(30)
  const [intent, setIntent] = useState<SchedulingIntent>(defaultIntent ?? (defaultDate ? 'prefer-date' : 'system'))
  const [date, setDate] = useState(defaultDate ?? '')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle(initial?.title ?? '')
    setSubject(initial?.subject ?? '其他')
    setCustomSubject('')
    setPriority(initial?.priority ?? 3)
    setMinutes(initial?.estimatedMinutes ?? 30)
    setIntent(creationMode === 'schedule' ? (initial?.schedulingIntent ?? defaultIntent ?? (defaultDate ? 'prefer-date' : 'system')) : 'system')
    setDate(initial?.date ?? defaultDate ?? '')
    setNotes(initial?.notes ?? '')
  }, [open, initial, defaultDate, defaultIntent, creationMode])

  const chosenSubject = customSubject.trim() || subject
  const schedule = creationMode === 'schedule'
  const submit = () => {
    if (!title.trim() || (schedule && intent !== 'system' && !date)) return
    onSubmit({
      title: title.trim(),
      standalone: true,
      subject: chosenSubject,
      priority,
      estimatedMinutes: minutes,
      schedulingIntent: schedule ? intent : 'system',
      date: schedule && intent !== 'system' ? date : undefined,
      locked: schedule && intent === 'lock-date',
      notes: notes.trim() || undefined,
    }, schedule)
  }

  const modalTitle = initial
    ? t('singleTaskDialog.titleEdit')
    : schedule
      ? t('singleTaskDialog.titleAddSchedule')
      : t('singleTaskDialog.titleAddIntake')

  return <Modal open={open} title={modalTitle} onClose={onClose} wide mobileFullscreen>
    <div className="form-grid">
      <label className="field span-2"><span>{t('singleTaskDialog.taskTitleLabel')}</span><input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder={t('singleTaskDialog.taskTitlePlaceholder')} /></label>
      <label className="field"><span>{t('singleTaskDialog.subjectLabel')}</span><select value={subject} onChange={event => { setSubject(event.target.value); setCustomSubject('') }}>{subjects.map(item => <option key={item}>{item}</option>)}</select></label>
      <label className="field"><span>{t('singleTaskDialog.customSubjectLabel')}</span><input value={customSubject} onChange={event => setCustomSubject(event.target.value)} placeholder={t('singleTaskDialog.customSubjectPlaceholder')} /></label>
      <label className="field"><span>{t('singleTaskDialog.priorityLabel')}</span><select value={priority} onChange={event => setPriority(Number(event.target.value) as Priority)}>{priorities.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="field"><span>{t('singleTaskDialog.minutesLabel')}</span><NumericInput min={1} max={1440} value={minutes} onValueChange={setMinutes} /></label>
      {schedule && <>
        <label className="field"><span>{t('singleTaskDialog.intentLabel')}</span><select value={intent} onChange={event => setIntent(event.target.value as SchedulingIntent)}>
          <option value="system">{t('singleTaskDialog.intentSystem')}</option>
          <option value="prefer-date">{t('singleTaskDialog.intentPreferDate')}</option>
          <option value="lock-date">{t('singleTaskDialog.intentLockDate')}</option>
        </select></label>
        {intent !== 'system' && <label className="field"><span>{t('singleTaskDialog.dateLabel')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={date} onChange={event => setDate(event.target.value)} /></label>}
      </>}
      <label className="field span-2"><span>{t('singleTaskDialog.notesLabel')}</span><textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} /></label>
      <div className="form-note span-2">{schedule
        ? t('singleTaskDialog.noteSchedule')
        : t('singleTaskDialog.noteIntake')}</div>
    </div>
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" disabled={!title.trim() || (schedule && intent !== 'system' && !date)} onClick={submit}>{schedule ? t('singleTaskDialog.submitSchedule') : initial ? t('singleTaskDialog.submitEditSave') : t('singleTaskDialog.submitSaveIntake')}</button></div>
  </Modal>
}
