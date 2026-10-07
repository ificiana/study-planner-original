import { useEffect, useMemo, useState } from 'react'
import type { AppState, Assignment, TaskGroup } from '../types'
import { Modal } from './Modal'
import { minutesText } from '../lib/date'
import { useT } from '../lib/i18n'

export function AssignmentGroupChangeDialog({ open, state, assignment, targetGroup, onClose, onSubmit }: {
  open: boolean
  state: AppState
  assignment?: Assignment
  targetGroup?: TaskGroup
  onClose: () => void
  onSubmit: (options: { adoptDefaultDuration: boolean; numberingChoice: 'preserve' | 'number-all' }) => void
}) {
  const t = useT()
  const canAdopt = Boolean(assignment && assignment.status === 'todo' && assignment.progress === 0 && assignment.actualMinutes === 0 && (assignment.timeEntries?.length ?? 0) === 0 && state.timer.assignmentId !== assignment.id)
  const targetItems = useMemo(() => targetGroup ? state.assignments.filter(item => item.groupId === targetGroup.id && item.id !== assignment?.id) : [], [state.assignments, targetGroup?.id, assignment?.id])
  const becomesMultiItem = targetItems.length === 1
  const [adoptDefaultDuration, setAdoptDefaultDuration] = useState(false)
  const [numberingChoice, setNumberingChoice] = useState<'preserve' | 'number-all'>('preserve')
  useEffect(() => {
    if (!open) return
    setAdoptDefaultDuration(false)
    setNumberingChoice('preserve')
  }, [open, assignment?.id, targetGroup?.id])

  return <Modal open={open} title={t('groupChangeDialog.title')} onClose={onClose} wide mobileFullscreen>
    {assignment && targetGroup && <div className="group-change-dialog">
      <section className="group-change-summary">
        <span>{t('groupChangeDialog.taskLabel')}</span><strong>{assignment.title}</strong>
        <div className="before-after"><span><small>{t('groupChangeDialog.currentGroupLabel')}</small>{state.taskGroups.find(item => item.id === assignment.groupId)?.title ?? assignment.groupId}</span><span><small>{t('groupChangeDialog.targetGroupLabel')}</small>{targetGroup.title}</span></div>
      </section>
      <section className="inheritance-preview">
        <strong>{t('groupChangeDialog.inheritanceStrong')}</strong>
        <span>{t('groupChangeDialog.subjectLabel', { subject: targetGroup.subject })}</span><span>{t('groupChangeDialog.priorityLabel', { priority: targetGroup.priority })}</span>
        <span>{t('groupChangeDialog.dailyMaxLabel', { value: targetGroup.dailyMax ?? t('groupChangeDialog.dailyMaxDefault') })}</span><span>{targetGroup.highIntensity ? t('groupChangeDialog.highIntensity') : t('groupChangeDialog.normalIntensity')}</span>
        <small>{t('groupChangeDialog.inheritanceNote')}</small>
      </section>
      <fieldset className="field group-change-options"><legend>{t('groupChangeDialog.durationLegend')}</legend>
        <label><input type="radio" name="group-duration" checked={!adoptDefaultDuration} onChange={() => setAdoptDefaultDuration(false)}/><span><strong>{t('groupChangeDialog.keepCurrentStrong', { minutes: minutesText(assignment.estimatedMinutes) })}</strong><small>{t('groupChangeDialog.keepCurrentSmall')}</small></span></label>
        <label className={!canAdopt ? 'disabled' : ''}><input type="radio" name="group-duration" disabled={!canAdopt} checked={adoptDefaultDuration} onChange={() => setAdoptDefaultDuration(true)}/><span><strong>{t('groupChangeDialog.adoptDefaultStrong', { minutes: minutesText(targetGroup.unitMinutes) })}</strong><small>{canAdopt ? t('groupChangeDialog.adoptDefaultSmallCan') : t('groupChangeDialog.adoptDefaultSmallCannot')}</small></span></label>
      </fieldset>
      {becomesMultiItem && <fieldset className="field numbering-choice"><legend>{t('groupChangeDialog.multiItemLegend')}</legend>
        <label><input type="radio" name="group-numbering" checked={numberingChoice === 'preserve'} onChange={() => setNumberingChoice('preserve')}/><span><strong>{t('groupChangeDialog.numberingPreserveStrong')}</strong><small>{t('groupChangeDialog.numberingPreserveSmall')}</small></span></label>
        <label><input type="radio" name="group-numbering" checked={numberingChoice === 'number-all'} onChange={() => setNumberingChoice('number-all')}/><span><strong>{t('groupChangeDialog.numberingAllStrong')}</strong><small>{t('groupChangeDialog.numberingAllSmall')}</small></span></label>
      </fieldset>}
      <div className="form-note">{t('groupChangeDialog.footNote')}</div>
    </div>}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" disabled={!assignment || !targetGroup} onClick={() => onSubmit({ adoptDefaultDuration: canAdopt && adoptDefaultDuration, numberingChoice })}>{t('groupChangeDialog.submit')}</button></div>
  </Modal>
}
