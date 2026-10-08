import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, Check, ChevronRight, ClipboardPaste, Copy, Download, FileSpreadsheet, FolderPlus, Inbox, Pencil, Plus,
  Save, Trash2, Upload, X,
} from 'lucide-react'
import type { AppState, IntakeBatch, IntakeTaskGroupDraft, NewTaskDraft, PlanChangeEvent, Priority, TaskGroupDraft } from '../types'
import { useApp } from '../AppContext'
import { useT } from '../lib/i18n'
import { dateRange, getCapacity, todayISO } from '../lib/date'
import {
  buildIntakeCsvTemplate, intakeDraftIssues, intakeDraftSignature, getIntakeImportFields, intakeSummary, parsePastedText,
  readIntakeFile, rebuildImportResult, remapIntakeTable, splitSessionCount, validateImportedDraft,
  type IntakeImportField, type IntakeImportResult, type IntakeImportReviewRow,
} from '../lib/intake'
import { downloadTextFile } from '../lib/exports'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'
import { SingleTaskDialog } from './SingleTaskDialog'
import type { TaskCreationKind } from './AddTaskDialog'
import { TUTORIAL_NEW_GOAL_ID, type TutorialStep } from '../lib/tutorial'

function usePriorities(): Array<{ value: Priority; label: string }> {
  const t = useT()
  return [
    { value: 5, label: t('priority.core') }, { value: 3, label: t('priority.high') }, { value: 2, label: t('priority.medium') }, { value: 1, label: t('priority.low') }, { value: 0, label: t('priority.optional') },
  ]
}

function useMinutesText() {
  const t = useT()
  return (minutes: number) => {
    const rounded = Math.max(0, Math.round(minutes))
    const hours = Math.floor(rounded / 60)
    const rest = rounded % 60
    return hours ? t('intakePage.hoursMinutes', { hours, minutes: rest }) : t('intakePage.minutesOnly', { minutes: rest })
  }
}

function emptyDraft(state: AppState): TaskGroupDraft {
  return {
    title: '', subject: state.settings.customSubjects[0] ?? '其他', priority: 3, unitMinutes: 30,
    activityType: 'normal', highIntensity: false, countInStats: true, quantity: 1, goalIds: [],
    recurring: false, allowSplit: false, prerequisiteGroupIds: [],
  }
}

export function IntakePage({ onPrepared, onNavigate, onAddTask, addRequest, onAddRequestHandled, tutorialMode = false, tutorialStep, tutorialText, onTutorialNaturalOpen, onTutorialParsed, onTutorialImported, onTutorialGoalLinked, onStartTutorial, onTutorialBlocked }: {
  onPrepared: (state: AppState, event: PlanChangeEvent) => void
  onNavigate: (page: 'today' | 'tasks' | 'intake' | 'goals' | 'settings') => void
  onAddTask: (batchId?: string) => void
  addRequest?: { id: string; kind: TaskCreationKind; batchId?: string }
  onAddRequestHandled: () => void
  tutorialMode?: boolean
  tutorialStep?: TutorialStep
  tutorialText?: string
  onTutorialNaturalOpen?: () => void
  onTutorialParsed?: () => void
  onTutorialImported?: () => void
  onTutorialGoalLinked?: () => void
  onStartTutorial?: () => void
  onTutorialBlocked?: (message?: string) => void
}) {
  const t = useT()
  const priorities = usePriorities()
  const minutesText = useMinutesText()
  const {
    state, canUndo, undo, updateSettings, createIntakeBatch, duplicateIntakeBatch, updateIntakeBatch, addIntakeSingleTask, addIntakeTaskGroup, updateIntakeSingleTask, updateIntakeTaskGroup,
    removeIntakeTaskGroup, deleteIntakeBatch, prepareIntakeBatch, resetAll,
  } = useApp()
  const activeBatches = useMemo(() => state.intakeBatches.filter(batch => batch.status !== 'archived'), [state.intakeBatches])
  const [showArchived, setShowArchived] = useState(false)
  const visibleBatches = showArchived ? state.intakeBatches : activeBatches
  const [activeId, setActiveId] = useState<string>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<IntakeTaskGroupDraft>()
  const [singleDialogOpen, setSingleDialogOpen] = useState(false)
  const [editingSingle, setEditingSingle] = useState<IntakeTaskGroupDraft>()
  const [dialogBatchId, setDialogBatchId] = useState<string>()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [importResult, setImportResult] = useState<IntakeImportResult>()
  const [importSource, setImportSource] = useState<'paste' | 'csv' | 'xlsx'>('paste')
  const [importBusy, setImportBusy] = useState(false)
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [deletedBatchName, setDeletedBatchName] = useState<string>()
  const fileRef = useRef<HTMLInputElement>(null)
  const handledAddRequestId = useRef<string>()
  const [showFirstScheduleCue, setShowFirstScheduleCue] = useState(false)
  const tutorialNaturalChoice = tutorialMode && tutorialStep === 'intake-entry'
  const tutorialNaturalEntry = tutorialMode && (tutorialStep === 'intake-source' || tutorialStep === 'intake-parse')
  const tutorialNaturalAllowed = tutorialNaturalChoice || tutorialNaturalEntry
  const tutorialCanSchedule = tutorialMode && tutorialStep === 'intake-schedule'
  const tutorialCanLinkGoal = tutorialMode && tutorialStep === 'goal-link'

  useEffect(() => {
    if (activeId && activeBatches.some(batch => batch.id === activeId)) return
    const resumable = [...activeBatches].reverse().find(batch => batch.status === 'editing' || batch.status === 'pending' || batch.status === 'calculating')
    setActiveId(resumable?.id ?? activeBatches.at(-1)?.id)
  }, [activeBatches, activeId])

  const active = activeBatches.find(batch => batch.id === activeId)

  useEffect(() => {
    if (!tutorialNaturalEntry || !active || !tutorialText) return
    setImportSource('paste')
    setPasteText(tutorialText)
    if (tutorialStep === 'intake-source') setImportResult(undefined)
    setPasteOpen(true)
  }, [tutorialNaturalEntry, tutorialStep, active?.id, tutorialText])
  const pendingItems = active?.taskGroups.filter(item => !item.appliedAt) ?? []
  const tutorialUnlinkedItem = tutorialCanLinkGoal ? pendingItems.find(item => item.kind !== 'single' && !item.goalIds.includes(TUTORIAL_NEW_GOAL_ID)) : undefined
  const summary = intakeSummary(active?.taskGroups ?? [])
  const capacity = dateRange(state.settings.startDate, state.settings.endDate)
    .reduce((sum, date) => sum + getCapacity(state, date) * state.settings.targetUtilization, 0)
  const existingPendingMinutes = state.assignments.filter(item => item.status !== 'done')
    .reduce((sum, item) => sum + Math.max(0, item.remainingMinutes ?? item.estimatedMinutes), 0)
  const capacityGap = capacity - existingPendingMinutes - summary.minutes
  const issueCount = pendingItems.reduce((sum, item) => sum + intakeDraftIssues(item, state).length, 0)
  const duplicateSignatures = useMemo(() => {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const item of pendingItems) {
      const signature = intakeDraftSignature(item)
      if (seen.has(signature)) duplicates.add(signature)
      seen.add(signature)
    }
    return duplicates
  }, [pendingItems])
  const duplicateCount = pendingItems.filter(item => duplicateSignatures.has(intakeDraftSignature(item))).length
  const deadlineCount = pendingItems.filter(item => item.desiredDate || item.latestDate || item.recurring).length
  const linkedGoalCount = pendingItems.filter(item => item.goalIds.length || item.goalTitle || item.desiredDate || item.latestDate).length
  const availabilityConfirmed = state.settings.setupProgress?.availabilityConfirmed ?? Boolean(state.assignments.length)
  const setupStep = state.settings.setupProgress?.currentStep ?? 1
  const setSetupStep = (currentStep: 1 | 2 | 3 | 4) => updateSettings({ setupProgress: { ...(state.settings.setupProgress ?? {}), currentStep } })

  useEffect(() => {
    if (state.assignments.length || !pendingItems.length || issueCount || dialogOpen || singleDialogOpen || pasteOpen) return
    try {
      const key = 'study-planner:seen-first-schedule-cue-v1'
      if (localStorage.getItem(key)) return
      localStorage.setItem(key, '1')
      setShowFirstScheduleCue(true)
    } catch {
      setShowFirstScheduleCue(true)
    }
  }, [state.assignments.length, pendingItems.length, issueCount, dialogOpen, singleDialogOpen, pasteOpen])

  useEffect(() => {
    if (!active?.lastEditedItemId) return
    const frame = window.requestAnimationFrame(() => document.getElementById(`intake-item-${active.lastEditedItemId}`)?.scrollIntoView({ block: 'nearest' }))
    return () => window.cancelAnimationFrame(frame)
  }, [active?.id])

  const createBatch = () => {
    const id = createIntakeBatch()
    setActiveId(id)
    setSelectedIds([])
    return id
  }

  useEffect(() => {
    if (!addRequest || handledAddRequestId.current === addRequest.id) return
    handledAddRequestId.current = addRequest.id
    const requestedBatch = addRequest.batchId && state.intakeBatches.some(batch => batch.id === addRequest.batchId && batch.status !== 'archived')
      ? addRequest.batchId
      : undefined
    const batchId = requestedBatch ?? createIntakeBatch()
    setActiveId(batchId)
    setSelectedIds([])
    setDialogBatchId(batchId)
    if (addRequest.kind === 'single') {
      setEditingSingle(undefined)
      setSingleDialogOpen(true)
    } else {
      setEditingItem(undefined)
      setDialogOpen(true)
    }
    onAddRequestHandled()
  }, [addRequest, createIntakeBatch, onAddRequestHandled, state.intakeBatches])

  const startWithImport = () => {
    createBatch()
    setImportSource('paste')
    setImportResult(undefined)
    setPasteOpen(true)
  }

  const startAddTask = () => {
    const id = createBatch()
    onAddTask(id)
  }

  const persistTaskGroupDraft = useCallback((draft: Partial<TaskGroupDraft>) => {
    const targetBatchId = dialogBatchId ?? active?.id
    if (targetBatchId) updateIntakeBatch(targetBatchId, { formDraft: draft })
  }, [active?.id, dialogBatchId, updateIntakeBatch])

  const schedule = () => {
    if (!active) return
    setShowFirstScheduleCue(false)
    const ids = selectedIds.length ? selectedIds : pendingItems.map(item => item.id)
    const invalid = pendingItems.filter(item => ids.includes(item.id) && intakeDraftIssues(item, state).length)
    if (invalid.length) {
      window.alert(t('intakePage.itemsNeedFixAlert', { count: invalid.length }))
      return
    }
    const prepared = prepareIntakeBatch(active.id, ids)
    prepared.state.settings.setupProgress = { ...(prepared.state.settings.setupProgress ?? {}), currentStep: 4 }
    onPrepared(prepared.state, prepared.event)
  }

  const importDrafts = (result: IntakeImportResult, source: 'paste' | 'csv' | 'xlsx') => {
    if (!active) return
    const existing = new Set(pendingItems.map(intakeDraftSignature))
    let added = 0
    for (const draft of result.drafts) {
      const signature = intakeDraftSignature(draft)
      if (skipDuplicates && existing.has(signature)) continue
      addIntakeTaskGroup(active.id, draft, source)
      existing.add(signature)
      added += 1
    }
    setImportResult(undefined)
    setPasteText('')
    setPasteOpen(false)
    if (!added) window.alert(t('intakePage.noNewContentAlert'))
    else if (tutorialMode && tutorialStep === 'intake-parse') onTutorialImported?.()
  }

  const handleFile = async (file: File) => {
    setImportBusy(true)
    try {
      const result = await readIntakeFile(file)
      setImportSource(file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv')
      setImportResult(result)
      setPasteOpen(true)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('intakePage.cannotReadFile'))
    } finally {
      setImportBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return <div className="intake-page">
    <section className="intake-intro">
      <div>
        <span className="intake-kicker"><Inbox size={16}/>{t('nav.intake')}</span>
        <h2>{state.assignments.length ? t('intakePage.headingHasAssignments', { count: state.assignments.length }) : t('intakePage.headingNoAssignments')}</h2>
        <p>{t('intakePage.introBody')}</p>
      </div>
      <button className={`primary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialUsePresetBatch')) : createBatch()}><FolderPlus size={17}/>{t('intakePage.newBatch')}</button>
    </section>
    {!tutorialMode && !state.assignments.length && <nav className="intake-setup-steps" aria-label={t('intakePage.setupStepsAria')}>
      <button className={`${pendingItems.length ? 'complete ' : ''}${setupStep === 1 ? 'active' : ''}`} onClick={() => setSetupStep(1)}><span>1</span><strong>{t('intakePage.step1Title')}</strong><small>{pendingItems.length ? t('intakePage.itemsEntered', { count: pendingItems.length }) : t('intakePage.inProgress')}</small></button>
      <button className={`${state.goals.length ? 'complete ' : ''}${setupStep === 2 ? 'active' : ''}`} onClick={() => { setSetupStep(2); onNavigate('goals') }}><span>2</span><strong>{t('intakePage.step2Title')}</strong><small>{state.goals.length ? t('intakePage.goalsCount', { count: state.goals.length }) : t('intakePage.canAddLater')}</small></button>
      <button className={`${availabilityConfirmed ? 'complete ' : ''}${setupStep === 3 ? 'active' : ''}`} onClick={() => { setSetupStep(3); onNavigate('settings') }}><span>3</span><strong>{t('intakePage.step3Title')}</strong><small>{availabilityConfirmed ? t('intakePage.confirmedAbout', { minutes: minutesText(Math.round(capacity)) }) : t('intakePage.pleaseConfirmDailyTime')}</small></button>
      <button className={setupStep === 4 ? 'active' : ''} disabled={!pendingItems.length || Boolean(issueCount) || !availabilityConfirmed} onClick={schedule}><span>4</span><strong>{t('intakePage.step4Title')}</strong><small>{issueCount ? t('intakePage.fixItemsFirst', { count: issueCount }) : !availabilityConfirmed ? t('intakePage.confirmAvailabilityFirst') : pendingItems.length ? t('intakePage.readyToPreview') : t('intakePage.waitingForTasks')}</small></button>
    </nav>}

    <div className="intake-layout">
      <aside className="intake-batch-list" aria-label={t('intakePage.batchListAria')}>
        <div className="intake-batch-list-head"><strong>{t('intakePage.intakeBatches')}</strong><button className={`text-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialNoArchiveSwitch')) : setShowArchived(value => !value)}>{showArchived ? t('intakePage.hideArchived') : t('intakePage.archivedCount', { count: state.intakeBatches.length - activeBatches.length })}</button></div>
        {visibleBatches.length ? visibleBatches.map(batch => {
          const batchSummary = intakeSummary(batch.taskGroups)
          const pending = batch.taskGroups.filter(item => !item.appliedAt).length
          const archived = batch.status === 'archived'
          return <button key={batch.id} className={`intake-batch-button ${batch.id === active?.id ? 'active' : ''} ${archived ? 'archived' : ''}`} onClick={() => { if (tutorialMode && batch.id !== active?.id) { onTutorialBlocked?.(t('intakePage.tutorialFixedBatch')); return }; if (archived) updateIntakeBatch(batch.id, { status: 'editing' }); setActiveId(batch.id); setSelectedIds([]) }}>
            <span><strong>{batch.name}</strong><small>{archived ? t('intakePage.archivedClickToRestore') : batch.status === 'calculating' ? t('intakePage.generatingPreview') : pending ? t('intakePage.pendingItemsSuffix', { count: pending }) : batch.taskGroups.length ? t('intakePage.allScheduled') : t('intakePage.notEnteredYet')}</small></span>
            <span className="intake-batch-count">{batchSummary.assignmentCount}</span>
            <ChevronRight size={16}/>
          </button>
        }) : <div className="intake-empty-side"><Inbox size={24}/><p>{t('intakePage.noBatchesYet')}</p></div>}
      </aside>

      <section className="intake-workspace">
        {!active ? <div className="intake-empty-main">
          <Inbox size={34}/><h3>{state.assignments.length ? t('intakePage.newContentSaveHint') : t('intakePage.chooseEasiestWay')}</h3><p>{t('intakePage.workspaceEmptyBody')}</p>
          <div className="intake-empty-options">
            <button className={`primary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialUsePresetBatch')) : startWithImport()}><Upload size={17}/><span><strong>{t('intakePage.importTaskList')}</strong><small>{t('intakePage.importTaskListHint')}</small></span></button>
            <button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialUsePresetBatch')) : startAddTask()}><Plus size={17}/><span><strong>{t('intakePage.addTask')}</strong><small>{t('intakePage.addTaskHint')}</small></span></button>
            {!state.assignments.length && onStartTutorial && <button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialAlreadyInTutorial')) : onStartTutorial()}><FileSpreadsheet size={17}/><span><strong>{t('intakePage.tryFullFlow')}</strong><small>{t('intakePage.tryFullFlowHint')}</small></span></button>}
          </div>
        </div> : <>
          <header className="intake-workspace-head">
            <div className="intake-name-field">
              <label htmlFor="intake-batch-name">{t('intakePage.batchName')}</label>
              <input id="intake-batch-name" value={active.name} readOnly={tutorialMode} onChange={event => updateIntakeBatch(active.id, { name: event.target.value })}/>
              <small>{t('intakePage.lastSavedAt', { time: new Date(active.updatedAt).toLocaleString('zh-CN') })}</small>
            </div>
            <div className="intake-head-actions">
              <button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => { if (tutorialMode) { onTutorialBlocked?.(t('intakePage.tutorialFinishBatchScheduleFirst')); return }; updateIntakeBatch(active.id, { status: 'pending' }); onNavigate(state.assignments.length ? 'today' : 'intake') }}><Save size={16}/>{t('intakePage.saveAndExit')}</button>
              <button className={`icon-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} aria-label={t('intakePage.duplicateBatchAria', { name: active.name })} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialNoDuplicate')) : setActiveId(duplicateIntakeBatch(active.id))}><Copy size={17}/></button>
              <button className={`icon-button danger-icon ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} aria-label={t('intakePage.deleteBatchAria', { name: active.name })} onClick={() => { if (tutorialMode) { onTutorialBlocked?.(t('intakePage.tutorialNoDeleteBatch')); return }; if (!window.confirm(t('intakePage.confirmDeleteBatch'))) return; setDeletedBatchName(active.name); deleteIntakeBatch(active.id) }}><Trash2 size={17}/></button>
            </div>
          </header>

          <div className="intake-summary" aria-label={t('intakePage.summaryAria')}>
            <div><span>{t('intakePage.pendingContent')}</span><strong>{summary.groupCount}</strong></div>
            <div><span>{t('intakePage.expectedGeneratedTasks')}</span><strong>{summary.assignmentCount}</strong></div>
            <div><span>{t('intakePage.newWorkload')}</span><strong>{minutesText(summary.minutes)}</strong></div>
            <div className={capacityGap < 0 ? 'danger' : ''}><span>{t('intakePage.capacityHeadroom')}</span><strong>{capacityGap < 0 ? t('intakePage.capacityShort', { minutes: minutesText(-capacityGap) }) : t('intakePage.capacitySurplus', { minutes: minutesText(capacityGap) })}</strong></div>
          </div>
          <p className="intake-summary-note">{t('intakePage.capacityNote')}</p>
          <div className="intake-health" role="status"><span>{t('intakePage.deadlineSet')} <strong>{deadlineCount}/{pendingItems.length}</strong></span><span>{t('intakePage.goalLinked')} <strong>{linkedGoalCount}/{pendingItems.length}</strong></span><span className={duplicateCount ? 'warning-text' : ''}>{t('intakePage.suspectedDuplicate')} <strong>{duplicateCount}</strong></span><span className={issueCount ? 'danger-text' : ''}>{t('intakePage.fieldIssues')} <strong>{issueCount}</strong></span></div>

          <div className="intake-toolbar">
            <div>
              <button className={`primary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialUsePresetTask')) : onAddTask(active.id)}><Plus size={16}/>{t('intakePage.addTask')}</button>
              <button data-tutorial-target={tutorialNaturalChoice ? 'tutorial-natural-input' : undefined} className={`secondary-button ${tutorialMode && !tutorialNaturalAllowed ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode && !tutorialNaturalAllowed || undefined} onClick={() => { if (tutorialNaturalChoice) { onTutorialNaturalOpen?.(); return }; if (tutorialMode && !tutorialNaturalEntry) { onTutorialBlocked?.(); return }; setImportSource('paste'); setImportResult(undefined); if (tutorialText) setPasteText(tutorialText); setPasteOpen(true) }}><ClipboardPaste size={16}/>{t('intakePage.naturalLanguagePaste')}</button>
              <button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} disabled={!tutorialMode && importBusy} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialNoOtherImport')) : fileRef.current?.click()}><Upload size={16}/>{importBusy ? t('intakePage.reading') : t('intakePage.importFile')}</button>
              <button className={`text-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialNoTemplateDownload')) : downloadTextFile('study-planner-import-template.csv', buildIntakeCsvTemplate(), 'text/csv')}><Download size={15}/>{t('intakePage.downloadFullTemplate')}</button>
              <input ref={fileRef} hidden type="file" accept=".txt,.csv,.tsv,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => event.target.files?.[0] && void handleFile(event.target.files[0])}/>
            </div>
            <div className="intake-readiness">
              {issueCount
                ? <span className="danger-text">{t('intakePage.fieldIssuesCount', { count: issueCount })}</span>
                : showFirstScheduleCue
                  ? <span className="success-text">{t('intakePage.tasksEnteredNextStep')}</span>
                  : <span className="success-text"><Check size={15}/>{t('intakePage.readyToGeneratePreview')}</span>}
              <button className={`primary-button ${tutorialMode && !tutorialCanSchedule ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode && !tutorialCanSchedule || undefined} data-tutorial-target={tutorialCanSchedule ? "schedule-intake" : undefined} data-tutorial-action="schedule-intake" disabled={!pendingItems.length || Boolean(issueCount)} onClick={() => tutorialMode && !tutorialCanSchedule ? onTutorialBlocked?.() : schedule()}>
                {selectedIds.length ? t('intakePage.previewSelected', { count: selectedIds.length }) : t('intakePage.generatePreview')}
              </button>
            </div>
          </div>

          {pendingItems.length ? <div className="intake-table-wrap">
            <table className="intake-table">
              <thead><tr><th><input aria-label={t('intakePage.selectAllPending')} type="checkbox" disabled={tutorialMode} checked={selectedIds.length === pendingItems.length && pendingItems.length > 0} onChange={event => setSelectedIds(event.target.checked ? pendingItems.map(item => item.id) : [])}/></th><th>{t('intakePage.colContent')}</th><th>{t('intakePage.colQuantity')}</th><th>{t('intakePage.colUnitEstimate')}</th><th>{t('intakePage.colRule')}</th><th>{t('intakePage.colStatus')}</th><th><span className="sr-only">{t('intakePage.colActions')}</span></th></tr></thead>
              <tbody>{pendingItems.map(item => {
                const issues = intakeDraftIssues(item, state)
                const duplicate = duplicateSignatures.has(intakeDraftSignature(item))
                const tutorialCanEditGoalLinkItem = tutorialCanLinkGoal && tutorialUnlinkedItem?.id === item.id && item.kind !== 'single'
                return <tr key={item.id} id={`intake-item-${item.id}`} className={issues.length ? 'has-error' : ''}>
                  <td><input aria-label={t('intakePage.selectItemAria', { title: item.title })} type="checkbox" disabled={tutorialMode} checked={selectedIds.includes(item.id)} onChange={event => setSelectedIds(current => event.target.checked ? [...new Set([...current, item.id])] : current.filter(id => id !== item.id))}/></td>
                  <td><strong>{item.title || (item.kind === 'single' ? t('intakePage.unnamedSingleTask') : t('intakePage.unnamedTaskGroup'))}</strong><small><span className="intake-kind-label">{item.kind === 'single' ? t('intakePage.kindSingle') : t('intakePage.kindGroup')}</span>{item.subject}，{priorities.find(option => option.value === item.priority)?.label ?? item.priority}{t('intakePage.priorityLabelSuffix')}{item.latestDate ? t('intakePage.latestSuffix', { date: item.latestDate }) : item.desiredDate ? t('intakePage.desiredSuffix', { date: item.desiredDate }) : ''}</small></td>
                  <td>{item.kind === 'single' ? '1' : item.recurring ? t('intakePage.byRecurrenceDate') : item.quantity}</td>
                  <td>{t('intakePage.minutesShort', { minutes: item.unitMinutes })}</td>
                  <td>{item.kind === 'single' ? t('intakePage.kindSingle') : item.recurring ? t('intakePage.recurringTask') : item.allowSplit ? t('intakePage.splitSuggestion', { minutes: item.splitSessionMinutes ?? 30 }) : item.dailyMax ? t('intakePage.dailyMaxLabel', { count: item.dailyMax }) : t('intakePage.normalGroup')}</td>
                  <td>{issues.length ? <span className="danger-text">{issues.join('；')}</span> : duplicate ? <span className="warning-text">{t('intakePage.suspectedDuplicateShort')}</span> : <span className="success-text">{t('intakePage.saved')}</span>}</td>
                  <td><div className="row-actions"><button data-tutorial-target={tutorialCanEditGoalLinkItem ? 'tutorial-goal-link-edit' : undefined} className={`icon-button ${tutorialMode && !tutorialCanEditGoalLinkItem ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode && !tutorialCanEditGoalLinkItem || undefined} aria-label={t('common.edit') + ' ' + item.title} onClick={() => { if (tutorialMode && !tutorialCanEditGoalLinkItem) { onTutorialBlocked?.(t('intakePage.tutorialFollowHighlightedOrder')); return }; setDialogBatchId(active.id); if (item.kind === 'single') { setEditingSingle(item); setSingleDialogOpen(true) } else { setEditingItem(item); setDialogOpen(true) } }}><Pencil size={16}/></button><button className={`icon-button danger-icon ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} aria-label={t('common.delete') + ' ' + item.title} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialPresetCannotDelete')) : removeIntakeTaskGroup(active.id, item.id)}><X size={16}/></button></div></td>
                </tr>
              })}</tbody>
            </table>
          </div> : <div className="intake-list-empty"><FileSpreadsheet size={28}/><h3>{t('intakePage.batchStillEmpty')}</h3><p>{t('intakePage.batchStillEmptyHint')}</p></div>}

          {active.taskGroups.some(item => item.appliedAt) && <details className="intake-applied"><summary>{t('intakePage.appliedFromBatch', { count: active.taskGroups.filter(item => item.appliedAt).length })}</summary><ul>{active.taskGroups.filter(item => item.appliedAt).map(item => <li key={item.id}>{item.title}</li>)}</ul></details>}

          <div className="intake-next-step">
            <div><strong>{state.assignments.length ? t('intakePage.notYetInFormalPlan') : t('intakePage.canRefineGoalsAndTime')}</strong><p>{state.assignments.length ? t('intakePage.confirmScheduleToAddToPlan') : t('intakePage.setThenGeneratePreview')}</p></div>
            <div>{!state.assignments.length && <><button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialFinishCurrentScheduleFirst')) : onNavigate('goals')}>{t('intakePage.setGoals')}</button><button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialFinishCurrentScheduleFirst')) : onNavigate('settings')}>{t('intakePage.setAvailableTime')}</button></>}<button className={`text-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('intakePage.tutorialNoArchiveCurrentBatch')) : updateIntakeBatch(active.id, { status: 'archived' })}><Archive size={15}/>{t('intakePage.archiveBatch')}</button></div>
          </div>
        </>}
      </section>
    </div>
    {deletedBatchName && <div className="intake-undo-toast" role="status"><span>{t('intakePage.deletedNotice', { name: deletedBatchName })}</span><button className="secondary-button" disabled={!canUndo} onClick={() => { undo(); setDeletedBatchName(undefined) }}>{t('intakePage.undoDelete')}</button><button className="text-button" onClick={() => setDeletedBatchName(undefined)}>{t('common.close')}</button></div>}

    <IntakeTaskDialog
      key={`${active?.id ?? 'none'}-${editingItem?.id ?? 'new'}`}
      open={dialogOpen && (!tutorialMode || tutorialCanLinkGoal)}
      state={state}
      initial={editingItem ?? active?.formDraft as TaskGroupDraft | undefined}
      tutorialGoalId={tutorialCanLinkGoal ? TUTORIAL_NEW_GOAL_ID : undefined}
      onDraftChange={persistTaskGroupDraft}
      onClose={() => { setDialogOpen(false); setEditingItem(undefined); setDialogBatchId(undefined) }}
      onSave={(draft, keepOpen) => {
        const targetBatchId = dialogBatchId ?? active?.id
        if (!targetBatchId) return
        if (tutorialCanLinkGoal && editingItem && !draft.goalIds.includes(TUTORIAL_NEW_GOAL_ID)) {
          onTutorialBlocked?.(t('intakePage.tutorialCheckGoalFirst'))
          return
        }
        const completesTutorialGoalLink = Boolean(tutorialCanLinkGoal && editingItem
          && pendingItems.every(item => item.id === editingItem.id ? draft.goalIds.includes(TUTORIAL_NEW_GOAL_ID) : item.goalIds.includes(TUTORIAL_NEW_GOAL_ID)))
        if (editingItem) updateIntakeTaskGroup(targetBatchId, editingItem.id, draft)
        else addIntakeTaskGroup(targetBatchId, draft)
        updateIntakeBatch(targetBatchId, { formDraft: undefined })
        if (!keepOpen || editingItem) { setDialogOpen(false); setEditingItem(undefined); setDialogBatchId(undefined) }
        if (completesTutorialGoalLink) onTutorialGoalLinked?.()
      }}
    />

    <SingleTaskDialog
      key={`${dialogBatchId ?? active?.id ?? 'none'}-${editingSingle?.id ?? 'new-single'}`}
      open={!tutorialMode && singleDialogOpen}
      state={state}
      creationMode="intake"
      initial={editingSingle ? {
        title: editingSingle.title,
        standalone: true,
        subject: editingSingle.subject,
        priority: editingSingle.priority,
        estimatedMinutes: editingSingle.unitMinutes,
        schedulingIntent: 'system',
        locked: false,
        notes: editingSingle.notes,
      } : undefined}
      onClose={() => { setSingleDialogOpen(false); setEditingSingle(undefined); setDialogBatchId(undefined) }}
      onSubmit={(draft: NewTaskDraft) => {
        const targetBatchId = dialogBatchId ?? active?.id
        if (!targetBatchId) return
        if (editingSingle) updateIntakeSingleTask(targetBatchId, editingSingle.id, draft)
        else addIntakeSingleTask(targetBatchId, draft)
        setSingleDialogOpen(false)
        setEditingSingle(undefined)
        setDialogBatchId(undefined)
      }}
    />

    <Modal open={pasteOpen} title={importResult ? t('intakePage.confirmImportResult') : t('intakePage.naturalLanguageOrPasteTitle')} onClose={() => { setPasteOpen(false); setImportResult(undefined) }} wide mobileFullscreen>
      {!importResult ? <div className="intake-paste-form">
        <label className="field"><span>{t('intakePage.oneTaskPerLine')}</span><textarea data-tutorial-target={tutorialNaturalEntry ? 'tutorial-natural-text' : undefined} autoFocus rows={12} value={pasteText} readOnly={tutorialNaturalEntry} onChange={event => setPasteText(event.target.value)} placeholder={t('intakePage.pastePlaceholder')}/><small>{t('intakePage.parseOnlyHint')}</small></label>
      </div> : <fieldset className="tutorial-import-preview-fieldset" disabled={tutorialNaturalEntry}><ImportPreview result={importResult} onChange={setImportResult}/></fieldset>}
      <div className="modal-actions intake-import-actions">
        <label className="checkbox-field"><input type="checkbox" disabled={tutorialNaturalEntry} checked={skipDuplicates} onChange={event => setSkipDuplicates(event.target.checked)}/><span>{t('intakePage.skipDuplicateGroups')}</span></label>
        <button className="secondary-button" onClick={() => { setPasteOpen(false); setImportResult(undefined) }}>{t('common.cancel')}</button>
        {importResult && importSource === 'paste' && <button className="secondary-button" onClick={() => setImportResult(undefined)}>{t('intakePage.backToEditOriginal')}</button>}
        {!importResult ? <button className="primary-button" data-tutorial-target={tutorialStep === 'intake-source' ? 'tutorial-parse' : undefined} disabled={!pasteText.trim()} onClick={() => { setImportResult(parsePastedText(pasteText)); if (tutorialStep === 'intake-source') onTutorialParsed?.() }}>{t('intakePage.parseAndPreview')}</button>
          : <button className="primary-button" data-tutorial-target={tutorialStep === 'intake-parse' ? 'tutorial-import-confirm' : undefined} disabled={!importResult.drafts.length || !active} onClick={() => importDrafts(importResult, importSource)}>{tutorialMode && tutorialStep === 'intake-parse' ? t('intakePage.confirmImport') : t('intakePage.addToCurrentBatch')}</button>}
      </div>
    </Modal>
  </div>
}

function ImportPreview({ result, onChange }: { result: IntakeImportResult; onChange: (result: IntakeImportResult) => void }) {
  const t = useT()
  const minutesText = useMinutesText()
  const [bulkSubject, setBulkSubject] = useState('')
  const [bulkMinutes, setBulkMinutes] = useState<number>()
  const [bulkLatestDate, setBulkLatestDate] = useState('')
  const [bulkGoalTitle, setBulkGoalTitle] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 100
  const reviewRows = result.reviewRows ?? result.drafts.map((draft, index) => ({ sourceRow: index + 1, draft, issues: validateImportedDraft(draft, index + 1) }))
  const generatedTaskCount = result.drafts.reduce((sum, draft) => sum + (draft.recurring ? 0 : splitSessionCount(draft)), 0)
  const generatedMinutes = result.drafts.reduce((sum, draft) => sum + (draft.recurring ? draft.unitMinutes : draft.quantity * draft.unitMinutes), 0)
  const updateRows = (rows: IntakeImportReviewRow[]) => { setPage(0); onChange(rebuildImportResult(result, rows)) }
  const updateDraft = (index: number, patch: Partial<TaskGroupDraft>) => updateRows(reviewRows.map((row, rowIndex) => {
    if (rowIndex !== index) return row
    const draft = { ...row.draft, ...patch }
    return { ...row, draft, issues: validateImportedDraft(draft, row.sourceRow) }
  }))
  const applyBulk = () => updateRows(reviewRows.map(row => {
    const draft = {
      ...row.draft,
      subject: bulkSubject.trim() || row.draft.subject,
      unitMinutes: bulkMinutes && bulkMinutes > 0 ? bulkMinutes : row.draft.unitMinutes,
      latestDate: bulkLatestDate || row.draft.latestDate,
      goalTitle: bulkGoalTitle.trim() || row.draft.goalTitle,
    }
    return { ...row, draft, issues: validateImportedDraft(draft, row.sourceRow) }
  }))
  const mergeSimilar = () => {
    const merged = new Map<string, TaskGroupDraft>()
    reviewRows.forEach((row, index) => {
      const draft = row.draft
      const key = draft.recurring
        ? `recurring-${index}`
        : [draft.title.trim().toLowerCase(), draft.subject.trim().toLowerCase(), draft.unitMinutes, draft.priority, draft.latestDate ?? '', draft.desiredDate ?? ''].join('|')
      const existing = merged.get(key)
      if (existing) existing.quantity += draft.quantity
      else merged.set(key, structuredClone(draft))
    })
    const rows = Array.from(merged.values()).map((draft, index) => ({ sourceRow: index + 1, draft, issues: validateImportedDraft(draft, index + 1) }))
    updateRows(rows)
  }
  return <div className="intake-import-preview">
    <div className="intake-import-summary"><strong>{t('intakePage.importSummary', { total: reviewRows.length, valid: result.drafts.length, tasks: generatedTaskCount || t('intakePage.byRecurrenceDate'), minutes: minutesText(generatedMinutes) })}</strong><span>{result.issues.length ? t('intakePage.issuesFoundInRedRows', { count: result.issues.length }) : t('intakePage.fieldCheckPassed')}</span></div>
    {result.table && <details className="intake-mapping" open={result.table.mapping.every(item => item === 'ignore')}><summary>{t('intakePage.checkHeaderMapping')}</summary><p>{t('intakePage.headerMappingHint')}</p><div className="intake-mapping-grid">{result.table.headers.map((header, index) => <label key={`${header}-${index}`}><span>{header}</span><select value={result.table?.mapping[index] ?? 'ignore'} onChange={event => result.table && onChange(remapIntakeTable(result.table, result.table.mapping.map((field, fieldIndex) => fieldIndex === index ? event.target.value as IntakeImportField | 'ignore' : field)))}>{getIntakeImportFields().map(field => <option key={field.value} value={field.value}>{field.label}</option>)}</select></label>)}</div></details>}
    <div className="intake-import-bulk"><label><span>{t('intakePage.bulkSubject')}</span><input value={bulkSubject} onChange={event => setBulkSubject(event.target.value)} placeholder={t('intakePage.leaveBlankNoChange')}/></label><label><span>{t('intakePage.bulkMinutes')}</span><NumericInput min={1} max={1440} value={bulkMinutes} onValueChange={setBulkMinutes} onEmpty={() => setBulkMinutes(undefined)}/></label><label><span>{t('intakePage.bulkLatestDate')}</span><input type="date" value={bulkLatestDate} onChange={event => setBulkLatestDate(event.target.value)}/></label><label><span>{t('intakePage.bulkGoalTitle')}</span><input value={bulkGoalTitle} onChange={event => setBulkGoalTitle(event.target.value)} placeholder={t('intakePage.leaveBlankNoChange')}/></label><button className="secondary-button" onClick={applyBulk}>{t('intakePage.applyToAllRows')}</button><button className="text-button" onClick={mergeSimilar}>{t('intakePage.mergeSimilarRows')}</button></div>
    <p className="intake-preview-tip">{t('intakePage.previewTip')}</p>
    <div className="intake-preview-table-wrap"><table className="intake-table"><thead><tr><th>{t('intakePage.colSourceRow')}</th><th>{t('intakePage.colGroupName')}</th><th>{t('intakePage.colSubject')}</th><th>{t('intakePage.colQuantity')}</th><th>{t('intakePage.colUnitEstimate')}</th><th>{t('intakePage.colGoalDeadline')}</th><th>{t('intakePage.colScheduleDate')}</th><th>{t('intakePage.colStatus')}</th><th><span className="sr-only">{t('intakePage.colRemove')}</span></th></tr></thead><tbody>{reviewRows.slice(page * pageSize, (page + 1) * pageSize).map((row, offset) => { const index = page * pageSize + offset; const draft = row.draft; return <tr className={row.issues.length ? 'has-error' : ''} key={`${row.sourceRow}-${index}`}><td>{row.sourceRow}</td><td><input aria-label={t('intakePage.rowGroupAria', { row: row.sourceRow })} value={draft.title} onChange={event => updateDraft(index, { title: event.target.value })}/></td><td><input aria-label={t('intakePage.rowSubjectAria', { row: row.sourceRow })} value={draft.subject} onChange={event => updateDraft(index, { subject: event.target.value })}/></td><td>{draft.recurring ? t('intakePage.recurring') : <NumericInput aria-label={t('intakePage.rowQuantityAria', { row: row.sourceRow })} min={1} max={10000} value={draft.quantity} onValueChange={quantity => updateDraft(index, { quantity })}/>}</td><td><NumericInput aria-label={t('intakePage.rowMinutesAria', { row: row.sourceRow })} min={1} max={1440} value={draft.unitMinutes} onValueChange={unitMinutes => updateDraft(index, { unitMinutes })}/></td><td><input aria-label={t('intakePage.rowLatestDateAria', { row: row.sourceRow })} type="date" value={draft.latestDate ?? ''} onChange={event => updateDraft(index, { latestDate: event.target.value || undefined })}/></td><td><select aria-label={t('intakePage.rowScheduleTypeAria', { row: row.sourceRow })} value={draft.fixedDate ? 'fixed' : draft.preferredDate ? 'preferred' : 'system'} onChange={event => updateDraft(index, event.target.value === 'fixed' ? { fixedDate: draft.fixedDate ?? todayISO(), preferredDate: undefined } : event.target.value === 'preferred' ? { preferredDate: draft.preferredDate ?? todayISO(), fixedDate: undefined } : { preferredDate: undefined, fixedDate: undefined })}><option value="system">{t('intakePage.systemScheduled')}</option><option value="preferred">{t('intakePage.preferredDate')}</option><option value="fixed">{t('intakePage.fixedDate')}</option></select>{(draft.preferredDate || draft.fixedDate) && <input aria-label={t('intakePage.rowScheduleDateAria', { row: row.sourceRow })} type="date" value={draft.fixedDate ?? draft.preferredDate ?? ''} onChange={event => updateDraft(index, draft.fixedDate ? { fixedDate: event.target.value || undefined } : { preferredDate: event.target.value || undefined })}/>}</td><td>{row.issues.length ? <span className="danger-text">{row.issues.map(issue => `${issue.field ? `${issue.field}：` : ''}${issue.message}`).join('；')}</span> : <span className="success-text">{t('intakePage.canBeAdded')}{draft.allowSplit ? t('intakePage.willGenerateSegments', { count: splitSessionCount(draft) }) : ''}</span>}</td><td><button className="icon-button danger-icon" aria-label={t('intakePage.removeSourceRowAria', { row: row.sourceRow })} onClick={() => updateRows(reviewRows.filter((_, rowIndex) => rowIndex !== index))}><X size={15}/></button></td></tr>})}</tbody></table></div>
    {reviewRows.length > pageSize && <div className="intake-import-pagination"><span>{t('intakePage.paginationInfo', { from: page * pageSize + 1, to: Math.min((page + 1) * pageSize, reviewRows.length), total: reviewRows.length })}</span><div className="button-wrap"><button className="secondary-button" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>{t('intakePage.previousPage')}</button><button className="secondary-button" disabled={(page + 1) * pageSize >= reviewRows.length} onClick={() => setPage(value => value + 1)}>{t('intakePage.nextPage')}</button></div></div>}
  </div>
}

function IntakeTaskDialog({ open, state, initial, tutorialGoalId, onDraftChange, onClose, onSave }: {
  open: boolean
  state: AppState
  initial?: IntakeTaskGroupDraft | Partial<TaskGroupDraft>
  tutorialGoalId?: string
  onDraftChange?: (draft: Partial<TaskGroupDraft>) => void
  onClose: () => void
  onSave: (draft: TaskGroupDraft, keepOpen: boolean) => void
}) {
  const t = useT()
  const priorities = usePriorities()
  const existingItem = Boolean(initial && 'id' in initial)
  const [form, setForm] = useState<TaskGroupDraft>(() => ({ ...emptyDraft(state), ...(initial ? structuredClone(initial) : {}) }))
  const patch = <K extends keyof TaskGroupDraft>(key: K, value: TaskGroupDraft[K]) => setForm(current => ({ ...current, [key]: value }))
  useEffect(() => {
    if (!open || existingItem || !onDraftChange) return
    const timer = window.setTimeout(() => onDraftChange(form), 300)
    return () => window.clearTimeout(timer)
  }, [existingItem, form, onDraftChange, open])
  useEffect(() => {
    if (!open) return
    setForm({ ...emptyDraft(state), ...(initial ? structuredClone(initial) : {}) })
  }, [open])
  const valid = Boolean(form.title.trim()) && form.quantity > 0 && form.unitMinutes > 0
    && (!form.desiredDate || !form.latestDate || form.desiredDate <= form.latestDate)
    && !(form.preferredDate && form.fixedDate)
    && (!form.recurring || Boolean(form.recurrenceStart && form.recurrenceEnd && form.recurrenceStart <= form.recurrenceEnd))
  const save = (keepOpen: boolean) => {
    if (!valid) return
    onSave({ ...form, title: form.title.trim() }, keepOpen)
    if (keepOpen && !existingItem) {
      setForm({ ...emptyDraft(state), subject: form.subject, priority: form.priority, unitMinutes: form.unitMinutes, activityType: form.activityType, highIntensity: form.highIntensity, countInStats: form.countInStats, recurring: form.recurring, allowSplit: form.allowSplit, splitSessionMinutes: form.splitSessionMinutes, prerequisiteGroupIds: form.prerequisiteGroupIds, goalIds: form.goalIds })
    }
  }

  return <Modal open={open} title={existingItem ? t('intakePage.editIntakeItem') : t('intakePage.addGroupToIntake')} onClose={onClose} wide mobileFullscreen>
    <div className="form-grid">
      <label className="field span-2"><span>{t('intakePage.groupNameLabel')}</span><input autoFocus value={form.title} onChange={event => patch('title', event.target.value)} placeholder={t('intakePage.groupNamePlaceholder')}/></label>
      <label className="field"><span>{t('intakePage.subjectCategoryLabel')}</span><input list="intake-subjects" value={form.subject} onChange={event => patch('subject', event.target.value)}/><datalist id="intake-subjects">{state.settings.customSubjects.map(subject => <option key={subject} value={subject}/>)}</datalist></label>
      <label className="field"><span>{t('intakePage.priorityLabel')}</span><select value={form.priority} onChange={event => patch('priority', Number(event.target.value) as Priority)}>{priorities.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="field"><span>{form.recurring ? t('intakePage.perOccurrenceEstimate') : t('intakePage.perItemEstimate')}</span><NumericInput min={1} max={1440} value={form.unitMinutes} onValueChange={value => patch('unitMinutes', value)}/></label>
      {!form.recurring && <label className="field"><span>{t('intakePage.quantityLabel')}</span><NumericInput min={1} max={10000} value={form.quantity} onValueChange={value => patch('quantity', value)}/></label>}
      {!form.recurring && <><label className="field"><span>{t('intakePage.desiredDateOptional')}</span><input type="date" min={state.settings.startDate} value={form.desiredDate ?? ''} onChange={event => patch('desiredDate', event.target.value || undefined)}/></label><label className="field"><span>{t('intakePage.latestDateOptional')}</span><input type="date" min={form.desiredDate ?? state.settings.startDate} value={form.latestDate ?? ''} onChange={event => patch('latestDate', event.target.value || undefined)}/></label>{(form.desiredDate || form.latestDate) && <label className="field span-2"><span>{t('intakePage.goalTitleOptional')}</span><input value={form.goalTitle ?? ''} onChange={event => patch('goalTitle', event.target.value || undefined)} placeholder={t('intakePage.goalTitleDefaultPlaceholder', { title: form.title || t('intakePage.defaultGroupWord') })}/><small>{t('intakePage.goalTitleHint')}</small></label>}</>}
      {form.desiredDate && form.latestDate && form.desiredDate > form.latestDate && <div className="form-error span-2">{t('intakePage.desiredAfterLatestError')}</div>}

      {!form.recurring && <><label className="field"><span>{t('intakePage.scheduleIntentLabel')}</span><select value={form.fixedDate ? 'fixed' : form.preferredDate ? 'preferred' : 'system'} onChange={event => { const date = form.fixedDate ?? form.preferredDate ?? todayISO(); setForm(current => ({ ...current, fixedDate: event.target.value === 'fixed' ? date : undefined, preferredDate: event.target.value === 'preferred' ? date : undefined })) }}><option value="system">{t('intakePage.systemChooseDate')}</option><option value="preferred">{t('intakePage.tryToScheduleOn')}</option><option value="fixed">{t('intakePage.mustScheduleAndLock')}</option></select></label>{(form.preferredDate || form.fixedDate) && <label className="field"><span>{form.fixedDate ? t('intakePage.fixedScheduleDate') : t('intakePage.preferredScheduleDate')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={form.fixedDate ?? form.preferredDate ?? ''} onChange={event => form.fixedDate ? patch('fixedDate', event.target.value || undefined) : patch('preferredDate', event.target.value || undefined)}/><small>{form.fixedDate ? t('intakePage.fixedDateHint') : t('intakePage.preferredDateHint')}</small></label>}</>}

      <fieldset className="field span-2 intake-rule-choice"><legend>{t('intakePage.executionMethodLegend')}</legend>
        <label><input type="radio" name="intake-rule" checked={!form.recurring} onChange={() => patch('recurring', false)}/><span><strong>{t('intakePage.normalGroupOption')}</strong><small>{t('intakePage.normalGroupHint')}</small></span></label>
        <label><input type="radio" name="intake-rule" checked={Boolean(form.recurring)} onChange={() => patch('recurring', true)}/><span><strong>{t('intakePage.recurringTaskOption')}</strong><small>{t('intakePage.recurringTaskHint')}</small></span></label>
      </fieldset>

      {form.recurring && <>
        <label className="field"><span>{t('intakePage.startDateLabel')}</span><input type="date" value={form.recurrenceStart ?? state.settings.startDate} onChange={event => patch('recurrenceStart', event.target.value)}/></label>
        <label className="field"><span>{t('intakePage.endDateLabel')}</span><input type="date" value={form.recurrenceEnd ?? state.settings.endDate} onChange={event => patch('recurrenceEnd', event.target.value)}/></label>
        <fieldset className="field span-2 weekday-picker"><legend>{t('intakePage.weeklyRecurrenceLegend')}</legend>{[t('intakePage.weekdaySun'), t('intakePage.weekdayMon'), t('intakePage.weekdayTue'), t('intakePage.weekdayWed'), t('intakePage.weekdayThu'), t('intakePage.weekdayFri'), t('intakePage.weekdaySat')].map((label, day) => <label key={day}><input type="checkbox" checked={(form.recurrenceWeekdays ?? []).includes(day)} onChange={event => patch('recurrenceWeekdays', event.target.checked ? [...new Set([...(form.recurrenceWeekdays ?? []), day])].sort() : (form.recurrenceWeekdays ?? []).filter(value => value !== day))}/><span>{label}</span></label>)}</fieldset>
      </>}

      {!form.recurring && <details className="form-advanced span-2"><summary>{t('intakePage.advancedRules')}</summary><div className="form-grid">
        <label className="field"><span>{t('intakePage.dailyMaxQuantity')}</span><NumericInput min={1} max={999} value={form.dailyMax} placeholder={t('intakePage.noLimit')} onValueChange={value => patch('dailyMax', value)} onEmpty={() => patch('dailyMax', undefined)}/></label>
        <label className="field checkbox-field"><input type="checkbox" checked={Boolean(form.highIntensity)} onChange={event => patch('highIntensity', event.target.checked)}/><span>{t('intakePage.highIntensityTask')}</span></label>
        <label className="field checkbox-field"><input type="checkbox" checked={Boolean(form.allowSplit)} onChange={event => patch('allowSplit', event.target.checked)}/><span>{t('intakePage.splitIntoSessionsLabel')}</span></label>
        {form.allowSplit && <label className="field"><span>{t('intakePage.targetSessionLength')}</span><NumericInput min={5} max={Math.max(5, form.unitMinutes - 1)} value={form.splitSessionMinutes ?? Math.min(60, Math.max(5, Math.round(form.unitMinutes / 2)))} onValueChange={value => patch('splitSessionMinutes', value)}/></label>}
        {state.taskGroups.length > 0 && <fieldset className="field span-2 prerequisite-picker"><legend>{t('intakePage.prerequisiteGroupsLegend')}</legend>{state.taskGroups.filter(group => group.status !== 'archived').map(group => <label key={group.id}><input type="checkbox" checked={(form.prerequisiteGroupIds ?? []).includes(group.id)} onChange={event => patch('prerequisiteGroupIds', event.target.checked ? [...new Set([...(form.prerequisiteGroupIds ?? []), group.id])] : (form.prerequisiteGroupIds ?? []).filter(id => id !== group.id))}/><span>{group.subject}，{group.title}</span></label>)}</fieldset>}
      </div></details>}

      {state.goals.length > 0 && <fieldset data-tutorial-target={tutorialGoalId ? 'tutorial-goal-link-field' : undefined} className="field span-2 goal-link-field"><legend>{t('intakePage.joinGoalLegend')}</legend>{state.goals.filter(goal => goal.status !== 'archived').map(goal => <label key={goal.id}><input type="checkbox" checked={form.goalIds.includes(goal.id)} onChange={event => patch('goalIds', event.target.checked ? [...new Set([...form.goalIds, goal.id])] : form.goalIds.filter(id => id !== goal.id))}/><span>{goal.title}，{t('intakePage.latestSuffix', { date: goal.latestDate })}</span></label>)}</fieldset>}
      <label className="field span-2"><span>{t('intakePage.notesLabel')}</span><textarea rows={3} value={form.notes ?? ''} onChange={event => patch('notes', event.target.value || undefined)}/></label>
      <div className="form-note span-2">{t('intakePage.saveOnlyUpdatesBatch')}</div>
    </div>
    <div className="modal-actions">
      <button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
      {!initial && <button className="secondary-button" disabled={!valid} onClick={() => save(true)}>{t('intakePage.saveAndAddMore')}</button>}
      <button className="primary-button" disabled={!valid} onClick={() => save(false)}>{existingItem ? t('intakePage.saveChanges') : t('intakePage.saveAndReturn')}</button>
    </div>
  </Modal>
}
