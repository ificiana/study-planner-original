import { useEffect, useState } from 'react'
import { CalendarClock, ChevronLeft, FolderPlus, Inbox, ListTodo } from 'lucide-react'
import { Modal } from './Modal'
import { useT } from '../lib/i18n'

export type TaskCreationMode = 'intake' | 'schedule'
export type TaskCreationKind = 'single' | 'group'

export function AddTaskDialog({ open, onClose, onSelect }: {
  open: boolean
  onClose: () => void
  onSelect: (mode: TaskCreationMode, kind: TaskCreationKind) => void
}) {
  const t = useT()
  const [step, setStep] = useState<'mode' | 'kind'>('mode')
  const [mode, setMode] = useState<TaskCreationMode>()

  useEffect(() => {
    if (!open) return
    setStep('mode')
    setMode(undefined)
  }, [open])

  const chooseMode = (nextMode: TaskCreationMode) => {
    setMode(nextMode)
    setStep('kind')
  }

  return <Modal open={open} title={step === 'mode' ? t('addTaskDialog.titleMode') : t('addTaskDialog.titleKind')} onClose={onClose} mobileSheet className="add-task-dialog">
    {step === 'mode' ? <>
      <div className="add-task-dialog-intro">
        <strong>{t('addTaskDialog.introModeStrong')}</strong>
        <span>{t('addTaskDialog.introModeSpan')}</span>
      </div>
      <div className="add-task-mode-grid">
        <button type="button" className="add-task-mode-card" onClick={() => chooseMode('intake')}>
          <span className="add-task-mode-icon intake"><Inbox size={21}/></span>
          <strong>{t('addTaskDialog.intakeCardStrong')}</strong>
          <small>{t('addTaskDialog.intakeCardSmall')}</small>
        </button>
        <button type="button" className="add-task-mode-card primary" onClick={() => chooseMode('schedule')}>
          <span className="add-task-mode-icon schedule"><CalendarClock size={21}/></span>
          <strong>{t('addTaskDialog.scheduleCardStrong')}</strong>
          <small>{t('addTaskDialog.scheduleCardSmall')}</small>
        </button>
      </div>
    </> : <>
      <button type="button" className="add-task-back" onClick={() => setStep('mode')}><ChevronLeft size={16}/>{t('common.back')}</button>
      <div className="add-task-selected-mode">
        <span>{mode === 'intake' ? t('addTaskDialog.selectedModeIntake') : t('addTaskDialog.selectedModeSchedule')}</span>
        <strong>{mode === 'intake' ? t('addTaskDialog.selectedModeIntakeStrong') : t('addTaskDialog.selectedModeScheduleStrong')}</strong>
      </div>
      <div className="add-task-dialog-intro">
        <strong>{t('addTaskDialog.introKindStrong')}</strong>
        <span>{t('addTaskDialog.introKindSpan')}</span>
      </div>
      <div className="add-task-kind-grid">
        <button type="button" className="add-task-kind-card" onClick={() => mode && onSelect(mode, 'single')}>
          <span className="add-task-kind-icon"><ListTodo size={20}/></span>
          <strong>{t('addTaskDialog.singleTitle')}</strong>
          <small>{t('addTaskDialog.singleExample')}</small>
        </button>
        <button type="button" className="add-task-kind-card" onClick={() => mode && onSelect(mode, 'group')}>
          <span className="add-task-kind-icon"><FolderPlus size={20}/></span>
          <strong>{t('addTaskDialog.groupTitle')}</strong>
          <small>{t('addTaskDialog.groupExample')}</small>
        </button>
      </div>
    </>}
  </Modal>
}
