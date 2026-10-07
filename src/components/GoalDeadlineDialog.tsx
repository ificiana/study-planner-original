import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Target } from 'lucide-react'
import type { AppState, GoalDraft } from '../types'
import { useApp } from '../AppContext'
import { useT } from '../lib/i18n'
import { Modal } from './Modal'

export function GoalDeadlineDialog({ open, state, onClose, onPrepared, onOpenGoals }: {
  open: boolean
  state: AppState
  onClose: () => void
  onPrepared: (prepared: AppState, event: import('../types').PlanChangeEvent) => void
  onOpenGoals?: () => void
}) {
  const t = useT()
  const { prepareGoalChange } = useApp()
  const goals = useMemo(() => state.goals.filter(goal => goal.status === 'active'), [state.goals])
  const [goalId, setGoalId] = useState('')
  const selected = goals.find(goal => goal.id === goalId) ?? goals[0]
  const [desiredDate, setDesiredDate] = useState('')
  const [latestDate, setLatestDate] = useState('')

  useEffect(() => {
    if (!open) return
    const next = goals[0]
    setGoalId(next?.id ?? '')
    setDesiredDate(next?.desiredDate ?? '')
    setLatestDate(next?.latestDate ?? state.settings.endDate)
  }, [open, goals, state.settings.endDate])

  useEffect(() => {
    if (!selected) return
    setDesiredDate(selected.desiredDate ?? '')
    setLatestDate(selected.latestDate)
  }, [selected?.id])

  const submit = () => {
    if (!selected || !latestDate || (desiredDate && desiredDate > latestDate)) return
    const draft: GoalDraft = {
      title: selected.title,
      description: selected.description,
      priority: selected.priority,
      desiredDate: desiredDate || undefined,
      latestDate,
      completionConditions: selected.completionConditions,
      linkedTaskGroupIds: selected.linkedTaskGroupIds,
      linkedAssignmentIds: selected.linkedAssignmentIds,
    }
    const prepared = prepareGoalChange(draft, selected.id)
    onClose()
    onPrepared(prepared.state, prepared.event)
  }

  return <Modal open={open} title={t('goalDeadlineDialog.title')} onClose={onClose} wide mobileFullscreen>
    <div className="direct-operation-dialog">
      <section className="direct-operation-intro"><div className="direct-operation-icon"><Target size={20} /></div><div><strong>{t('goalDeadlineDialog.introTitle')}</strong><p>{t('goalDeadlineDialog.introBody')}</p></div></section>
      {goals.length ? <>
        <div className="direct-operation-form">
          <label className="field span-2"><span>{t('goalDeadlineDialog.selectGoal')}</span><select value={selected?.id ?? ''} onChange={event => setGoalId(event.target.value)}>{goals.map(goal => <option key={goal.id} value={goal.id}>{t('goalDeadlineDialog.goalOptionLatest', { title: goal.title, date: goal.latestDate })}</option>)}</select></label>
          <label className="field"><span>{t('goalDeadlineDialog.desiredDate')}</span><input type="date" min={state.settings.startDate} max={latestDate || state.settings.endDate} value={desiredDate} onChange={event => setDesiredDate(event.target.value)} /></label>
          <label className="field"><span>{t('goalDeadlineDialog.latestDate')}</span><input type="date" min={desiredDate || state.settings.startDate} max={state.settings.endDate} value={latestDate} onChange={event => setLatestDate(event.target.value)} /></label>
        </div>
        <div className="direct-operation-note"><CalendarClock size={17} /><span>{t('goalDeadlineDialog.note')}</span></div>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" disabled={!selected || !latestDate || Boolean(desiredDate && desiredDate > latestDate)} onClick={submit}>{t('goalDeadlineDialog.analyze')}</button></div>
      </> : <div className="direct-operation-empty"><Target size={26} /><strong>{t('goalDeadlineDialog.emptyTitle')}</strong><span>{t('goalDeadlineDialog.emptyBody')}</span>{onOpenGoals && <button className="primary-button" onClick={() => { onClose(); onOpenGoals() }}>{t('goalDeadlineDialog.openGoals')}</button>}</div>}
    </div>
  </Modal>
}
