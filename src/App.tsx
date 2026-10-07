import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  ArrowUpRight, BarChart3, BookOpen, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Cloud, CloudOff, Github, Target,
  Download, FileDown, Filter, Inbox, LayoutDashboard, ListTodo, Lock, Menu, Plus, RefreshCw,
  RotateCcw, Search, Settings as SettingsIcon, Sparkles, Trash2, Upload, X, Printer
} from 'lucide-react'
import { addMonths, endOfMonth, format, getDay, isWithinInterval, parseISO, startOfMonth } from 'date-fns'
import { useApp } from './AppContext'
import { displayPlanName, useT } from './lib/i18n'
import type { Language } from './lib/i18n'
import type { AppState, Assignment, BufferPreference, DayType, PlanAdjustmentPolicy, PlanChangeEvent, Priority, SchedulingIntent, SchedulingProposal, SequenceRenumberSuggestion, ConstraintException, Subject, TaskGroup } from './types'
import { clampDate, constraintsForDate, dateRange, dayTypeLabel, fmtDate, fmtWeekday, getCapacity, getDayConfig, isDateProtected, minutesText, shiftDate, timestampForDate, todayISO } from './lib/date'
import { actualLearningSnapshot, allDurationSuggestions, analyzePlan, checkAssignmentPlacement, effectiveMinutes, planningDayLoad, predictCompletion, previewPreparedChange } from './lib/planner'
import { allGoalProgress, nearestRelevantGoalDate } from './lib/goals'
import { uid } from './lib/id'
import { addInferredCompletionEntry, appendStatusEvent } from './lib/execution'
import { cloneActiveState, hydratePortableState } from './lib/state'
import { buildBlankState, buildGuestDemoState, normalizeState } from './lib/seed'
import { deleteRecoverySnapshot, listRecoverySnapshots, loadLocalState, preserveRecoverySnapshot, type DataRecoverySnapshot } from './lib/db'
import {
  TUTORIAL_EXECUTE_ASSIGNMENT_ID, TUTORIAL_PARTIAL_ASSIGNMENT_ID, TUTORIAL_NAMESPACE, advanceTutorialSession, buildTutorialCheckpoint, buildTutorialState,
  clearTutorialSession, createTutorialSession, ensureTutorialIntakeBatch, isTutorialNamespace, readTutorialSession, recoverTutorialSession,
  tutorialAcceptsEvent, tutorialAllowsPage, tutorialCompleted, tutorialIssueCount, tutorialNaturalLanguageText, tutorialPageForStep, tutorialRecoveryStep, tutorialStateHealth, markTutorialOfferDismissed,
  writeTutorialSession, type TutorialSession, type TutorialStep,
} from './lib/tutorial'
import { Modal } from './components/Modal'
import { Drawer } from './components/Drawer'
import { TaskCard, nativeTaskDragAvailable } from './components/TaskCard'
import { AdjustmentIntentDialog } from './components/AdjustmentIntentDialog'
import { BulkMoveCenterDialog } from './components/BulkMoveCenterDialog'
import { GoalDeadlineDialog } from './components/GoalDeadlineDialog'
import { TaskGroupDialog } from './components/TaskGroupDialog'
import { SingleTaskDialog } from './components/SingleTaskDialog'
import { AddTaskDialog, type TaskCreationKind, type TaskCreationMode } from './components/AddTaskDialog'
import { AssignmentGroupChangeDialog } from './components/AssignmentGroupChangeDialog'
import { ProposalDialog } from './components/ProposalDialog'
import { CalendarConstraintManager } from './components/CalendarConstraintManager'
import { ReviewDialog } from './components/ReviewDialog'
import { HistoryDiffDialog } from './components/HistoryDiffDialog'
import { TutorialCoachmark, type TutorialCoachmarkConfig } from './components/TutorialCoachmark'
import { NumericInput } from './components/NumericInput'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { adjustmentPolicyForEvent, eventWithPreferences } from './lib/adjustment'
import { applyConflictDecisions, mergeConstraintExceptions } from './lib/conflicts'
import { CloudRevisionConflictError, downloadSnapshot, getSession, preparePortableState, signIn, signOut, signUp, supabase, supabaseConfigured, uploadSnapshot } from './lib/supabase'
import { buildCalendarPrintHtml, buildCalendarSvg, downloadSvgAsPng, safeExportName } from './lib/exports'
import { Analytics } from '@vercel/analytics/react'
import { SCHEMA_VERSION } from './types'
import { validateStateInput } from './lib/state-schema'
import { getTimerElapsedSeconds } from './lib/timer'
import { APP_VERSION, GITHUB_REPO_URL } from './lib/constants'
import './styles.css'
import './tutorial.css'

const StatsPage = lazy(() => import('./components/StatsPage').then(module => ({ default: module.StatsPage })))
const GoalsPage = lazy(() => import('./components/GoalsPage').then(module => ({ default: module.GoalsPage })))
const FocusTimerPage = lazy(() => import('./components/FocusTimerPage').then(module => ({ default: module.FocusTimerPage })))
const GuidePage = lazy(() => import('./components/GuidePage').then(module => ({ default: module.GuidePage })))
const IntakePage = lazy(() => import('./components/IntakePage').then(module => ({ default: module.IntakePage })))
const ExportPage = lazy(() => import('./components/ExportPage').then(module => ({ default: module.ExportPage })))
const FeedbackPage = lazy(() => import('./components/FeedbackPage').then(module => ({ default: module.FeedbackPage })))

type Page = 'today' | 'calendar' | 'tasks' | 'intake' | 'goals' | 'stats' | 'export' | 'feedback' | 'guide' | 'settings' | 'timer'
type ShiftScope = 'today' | 'future'
type CloudSyncStatus = 'local' | 'restoring' | 'queued' | 'saving' | 'saved' | 'error'

type CloudSaveQueue = {
  scope?: string
  pending?: AppState
  timer?: number
  inFlight?: Promise<void>
  lastSavedUpdatedAt?: string
  revision?: number
}

const navItemDefs: { id: Page; key: string; icon: typeof LayoutDashboard }[] = [
  { id: 'today', key: 'nav.today', icon: LayoutDashboard },
  { id: 'calendar', key: 'nav.calendar', icon: CalendarDays },
  { id: 'tasks', key: 'nav.tasks', icon: ListTodo },
  { id: 'intake', key: 'nav.intake', icon: Inbox },
  { id: 'goals', key: 'nav.goals', icon: Target },
  { id: 'stats', key: 'nav.stats', icon: BarChart3 },
  { id: 'export', key: 'nav.export', icon: FileDown },
  { id: 'feedback', key: 'nav.feedback', icon: Inbox },
  { id: 'guide', key: 'nav.guide', icon: BookOpen },
  { id: 'settings', key: 'nav.settings', icon: SettingsIcon }
]

function LanguageSwitcher({ language, onChange }: { language: Language; onChange: (language: Language) => void }) {
  return (
    <label className="language-switcher">
      <span className="sr-only">Language / 语言</span>
      <select
        aria-label="Language / 语言"
        value={language}
        onChange={event => onChange(event.target.value as Language)}
      >
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </label>
  )
}

function priorityLabel(priority: Priority, t: ReturnType<typeof useT>) {
  return priority === 5 ? t('priority.core') : priority === 3 ? t('priority.high') : priority === 2 ? t('priority.medium') : priority === 1 ? t('priority.low') : t('priority.optional')
}

function weekdayShortLabels(t: ReturnType<typeof useT>) {
  return [
    t('calendarPage.weekdaySun'), t('calendarPage.weekdayMon'), t('calendarPage.weekdayTue'),
    t('calendarPage.weekdayWed'), t('calendarPage.weekdayThu'), t('calendarPage.weekdayFri'), t('calendarPage.weekdaySat'),
  ]
}

export default function App() {
  const t = useT()
  const navItems = useMemo(() => navItemDefs.map(item => ({ ...item, label: t(item.key) })), [t])
  const {
    state, namespace, ready, loadedFromStorage, updateSettings, prepareSingleAssignment, prepareTaskGroup,
    generateProposals, applySchedulingProposal, applyPreparedWithoutScheduling, replaceState, loadDataSpace, setDataSpace, clearDataSpace, sequenceRenumberSuggestion,
    dismissSequenceRenumberSuggestion, applySequenceRenumber, completeReview, undo, canUndo, updateIntakeBatch, prepareDurationChange
  } = useApp()
  const [page, setPage] = useState<Page>('today')
  const initialRouteHandled = useRef(false)
  const mainAreaRef = useRef<HTMLElement>(null)
  const [singleTaskOpen, setSingleTaskOpen] = useState(false)
  const [singleTaskDate, setSingleTaskDate] = useState<string>()
  const [singleTaskIntent, setSingleTaskIntent] = useState<SchedulingIntent>('system')
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [addTaskOpen, setAddTaskOpen] = useState(false)
  const [addTaskContext, setAddTaskContext] = useState<{ date?: string; intent: SchedulingIntent; intakeBatchId?: string }>({ intent: 'system' })
  const [intakeAddRequest, setIntakeAddRequest] = useState<{ id: string; kind: TaskCreationKind; batchId?: string }>()
  const [reviewDate, setReviewDate] = useState<string>()
  const [proposalSession, setProposalSession] = useState<{ baseline: AppState; prepared: AppState; event: PlanChangeEvent; policy: PlanAdjustmentPolicy; proposals: SchedulingProposal[]; expansionLevel: number; calculationRevision: number; acceptedExceptions?: ConstraintException[]; decisionSummary?: string; moreExhausted?: boolean }>()
  const [proposalGeneration, setProposalGeneration] = useState<{ baseline: AppState; prepared: AppState; event: PlanChangeEvent; policy: PlanAdjustmentPolicy; seedProposals: SchedulingProposal[]; worker?: Worker; error?: string }>()
  const [mobileNav, setMobileNav] = useState(false)
  const [adjustmentOpen, setAdjustmentOpen] = useState(false)
  const [adjustmentDate, setAdjustmentDate] = useState<string>()
  const [adjustmentReason, setAdjustmentReason] = useState<'current-conflicts' | 'too-tiring' | 'future-replan' | 'execution-difference'>('current-conflicts')
  const [deadlineDialogOpen, setDeadlineDialogOpen] = useState(false)
  const [bulkMoveCenterOpen, setBulkMoveCenterOpen] = useState(false)
  const [sessionUser, setSessionUser] = useState<{ id: string; email?: string }>()
  const [authResolved, setAuthResolved] = useState(!supabase)
  const [tutorialSession, setTutorialSession] = useState<TutorialSession | undefined>(() => readTutorialSession())
  const [tutorialBootReady, setTutorialBootReady] = useState(false)
  const [tutorialBlockedNotice, setTutorialBlockedNotice] = useState<string>()
  const [tutorialOfferOpen, setTutorialOfferOpen] = useState(false)
  const tutorialBootstrapRunning = useRef(false)
  const tutorialBootHandled = useRef(false)
  const tutorialTransitionRunning = useRef(false)
  const tutorialSessionRef = useRef(tutorialSession)
  const [cloudReady, setCloudReady] = useState(false)
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus>('local')
  const [firstLoginOpen, setFirstLoginOpen] = useState(false)
  const [cloudMessage, setCloudMessage] = useState('')
  const [actionNotice, setActionNotice] = useState<string>()
  const [dataSwitching, setDataSwitching] = useState(false)
  const tutorialActive = Boolean(tutorialSession && isTutorialNamespace(namespace))
  const tutorialStepValue = tutorialSession?.step
  const effectiveToday = tutorialSession?.anchorDate ?? todayISO()
  const currentIssueCount = useMemo(() => tutorialActive ? tutorialIssueCount(state, effectiveToday) : analyzePlan(state, effectiveToday).filter(issue => issue.level === 'danger').length, [state, effectiveToday, tutorialActive])
  const previousUserId = useRef<string>()
  const guestSnapshotRef = useRef<AppState>()
  const [guestImportAvailable, setGuestImportAvailable] = useState(false)
  const stateRef = useRef(state)
  const namespaceRef = useRef(namespace)
  const cloudSaveQueue = useRef<CloudSaveQueue>({})
  stateRef.current = state
  namespaceRef.current = namespace
  tutorialSessionRef.current = tutorialSession

  const tutorialReturnPage = (value: Page): TutorialSession['returnPage'] => value === 'timer' || value === 'feedback' ? 'today' : value

  const tutorialNotice = (message = t('common.tutorialFinishStep')) => {
    setTutorialBlockedNotice(message)
    window.setTimeout(() => setTutorialBlockedNotice(current => current === message ? undefined : current), 1800)
  }

  const closeTutorialTransients = () => {
    setProposalSession(undefined)
    proposalGeneration?.worker?.terminate()
    setProposalGeneration(undefined)
    setAdjustmentOpen(false)
    setReviewDate(undefined)
    setAddTaskOpen(false)
    setSingleTaskOpen(false)
    setGroupDialogOpen(false)
    setDeadlineDialogOpen(false)
    setBulkMoveCenterOpen(false)
    setMobileNav(false)
  }

  const persistTutorialState = async (next: AppState) => {
    try {
      await setDataSpace(TUTORIAL_NAMESPACE, next, false)
      return true
    } catch (error) {
      console.warn('教程状态暂时无法持久化；当前标签页仍可继续。', error)
      tutorialNotice(t('shell.tutorialContinuesLocalSaveUnavailable'))
      return false
    }
  }

  const updateTutorialSession = (session: TutorialSession) => {
    tutorialSessionRef.current = session
    setTutorialSession(session)
    writeTutorialSession(session)
    return session
  }

  const advanceTutorialOnly = (expected: TutorialStep | TutorialStep[], next: TutorialStep) => {
    const current = tutorialSessionRef.current
    if (!current) return undefined
    const updated = advanceTutorialSession(current, expected, next)
    if (updated === current) return undefined
    tutorialSessionRef.current = updated
    setTutorialSession(updated)
    return updated
  }


  const advanceTutorialStable = (expected: TutorialStep | TutorialStep[], next: TutorialStep) => {
    if (tutorialTransitionRunning.current) return false
    const updated = advanceTutorialOnly(expected, next)
    if (!updated) return false
    closeTutorialTransients()
    setPage(tutorialPageForStep(next) as Page)
    return true
  }

  const enterTutorialIntake = async () => {
    const current = tutorialSessionRef.current
    if (!current || current.step !== 'goal-existing' || tutorialTransitionRunning.current) return
    const updated = advanceTutorialOnly('goal-existing', 'intake-entry')
    if (!updated) return
    tutorialTransitionRunning.current = true
    closeTutorialTransients()
    try {
      const next = ensureTutorialIntakeBatch(stateRef.current, updated.anchorDate)
      await persistTutorialState(next)
      setPage('intake')
    } finally {
      tutorialTransitionRunning.current = false
    }
  }

  const advanceTutorialAfterImport = () => advanceTutorialStable('intake-parse', 'tasks-intake')
  const tutorialIntakeSeen = () => advanceTutorialStable('tasks-intake', 'goal-create')
  const tutorialGoalCreated = () => advanceTutorialStable('goal-create', 'goal-link')
  const tutorialGoalLinked = () => advanceTutorialStable('goal-link', 'intake-schedule')
  const tutorialStatsExpanded = () => advanceTutorialStable('stats', 'stats-detail')

  const tutorialProposalState = (proposal: SchedulingProposal) => hydratePortableState(proposal.stateAfter, {
    replanHistory: stateRef.current.replanHistory,
    conflictBackups: stateRef.current.conflictBackups,
    planVersions: stateRef.current.planVersions,
  })

  const applyTutorialProposal = async (proposal: SchedulingProposal, expected: TutorialStep, next: TutorialStep) => {
    const current = tutorialSessionRef.current
    if (!current || current.step !== expected || tutorialTransitionRunning.current) return false
    const nextState = tutorialProposalState(proposal)
    const candidateSession: TutorialSession = { ...current, step: next, updatedAt: new Date().toISOString() }
    const health = tutorialStateHealth(nextState, candidateSession)
    if (!health.ok) {
      tutorialNotice(t('shell.tutorialCannotAdvance', { reason: health.reason }))
      return false
    }
    let updated = advanceTutorialOnly(expected, next)
    if (!updated) return false
    if (['repair-calendar', 'intake-calendar', 'review-calendar', 'future-calendar'].includes(next)) {
      const highlightDates = Array.from(new Set(proposal.movements.flatMap(move => [move.fromDate, move.toDate].filter(Boolean) as string[]))).sort()
      updated = updateTutorialSession({ ...updated, highlightDates, lastChangeLabel: proposal.title, updatedAt: new Date().toISOString() })
    }
    tutorialTransitionRunning.current = true
    closeTutorialTransients()
    try {
      await persistTutorialState(nextState)
      setPage(tutorialPageForStep(next) as Page)
      return true
    } finally {
      tutorialTransitionRunning.current = false
    }
  }

  const recoverTutorialTo = async (step?: TutorialStep, message?: string) => {
    const current = tutorialSessionRef.current
    if (!current) return
    const safeStep = step ?? tutorialRecoveryStep(current.step)
    const recovered = updateTutorialSession({ ...current, step: safeStep, updatedAt: new Date().toISOString() })
    closeTutorialTransients()
    const health = tutorialStateHealth(stateRef.current, recovered)
    if (!health.ok) await persistTutorialState(buildTutorialCheckpoint(safeStep, recovered.anchorDate))
    setPage(tutorialPageForStep(safeStep) as Page)
    if (message) tutorialNotice(message)
  }

  const startTutorial = async (options?: { auto?: boolean }) => {
    if (tutorialBootstrapRunning.current) return
    tutorialBootstrapRunning.current = true
    setDataSwitching(true)
    closeTutorialTransients()
    setFirstLoginOpen(false)
    try {
      const returnNamespace = namespaceRef.current
      const returnHadData = options?.auto ? false : loadedFromStorage || stateRef.current.assignments.length > 0 || stateRef.current.taskGroups.length > 0 || stateRef.current.intakeBatches.length > 0
      if (returnHadData) await setDataSpace(returnNamespace, stateRef.current, false)
      const session = createTutorialSession(returnNamespace, returnHadData, todayISO(), tutorialReturnPage(page))
      tutorialSessionRef.current = session
      setTutorialSession(session)
      await persistTutorialState(buildTutorialState(session.anchorDate))
      setPage('today')
    } finally {
      setDataSwitching(false)
      tutorialBootstrapRunning.current = false
    }
  }

  const restartTutorial = async () => {
    const current = tutorialSessionRef.current
    if (!current || tutorialBootstrapRunning.current) return
    tutorialBootstrapRunning.current = true
    setDataSwitching(true)
    closeTutorialTransients()
    try {
      const restarted = updateTutorialSession({ ...current, step: 'repair-entry', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      await persistTutorialState(buildTutorialCheckpoint('repair-entry', restarted.anchorDate))
      setPage('today')
    } finally {
      setDataSwitching(false)
      tutorialBootstrapRunning.current = false
    }
  }

  const exitTutorial = async (markCompleted = false) => {
    const current = tutorialSessionRef.current
    if (!current || tutorialBootstrapRunning.current) return
    tutorialBootstrapRunning.current = true
    setDataSwitching(true)
    closeTutorialTransients()
    let switched = false
    try {
      let returnNamespace = current.returnNamespace
      if (sessionUser?.id) returnNamespace = `user:${sessionUser.id}`
      else if (returnNamespace.startsWith('user:')) returnNamespace = 'guest'

      if (returnNamespace.startsWith('user:')) {
        const userId = returnNamespace.slice('user:'.length)
        if (current.returnHadData) {
          try {
            await loadDataSpace(returnNamespace, buildBlankState())
            switched = true
          } catch (error) {
            console.warn('无法恢复教程前的账号计划。', error)
            tutorialNotice(t('shell.tutorialCannotRestorePlan'))
            return
          }
        } else {
          const blank = buildBlankState()
          blank.guestModified = false
          try { await setDataSpace(returnNamespace, blank, false) } catch (error) { console.warn('空白账号计划暂时无法持久化。', error) }
          switched = true
          if (markCompleted && sessionUser?.id === userId) {
            try {
              await uploadSnapshot(blank, userId)
              resetCloudQueue(returnNamespace, blank.updatedAt)
              setCloudReady(true)
              setSyncStatus('saved')
              setCloudMessage(t('shell.tutorialEndedBlankPlanCreated'))
            } catch (error) {
              setCloudReady(false)
              setSyncStatus('error')
              setCloudMessage(error instanceof Error ? t('shell.planSavedLocallyCloudInitFailedWithMessage', { message: error.message }) : t('shell.planSavedLocallyCloudInitFailed'))
            }
          } else {
            setCloudReady(false)
            setSyncStatus('local')
            setFirstLoginOpen(true)
          }
        }
      } else if (current.returnHadData) {
        try {
          await loadDataSpace(returnNamespace, buildGuestDemoState())
          switched = true
        } catch (error) {
          console.warn('无法恢复教程前的游客计划。', error)
          tutorialNotice(t('shell.tutorialCannotRestorePlan'))
          return
        }
      } else {
        const blank = buildBlankState()
        try { await setDataSpace(returnNamespace, blank, false) } catch (error) { console.warn('空白游客计划暂时无法持久化。', error) }
        switched = true
      }

      if (!switched) return
      clearTutorialSession(markCompleted)
      tutorialSessionRef.current = undefined
      setTutorialSession(undefined)
      void clearDataSpace(TUTORIAL_NAMESPACE).catch(() => undefined)
      setPage(current.returnPage as Page)
    } finally {
      setDataSwitching(false)
      tutorialBootstrapRunning.current = false
    }
  }


  const navigate = (target: Page) => {
    const current = tutorialSessionRef.current
    if (current && !tutorialAllowsPage(current.step, target)) {
      tutorialNotice()
      setMobileNav(false)
      return
    }
    setPage(target)
    setMobileNav(false)
  }

  useEffect(() => {
    if (!ready || !authResolved || tutorialBootHandled.current) return
    tutorialBootHandled.current = true
    const stored = tutorialSessionRef.current
    if (stored) {
      const recoveredBase = recoverTutorialSession(stored)
      const returnNamespace = sessionUser?.id ? `user:${sessionUser.id}` : recoveredBase.returnNamespace.startsWith('user:') ? 'guest' : recoveredBase.returnNamespace
      const recovered = returnNamespace === recoveredBase.returnNamespace ? recoveredBase : { ...recoveredBase, returnNamespace, updatedAt: new Date().toISOString() }
      updateTutorialSession(recovered)
      tutorialBootstrapRunning.current = true
      setDataSwitching(true)
      closeTutorialTransients()
      const fallback = buildTutorialCheckpoint(recovered.step, recovered.anchorDate)
      void loadDataSpace(TUTORIAL_NAMESPACE, fallback)
        .then(async loaded => {
          const health = tutorialStateHealth(loaded, recovered)
          if (!health.ok) await persistTutorialState(fallback)
          setPage(tutorialPageForStep(recovered.step) as Page)
        })
        .catch(async error => {
          console.warn('教程本地状态读取失败，使用当前版本 checkpoint 恢复。', error)
          await persistTutorialState(fallback)
          setPage(tutorialPageForStep(recovered.step) as Page)
        })
        .finally(() => { tutorialBootstrapRunning.current = false; setDataSwitching(false); setTutorialBootReady(true) })
      return
    }
    if (namespace === 'guest' && !sessionUser && !loadedFromStorage && !tutorialCompleted()) {
      setTutorialOfferOpen(true)
      setTutorialBootReady(true)
      return
    }
    setTutorialBootReady(true)
  }, [ready, authResolved, namespace, loadedFromStorage, sessionUser?.id])

  useEffect(() => {
    const current = tutorialSessionRef.current
    if (!tutorialBootReady || !current || current.step === 'free') return
    const target = tutorialPageForStep(current.step) as Page
    if (page !== target) setPage(target)
  }, [tutorialBootReady, tutorialSession?.step, page])

  useEffect(() => {
    // Pages share the document scroller. Starting a newly selected module at the
    // previous module's scroll offset is especially disorienting on mobile.
    const resetScroll = () => {
      window.scrollTo(0, 0)
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
      mainAreaRef.current?.scrollIntoView({ block: 'start' })
    }
    resetScroll()
    const frame = window.requestAnimationFrame(resetScroll)
    const afterNavigation = window.setTimeout(resetScroll, 260)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(afterNavigation)
    }
  }, [page])

  useEffect(() => {
    if (!ready || tutorialSession || initialRouteHandled.current) return
    initialRouteHandled.current = true
    if (sessionStorage.getItem('study-planner:open-recovery') === '1') {
      sessionStorage.removeItem('study-planner:open-recovery')
      setPage('settings')
      return
    }
    const trulyBlank = state.assignments.length === 0 && state.taskGroups.length === 0 && state.intakeBatches.length === 0
    if (trulyBlank && (state.templateKind === 'blank' || namespace !== 'guest')) setPage('intake')
  }, [ready, tutorialSession, namespace, state.assignments.length, state.taskGroups.length, state.intakeBatches.length, state.templateKind])

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const resolved = state.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings.theme
      root.dataset.theme = resolved
      root.style.colorScheme = resolved
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [state.settings.theme])

  const resetCloudQueue = (scope?: string, lastSavedUpdatedAt?: string, revision?: number) => {
    const queue = cloudSaveQueue.current
    if (queue.timer) window.clearTimeout(queue.timer)
    queue.scope = scope
    queue.pending = undefined
    queue.timer = undefined
    queue.lastSavedUpdatedAt = lastSavedUpdatedAt
    queue.revision = revision
  }

  const flushCloudQueue = async () => {
    const queue = cloudSaveQueue.current
    if (queue.inFlight || !queue.pending || !queue.scope) return
    const scope = queue.scope
    const userId = scope.replace(/^user:/, '')
    const next = queue.pending
    queue.pending = undefined
    queue.timer = undefined
    setSyncStatus('saving')

    const rawRequest = uploadSnapshot(next, userId, queue.revision)
    const request = rawRequest.then(() => undefined, () => undefined)
    queue.inFlight = request
    try {
      const saved = await rawRequest
      if (queue.scope === scope) queue.revision = saved.revision
      if (queue.scope === scope) queue.lastSavedUpdatedAt = next.updatedAt
    } catch (error) {
      if (queue.scope === scope) {
        setSyncStatus('error')
        if (error instanceof CloudRevisionConflictError) {
          try {
            const cloud = await downloadSnapshot(userId)
            if (cloud) await preserveRecoverySnapshot(scope, cloud.state, 'cloud-conflict', 'cloud', [`云端 revision ${cloud.revision}`])
            await preserveRecoverySnapshot(scope, next, 'cloud-conflict', 'snapshot', [`本机尝试写入 revision ${error.expectedRevision + 1}`])
          } catch { /* 恢复副本失败时仍保留本机当前状态 */ }
          setCloudReady(false)
          setCloudMessage(t('shell.cloudConflictDetected'))
        } else setCloudMessage(error instanceof Error ? error.message : t('shell.cloudSyncFailedLocalKept'))
      }
    } finally {
      if (queue.inFlight === request) queue.inFlight = undefined
      if (queue.scope !== scope) return
      const pendingAfter = cloudSaveQueue.current.pending as AppState | undefined
      if (pendingAfter && pendingAfter.updatedAt !== queue.lastSavedUpdatedAt) {
        setSyncStatus('queued')
        queue.timer = window.setTimeout(() => { void flushCloudQueue() }, 120)
      } else if (queue.lastSavedUpdatedAt === next.updatedAt) {
        setSyncStatus('saved')
      }
    }
  }

  const queueCloudSave = (next: AppState, userId: string, delay = 450) => {
    const scope = `user:${userId}`
    const queue = cloudSaveQueue.current
    if (queue.scope !== scope) resetCloudQueue(scope)
    if (queue.lastSavedUpdatedAt === next.updatedAt) return
    queue.pending = next
    if (queue.timer) window.clearTimeout(queue.timer)
    if (!queue.inFlight) setSyncStatus('queued')
    queue.timer = window.setTimeout(() => { void flushCloudQueue() }, delay)
  }

  const uploadCloudNow = async () => {
    if (!sessionUser?.id) throw new Error(t('shell.pleaseLoginFirst'))
    const userId = sessionUser.id
    const scope = `user:${userId}`
    const queue = cloudSaveQueue.current
    if (queue.scope !== scope) resetCloudQueue(scope)
    if (queue.timer) window.clearTimeout(queue.timer)
    queue.timer = undefined
    if (queue.inFlight) {
      try { await queue.inFlight } catch { /* retry below with latest state */ }
    }
    if (queue.timer) window.clearTimeout(queue.timer)
    queue.timer = undefined
    const latest = stateRef.current
    queue.pending = undefined
    setSyncStatus('saving')
    const rawRequest = uploadSnapshot(latest, userId, queue.revision)
    const request = rawRequest.then(() => undefined, () => undefined)
    queue.inFlight = request
    try {
      const saved = await rawRequest
      queue.revision = saved.revision
      queue.lastSavedUpdatedAt = latest.updatedAt
      setSyncStatus('saved')
      return saved.savedAt
    } catch (error) {
      setSyncStatus('error')
      if (error instanceof CloudRevisionConflictError) {
        try {
          const cloud = await downloadSnapshot(userId)
          if (cloud) await preserveRecoverySnapshot(scope, cloud.state, 'cloud-conflict', 'cloud', [`云端 revision ${cloud.revision}`])
          await preserveRecoverySnapshot(scope, latest, 'cloud-conflict', 'snapshot', [`本机尝试写入 revision ${error.expectedRevision + 1}`])
        } catch { /* keep local state */ }
        setCloudReady(false)
        setCloudMessage(t('shell.cloudConflictDetected'))
      }
      throw error
    } finally {
      if (queue.inFlight === request) queue.inFlight = undefined
      const pendingAfter = cloudSaveQueue.current.pending as AppState | undefined
      if (pendingAfter && pendingAfter.updatedAt !== queue.lastSavedUpdatedAt) {
        setSyncStatus('queued')
        queue.timer = window.setTimeout(() => { void flushCloudQueue() }, 120)
      }
    }
  }

  useEffect(() => {
    if (!supabase) { setAuthResolved(true); return }
    let disposed = false
    const applySession = async (session: Session | null) => {
      const user = session ? { id: session.user.id, email: session.user.email } : undefined
      const tutorialRunning = Boolean(tutorialSessionRef.current)

      // Supabase may emit TOKEN_REFRESHED / SIGNED_IN again when a background tab
      // becomes visible. That is not an account change.
      if (user && previousUserId.current === user.id) {
        setSessionUser(current => (current?.id === user.id && current.email === user.email ? current : user))
        return
      }

      if (!user && !previousUserId.current) {
        setSessionUser(undefined)
        return
      }

      // Tutorial is an isolated local workspace. Auth can change in another tab or
      // because a token refreshes, but it must never replace tutorial data mid-step.
      if (tutorialRunning) {
        previousUserId.current = user?.id
        setSessionUser(user)
        setCloudReady(false)
        resetCloudQueue(user ? `user:${user.id}` : undefined)
        setSyncStatus('local')
        setFirstLoginOpen(false)
        return
      }

      if (!user) {
        setDataSwitching(true)
        const oldUser = previousUserId.current
        previousUserId.current = undefined
        setSessionUser(undefined)
        setCloudReady(false)
        resetCloudQueue()
        setSyncStatus('local')
        setFirstLoginOpen(false)
        const keepOffline = stateRef.current.settings.keepOfflineOnLogout
        try {
          await loadDataSpace('guest', buildGuestDemoState())
          if (oldUser && !keepOffline) await clearDataSpace(`user:${oldUser}`)
        } finally {
          setDataSwitching(false)
        }
        return
      }
      previousUserId.current = user.id
      resetCloudQueue(`user:${user.id}`)
      setDataSwitching(true)
      setSessionUser(user)
    }
    getSession()
      .then(session => void applySession(session))
      .finally(() => { if (!disposed) setAuthResolved(true) })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session).finally(() => { if (!disposed) setAuthResolved(true) })
    })
    return () => { disposed = true; data.subscription.unsubscribe() }
  }, [clearDataSpace, loadDataSpace])

  useEffect(() => {
    if (!ready || !sessionUser?.id || tutorialSession || isTutorialNamespace(namespace)) return
    let cancelled = false
    setCloudReady(false)
    setSyncStatus('restoring')
    const bootstrapCloud = async () => {
      try {
        const userId = sessionUser.id
        const userNamespace = `user:${userId}`
        // Local cache and cloud snapshot are independent; read them in parallel.
        const [localUser, cloudSnapshot] = await Promise.all([
          loadLocalState(userNamespace),
          downloadSnapshot(userId)
        ])
        if (cancelled) return

        const normalizedLocal = localUser ? normalizeState(localUser) : undefined
        const cloud = cloudSnapshot?.state
        if (cloud) {
          const cloudNeedsCompaction = Boolean(cloud.replanHistory?.length || cloud.conflictBackups?.length)
          const normalizedCloud = normalizeState({
            ...cloud,
            // Replan history and conflict backups are device-local performance data.
            replanHistory: normalizedLocal?.replanHistory ?? [],
            conflictBackups: normalizedLocal?.conflictBackups ?? [],
            planVersions: normalizedLocal?.planVersions ?? []
          })
          const localNewer = normalizedLocal && Date.parse(normalizedLocal.updatedAt) > Date.parse(normalizedCloud.updatedAt)
          if (localNewer) {
            const useLocal = window.confirm(t('shell.confirmLocalNewerThanCloud'))
            if (useLocal) {
              await setDataSpace(userNamespace, normalizedLocal, false)
              const uploaded = await uploadSnapshot(normalizedLocal, userId, cloudSnapshot?.revision)
              resetCloudQueue(userNamespace, normalizedLocal.updatedAt, uploaded.revision)
              setCloudMessage(t('shell.usedNewerLocalSynced'))
            } else {
              const backup = JSON.stringify(preparePortableState(normalizedLocal))
              normalizedCloud.conflictBackups = [...(normalizedLocal.conflictBackups ?? []).slice(-2), backup].slice(-3)
              await setDataSpace(userNamespace, normalizedCloud, false)
              resetCloudQueue(userNamespace, cloudNeedsCompaction ? undefined : normalizedCloud.updatedAt, cloudSnapshot?.revision)
              setCloudMessage(t('shell.restoredCloudVersionLocalBackedUp'))
            }
          } else {
            if (normalizedLocal && normalizedLocal.updatedAt !== normalizedCloud.updatedAt) {
              const backup = JSON.stringify(preparePortableState(normalizedLocal))
              normalizedCloud.conflictBackups = [...(normalizedLocal.conflictBackups ?? []).slice(-2), backup].slice(-3)
            }
            await setDataSpace(userNamespace, normalizedCloud, false)
            resetCloudQueue(userNamespace, cloudNeedsCompaction ? undefined : normalizedCloud.updatedAt, cloudSnapshot?.revision)
            setCloudMessage(cloudNeedsCompaction ? t('shell.restoredPlanCompacting') : t('shell.restoredPlanFromCloud'))
          }
          if (!cancelled) {
            setCloudReady(true)
            setSyncStatus('saved')
            setDataSwitching(false)
          }
          return
        }

        if (normalizedLocal && normalizedLocal.taskGroups.length > 0) {
          await setDataSpace(userNamespace, normalizedLocal, false)
          const uploadLocal = window.confirm(t('shell.confirmUploadLocalAsCloudInitial'))
          if (uploadLocal) {
            const uploaded = await uploadSnapshot(normalizedLocal, userId)
            resetCloudQueue(userNamespace, normalizedLocal.updatedAt, uploaded.revision)
            setCloudReady(true)
            setSyncStatus('saved')
            setCloudMessage(t('shell.localSetAsCloudInitial'))
            setDataSwitching(false)
          } else {
            setSyncStatus('local')
            setFirstLoginOpen(true)
            setDataSwitching(false)
          }
          return
        }

        // 云端为空时绝不上传游客数据，先让用户选择模板或明确导入。
        const guestSource = normalizeState((await loadLocalState('guest')) ?? buildGuestDemoState())
        guestSnapshotRef.current = guestSource
        setGuestImportAvailable(Boolean(guestSource.guestModified))
        await loadDataSpace(userNamespace, buildBlankState())
        if (!cancelled) {
          resetCloudQueue(userNamespace)
          setSyncStatus('local')
          setFirstLoginOpen(true)
          setDataSwitching(false)
        }
      } catch (error) {
        if (!cancelled) {
          setCloudReady(false)
          setSyncStatus('error')
          setCloudMessage(error instanceof Error ? error.message : t('shell.cloudRestoreFailed'))
          setDataSwitching(false)
        }
      }
    }
    void bootstrapCloud()
    return () => { cancelled = true }
  }, [ready, sessionUser?.id, tutorialSession, namespace, loadDataSpace, setDataSpace])

  useEffect(() => {
    if (!ready || !sessionUser?.id || !cloudReady || namespace !== `user:${sessionUser.id}`) return
    queueCloudSave(state, sessionUser.id)
  }, [state, ready, sessionUser?.id, cloudReady, namespace])

  useEffect(() => {
    const retry = () => {
      if (!sessionUser?.id || !cloudReady || namespace !== `user:${sessionUser.id}`) return
      queueCloudSave(stateRef.current, sessionUser.id, 0)
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [sessionUser?.id, cloudReady, namespace])

  useEffect(() => {
    const flushBeforeBackground = () => {
      if (document.visibilityState === 'hidden' && cloudSaveQueue.current.pending) void flushCloudQueue()
    }
    const flushBeforePageHide = () => {
      if (cloudSaveQueue.current.pending) void flushCloudQueue()
    }
    document.addEventListener('visibilitychange', flushBeforeBackground)
    window.addEventListener('pagehide', flushBeforePageHide)
    return () => {
      document.removeEventListener('visibilitychange', flushBeforeBackground)
      window.removeEventListener('pagehide', flushBeforePageHide)
      const queue = cloudSaveQueue.current
      if (queue.timer) window.clearTimeout(queue.timer)
    }
  }, [])

  const openAdjustment = (date?: string, reason: 'current-conflicts' | 'too-tiring' | 'future-replan' | 'execution-difference' = 'current-conflicts') => {
    const tutorial = tutorialSessionRef.current
    if (tutorial && tutorial.step !== 'free') {
      if (tutorial.step === 'repair-entry') {
        if (!advanceTutorialOnly('repair-entry', 'repair-action')) return
        setAdjustmentDate(tutorial.anchorDate)
        setAdjustmentReason('current-conflicts')
        setAdjustmentOpen(true)
        return
      }
      if (tutorial.step === 'future-entry') {
        if (!advanceTutorialOnly('future-entry', 'future-action')) return
        setAdjustmentDate(shiftDate(tutorial.anchorDate, 1))
        setAdjustmentReason('future-replan')
        setAdjustmentOpen(true)
        return
      }
      tutorialNotice()
      return
    }
    setAdjustmentDate(date)
    setAdjustmentReason(reason)
    setAdjustmentOpen(true)
  }

  const closeAdjustment = () => {
    const tutorial = tutorialSessionRef.current
    setAdjustmentOpen(false)
    if (tutorial?.step === 'repair-action') void recoverTutorialTo('repair-entry')
    else if (tutorial?.step === 'future-action') void recoverTutorialTo('future-entry')
  }

  const openReview = (date: string) => {
    const tutorial = tutorialSessionRef.current
    if (tutorial && tutorial.step !== 'free') {
      if (tutorial.step !== 'review-entry' || date !== tutorial.anchorDate) { tutorialNotice(); return }
      if (!advanceTutorialOnly('review-entry', 'review-carry')) return
    }
    setReviewDate(date)
  }

  const closeReview = () => {
    const tutorial = tutorialSessionRef.current
    setReviewDate(undefined)
    if (tutorial?.step === 'review-carry') void recoverTutorialTo('review-entry')
  }

  const initializeAccount = async (kind: 'blank' | 'demo' | 'import' | 'separate') => {
    if (!sessionUser?.id) return
    let initial: AppState
    if (kind === 'import' && guestSnapshotRef.current) {
      initial = normalizeState(structuredClone(guestSnapshotRef.current))
      initial.guestModified = false
      initial.updatedAt = new Date().toISOString()
    } else {
      initial = kind === 'demo' ? buildGuestDemoState() : buildBlankState()
      initial.guestModified = false
    }
    await setDataSpace(`user:${sessionUser.id}`, initial, false)
    const uploaded = await uploadSnapshot(initial, sessionUser.id)
    resetCloudQueue(`user:${sessionUser.id}`, initial.updatedAt, uploaded.revision)
    setCloudReady(true)
    setSyncStatus('saved')
    setFirstLoginOpen(false)
    setDataSwitching(false)
    setCloudMessage(kind === 'import' ? t('shell.guestPlanCopiedToAccount') : kind === 'separate' ? t('shell.separateBlankAccountCreated') : t('shell.personalPlanInitialized'))
  }

  const openPrepared = (prepared: AppState, event: PlanChangeEvent, options?: { forceAlternatives?: boolean }) => {
    const tutorial = tutorialSessionRef.current
    const tutorialRestricted = Boolean(tutorial && tutorial.step !== 'free')
    const baseline = stateRef.current
    const policy = adjustmentPolicyForEvent(event)
    if (tutorialRestricted && tutorial) {
      if (!tutorialAcceptsEvent(tutorial, event)) { tutorialNotice(); return }
      const previewStep: Partial<Record<TutorialStep, TutorialStep>> = {
        'repair-action': 'repair-preview',
        'intake-schedule': 'intake-preview',
        'review-carry': 'review-preview',
        'future-action': 'future-preview',
      }
      const nextPreview = previewStep[tutorial.step]
      if (!nextPreview) { tutorialNotice(); return }

      // 教程使用正式调度/校验核心。固定 fixture、固定策略和操作白名单负责一致性，
      // checkpoint 只负责验证，不再预先写死“正确答案”。
      const direct = previewPreparedChange(baseline, prepared, event, policy.directPreviewLabel)
      const generated = tutorial.step === 'review-carry'
        ? []
        : generateProposals(prepared, event, baseline, undefined, 0)
      const feasibleGenerated = generated.filter(item => !item.infeasible)
      const repairTeachingProposals = tutorial.step === 'repair-action'
        ? feasibleGenerated.filter(item => item.movements.length > 0 && item.goalImpacts.some(goal => (goal.latestRiskBefore && !goal.latestRiskAfter) || (goal.desiredRiskBefore && !goal.desiredRiskAfter) || Boolean(goal.beforeExpectedCompletion && goal.afterExpectedCompletion && goal.afterExpectedCompletion < goal.beforeExpectedCompletion)))
        : []
      const futureTeachingProposals = tutorial.step === 'future-action'
        ? feasibleGenerated.filter(item => item.movements.length > 0)
        : []
      const proposals = tutorial.step === 'review-carry'
        ? (direct.infeasible ? [] : [direct])
        : repairTeachingProposals.length ? repairTeachingProposals
          : futureTeachingProposals.length ? futureTeachingProposals
            : feasibleGenerated
      if (!proposals.length) {
        // 保留问题详情给用户看，不自动把整个教程跳回上一层。
        if (!advanceTutorialOnly(tutorial.step, nextPreview)) return
        setProposalSession({ baseline, prepared, event, policy, proposals: generated.length ? generated : [direct], expansionLevel: 0, calculationRevision: 0, moreExhausted: true })
        tutorialNotice(t('shell.noDirectProposalUnderCurrentConditions'))
        return
      }
      if (!advanceTutorialOnly(tutorial.step, nextPreview)) return
      setProposalSession({ baseline, prepared, event, policy, proposals, expansionLevel: 0, calculationRevision: 0, moreExhausted: true })
      return
    }
    const directPreview = previewPreparedChange(baseline, prepared, event, policy.directPreviewLabel)
    const explicitLocalOperation = event.metadata?.explicitLocalOperation === true || event.metadata?.operationScope === 'requested-change-only'
    const useDirectFirst = policy.mode === 'validate-and-commit' || policy.mode === 'optional-optimization'

    // 明确的局部操作永远先展示“只执行用户操作”的精确预览。
    // 即使它产生了需要决定的新问题，也不自动启动全局搜索；用户可以处理这些问题，或主动获取更大范围方案。
    if (explicitLocalOperation && !options?.forceAlternatives) {
      setProposalSession({ baseline, prepared, event, policy, proposals: [directPreview], expansionLevel: 0, calculationRevision: 0 })
      return
    }

    // 用户已经明确指定结果，或变化只是放宽约束时，合法结果立即进入精确预览。
    // 其他优化方案仍可由用户在预览中主动生成，不让“保持现状”也先等待一轮重排。
    if (useDirectFirst && !directPreview.infeasible && !options?.forceAlternatives) {
      setProposalSession({ baseline, prepared, event, policy, proposals: [directPreview], expansionLevel: 0, calculationRevision: 0 })
      return
    }

    // 精确选择存在冲突时，仅把冲突任务交给系统；其余合法选择继续固定。
    const conflictIds = directPreview.infeasible
      ? Array.from(new Set(directPreview.issues.flatMap(issue => issue.assignmentIds))).filter(id => event.affectedAssignmentIds.includes(id))
      : []
    const eventForRouting: PlanChangeEvent = {
      ...event,
      affectedAssignmentIds: conflictIds.length ? conflictIds : event.affectedAssignmentIds,
      metadata: {
        ...(event.metadata ?? {}),
        directValidationConflictIds: conflictIds,
        fixedAssignmentIds: conflictIds.length ? event.affectedAssignmentIds.filter(id => !conflictIds.includes(id)) : [],
      },
    }

    // 首屏只计算一个推荐方案；其他策略在用户点击“生成更多不同方案”时按需加载。
    // 这样批量录入和常规调整都能先快速得到一个可执行结果。
    const initialPreferences = [policy.primaryPreference] as typeof policy.alternativePreferences
    const routedEvent = eventWithPreferences(eventForRouting, initialPreferences)
    const seedProposals = useDirectFirst || directPreview.infeasible ? [directPreview] : []

    const complete = (generated: SchedulingProposal[]) => {
      const intakeBatchId = typeof event.metadata?.intakeBatchId === 'string' ? event.metadata.intakeBatchId : undefined
      if (intakeBatchId) updateIntakeBatch(intakeBatchId, { status: 'pending' })
      const merged = [...seedProposals]
      const signatures = new Set(merged.map(item => item.distinctSignature))
      for (const proposal of generated) if (!signatures.has(proposal.distinctSignature)) {
        signatures.add(proposal.distinctSignature)
        merged.push(proposal)
      }
      if (tutorialRestricted && merged.length === 0) merged.push(directPreview)
      setProposalSession({ baseline, prepared, event: routedEvent, policy, proposals: merged, expansionLevel: 0, calculationRevision: 0 })
    }

    if (tutorialRestricted || typeof Worker === 'undefined') {
      complete(generateProposals(prepared, routedEvent, baseline))
      return
    }
    const worker = new Worker(new URL('./workers/proposal.worker.ts', import.meta.url), { type: 'module' })
    const intakeBatchId = typeof event.metadata?.intakeBatchId === 'string' ? event.metadata.intakeBatchId : undefined
    if (intakeBatchId) updateIntakeBatch(intakeBatchId, { status: 'calculating' })
    setProposalGeneration({ baseline, prepared, event: routedEvent, policy, seedProposals, worker })
    worker.onmessage = (message: MessageEvent<{ ok: boolean; proposals?: SchedulingProposal[]; message?: string }>) => {
      worker.terminate()
      if (message.data.ok) {
        setProposalGeneration(undefined)
        complete(message.data.proposals ?? [])
      } else {
        if (intakeBatchId) updateIntakeBatch(intakeBatchId, { status: 'pending' })
        setProposalGeneration({ baseline, prepared, event: routedEvent, policy, seedProposals, error: message.data.message ?? t('shell.proposalCalculationFailed') })
      }
    }
    worker.onerror = eventValue => {
      worker.terminate()
      if (intakeBatchId) updateIntakeBatch(intakeBatchId, { status: 'pending' })
      setProposalGeneration({ baseline, prepared, event: routedEvent, policy, seedProposals, error: eventValue.message || t('shell.proposalCalculationFailed') })
    }
    worker.postMessage({ preparedState: prepared, baseline, event: routedEvent })
  }
  const cancelProposalGeneration = () => {
    proposalGeneration?.worker?.terminate()
    const intakeBatchId = typeof proposalGeneration?.event.metadata?.intakeBatchId === 'string' ? proposalGeneration.event.metadata.intakeBatchId : undefined
    if (intakeBatchId) updateIntakeBatch(intakeBatchId, { status: 'pending' })
    setProposalGeneration(undefined)
  }

  const applyCurrentReviewPlan = (prepared: AppState, event: PlanChangeEvent) => {
    const tutorial = tutorialSessionRef.current
    if (tutorial?.step === 'review-carry') {
      openPrepared(prepared, event)
      return
    }
    const baseline = stateRef.current
    const policy = adjustmentPolicyForEvent(event)
    const directPreview = previewPreparedChange(baseline, prepared, event, policy.directPreviewLabel)
    if (!directPreview.infeasible) {
      applyPreparedWithoutScheduling(prepared, event, t('shell.completedReviewAndPostponed', { count: directPreview.movements.length }))
      setActionNotice(t('shell.completedReviewAndPostponedNotice', { count: directPreview.movements.length }))
      return
    }
    // 复盘中用户已逐项决定日期。发现冲突时只打开精确冲突预览，
    // 不自动耗时生成其他方案；用户仍可在页面中主动“生成更多不同方案”。
    setProposalSession({ baseline, prepared, event, policy, proposals: [directPreview], expansionLevel: 0, calculationRevision: 0 })
  }

  const openMoreReviewPlans = (prepared: AppState, event: PlanChangeEvent) => {
    openPrepared(prepared, event, { forceAlternatives: true })
  }

  const openAddTask = (date?: string, intent: SchedulingIntent = date ? 'prefer-date' : 'system', intakeBatchId?: string) => {
    const tutorial = tutorialSessionRef.current
    if (tutorial && tutorial.step !== 'free') { tutorialNotice(); return }
    setAddTaskContext({ date, intent, intakeBatchId })
    setAddTaskOpen(true)
  }

  const selectTaskCreation = (mode: TaskCreationMode, kind: TaskCreationKind) => {
    setAddTaskOpen(false)
    if (mode === 'intake') {
      setIntakeAddRequest({ id: uid('intake-add'), kind, batchId: addTaskContext.intakeBatchId })
      navigate('intake')
      return
    }
    if (kind === 'single') {
      setSingleTaskDate(addTaskContext.date)
      setSingleTaskIntent(addTaskContext.intent)
      setSingleTaskOpen(true)
    } else {
      setGroupDialogOpen(true)
    }
  }

  const pendingIntakeCount = state.intakeBatches.reduce((sum, batch) => sum + (batch.status === 'archived' ? 0 : batch.taskGroups.filter(item => !item.appliedAt).length), 0)

  const tutorialRestricted = Boolean(tutorialActive && tutorialStepValue && tutorialStepValue !== 'free')
  let tutorialCoachConfig: TutorialCoachmarkConfig | undefined
  if (tutorialRestricted && tutorialStepValue) {
    const base: Partial<Record<TutorialStep, TutorialCoachmarkConfig>> = {
      'repair-entry': { target: 'replan-center', text: t('tutorial.coach.repairEntry') },
      'repair-action': { target: 'repair-submit|repair-current', text: t('tutorial.coach.repairAction') },
      'repair-preview': { target: 'proposal-primary', text: t('tutorial.coach.repairPreview') },
      'repair-calendar': { text: t('tutorial.coach.repairCalendar'), actionLabel: t('tutorial.coach.continueAction'), onAction: () => advanceTutorialStable('repair-calendar', 'goal-existing') },
      'goal-existing': { target: 'tutorial-goal-view', text: t('tutorial.coach.goalExisting') },
      'intake-entry': { target: 'tutorial-natural-input', text: t('tutorial.coach.intakeEntry') },
      'intake-source': { target: 'tutorial-parse', text: t('tutorial.coach.intakeSource') },
      'intake-parse': { target: 'tutorial-import-confirm', text: t('tutorial.coach.intakeParse') },
      'tasks-intake': { text: t('tutorial.coach.tasksIntake'), actionLabel: t('tutorial.coach.continueNewGoal'), onAction: tutorialIntakeSeen },
      'goal-create': { target: 'tutorial-goal-create', text: t('tutorial.coach.goalCreate') },
      'goal-link': { target: 'tutorial-goal-link-field|tutorial-goal-link-edit', text: t('tutorial.coach.goalLink') },
      'intake-schedule': { target: 'schedule-intake', text: t('tutorial.coach.intakeSchedule') },
      'intake-preview': { target: 'proposal-primary', text: t('tutorial.coach.intakePreview') },
      'intake-calendar': { text: t('tutorial.coach.intakeCalendar'), actionLabel: t('tutorial.coach.continueExecuteToday'), onAction: () => advanceTutorialStable('intake-calendar', 'execute-complete') },
      'execute-complete': { target: 'tutorial-complete-confirm|tutorial-execute', text: t('tutorial.coach.executeComplete') },
      'execute-partial': { target: 'tutorial-partial-confirm|tutorial-execute', text: t('tutorial.coach.executePartial') },
      'review-entry': { target: 'today-review', text: t('tutorial.coach.reviewEntry') },
      'review-carry': { target: 'review-carry', text: t('tutorial.coach.reviewCarry') },
      'review-preview': { target: 'proposal-primary', text: t('tutorial.coach.reviewPreview') },
      'review-calendar': { text: t('tutorial.coach.reviewCalendar'), actionLabel: t('tutorial.coach.continueSeeStats'), onAction: () => advanceTutorialStable('review-calendar', 'stats') },
      stats: { target: 'tutorial-stats-expand', text: t('tutorial.coach.stats') },
      'stats-detail': { text: t('tutorial.coach.statsDetail'), actionLabel: t('tutorial.coach.continueReplanFuture'), onAction: () => advanceTutorialStable('stats-detail', 'future-entry') },
      'future-entry': { target: 'replan-center', text: t('tutorial.coach.futureEntry') },
      'future-action': { target: 'future-submit|future-replan', text: t('tutorial.coach.futureAction') },
      'future-preview': { target: 'proposal-primary', text: t('tutorial.coach.futurePreview') },
      'future-calendar': { text: t('tutorial.coach.futureCalendar'), actionLabel: t('tutorial.coach.finishExperience'), onAction: () => advanceTutorialStable('future-calendar', 'complete') },
      complete: { text: t('tutorial.coach.complete'), actionLabel: t('tutorial.coach.startMyPlan'), onAction: () => { void exitTutorial(true) }, secondaryLabel: t('tutorial.coach.keepLooking'), onSecondary: () => { const updated = advanceTutorialOnly('complete', 'free'); if (updated) setPage('today') } },
    }
    const headlines: Partial<Record<TutorialStep, string>> = {
      'repair-entry': t('tutorial.headline.repairEntry'),
      'repair-action': t('tutorial.headline.repairAction'),
      'repair-preview': t('tutorial.headline.repairPreview'),
      'repair-calendar': t('tutorial.headline.repairCalendar'),
      'goal-existing': t('tutorial.headline.goalExisting'),
      'intake-entry': t('tutorial.headline.intakeEntry'),
      'intake-source': t('tutorial.headline.intakeSource'),
      'intake-parse': t('tutorial.headline.intakeParse'),
      'tasks-intake': t('tutorial.headline.tasksIntake'),
      'goal-create': t('tutorial.headline.goalCreate'),
      'goal-link': t('tutorial.headline.goalLink'),
      'intake-schedule': t('tutorial.headline.intakeSchedule'),
      'intake-preview': t('tutorial.headline.intakePreview'),
      'intake-calendar': t('tutorial.headline.intakeCalendar'),
      'execute-complete': t('tutorial.headline.executeComplete'),
      'execute-partial': t('tutorial.headline.executePartial'),
      'review-entry': t('tutorial.headline.reviewEntry'),
      'review-carry': t('tutorial.headline.reviewCarry'),
      'review-preview': t('tutorial.headline.reviewPreview'),
      'review-calendar': t('tutorial.headline.reviewCalendar'),
      stats: t('tutorial.headline.stats'),
      'stats-detail': t('tutorial.headline.statsDetail'),
      'future-entry': t('tutorial.headline.futureEntry'),
      'future-action': t('tutorial.headline.futureAction'),
      'future-preview': t('tutorial.headline.futurePreview'),
      'future-calendar': t('tutorial.headline.futureCalendar'),
      complete: t('tutorial.headline.complete'),
    }
    const phase = tutorialStepValue.startsWith('repair') ? t('tutorial.phase.repair')
      : ['goal-existing', 'goal-create'].includes(tutorialStepValue) ? t('tutorial.phase.goal')
        : tutorialStepValue === 'goal-link' || tutorialStepValue === 'tasks-intake' || tutorialStepValue.startsWith('intake') ? t('tutorial.phase.intake')
          : tutorialStepValue.startsWith('execute') ? t('tutorial.phase.execute')
            : tutorialStepValue.startsWith('review') ? t('tutorial.phase.review')
              : tutorialStepValue.startsWith('stats') ? t('tutorial.phase.stats')
                : tutorialStepValue.startsWith('future') ? t('tutorial.phase.future')
                  : t('tutorial.phase.complete')
    const coach = base[tutorialStepValue]
    tutorialCoachConfig = coach ? { ...coach, eyebrow: coach.eyebrow ?? phase, headline: headlines[tutorialStepValue] } : undefined
  }



  if (!ready || !authResolved || !tutorialBootReady || dataSwitching) return <div className="loading-screen"><div className="spinner"/><p>{dataSwitching ? t('shell.switchingDataSpace') : t('shell.loadingPlan')}</p></div>

  if (page === 'timer') return (
    <Suspense fallback={<div className="loading-screen"><div className="spinner"/><p>{t('shell.loadingTimer')}</p></div>}>
      <FocusTimerPage onExit={() => navigate('today')}/>
    </Suspense>
  )

  return (
    <div className={`app-shell ${state.settings.sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${mobileNav ? 'sidebar-mobile-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><CheckCircle2 size={22}/></div><div><strong>{t('app.brandName')}</strong><small>{displayPlanName(state.settings.planName)}</small></div></div>
        <nav>
          {navItems.map(item => {
            const Icon = item.icon
            const intakeLabel = item.id === 'intake' && pendingIntakeCount ? `${item.label}${t('nav.intakePendingSuffix', { count: pendingIntakeCount })}` : item.label
            const tutorialDisabled = Boolean(tutorialSession && !tutorialAllowsPage(tutorialSession.step, item.id))
            return <button key={item.id} aria-label={intakeLabel} aria-disabled={tutorialDisabled || undefined} title={tutorialDisabled ? t('common.tutorialFinishStep') : state.settings.sidebarCollapsed ? intakeLabel : undefined} className={`${page === item.id ? 'nav-active' : ''} ${tutorialDisabled ? 'tutorial-disabled-control' : ''}`.trim()} onClick={() => navigate(item.id)}><Icon size={19}/><span>{item.label}</span>{item.id === 'intake' && pendingIntakeCount > 0 && <em className="intake-nav-badge">{pendingIntakeCount > 99 ? '99+' : pendingIntakeCount}</em>}</button>
          })}
        </nav>
        <div className="sidebar-bottom">
          <a className="sidebar-repo-link" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" title={state.settings.sidebarCollapsed ? t('app.githubRepo') : undefined}><Github size={18}/><span>{t('app.githubRepo')}</span><ArrowUpRight className="sidebar-repo-arrow" size={14}/></a>
          <div className={`sync-status ${sessionUser && !tutorialActive ? 'online' : ''} ${syncStatus === 'error' && !tutorialActive ? 'sync-error' : ''}`}>{tutorialActive || !sessionUser ? <CloudOff size={16}/> : <Cloud size={16}/>}<span>{tutorialActive ? t('app.syncTutorial') : !sessionUser ? t('app.syncGuest') : syncStatus === 'restoring' ? t('app.syncRestoring') : syncStatus === 'queued' ? t('app.syncQueued') : syncStatus === 'saving' ? t('app.syncSaving') : syncStatus === 'error' ? t('app.syncError') : cloudReady ? t('app.syncSaved') : t('app.syncWaiting')}</span></div>
          <button className={`collapse-button ${tutorialRestricted ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialRestricted || undefined} title={tutorialRestricted ? t('common.tutorialKeepLayout') : state.settings.sidebarCollapsed ? t('common.expandSidebar') : t('common.collapseSidebar')} aria-label={state.settings.sidebarCollapsed ? t('common.expandSidebar') : t('common.collapseSidebar')} onClick={() => tutorialRestricted ? tutorialNotice(t('common.tutorialKeepLayoutBrief')) : updateSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed })}><ChevronLeft size={18}/><span>{state.settings.sidebarCollapsed ? t('common.expandSidebar') : t('common.collapseSidebar')}</span></button>
          <small className="sidebar-version">v{APP_VERSION}</small>
        </div>
      </aside>
      {mobileNav && <button className="mobile-overlay" onClick={() => setMobileNav(false)} aria-label={t('common.closeMenu')}/>}
      <main ref={mainAreaRef} className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label={t('common.openMenu')} onClick={() => setMobileNav(true)}><Menu size={21}/></button>
          <div className="page-heading"><h1>{navItems.find(n => n.id === page)?.label}</h1><span>{format(tutorialActive ? parseISO(effectiveToday) : new Date(), state.settings.language === 'en' ? 'MMMM d, yyyy' : 'yyyy年M月d日')}</span></div>
          <div className="topbar-actions"><LanguageSwitcher language={state.settings.language} onChange={language => updateSettings({ language })}/><ActiveTimerReturnButton onOpen={() => tutorialRestricted ? tutorialNotice(t('common.tutorialFinishStepThenTimer')) : navigate('timer')}/><button data-tutorial-target={tutorialRestricted && (tutorialStepValue === 'repair-entry' || tutorialStepValue === 'future-entry') ? 'replan-center' : undefined} aria-disabled={tutorialRestricted && tutorialStepValue !== 'repair-entry' && tutorialStepValue !== 'future-entry' ? true : undefined} className={`secondary-button ${tutorialRestricted && tutorialStepValue !== 'repair-entry' && tutorialStepValue !== 'future-entry' ? 'tutorial-disabled-control' : ''}`} aria-label={currentIssueCount ? t('common.planHasIssues', { count: currentIssueCount }) : t('common.openAdjustmentEntry')} onClick={() => openAdjustment()}><RefreshCw size={16}/><span>{tutorialActive && tutorialStepValue === 'repair-entry' ? t('common.planIssuesShort', { count: currentIssueCount }) : currentIssueCount ? t('common.issuesNeedHandling', { count: currentIssueCount }) : t('common.planChanged')}</span></button>{tutorialActive && tutorialStepValue === 'free' && <button className="secondary-button" onClick={() => void exitTutorial(false)}>{t('common.backToMyPlan')}</button>}</div>
        </header>
        {tutorialActive && tutorialCoachConfig && tutorialStepValue && <TutorialCoachmark step={tutorialStepValue} config={tutorialCoachConfig} onRestart={() => { void restartTutorial() }} onExit={() => { void exitTutorial(false) }}/>}
        <div className="page-content">
          {page === 'today' && <TodayPage onNavigate={navigate} onPrepared={openPrepared} onAddTask={date => openAddTask(date, 'prefer-date')} onReview={openReview} todayOverride={tutorialSession?.anchorDate} tutorialMode={tutorialRestricted} tutorialStep={tutorialStepValue} tutorialTargetId={tutorialStepValue === 'execute-partial' ? TUTORIAL_PARTIAL_ASSIGNMENT_ID : TUTORIAL_EXECUTE_ASSIGNMENT_ID} onTutorialTaskRecorded={mode => { if (mode === 'complete') advanceTutorialStable('execute-complete', 'execute-partial'); else advanceTutorialStable('execute-partial', 'review-entry') }} onTutorialBlocked={tutorialNotice}/>}
          {page === 'calendar' && <CalendarPage onPrepared={openPrepared} onOpenAdjustment={date => openAdjustment(date, 'current-conflicts')} onAddTask={date => openAddTask(date, 'prefer-date')} tutorialMode={tutorialRestricted} tutorialHighlightDates={tutorialSession?.highlightDates} onTutorialBlocked={tutorialNotice}/>}
          {page === 'tasks' && <TasksPage onOpenIntake={() => navigate('intake')} onPrepared={openPrepared} tutorialMode={tutorialRestricted} onTutorialBlocked={tutorialNotice}/>}
          <Suspense fallback={<div className="page-loading"><div className="spinner"/><p>{t('shell.loadingPage')}</p></div>}>
            {page === 'intake' && <IntakePage onPrepared={openPrepared} onNavigate={target => navigate(target)} onAddTask={batchId => openAddTask(undefined, 'system', batchId)} addRequest={intakeAddRequest} onAddRequestHandled={() => setIntakeAddRequest(undefined)} tutorialMode={tutorialRestricted && tutorialPageForStep(tutorialStepValue!) === 'intake'} tutorialStep={tutorialStepValue} tutorialText={tutorialSession ? tutorialNaturalLanguageText(tutorialSession.anchorDate) : undefined} onTutorialNaturalOpen={() => advanceTutorialStable('intake-entry', 'intake-source')} onTutorialParsed={() => advanceTutorialStable('intake-source', 'intake-parse')} onTutorialImported={advanceTutorialAfterImport} onTutorialGoalLinked={tutorialGoalLinked} onStartTutorial={() => setTutorialOfferOpen(true)} onTutorialBlocked={tutorialNotice}/>}
            {page === 'goals' && <GoalsPage onPrepared={openPrepared} tutorialMode={tutorialRestricted && tutorialPageForStep(tutorialStepValue!) === 'goals'} tutorialStep={tutorialStepValue} onTutorialExistingViewed={() => { void enterTutorialIntake() }} onTutorialGoalCreated={tutorialGoalCreated} onTutorialBlocked={tutorialNotice}/>}
            {page === 'stats' && <StatsPage onOpenReplan={date => openAdjustment(date, 'current-conflicts')} tutorialMode={tutorialRestricted && (tutorialStepValue === 'stats' || tutorialStepValue === 'stats-detail')} onTutorialExpanded={tutorialStatsExpanded}/>}
            {page === 'export' && <ExportPage onNavigate={target => navigate(target)}/>}
            {page === 'feedback' && <FeedbackPage/>}
            {page === 'guide' && <GuidePage onNavigate={target => navigate(target)} onStartTutorial={() => setTutorialOfferOpen(true)}/>}
          </Suspense>
          {page === 'settings' && <SettingsPage sessionUserId={sessionUser?.id} sessionEmail={sessionUser?.email} cloudMessage={cloudMessage} onCloudUpload={uploadCloudNow} onPrepared={openPrepared} onStartTutorial={() => setTutorialOfferOpen(true)}/>}
        </div>
      </main>
      <Modal open={tutorialOfferOpen} title={t('shell.tutorialOfferTitle')} onClose={() => { markTutorialOfferDismissed(); setTutorialOfferOpen(false) }}>
        <div className="tutorial-offer-copy"><p>{t('shell.tutorialOfferBody1')}</p><p>{t('shell.tutorialOfferBody2')}</p><p>{t('shell.tutorialOfferBody3')}</p></div>
        <div className="modal-actions"><button className="secondary-button" onClick={() => { markTutorialOfferDismissed(); setTutorialOfferOpen(false); if (!state.assignments.length) setPage('intake') }}>{t('shell.startMyPlanDirectly')}</button><button className="primary-button" onClick={() => { setTutorialOfferOpen(false); void startTutorial() }}>{t('shell.startExperience')}</button></div>
      </Modal>
      <AddTaskDialog open={addTaskOpen} onClose={() => setAddTaskOpen(false)} onSelect={selectTaskCreation}/>
      <SingleTaskDialog open={singleTaskOpen} state={state} defaultDate={singleTaskDate} defaultIntent={singleTaskIntent} creationMode="schedule" onClose={() => setSingleTaskOpen(false)} onSubmit={draft => {
        const prepared = prepareSingleAssignment(draft)
        setSingleTaskOpen(false)
        openPrepared(prepared.state, prepared.event)
      }}/>
      <TaskGroupDialog open={groupDialogOpen} state={state} defaultDate={addTaskContext.date} onClose={() => setGroupDialogOpen(false)} onCreate={draft => {
        const prepared = prepareTaskGroup(draft)
        setGroupDialogOpen(false)
        openPrepared(prepared.state, prepared.event)
      }}/>
      {proposalGeneration && <Modal open title={t('shell.generatingProposalTitle')} onClose={cancelProposalGeneration}>
        <div className="proposal-generation-state"><div className={proposalGeneration.error ? 'proposal-generation-error' : 'spinner'}/><h3>{proposalGeneration.error ? t('shell.proposalCalculationIncomplete') : proposalGeneration.event.title}</h3><p>{proposalGeneration.error ?? t('shell.generatingProposalBody')}</p></div>
        <div className="modal-actions"><button className="secondary-button" onClick={cancelProposalGeneration}>{proposalGeneration.error ? t('shell.close') : t('shell.cancelCalculation')}</button>{proposalGeneration.error && <button className="primary-button" onClick={() => { const { prepared, event, baseline, policy, seedProposals } = proposalGeneration; setProposalGeneration(undefined); const proposals = generateProposals(prepared, event, baseline); setProposalSession({ baseline, prepared, event, policy, proposals: [...seedProposals, ...proposals.filter(item => !seedProposals.some(seed => seed.distinctSignature === item.distinctSignature))], expansionLevel: 0, calculationRevision: 0 }) }}>{t('shell.retryInCurrentThread')}</button>}</div>
      </Modal>}
      {proposalSession && <ProposalDialog
        open baseline={proposalSession.baseline} preparedState={proposalSession.prepared} event={proposalSession.event}
        proposals={proposalSession.proposals} policy={proposalSession.policy} calculationRevision={proposalSession.calculationRevision} decisionSummary={proposalSession.decisionSummary} moreExhausted={proposalSession.moreExhausted} tutorialMode={tutorialRestricted} onTutorialBlocked={tutorialNotice}
        onClose={() => {
          const step = tutorialSessionRef.current?.step
          setProposalSession(undefined)
          if (step === 'repair-preview') void recoverTutorialTo('repair-entry')
          else if (step === 'intake-preview') void recoverTutorialTo('intake-schedule')
          else if (step === 'review-preview') void recoverTutorialTo('review-entry')
          else if (step === 'future-preview') void recoverTutorialTo('future-entry')
        }}
        onKeep={() => {
          const type = proposalSession.event.type
          const reviewDate = typeof proposalSession.event.metadata?.reviewDate === 'string' ? proposalSession.event.metadata.reviewDate : undefined
          if (reviewDate && proposalSession.event.metadata?.containsReviewRecord) {
            const isDurationEstimateChange = type === 'rule-change' && proposalSession.event.metadata?.currentEstimate != null
            if (isDurationEstimateChange) {
              // The Review already asked the user to accept the new estimate. “Keep dates” must
              // apply that estimate plus the Review record, not silently discard the accepted change.
              applyPreparedWithoutScheduling(proposalSession.prepared, proposalSession.event, t('shell.applyOnlyNewEstimate'))
            } else completeReview(reviewDate)
            setProposalSession(undefined)
            return
          }
          if (type === 'bulk-move' || type === 'execution-difference' || type === 'load-preference-change' || type === 'future-replanning') {
            setProposalSession(undefined)
            return
          }
          applyPreparedWithoutScheduling(proposalSession.prepared, proposalSession.event, t('shell.keepBaseChangeNoDateAdjust'))
          setProposalSession(undefined)
        }}
        onGenerateMore={() => {
          setProposalSession(current => {
            if (!current || current.moreExhausted) return current
            const allPreferences = [current.policy.primaryPreference, ...current.policy.alternativePreferences]
            const generatedPreferences = new Set(current.proposals.map(item => item.preference))
            const remainingPreferences = allPreferences.filter(item => !generatedPreferences.has(item))
            const nextLevel = remainingPreferences.length ? current.expansionLevel : Math.min(2, current.expansionLevel + 1)
            const preferences = remainingPreferences.length ? remainingPreferences : allPreferences
            const localOperation = current.event.metadata?.explicitLocalOperation === true
            const expansionBaseEvent: PlanChangeEvent = localOperation
              ? { ...current.event, action: 'optimize', metadata: { ...(current.event.metadata ?? {}), operationScope: 'broader-future-plan', broaderOptimizationRequested: true } }
              : current.event
            const expandedEvent = eventWithPreferences(expansionBaseEvent, preferences)
            const extra = generateProposals(current.prepared, expandedEvent, current.baseline, undefined, nextLevel, {
              acceptedExceptions: current.acceptedExceptions,
              disableAutomaticExceptions: Boolean(current.acceptedExceptions),
            })
            const merged = [...current.proposals]
            const signatures = new Set(merged.map(item => item.distinctSignature))
            for (const proposal of extra) if (!signatures.has(proposal.distinctSignature)) { signatures.add(proposal.distinctSignature); merged.push(proposal) }
            const added = merged.length - current.proposals.length
            return { ...current, event: expandedEvent, proposals: merged, expansionLevel: nextLevel, moreExhausted: added === 0 && nextLevel >= 2 && remainingPreferences.length === 0 }
          })
        }}
        onResolveConflicts={(proposal, decisions, exceptionDecisions) => {
          const applied = applyConflictDecisions(proposalSession.baseline, proposalSession.prepared, proposal, proposalSession.event, decisions, exceptionDecisions)
          const acceptedExceptions = mergeConstraintExceptions(applied.acceptedExceptions)
          const preferences = Array.from(new Set([proposal.preference, proposalSession.policy.primaryPreference, ...proposalSession.policy.alternativePreferences.slice(0, 1)]))
          const routedEvent = eventWithPreferences(applied.event, preferences)
          const recalculated = generateProposals(applied.preparedState, routedEvent, proposalSession.baseline, undefined, proposalSession.expansionLevel, {
            acceptedExceptions,
            disableAutomaticExceptions: true,
          })
          const fallback = previewPreparedChange(
            proposalSession.baseline,
            applied.preparedState,
            routedEvent,
            t('shell.revalidateAfterConflictDecision'),
            acceptedExceptions,
          )
          const merged = [...recalculated]
          if (!merged.some(item => item.distinctSignature === fallback.distinctSignature)) merged.unshift(fallback)
          setProposalSession(current => current ? {
            ...current,
            prepared: applied.preparedState,
            event: routedEvent,
            proposals: merged.length ? merged : [fallback],
            acceptedExceptions,
            calculationRevision: current.calculationRevision + 1,
            decisionSummary: t('shell.conflictDecisionSummary', { count: decisions.length + exceptionDecisions.length, acceptedCount: acceptedExceptions.length }),
            moreExhausted: false,
          } : current)
        }}
        onRequestExternalChange={action => {
          setProposalSession(undefined)
          navigate(action === 'change-goal' ? 'goals' : 'settings')
        }}
        onApply={proposal => {
          const step = tutorialSessionRef.current?.step
          if (step === 'repair-preview') { void applyTutorialProposal(proposal, 'repair-preview', 'repair-calendar'); return }
          if (step === 'intake-preview') { void applyTutorialProposal(proposal, 'intake-preview', 'intake-calendar'); return }
          if (step === 'review-preview') { void applyTutorialProposal(proposal, 'review-preview', 'review-calendar'); return }
          if (step === 'future-preview') { void applyTutorialProposal(proposal, 'future-preview', 'future-calendar'); return }
          applySchedulingProposal(proposal, proposalSession.event)
          setActionNotice(t('shell.appliedProposalNotice', { title: proposal.title, count: proposal.metrics.movedTaskCount }))
          setProposalSession(undefined)
        }}
      />} 
      <ReviewDialog
        open={Boolean(reviewDate)}
        date={reviewDate ?? effectiveToday}
        onClose={closeReview}
        onPreparedDuration={openPrepared}
        onApplyCurrentPlan={applyCurrentReviewPlan}
        onRequestMorePlans={openMoreReviewPlans}
        tutorialMode={tutorialStepValue === 'review-carry'}
        onTutorialBlocked={tutorialNotice}
      />
      <SequenceRenumberDialog
        suggestion={sequenceRenumberSuggestion}
        onKeep={dismissSequenceRenumberSuggestion}
        onApply={applySequenceRenumber}
      />
      <AdjustmentIntentDialog
        open={adjustmentOpen}
        state={state}
        initialDate={adjustmentDate}
        initialReason={adjustmentReason}
        onClose={closeAdjustment}
        onPrepared={(prepared, event) => { setAdjustmentOpen(false); openPrepared(prepared, event) }}
        onOpenIntake={() => openAddTask()}
        onOpenDeadline={() => tutorialRestricted ? tutorialNotice() : setDeadlineDialogOpen(true)}
        onOpenBulkMove={() => tutorialRestricted ? tutorialNotice() : setBulkMoveCenterOpen(true)}
        onDurationSuggestion={suggestion => { if (tutorialRestricted) { tutorialNotice(); return }; const prepared = prepareDurationChange(suggestion); openPrepared(prepared.state, prepared.event) }}
        tutorialMode={tutorialStepValue === 'repair-action' ? 'repair' : tutorialStepValue === 'future-action' ? 'future' : undefined}
        onTutorialBlocked={tutorialNotice}
      />
      <GoalDeadlineDialog
        open={deadlineDialogOpen}
        state={state}
        onClose={() => setDeadlineDialogOpen(false)}
        onPrepared={openPrepared}
        onOpenGoals={() => navigate('goals')}
      />
      <BulkMoveCenterDialog
        open={bulkMoveCenterOpen}
        state={state}
        onClose={() => setBulkMoveCenterOpen(false)}
        onPrepared={openPrepared}
      />
      {actionNotice && !tutorialRestricted && <div className="action-result-toast"><div><strong>{actionNotice}</strong><span>{t('shell.actionSavedUndoHint')}</span></div><div><button className="secondary-button" disabled={!canUndo} onClick={() => { undo(); setActionNotice(t('shell.undoDone')) }}>{t('shell.undo')}</button><button className="text-button" onClick={() => setActionNotice(undefined)}>{t('shell.close')}</button></div></div>}
      <Modal open={firstLoginOpen} title={t('shell.welcomeChooseStartTitle')} onClose={() => {}}>
        <p className="onboarding-copy">{t('shell.welcomeChooseStartBody')}</p>
        <div className="template-options">
          {guestImportAvailable && <button onClick={() => void initializeAccount('import')}><strong>{t('shell.importModifiedGuestPlanTitle')}</strong><span>{t('shell.importModifiedGuestPlanBody')}</span></button>}
          <button onClick={() => { setFirstLoginOpen(false); setTutorialOfferOpen(true) }}><strong>{t('shell.experienceFullFlowTitle')}</strong><span>{t('shell.experienceFullFlowBody')}</span></button>
          <button onClick={() => void initializeAccount('blank')}><strong>{t('shell.startFromBlankTitle')}</strong><span>{t('shell.startFromBlankBody')}</span></button>
        </div>
      </Modal>
      <PwaUpdatePrompt />
      {tutorialBlockedNotice && <div className="tutorial-blocked-notice" role="status">{tutorialBlockedNotice}</div>}
      <Analytics />
    </div>
  )
}


function SequenceRenumberDialog({
  suggestion,
  onKeep,
  onApply
}: {
  suggestion?: SequenceRenumberSuggestion
  onKeep: () => void
  onApply: (groupIds?: string[]) => void
}) {
  const t = useT()
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    setSelectedGroupIds(suggestion?.groups.map(group => group.groupId) ?? [])
    setDetailsOpen(false)
  }, [suggestion])

  const sourceLabel = suggestion?.source === 'automatic'
    ? t('sequenceRenumber.sourceAutomatic')
    : suggestion?.source === 'mixed'
      ? t('sequenceRenumber.sourceMixed')
      : t('sequenceRenumber.sourceManual')

  return <>
    {suggestion && <div className="sequence-renumber-toast"><div><strong>{t('sequenceRenumber.toastTitle', { count: suggestion.groups.length })}</strong><span>{t('sequenceRenumber.toastBody')}</span></div><div className="button-wrap"><button className="secondary-button" onClick={onKeep}>{t('sequenceRenumber.keepOriginal')}</button><button className="primary-button" onClick={() => setDetailsOpen(true)}>{t('sequenceRenumber.viewSuggestion')}</button></div></div>}
    <Modal open={Boolean(suggestion && detailsOpen)} title={t('sequenceRenumber.dialogTitle')} onClose={() => setDetailsOpen(false)} wide mobileFullscreen>
    {suggestion && <>
      <p className="onboarding-copy">
        {t('sequenceRenumber.dialogBody', { sourceLabel })}
      </p>
      <div className="sequence-renumber-list">
        {suggestion.groups.map(group => {
          const selected = selectedGroupIds.includes(group.groupId)
          return <section className={`sequence-renumber-group ${selected ? 'selected' : ''}`} key={group.groupId}>
            <label className="sequence-renumber-head">
              <input
                type="checkbox"
                checked={selected}
                onChange={event => setSelectedGroupIds(current => event.target.checked
                  ? [...new Set([...current, group.groupId])]
                  : current.filter(id => id !== group.groupId))}
              />
              <span><strong>{group.groupTitle}</strong><small>{t('sequenceRenumber.taskCountAndChanges', { count: group.assignmentCount, changeCount: group.changes.length })}</small></span>
            </label>
            <div className="sequence-renumber-changes">
              {group.changes.slice(0, 8).map(change => <div key={change.assignmentId}>
                <span>{change.scheduledDate ? fmtDate(change.scheduledDate) : t('sequenceRenumber.unscheduled')}</span>
                <strong>{change.fromTitle}</strong>
                <em>→</em>
                <strong>{change.toTitle}</strong>
              </div>)}
              {group.changes.length > 8 && <small>{t('sequenceRenumber.moreWillRenumber', { count: group.changes.length - 8 })}</small>}
            </div>
          </section>
        })}
      </div>
      <p className="muted-text">{t('sequenceRenumber.footNote')}</p>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onKeep}>{t('sequenceRenumber.keepOriginal')}</button>
        <button className="primary-button" disabled={selectedGroupIds.length === 0} onClick={() => onApply(selectedGroupIds)}>
          {selectedGroupIds.length ? t('sequenceRenumber.applyByDateWithCount', { count: selectedGroupIds.length }) : t('sequenceRenumber.applyByDate')}
        </button>
      </div>
    </>}
    </Modal>
  </>
}

function ActiveTimerReturnButton({ onOpen }: { onOpen: () => void }) {
  const t = useT()
  const { state } = useApp()
  const [tick, setTick] = useState(0)
  const assignment = state.assignments.find(item => item.id === state.timer.assignmentId)
  useEffect(() => {
    if (!state.timer.running) return
    const id = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => window.clearInterval(id)
  }, [state.timer.running])
  void tick
  if (!assignment) return null
  const seconds = getTimerElapsedSeconds(state.timer)
  const elapsed = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return <button className={`active-timer-return ${state.timer.running ? 'running' : 'paused'}`} onClick={onOpen}><Clock3 size={16}/><span><strong>{state.timer.running ? t('activeTimer.running') : t('activeTimer.paused')}</strong><small>{elapsed}</small></span></button>
}

function TodayPage({ onNavigate, onPrepared, onAddTask, onReview, todayOverride, tutorialMode = false, tutorialStep, tutorialTargetId, onTutorialTaskRecorded, onTutorialBlocked }: { onNavigate: (page: Page) => void; onPrepared: (state: AppState, event: PlanChangeEvent) => void; onAddTask: (date: string) => void; onReview: (date: string) => void; todayOverride?: string; tutorialMode?: boolean; tutorialStep?: TutorialStep; tutorialTargetId?: string; onTutorialTaskRecorded?: (mode: 'complete' | 'partial') => void; onTutorialBlocked?: (message?: string) => void }) {
  const { state, namespace, commit, captureDailyPlanBaseline, startTimer } = useApp()
  const t = useT()
  const rawToday = todayOverride ?? todayISO()
  const defaultDate = clampDate(rawToday, state.settings.startDate, state.settings.endDate)
  const [date, setDate] = useState(defaultDate)
  const [completeTarget, setCompleteTarget] = useState<Assignment>()
  const [completeDate, setCompleteDate] = useState<string>()
  const [actual, setActual] = useState('')
  const [progress, setProgress] = useState(100)
  const [shiftOpen, setShiftOpen] = useState(false)
  const [shiftScope, setShiftScope] = useState<ShiftScope>('future')
  const [shiftDays, setShiftDays] = useState(1)
  const [reviewReminderDate, setReviewReminderDate] = useState<string>()
  const groups = useMemo(() => new Map(state.taskGroups.map(g => [g.id, g])), [state.taskGroups])
  const tasks = state.assignments.filter(a => a.scheduledDate === date).sort((a,b) => (groups.get(b.groupId)?.priority ?? 0) - (groups.get(a.groupId)?.priority ?? 0) || a.status.localeCompare(b.status))
  const activeTasks = tasks.filter(task => task.status !== 'done')
  const completedTasks = tasks.filter(task => task.status === 'done')
  const counted = tasks.filter(a => groups.get(a.groupId)?.countInStats || state.settings.countWordsTime)
  const dailyBaseline = state.dailyPlanBaselines.find(item => item.date === date)
  const originalPlanned = dailyBaseline
    ? dailyBaseline.assignments.reduce((sum, item) => sum + ((groups.get(item.groupId)?.countInStats || state.settings.countWordsTime) ? item.estimatedMinutes : 0), 0)
    : counted.reduce((sum, a) => sum + a.estimatedMinutes, 0)
  const remainingPlanned = counted.reduce((sum, a) => sum + effectiveMinutes(a), 0)
  const actualTotal = actualLearningSnapshot(state, date).actualMinutes
  const executionLoad = planningDayLoad(state, date)
  const done = tasks.filter(a => a.status === 'done').length
  const capacity = getCapacity(state, date)
  const config = getDayConfig(state, date)
  const isToday = date === rawToday
  const isPast = date < rawToday
  const dateContextLabel = isToday ? t('todayPage.today') : isPast ? fmtDate(date) : fmtDate(date)
  const goalRisks = allGoalProgress(state).filter(item => item.latestRisk || item.desiredRisk)
  const firstRiskGoal = goalRisks.length ? state.goals.find(goal => goal.id === goalRisks[0].goalId) : undefined
  const risk = executionLoad > capacity
    ? t('todayPage.riskOverCapacity', { context: dateContextLabel, minutes: minutesText(executionLoad - capacity) })
    : firstRiskGoal ? t(goalRisks[0].latestRisk ? 'todayPage.riskGoalLatestDate' : 'todayPage.riskGoalDesiredDate', { title: firstRiskGoal.title }) : undefined
  const pendingPastTasks = state.assignments.filter(item => item.status !== 'done' && item.scheduledDate && item.scheduledDate < rawToday && !groups.get(item.groupId)?.recurring)
  const resumableBatch = [...state.intakeBatches].reverse().find(batch => (batch.status === 'editing' || batch.status === 'pending' || batch.status === 'calculating') && batch.taskGroups.some(item => !item.appliedAt))
  const resumableBatchCount = resumableBatch?.taskGroups.filter(item => !item.appliedAt).length ?? 0
  useEffect(() => {
    if (rawToday < state.settings.startDate || rawToday > state.settings.endDate || state.dailyPlanBaselines.some(item => item.date === rawToday)) return
    captureDailyPlanBaseline(rawToday)
  }, [rawToday, state.settings.startDate, state.settings.endDate, state.dailyPlanBaselines, captureDailyPlanBaseline])
  useEffect(() => {
    if (!state.settings.optionalReview || tutorialMode || date !== rawToday || !tasks.length || !tasks.every(item => item.status === 'done') || state.reviewRecords.some(item => item.date === date)) return
    const key = `study-planner:auto-review:${namespace}:${date}`
    if (window.sessionStorage.getItem(key)) return
    window.sessionStorage.setItem(key, '1')
    onReview(date)
  }, [tasks.length, done, date, state.reviewRecords, state.settings.optionalReview, onReview, namespace])

  const shiftPreview = useMemo(() => {
    if (!shiftOpen) return { next: undefined, changes: [], ignoredLocked: 0, stayedAtEnd: 0, issues: [] }
    const next = cloneActiveState(state)
    const changes: Array<{ id: string; title: string; from: string; to: string }> = []
    let ignoredLocked = 0
    let stayedAtEnd = 0
    const days = Math.max(1, Math.min(14, Math.round(shiftDays || 1)))
    const movedAt = new Date().toISOString()
    for (const assignment of next.assignments) {
      const group = groups.get(assignment.groupId)
      if (!assignment.scheduledDate || assignment.status === 'done' || group?.recurring) continue
      const inScope = shiftScope === 'today' ? assignment.scheduledDate === date : assignment.scheduledDate >= date
      if (!inScope) continue
      if (assignment.locked || next.timer.assignmentId === assignment.id) { ignoredLocked += 1; continue }
      const from = assignment.scheduledDate
      const rawTarget = shiftDate(from, days)
      const to = rawTarget > next.settings.endDate ? next.settings.endDate : rawTarget
      if (to === from) { stayedAtEnd += 1; continue }
      assignment.previousDate = from
      assignment.scheduledDate = to
      assignment.lastManualMoveAt = movedAt
      assignment.scheduleSource = 'carryover'
      assignment.intentStrength = assignment.locked ? 'locked' : 'manual'
      changes.push({ id: assignment.id, title: assignment.title, from, to })
    }
    next.updatedAt = movedAt
    return {
      next,
      changes,
      ignoredLocked,
      stayedAtEnd,
      issues: analyzePlan(next, date).slice(0, 10)
    }
  }, [state, groups, date, shiftScope, shiftDays, shiftOpen])

  const applyShift = () => {
    if (!shiftPreview.next || !shiftPreview.changes.length) return
    const next = shiftPreview.next
    const now = new Date().toISOString()
    const affectedAssignmentIds = shiftPreview.changes.map(item => item.id)
    const affectedDates = Array.from(new Set(shiftPreview.changes.flatMap(item => [item.from, item.to]))).sort()
    const affectedGroupIds = Array.from(new Set(next.assignments.filter(item => affectedAssignmentIds.includes(item.id)).map(item => item.groupId)))
    const affectedGoalIds = next.goals.filter(goal => goal.linkedTaskGroupIds.some(id => affectedGroupIds.includes(id)) || goal.linkedAssignmentIds.some(id => affectedAssignmentIds.includes(id)) || goal.completionConditions.some(condition => affectedGroupIds.includes(condition.groupId))).map(goal => goal.id)
    const event: PlanChangeEvent = {
      id: uid('event'), type: 'bulk-move', action: 'repair',
      title: shiftScope === 'today' ? t('todayPage.shiftEventTitleToday', { date: fmtDate(date) }) : t('todayPage.shiftEventTitleFuture', { date: fmtDate(date) }),
      description: t('todayPage.shiftEventDescription', { days: Math.max(1, Math.min(14, Math.round(shiftDays || 1))) }),
      affectedGoalIds, affectedGroupIds, affectedAssignmentIds, affectedDates, createdAt: now,
      metadata: { shiftScope, shiftDays: Math.max(1, Math.min(14, Math.round(shiftDays || 1))), preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'] },
    }
    next.changeEvents = [...next.changeEvents, event].slice(-100)
    next.updatedAt = now
    setShiftOpen(false)
    onPrepared(next, event)
  }


  useEffect(() => {
    if (tutorialMode) return
    const current = rawToday
    if (current <= state.settings.startDate) return
    const reviewedDates = new Set(state.reviewRecords.map(record => record.date))
    const previousDate = state.assignments
      .filter(a => a.scheduledDate && a.scheduledDate < current && !groups.get(a.groupId)?.recurring && !reviewedDates.has(a.scheduledDate))
      .map(a => a.scheduledDate!)
      .sort()
      .at(-1)
    if (!previousDate) return
    const promptKey = `study-planner:carryover-prompt:${namespace}:${current}`
    if (window.sessionStorage.getItem(promptKey)) return
    window.sessionStorage.setItem(promptKey, '1')
    setReviewReminderDate(previousDate)
  }, [namespace, state.settings.startDate, state.assignments, state.reviewRecords, groups, tutorialMode, rawToday])

  const openComplete = (a: Assignment) => {
    if (tutorialMode && (!['execute-complete', 'execute-partial'].includes(tutorialStep ?? '') || a.id !== tutorialTargetId)) { onTutorialBlocked?.(t('todayPage.tutorialBlockedHighlighted')); return }
    if (state.timer.assignmentId === a.id) { onNavigate('timer'); return }
    setCompleteTarget(a); setCompleteDate(date); setActual(tutorialMode && a.id === tutorialTargetId ? (tutorialStep === 'execute-partial' ? '12' : '52') : ''); setProgress(tutorialMode && tutorialStep === 'execute-partial' ? 50 : 100)
  }

  const closeCompletion = () => {
    setCompleteTarget(undefined)
    setCompleteDate(undefined)
  }

  const saveCompletion = (finish: boolean) => {
    if (!completeTarget) return
    const minutes = Math.max(0, Number(actual) || 0)
    const viewedDate = completeDate ?? date
    const currentDate = rawToday
    const actualDate = viewedDate < currentDate ? viewedDate : currentDate
    const actualTimestamp = timestampForDate(actualDate)
    commit(draft => {
      const item = draft.assignments.find(a => a.id === completeTarget.id)
      if (!item) return
      const changedAt = new Date().toISOString()
      const activeTimerMinutes = draft.timer.assignmentId === item.id ? Math.max(1, Math.round(getTimerElapsedSeconds(draft.timer) / 60)) : 0
      const minutesToRecord = minutes || activeTimerMinutes
      if (minutesToRecord) {
        item.actualMinutes += minutesToRecord
        item.timeEntries.push({ id: uid('time'), minutes: minutesToRecord, date: actualDate, createdAt: changedAt, source: activeTimerMinutes && !minutes ? 'timer' : 'manual' })
      } else if (finish && item.actualMinutes <= 0) {
        addInferredCompletionEntry(item, actualDate, changedAt)
      }
      item.progress = finish ? 100 : Math.min(99, Math.max(1, progress))
      item.remainingMinutes = finish ? 0 : effectiveMinutes(item)
      item.status = finish ? 'done' : 'partial'
      item.completedAt = finish ? actualTimestamp : undefined
      appendStatusEvent(item, item.status, item.progress, actualDate, finish ? 'completion' : 'partial', changedAt)
      if (draft.timer.assignmentId === item.id) draft.timer = { accumulatedSeconds: 0, running: false }
    }, tutorialMode ? { tutorialAction: 'execute-task', tutorialTargetId: completeTarget.id } : undefined)
    closeCompletion()
    if (tutorialMode && completeTarget.id === tutorialTargetId) {
      if (tutorialStep === 'execute-complete' && finish) onTutorialTaskRecorded?.('complete')
      if (tutorialStep === 'execute-partial' && !finish) onTutorialTaskRecorded?.('partial')
    }
  }

  return <>
    <section className="today-hero">
      <div className="today-hero-main">
        <div className="date-switcher"><button className={`icon-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} aria-label={t('shell.viewPreviousDay')} onClick={() => tutorialMode ? onTutorialBlocked?.(t('todayPage.tutorialDateFixed')) : setDate(clampDate(format(new Date(parseISO(date).getTime()-86400000),'yyyy-MM-dd'), state.settings.startDate,state.settings.endDate))}><ChevronLeft size={19}/></button><div><h2>{fmtDate(date)} · {fmtWeekday(date)}</h2><span className={`day-badge day-${config.type}`}>{dayTypeLabel[config.type]}</span></div><button className={`icon-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} aria-label={t('shell.viewNextDay')} onClick={() => tutorialMode ? onTutorialBlocked?.(t('todayPage.tutorialDateFixed')) : setDate(clampDate(format(new Date(parseISO(date).getTime()+86400000),'yyyy-MM-dd'), state.settings.startDate,state.settings.endDate))}><ChevronRight size={19}/></button></div>
        <p>{tasks.length
          ? t('todayPage.summaryWithTasks', { context: isToday ? t('todayPage.today') : isPast ? t('todayPage.thatDayFormal') : t('todayPage.thatDay'), count: tasks.length, done, minutes: minutesText(remainingPlanned) })
          : isToday && resumableBatchCount
            ? t('todayPage.summaryNoneScheduledResumable', { count: resumableBatchCount })
            : t('todayPage.summaryNoneScheduled', { context: isToday ? t('todayPage.today') : t('todayPage.thatDay') })}</p>
      </div>
      <div className="button-wrap today-hero-actions"><button className={`primary-button subtle-action ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('todayPage.tutorialNoExtraTasks')) : onAddTask(date)}><Plus size={16}/>{t('todayPage.addTask')}</button><button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('todayPage.tutorialFinishStepThenCalendar')) : onNavigate('calendar')}><CalendarDays size={16}/>{t('todayPage.openCalendar')}</button><button className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={()=>tutorialMode ? onTutorialBlocked?.(t('todayPage.tutorialNoExtraShift')) : setShiftOpen(true)}>{t('todayPage.bulkPostpone')}</button>{!(!isToday && !isPast) && <button className={`secondary-button today-review-button ${tutorialMode && tutorialStep === 'review-entry' ? 'tutorial-target' : ''} ${tutorialMode && tutorialStep !== 'review-entry' ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode && tutorialStep !== 'review-entry' ? true : undefined} data-tutorial-target={tutorialMode && tutorialStep === 'review-entry' ? 'today-review' : undefined} data-tutorial-action={tutorialMode && tutorialStep === 'review-entry' ? 'open-review' : undefined} onClick={() => tutorialMode && tutorialStep !== 'review-entry' ? onTutorialBlocked?.(t('todayPage.tutorialFinishHighlighted')) : onReview(date)}>{isToday ? t('todayPage.endTodayAndReview') : t('todayPage.reviewThisDay')}</button>}</div>
    </section>
    {!tutorialMode && resumableBatch && (tasks.length > 0 || state.assignments.length > 0) && <div className="intake-resume-banner"><div><Inbox size={19}/><span><strong>{t('todayPage.resumeBannerTitle', { count: resumableBatchCount })}</strong><small>{t('todayPage.resumeBannerBody')}</small></span></div><button className="primary-button" onClick={() => onNavigate('intake')}>{t('todayPage.scheduleNow')}</button></div>}
    {!tutorialMode && reviewReminderDate && <div className="review-reminder-banner"><div><strong>{t('todayPage.reviewReminderTitle', { date: fmtDate(reviewReminderDate) })}</strong><span>{t('todayPage.reviewReminderBody')}</span></div><div><button className="secondary-button" onClick={() => setReviewReminderDate(undefined)}>{t('todayPage.later')}</button><button className="primary-button" onClick={() => { setDate(reviewReminderDate); onReview(reviewReminderDate); setReviewReminderDate(undefined) }}>{t('todayPage.openReview')}</button></div></div>}
    {!tutorialMode && pendingPastTasks.length > 0 && <div className="review-reminder-banner pending-task-banner"><div><strong>{t('todayPage.pendingPastTasksTitle', { count: pendingPastTasks.length })}</strong><span>{t('todayPage.pendingPastTasksBody')}</span></div><div><button className="primary-button" onClick={() => onNavigate('tasks')}>{t('todayPage.viewPendingTasks')}</button></div></div>}
    <section className="compact-metrics today-load-metrics">
      <div><span>{t('todayPage.originalPlan')}</span><strong>{minutesText(originalPlanned)}</strong></div>
      <div><span>{t('todayPage.actualSoFar')}</span><strong>{minutesText(actualTotal)}</strong></div>
      <div><span>{t('todayPage.remainingPlanned')}</span><strong>{minutesText(remainingPlanned)}</strong></div>
      <div className={executionLoad > capacity ? 'metric-over' : ''}><span>{t('todayPage.executionLoadOverCapacity')}</span><strong>{minutesText(executionLoad)} / {minutesText(capacity)}</strong></div>
    </section>
    <div className="load-metric-note" role="note"><Sparkles size={15}/><span><strong>{t('todayPage.metricNoteTitle')}</strong>{t('todayPage.metricNoteBody')}</span></div>
    {state.settings.showWarnings && risk && <div className="alert warning"><Sparkles size={18}/><div><strong>{t('todayPage.progressAlertTitle')}</strong><span>{risk}</span></div></div>}
    {isToday && activeTasks[0] && <section className="today-next-focus"><div><span><Sparkles size={15}/>{t('todayPage.nextSuggestion')}</span><strong>{activeTasks[0].title}</strong><small>{groups.get(activeTasks[0].groupId)?.subject ?? t('todayPage.other')} · {t('todayPage.remainingAbout', { minutes: minutesText(effectiveMinutes(activeTasks[0])) })}</small></div><button className={`primary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => { if (tutorialMode) { onTutorialBlocked?.(t('todayPage.tutorialFinishHighlightedThenFocus')); return }; startTimer(activeTasks[0].id); onNavigate('timer') }}><Clock3 size={16}/>{t('todayPage.startFocus')}</button></section>}
    <section className="section-block">
      <div className="section-title"><div><h2>{isToday ? t('todayPage.todayTasksTitle') : isPast ? t('todayPage.pastExecutionRecordTitle', { date: fmtDate(date) }) : t('todayPage.plannedTasksTitle', { date: fmtDate(date) })}</h2><p>{isPast ? t('todayPage.pastSectionHint') : t('todayPage.todaySectionHint')}</p></div></div>
      <div className="task-list">{tasks.length ? <>
        {activeTasks.map(a => <TaskCard key={a.id} assignment={a} group={groups.get(a.groupId)!} onComplete={openComplete} onOpenTimer={() => onNavigate('timer')} tutorialTarget={tutorialMode && ['execute-complete', 'execute-partial'].includes(tutorialStep ?? '') && a.id === tutorialTargetId} tutorialLocked={tutorialMode} tutorialDisabled={tutorialMode && !(['execute-complete', 'execute-partial'].includes(tutorialStep ?? '') && a.id === tutorialTargetId)} onTutorialBlocked={onTutorialBlocked}/>)}
        {completedTasks.length > 0 && <details className="completed-task-section"><summary>{t('todayPage.completedCount', { count: completedTasks.length })}<span>{t('todayPage.expandToView')}</span></summary><div>{completedTasks.map(a => <TaskCard key={a.id} assignment={a} group={groups.get(a.groupId)!} onComplete={openComplete} onOpenTimer={() => onNavigate('timer')} tutorialLocked={tutorialMode} tutorialDisabled={tutorialMode} onTutorialBlocked={onTutorialBlocked}/>)}</div></details>}
      </> : <div className="empty-state today-empty-actions"><CheckCircle2 size={30}/><h3>{isToday ? t('todayPage.emptyTodayTitle') : t('todayPage.emptyDayTitle')}</h3><p>{isToday && resumableBatchCount ? t('todayPage.emptyResumableHint', { count: resumableBatchCount }) : state.assignments.length ? t('todayPage.emptyHasAssignmentsHint') : t('todayPage.emptyNoAssignmentsHint')}</p>{!state.assignments.length && <button className="primary-button" onClick={() => onNavigate('intake')}><Inbox size={16}/>{resumableBatchCount ? t('todayPage.scheduleNow') : t('todayPage.startIntake')}</button>}</div>}</div>
    </section>
    <Modal open={Boolean(completeTarget)} title={completeTarget ? t('todayPage.recordTitle', { title: completeTarget.title }) : t('todayPage.recordTaskTitle')} onClose={closeCompletion}>
      <div className="form-stack">
        <p className="muted-text">{completeDate && completeDate < rawToday ? t('todayPage.historicalNote', { date: fmtDate(completeDate) }) : t('todayPage.actualCountsTowardToday')}</p>
        <label className="field"><span>{tutorialMode ? t('todayPage.actualMinutesLabelTutorial') : t('todayPage.actualMinutesLabel')}</span><NumericInput min={tutorialMode ? 1 : 0} max={tutorialMode ? 65 : 1440} step={1} value={actual === '' ? undefined : Number(actual)} onValueChange={value => setActual(String(value))} onEmpty={() => setActual('')} autoFocus={!tutorialMode}/></label>
        {(!tutorialMode || tutorialStep === 'execute-partial') && <label className="field"><span>{t('todayPage.progressLabel')}</span><NumericInput min={1} max={99} value={progress} onValueChange={setProgress}/></label>}
      </div>
      <div className="modal-actions"><button className={`secondary-button ${tutorialMode && tutorialStep !== 'execute-partial' ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode && tutorialStep !== 'execute-partial' || undefined} data-tutorial-target={tutorialMode && tutorialStep === 'execute-partial' ? 'tutorial-partial-confirm' : undefined} onClick={() => tutorialMode && tutorialStep !== 'execute-partial' ? onTutorialBlocked?.(t('todayPage.tutorialFollowHighlightedStep')) : saveCompletion(false)}>{t('todayPage.saveAsPartial')}</button><button className={`primary-button ${tutorialMode && tutorialStep === 'execute-complete' ? 'tutorial-target' : tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode && tutorialStep !== 'execute-complete' || undefined} data-tutorial-target={tutorialMode && tutorialStep === 'execute-complete' ? 'tutorial-complete-confirm' : undefined} data-tutorial-action={tutorialMode ? 'completion-primary' : undefined} disabled={tutorialMode && tutorialStep === 'execute-complete' && (!actual || Number(actual) < 1 || Number(actual) > 65)} onClick={() => tutorialMode && tutorialStep !== 'execute-complete' ? onTutorialBlocked?.(t('todayPage.tutorialRecordPartialFirst')) : saveCompletion(true)}>{t('todayPage.markComplete')}</button></div>
    </Modal>
    <Modal open={shiftOpen} title={t('todayPage.bulkShiftTitle')} onClose={()=>setShiftOpen(false)} wide mobileFullscreen>
      <p className="muted-text">{t('todayPage.bulkShiftHint')}</p>
      <div className="replan-controls">
        <div className="segmented-control">
          <button className={shiftScope==='today'?'active':''} onClick={()=>setShiftScope('today')}>{t('todayPage.onlyTodayUnfinished')}</button>
          <button className={shiftScope==='future'?'active':''} onClick={()=>setShiftScope('future')}>{t('todayPage.fromTodayAllFuture')}</button>
        </div>
        <label className="field compact-field"><span>{t('todayPage.shiftDaysLabel')}</span><NumericInput min={1} max={14} value={shiftDays} onValueChange={setShiftDays}/></label>
        <div className="lock-choice static"><Lock size={14}/>{t('todayPage.lockedTasksNeverMove')}</div>
      </div>
      <div className="summary-grid replan-summary-grid">
        <div className="metric-card"><span>{t('todayPage.willMove')}</span><strong>{shiftPreview.changes.length}</strong><small>{t('todayPage.tasksUnit')}</small></div>
        <div className="metric-card"><span>{t('todayPage.lockedNotMoved')}</span><strong>{shiftPreview.ignoredLocked}</strong><small>{t('todayPage.itemsUnit')}</small></div>
        <div className="metric-card"><span>{t('todayPage.stayedAtEndDate')}</span><strong>{shiftPreview.stayedAtEnd}</strong><small>{t('todayPage.itemsUnit')}</small></div>
        <div className="metric-card"><span>{t('todayPage.affectedScope')}</span><strong>{shiftScope==='today'?t('todayPage.thatDayScope'):t('todayPage.restAllScope')}</strong><small>{t('todayPage.postponeDaysUnit', { days: shiftDays })}</small></div>
      </div>
      <section className="replan-section">
        <div className="replan-section-title"><CalendarDays size={18}/><div><h3>{t('todayPage.changePreviewTitle')}</h3><p>{t('todayPage.changePreviewHint')}</p></div></div>
        <div className="carryover-list">{shiftPreview.changes.slice(0,16).map(change=><div className="carryover-row" key={change.id}><div><strong>{change.title}</strong><span>{change.from} → {change.to}</span></div></div>)}</div>
      </section>
      {shiftPreview.issues.length>0&&<section className="replan-section warning-section"><div className="replan-section-title"><Sparkles size={18}/><div><h3>{t('todayPage.postApplyImpactTitle')}</h3><p>{t('todayPage.postApplyImpactHint')}</p></div></div><div className="warning-list">{shiftPreview.issues.map((issue,index)=><div key={index} className={`warning-item issue-${issue.level}`}>{issue.message}</div>)}</div></section>}
      <div className="modal-actions"><button className="secondary-button" onClick={()=>setShiftOpen(false)}>{t('todayPage.cancel')}</button><button className="primary-button" disabled={!shiftPreview.changes.length} onClick={applyShift}>{t('todayPage.generateFullPreview')}</button></div>
    </Modal>
  </>
}

function CalendarPage({ onPrepared, onOpenAdjustment, onAddTask, tutorialMode = false, tutorialHighlightDates = [], onTutorialBlocked }: { onPrepared: (state: AppState, event: PlanChangeEvent) => void; onOpenAdjustment: (date: string) => void; onAddTask: (date: string) => void; tutorialMode?: boolean; tutorialHighlightDates?: string[]; onTutorialBlocked?: (message?: string) => void }) {
  const { state, commit, updateAssignment, updateDayConfig, moveAssignments, reopenAssignment, prepareAssignmentDelete, prepareDurationChange, prepareAssignmentGroupChange } = useApp()
  const t = useT()
  // 月历任务卡的原生拖拽仅在纯鼠标桌面环境启用（触屏笔记本/Edge 会让 HTML5 拖拽抢占纵向滑动）。
  const nativeDragEnabled = nativeTaskDragAvailable()
  const initialCalendarDate = todayISO() >= state.settings.startDate && todayISO() <= state.settings.endDate ? todayISO() : state.settings.startDate
  const [month, setMonth] = useState(startOfMonth(parseISO(initialCalendarDate)))
  const [viewMode, setViewMode] = useState<'month' | 'week'>(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches ? 'week' : 'month')
  const [weekStart, setWeekStart] = useState(() => shiftDate(initialCalendarDate, -getDay(parseISO(initialCalendarDate))))
  const [dayOpen, setDayOpen] = useState<string>()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [overflowSelectedIds, setOverflowSelectedIds] = useState<string[]>([])
  const [overflowPanel, setOverflowPanel] = useState<{ date: string; top: number; left: number }>()
  const [taskOpenId, setTaskOpenId] = useState<string>()
  const [taskTitleDraft, setTaskTitleDraft] = useState('')
  const [taskDurationDraft, setTaskDurationDraft] = useState<number>()
  const [groupChangeTargetId, setGroupChangeTargetId] = useState<string>()
  const [moveNotice, setMoveNotice] = useState<{ id: string; title: string; date: string }>()
  const [bulkMoveDialog, setBulkMoveDialog] = useState<{ ids: string[]; target: string }>()
  const [pendingDayType, setPendingDayType] = useState<DayType>()
  const [pendingDayNote, setPendingDayNote] = useState('')
  const [pendingCustomMinutes, setPendingCustomMinutes] = useState<number>()
  const [pendingAvailabilityMode, setPendingAvailabilityMode] = useState<'default' | 'reduced' | 'rest'>('default')
  const [pendingAvailableMinutes, setPendingAvailableMinutes] = useState<number>(60)
  const [pendingBufferReason, setPendingBufferReason] = useState('')
  const [pendingBufferPreference, setPendingBufferPreference] = useState<BufferPreference>('preserve')
  const [dragAssignmentId, setDragAssignmentId] = useState<string>()
  const [dragTargetDate, setDragTargetDate] = useState<string>()
  const [calendarExportNotice, setCalendarExportNotice] = useState('')
  const [moveModeTaskId, setMoveModeTaskId] = useState<string>()
  const longPressActivated = useRef(false)
  const [calendarTaskLimit, setCalendarTaskLimit] = useState(() => window.innerWidth >= 1400 ? 4 : window.innerWidth >= 900 ? 3 : 2)
  const longPressTimer = useRef<number>()
  const groups = useMemo(() => new Map(state.taskGroups.map(group => [group.id, group])), [state.taskGroups])

  useEffect(() => {
    const item = taskOpenId ? state.assignments.find(assignment => assignment.id === taskOpenId) : undefined
    setTaskTitleDraft(item?.title ?? '')
    setTaskDurationDraft(item?.estimatedMinutes)
  }, [taskOpenId])

  useEffect(() => {
    const updateLimit = () => setCalendarTaskLimit(window.innerWidth >= 1400 ? 4 : window.innerWidth >= 900 ? 3 : 2)
    window.addEventListener('resize', updateLimit)
    return () => window.removeEventListener('resize', updateLimit)
  }, [])

  useEffect(() => {
    if (!overflowPanel) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.calendar-overflow-panel') || target?.closest('.calendar-more-button')) return
      setOverflowPanel(undefined)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [overflowPanel])
  const monthStart = startOfMonth(month)
  const monthEnd = endOfMonth(month)
  const monthDays = dateRange(format(monthStart, 'yyyy-MM-dd'), format(monthEnd, 'yyyy-MM-dd'))
  const weekDays = dateRange(weekStart, shiftDate(weekStart, 6))
  const days = viewMode === 'month' ? monthDays : weekDays
  const blanks = viewMode === 'month' ? Array.from({ length: getDay(monthStart) }) : []
  const planInterval = { start: parseISO(state.settings.startDate), end: parseISO(state.settings.endDate) }

  const sortTasks = (items: Assignment[]) => [...items].sort((a, b) => {
    const runningA = state.timer.assignmentId === a.id && state.timer.running ? 1 : 0
    const runningB = state.timer.assignmentId === b.id && state.timer.running ? 1 : 0
    if (runningA !== runningB) return runningB - runningA
    const manualA = a.intentStrength === 'manual' ? 1 : 0
    const manualB = b.intentStrength === 'manual' ? 1 : 0
    if (manualA !== manualB) return manualB - manualA
    if (a.locked !== b.locked) return Number(b.locked) - Number(a.locked)
    const priorityA = groups.get(a.groupId)?.priority ?? 0
    const priorityB = groups.get(b.groupId)?.priority ?? 0
    if (priorityA !== priorityB) return priorityB - priorityA
    if (a.status === 'done' && b.status !== 'done') return 1
    if (a.status !== 'done' && b.status === 'done') return -1
    return effectiveMinutes(b) - effectiveMinutes(a)
  })

  const prepareCalendarDayChange = (date: string, prepared: AppState) => {
    const now = new Date().toISOString()
    const before = getDayConfig(state, date)
    const after = getDayConfig(prepared, date)
    const affectedAssignmentIds = prepared.assignments.filter(item => item.scheduledDate === date && item.status !== 'done').map(item => item.id)
    const affectedGroupIds = Array.from(new Set(prepared.assignments.filter(item => affectedAssignmentIds.includes(item.id)).map(item => item.groupId)))
    const affectedGoalIds = prepared.goals.filter(goal => goal.linkedTaskGroupIds.some(id => affectedGroupIds.includes(id)) || goal.linkedAssignmentIds.some(id => affectedAssignmentIds.includes(id)) || goal.completionConditions.some(condition => affectedGroupIds.includes(condition.groupId))).map(goal => goal.id)
    const availabilityBefore = getCapacity(state, date)
    const availabilityAfter = getCapacity(prepared, date)
    const protectionBefore = isDateProtected(state, date)
    const protectionAfter = isDateProtected(prepared, date)
    const tightening = availabilityAfter < availabilityBefore || (!protectionBefore && protectionAfter)
    const event: PlanChangeEvent = {
      id: uid('event'), type: 'availability-change', action: tightening ? 'repair' : 'optimize',
      title: tightening ? t('calendarPage.tighteningTitle', { date: fmtDate(date) }) : t('calendarPage.looseningTitle', { date: fmtDate(date) }),
      description: tightening
        ? t('calendarPage.tighteningDesc', { before: minutesText(availabilityBefore), after: minutesText(availabilityAfter), beforeType: dayTypeLabel[before.type], afterType: dayTypeLabel[after.type] })
        : t('calendarPage.looseningDesc', { before: minutesText(availabilityBefore), after: minutesText(availabilityAfter), beforeType: dayTypeLabel[before.type], afterType: dayTypeLabel[after.type] }),
      affectedGoalIds, affectedGroupIds, affectedAssignmentIds, affectedDates: [date], createdAt: now,
      metadata: {
        preferredPreferences: tightening
          ? [after.bufferPreference === 'goal' ? 'goal' : after.bufferPreference === 'spread' ? 'balanced' : 'preserve', 'balanced', 'goal', 'rest']
          : ['preserve', 'rest', 'balanced', 'goal'],
        availabilityBefore, availabilityAfter, protectionBefore, protectionAfter, availabilityRelaxed: !tightening,
      },
    }
    prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
    prepared.updatedAt = now
    onPrepared(prepared, event)
  }

  const tasksFor = (date: string) => sortTasks(state.assignments.filter(assignment => assignment.scheduledDate === date))
  const countedMinutes = (assignment: Assignment) => effectiveMinutes(assignment)
  const loadFor = (date: string) => planningDayLoad(state, date)

  const moveWithValidation = (assignmentId: string, targetDate: string) => {
    const assignment = state.assignments.find(item => item.id === assignmentId)
    const group = assignment && groups.get(assignment.groupId)
    if (!assignment || !group || assignment.scheduledDate === targetDate) return false
    if (assignment.status === 'done') { window.alert(t('calendarPage.alertDoneTaskLocked')); return false }
    if (assignment.locked) { window.alert(t('calendarPage.alertTaskLocked')); return false }
    if (state.timer.assignmentId === assignment.id) { window.alert(t('calendarPage.alertTimerRunning')); return false }
    if (!targetDate || targetDate < state.settings.startDate || targetDate > state.settings.endDate) {
      window.alert(t('calendarPage.alertOutOfRange'))
      return false
    }

    const placementChecks = checkAssignmentPlacement(state, assignmentId, targetDate)
    const overrideable = (key: string) => key === 'capacity' || key.startsWith('group:') || key.startsWith('activity:') || key === 'long' || key === 'high-intensity' || key === 'date-protection' || key === 'protected-buffer' || key === 'today-closed' || key === 'today-extra'
    const nonOverrideable = placementChecks.filter(item => item.hard && !overrideable(item.key))
    if (nonOverrideable.length) {
      window.alert(nonOverrideable.map(item => item.label).join('；'))
      return false
    }

    const sourceProtected = Boolean(assignment.scheduledDate && isDateProtected(state, assignment.scheduledDate))
    const targetProtected = isDateProtected(state, targetDate)
    const hardOverrideable = placementChecks.filter(item => item.hard && overrideable(item.key))
    if (sourceProtected || targetProtected || hardOverrideable.length) {
      const prepared = cloneActiveState(state)
      const draftTask = prepared.assignments.find(item => item.id === assignment.id)
      if (!draftTask) return false
      const movedAt = new Date().toISOString()
      const oldDate = draftTask.scheduledDate
      draftTask.previousDate = oldDate
      draftTask.scheduledDate = targetDate
      draftTask.lastManualMoveAt = movedAt
      draftTask.scheduleSource = 'manual'
      draftTask.intentStrength = 'manual'
      draftTask.updatedAt = movedAt
      const affectedGoalIds = prepared.goals.filter(goal => goal.linkedAssignmentIds.includes(draftTask.id) || goal.linkedTaskGroupIds.includes(draftTask.groupId) || goal.completionConditions.some(condition => condition.groupId === draftTask.groupId)).map(goal => goal.id)
      const event: PlanChangeEvent = {
        id: uid('event'), type: 'bulk-move', action: 'repair', title: t('calendarPage.moveEventTitle', { title: draftTask.title }),
        description: t('calendarPage.moveEventDesc', { from: oldDate ?? t('sequenceRenumber.unscheduled'), to: targetDate }),
        affectedGoalIds, affectedGroupIds: [draftTask.groupId], affectedAssignmentIds: [draftTask.id],
        affectedDates: Array.from(new Set([oldDate, targetDate].filter((date): date is string => Boolean(date)))).sort(), createdAt: movedAt,
        metadata: { requestedDate: targetDate, manualMove: true, preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'] },
      }
      prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
      prepared.updatedAt = movedAt
      setTaskOpenId(undefined)
      onPrepared(prepared, event)
      return true
    }

    const targetLoad = loadFor(targetDate) - (assignment.scheduledDate === targetDate ? countedMinutes(assignment) : 0)
    const projected = targetLoad + countedMinutes(assignment)
    const capacity = getCapacity(state, targetDate)
    const risks: string[] = []
    const desiredDate = nearestRelevantGoalDate(state, assignment)
    if (desiredDate && targetDate > desiredDate) risks.push(t('calendarPage.riskPastGoalDate', { date: desiredDate }))
    if (projected > capacity) risks.push(t('calendarPage.riskOverCapacity', { before: minutesText(targetLoad), after: minutesText(projected), over: minutesText(projected - capacity) }))
    if (risks.length && !window.confirm(t('calendarPage.confirmMove', { title: assignment.title, date: targetDate, risks: risks.join('\n') }))) return false
    updateAssignment(assignmentId, { scheduledDate: targetDate })
    setMoveNotice({ id: assignmentId, title: assignment.title, date: targetDate })
    return true
  }

  const drop = (date: string, event: React.DragEvent) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/assignment-id') || dragAssignmentId
    if (id) moveWithValidation(id, date)
    setDragAssignmentId(undefined)
    setDragTargetDate(undefined)
  }

  const beginDrag = (assignment: Assignment, event: React.DragEvent) => {
    window.clearTimeout(longPressTimer.current)
    event.stopPropagation()
    setDragAssignmentId(assignment.id)
    event.dataTransfer.setData('text/assignment-id', assignment.id)
    event.dataTransfer.effectAllowed = 'move'
  }

  const startLongPress = (assignmentId: string) => {
    const candidate = state.assignments.find(item => item.id === assignmentId)
    if (!candidate || candidate.locked) return
    window.clearTimeout(longPressTimer.current)
    longPressActivated.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressActivated.current = true
      setMoveModeTaskId(assignmentId)
      setTaskOpenId(undefined)
      setDayOpen(undefined)
      if (navigator.vibrate) navigator.vibrate(35)
    }, 460)
  }
  const cancelLongPress = () => window.clearTimeout(longPressTimer.current)
  const openTaskUnlessLongPressed = (assignmentId: string) => {
    if (longPressActivated.current) { longPressActivated.current = false; return }
    setTaskOpenId(assignmentId)
  }
  const chooseCalendarDate = (date: string) => {
    if (moveModeTaskId) {
      if (moveWithValidation(moveModeTaskId, date)) setMoveModeTaskId(undefined)
      return
    }
    setDayOpen(date)
    const current = getDayConfig(state, date)
    const constraint = constraintsForDate(state, date).slice().reverse().find(item => ['unavailable', 'reduced-capacity', 'special-capacity', 'protected-buffer'].includes(item.kind))
    setPendingDayType(current.type)
    setPendingDayNote(current.note ?? '')
    setPendingCustomMinutes(current.customMinutes)
    setPendingAvailabilityMode(constraint?.kind === 'unavailable' || current.type === 'travel' || current.availableMinutes === 0 ? 'rest' : constraint || current.isBufferDay ? 'reduced' : 'default')
    setPendingAvailableMinutes(constraint?.capacityMinutes ?? current.availableMinutes ?? 60)
    setPendingBufferReason(constraint?.reason ?? current.bufferReason ?? '')
    setPendingBufferPreference(constraint?.preference ?? current.bufferPreference ?? 'preserve')
  }
  const moveCalendarWindow = (direction: -1 | 1) => {
    if (viewMode === 'month') setMonth(addMonths(month, direction))
    else setWeekStart(previous => shiftDate(previous, direction * 7))
  }
  const currentCalendarMonth = format(month, 'yyyy-MM')
  const openCalendarPrint = () => {
    const reportWindow = window.open('', '_blank')
    if (!reportWindow) {
      setCalendarExportNotice(t('calendarPage.exportBlockedPopup'))
      return
    }
    reportWindow.opener = null
    reportWindow.document.open()
    reportWindow.document.write(buildCalendarPrintHtml(state, currentCalendarMonth))
    reportWindow.document.close()
    reportWindow.focus()
    window.setTimeout(() => reportWindow.print(), 250)
    setCalendarExportNotice(t('calendarPage.exportPrintReady'))
  }
  const downloadCalendarImage = () => {
    setCalendarExportNotice(t('calendarPage.exportGeneratingPng'))
    void downloadSvgAsPng(`${safeExportName(state.settings.planName)}-${currentCalendarMonth}-calendar.png`, buildCalendarSvg(state, currentCalendarMonth))
      .then(() => setCalendarExportNotice(t('calendarPage.exportPngStarted')))
      .catch(error => setCalendarExportNotice(error instanceof Error ? error.message : t('calendarPage.exportPngFailed')))
  }
  const openOverflow = (date: string, event: React.MouseEvent) => {
    event.stopPropagation()
    if (window.innerWidth <= 760) { chooseCalendarDate(date); return }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const width = 380
    setOverflowSelectedIds([])
    setOverflowPanel({
      date,
      top: Math.max(12, Math.min(window.innerHeight - 470, rect.bottom + 8)),
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    })
  }

  const dayTasks = dayOpen ? tasksFor(dayOpen) : []
  const dayCfg = dayOpen ? getDayConfig(state, dayOpen) : undefined
  const taskOpen = taskOpenId ? state.assignments.find(item => item.id === taskOpenId) : undefined
  const taskOpenGroup = taskOpen ? groups.get(taskOpen.groupId) : undefined
  const taskOpenDurationSuggestion = taskOpen ? allDurationSuggestions(state).find(item => item.groupId === taskOpen.groupId) : undefined
  const saveTaskBasics = () => {
    if (!taskOpen) return
    const nextTitle = taskTitleDraft.trim() || taskOpen.title
    const nextDuration = Math.max(1, Math.round(taskDurationDraft ?? taskOpen.estimatedMinutes))
    const titleChanged = nextTitle !== taskOpen.title
    const durationChanged = nextDuration !== taskOpen.estimatedMinutes
    if (!titleChanged && !durationChanged) return
    if (!durationChanged) {
      commit(draft => { const item = draft.assignments.find(candidate => candidate.id === taskOpen.id); if (!item) return; item.title = nextTitle; item.titleCustomized = true; item.updatedAt = new Date().toISOString() })
      return
    }
    const prepared = cloneActiveState(state)
    const item = prepared.assignments.find(candidate => candidate.id === taskOpen.id)
    if (!item) return
    item.title = nextTitle
    item.titleCustomized = true
    item.estimatedMinutes = nextDuration
    item.durationCustomized = true
    item.manuallyEstimated = true
    item.updatedAt = new Date().toISOString()
    const event: PlanChangeEvent = {
      id: uid('event'), type: 'rule-change', action: 'repair', title: t('calendarPage.durationEventTitle', { title: nextTitle }),
      description: t('calendarPage.durationEventDesc', { from: taskOpen.estimatedMinutes, to: nextDuration }),
      affectedGoalIds: prepared.goals.filter(goal => goal.linkedAssignmentIds.includes(item.id) || goal.linkedTaskGroupIds.includes(item.groupId) || goal.completionConditions.some(condition => condition.groupId === item.groupId)).map(goal => goal.id),
      affectedGroupIds: [item.groupId], affectedAssignmentIds: [item.id], affectedDates: item.scheduledDate ? [item.scheduledDate] : [], createdAt: new Date().toISOString(),
      metadata: { explicitLocalOperation: true, operationScope: 'requested-change-only', requestedChangeLabel: t('calendarPage.durationChangeLabel', { title: nextTitle }), requestedChangeKind: 'assignment-duration' },
    }
    prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
    setTaskOpenId(undefined)
    onPrepared(prepared, event)
  }
  const groupChangeTarget = groupChangeTargetId ? state.taskGroups.find(group => group.id === groupChangeTargetId) : undefined
  const overflowTasks = overflowPanel ? tasksFor(overflowPanel.date).slice(calendarTaskLimit) : []

  const bulkMoveTo = (ids: string[], target: string) => {
    if (!target || !ids.length) return false
    if (target < state.settings.startDate || target > state.settings.endDate) { window.alert(t('calendarPage.alertOutOfRange')); return false }
    const moving = state.assignments.filter(item => ids.includes(item.id) && item.status !== 'done' && !item.locked && item.id !== state.timer.assignmentId)
    if (!moving.length) { window.alert(t('calendarPage.alertNoMovable')); return false }
    const prepared = cloneActiveState(state)
    const now = new Date().toISOString()
    const affectedDates = new Set<string>([target])
    for (const source of moving) {
      const item = prepared.assignments.find(candidate => candidate.id === source.id)
      if (!item) continue
      if (item.scheduledDate) affectedDates.add(item.scheduledDate)
      item.previousDate = item.scheduledDate
      item.scheduledDate = target
      item.lastManualMoveAt = now
      item.scheduleSource = 'manual'
      item.intentStrength = 'manual'
      item.updatedAt = now
    }
    const affectedAssignmentIds = moving.map(item => item.id)
    const affectedGroupIds = Array.from(new Set(moving.map(item => item.groupId)))
    const affectedGoalIds = prepared.goals.filter(goal => goal.linkedTaskGroupIds.some(id => affectedGroupIds.includes(id)) || goal.linkedAssignmentIds.some(id => affectedAssignmentIds.includes(id)) || goal.completionConditions.some(condition => affectedGroupIds.includes(condition.groupId))).map(goal => goal.id)
    const event: PlanChangeEvent = {
      id: uid('event'), type: 'bulk-move', action: 'repair', title: t('calendarPage.bulkMoveEventTitle', { count: moving.length, date: fmtDate(target) }),
      description: t('calendarPage.bulkMoveEventDesc'),
      affectedGoalIds, affectedGroupIds, affectedAssignmentIds, affectedDates: Array.from(affectedDates).sort(), createdAt: now,
      metadata: { requestedDate: target, preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'] },
    }
    prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
    prepared.updatedAt = now
    setSelectedIds([])
    setOverflowSelectedIds([])
    onPrepared(prepared, event)
    return true
  }


  const bulkMove = (ids = selectedIds) => {
    const candidates = state.assignments.filter(item => ids.includes(item.id) && item.status !== 'done' && !item.locked && item.id !== state.timer.assignmentId)
    if (!candidates.length) { window.alert(t('calendarPage.alertNoMovable')); return }
    const sourceDates = candidates.flatMap(item => item.scheduledDate ? [item.scheduledDate] : [])
    const latestSource = sourceDates.sort().at(-1) ?? todayISO()
    const suggested = shiftDate(latestSource, 1)
    const target = suggested > state.settings.endDate ? state.settings.endDate : suggested < state.settings.startDate ? state.settings.startDate : suggested
    setBulkMoveDialog({ ids: candidates.map(item => item.id), target })
  }

  const shiftOverflowSelected = () => {
    if (!overflowSelectedIds.length || !overflowPanel) return
    const target = shiftDate(overflowPanel.date, 1)
    if (target > state.settings.endDate) { window.alert(t('calendarPage.alertAtEndDate')); return }
    bulkMoveTo(overflowSelectedIds, target)
  }

  const lockOverflowSelected = () => {
    if (!overflowSelectedIds.length) return
    commit(draft => {
      for (const assignment of draft.assignments) {
        if (!overflowSelectedIds.includes(assignment.id)) continue
        assignment.locked = true
        assignment.intentStrength = 'locked'
      }
    })
    setOverflowSelectedIds([])
  }

  const exactDayConstraint = dayOpen ? state.calendarConstraints.find(item => item.startDate === dayOpen && item.endDate === dayOpen && ['unavailable', 'reduced-capacity', 'special-capacity', 'protected-buffer'].includes(item.kind)) : undefined
  let dayPreviewState: AppState | undefined
  if (dayOpen && dayCfg) {
    dayPreviewState = cloneActiveState(state)
    const type = pendingDayType ?? dayCfg.type
    // 日期类型负责基础容量；临时不可用、降低容量和受保护缓冲统一写入 CalendarConstraint。
    dayPreviewState.dayConfigs[dayOpen] = {
      ...dayCfg,
      date: dayOpen,
      type,
      note: pendingDayNote.trim() || undefined,
      customMinutes: type === 'custom' ? pendingCustomMinutes ?? dayCfg.customMinutes ?? state.settings.regularMinutes : undefined,
      isBufferDay: undefined,
      availableMinutes: undefined,
      bufferReason: undefined,
      bufferPreference: undefined,
      bufferProtected: undefined,
      userSet: true,
    }
    if (exactDayConstraint) dayPreviewState.calendarConstraints = dayPreviewState.calendarConstraints.filter(item => item.id !== exactDayConstraint.id)
    const needsUnavailable = type === 'travel' || pendingAvailabilityMode === 'rest'
    const needsReduced = !needsUnavailable && pendingAvailabilityMode === 'reduced'
    if (needsUnavailable || needsReduced) {
      const now = new Date().toISOString()
      dayPreviewState.calendarConstraints.push({
        id: exactDayConstraint?.id ?? uid('constraint'), startDate: dayOpen, endDate: dayOpen,
        kind: needsUnavailable ? 'unavailable' : 'protected-buffer',
        capacityMinutes: needsUnavailable ? 0 : Math.max(0, pendingAvailableMinutes),
        protected: true,
        reason: pendingBufferReason.trim() || (needsUnavailable ? t('calendarPage.bufferReasonUnavailable') : t('calendarPage.bufferReasonReduced')),
        preference: pendingBufferPreference,
        createdAt: exactDayConstraint?.createdAt ?? now, updatedAt: now,
      })
    }
  }


  return <>
     <section className="calendar-toolbar"><div><h2>{viewMode === 'month' ? format(month, state.settings.language === 'en' ? 'MMMM yyyy' : 'yyyy年M月') : `${fmtDate(weekStart)}－${fmtDate(shiftDate(weekStart, 6))}`}</h2><p>{t('calendarPage.toolbarHint')}</p></div><div className="calendar-toolbar-actions"><div className="segmented-control calendar-view-toggle"><button className={viewMode === 'month' ? 'active' : ''} onClick={() => setViewMode('month')}>{t('calendarPage.monthToggle')}</button><button className={viewMode === 'week' ? 'active' : ''} onClick={() => setViewMode('week')}>{t('calendarPage.weekToggle')}</button></div><button className="icon-button" onClick={() => moveCalendarWindow(-1)}><ChevronLeft size={19}/></button><button className="secondary-button" onClick={() => { const date = initialCalendarDate; setMonth(startOfMonth(parseISO(date))); setWeekStart(shiftDate(date, -getDay(parseISO(date)))) }}>{t('calendarPage.nearToday')}</button><button className="icon-button" onClick={() => moveCalendarWindow(1)}><ChevronRight size={19}/></button></div></section>
     {viewMode === 'month' && <div className="calendar-export-bar"><div><strong>{t('calendarPage.exportCurrentMonth')}</strong><span>{t('calendarPage.exportHint')}</span></div><div className="button-wrap"><button className="secondary-button" onClick={downloadCalendarImage}><Download size={16}/>{t('calendarPage.pngButton')}</button><button className="secondary-button" onClick={openCalendarPrint}><Printer size={16}/>{t('calendarPage.pdfButton')}</button></div></div>}
     {calendarExportNotice && <div className="export-notice calendar-export-notice" role="status"><CheckCircle2 size={17}/><span>{calendarExportNotice}</span></div>}
    {moveNotice && <div className="manual-move-notice"><div><strong>{t('calendarPage.moveNoticeTitle')}</strong><span>{t('calendarPage.moveNoticeBody', { title: moveNotice.title, date: moveNotice.date })}</span></div><div className="button-wrap"><button className="secondary-button" onClick={() => { updateAssignment(moveNotice.id, { locked: true }); setMoveNotice(undefined) }}><Lock size={15}/>{t('calendarPage.lockToo')}</button><button className="text-button" onClick={() => setMoveNotice(undefined)}>{t('calendarPage.gotIt')}</button></div></div>}
    {moveModeTaskId && <div className="calendar-move-mode"><div><strong>{t('calendarPage.movingTitle', { title: state.assignments.find(item => item.id === moveModeTaskId)?.title ?? '' })}</strong><span>{t('calendarPage.movingHint')}</span></div><button className="secondary-button" onClick={() => setMoveModeTaskId(undefined)}>{t('calendarPage.cancelMove')}</button></div>}
    {tutorialMode && tutorialHighlightDates.length > 0 && <div className="tutorial-calendar-result-note"><CheckCircle2 size={17}/><span>{t('calendarPage.tutorialHighlightNote', { count: tutorialHighlightDates.length })}</span></div>}
    <section className={`calendar-card ${viewMode === 'week' ? 'calendar-week-view' : 'calendar-month-view'}`}>
      {viewMode === 'month' ? <>
        <div className="weekday-row">{weekdayShortLabels(t).map((label, index) => <div key={index}>{label}</div>)}</div>
        <div className="calendar-grid">
          {blanks.map((_, index) => <div className="calendar-cell outside" key={`b${index}`}/>)}
          {days.map(date => {
            const inPlan = isWithinInterval(parseISO(date), planInterval)
            const tasks = tasksFor(date)
            const visibleTasks = tasks.slice(0, calendarTaskLimit)
            const load = loadFor(date)
            const capacity = inPlan ? getCapacity(state, date) : 0
            const ratio = capacity ? load / capacity : 0
            const config = inPlan ? getDayConfig(state, date) : undefined
            const dragged = dragAssignmentId ? state.assignments.find(item => item.id === dragAssignmentId) : undefined
            const projected = dragged ? load + (dragged.scheduledDate === date ? 0 : countedMinutes(dragged)) : load
            return <div
              key={date}
              className={`calendar-cell ${!inPlan ? 'outside' : ''} ${config ? `day-${config.type}` : ''} ${config?.isBufferDay ? 'day-buffer' : ''} ${ratio > 1 ? 'load-over' : ratio > .8 ? 'load-near' : ''} ${dragTargetDate === date ? 'calendar-drag-target' : ''} ${moveModeTaskId ? 'calendar-date-selectable' : ''} ${tutorialHighlightDates.includes(date) ? 'tutorial-calendar-changed' : ''}`}
              onDragOver={event => { if (!inPlan) return; event.preventDefault(); setDragTargetDate(date) }}
              onDrop={event => inPlan && drop(date, event)}
              onClick={() => inPlan && chooseCalendarDate(date)}
            >
              <div className="calendar-date"><span>{Number(date.slice(-2))}</span>{config && <small>{config.isBufferDay ? t('calendarPage.bufferMinutes', { minutes: minutesText(config.availableMinutes ?? capacity) }) : dayTypeLabel[config.type]}</small>}</div>
              {inPlan && <div className="load-line"><i style={{ width: `${Math.min(100, ratio * 100)}%` }}/></div>}
              <div className="calendar-tasks">
                {visibleTasks.map(assignment => <div
                  key={assignment.id}
                  draggable={nativeDragEnabled && !assignment.locked}
                  onDragStart={event => beginDrag(assignment, event)}
                  onDragEnd={() => { setDragAssignmentId(undefined); setDragTargetDate(undefined) }}
                  onPointerDown={() => startLongPress(assignment.id)}
                  onPointerUp={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onPointerMove={cancelLongPress}
                  onClick={event => { event.stopPropagation(); openTaskUnlessLongPressed(assignment.id) }}
                  className={assignment.status === 'done' ? 'mini-done' : ''}
                ><span className={`subject-dot subject-${groups.get(assignment.groupId)?.subject}`}/><span>{assignment.title}</span><em>{minutesText(assignment.estimatedMinutes)}</em></div>)}
                {tasks.length > calendarTaskLimit && <button className="calendar-more-button" onClick={event => openOverflow(date, event)}>{t('calendarPage.moreItems', { count: tasks.length - calendarTaskLimit })}</button>}
              </div>
              {dragTargetDate === date && dragged && <div className={`calendar-drop-preview ${projected > capacity ? 'over' : ''}`}><strong>{t('calendarPage.afterDrop', { minutes: minutesText(projected) })}</strong><span>{projected > capacity ? t('calendarPage.overloadBy', { minutes: minutesText(projected - capacity) }) : t('calendarPage.remainingBy', { minutes: minutesText(capacity - projected) })}</span></div>}
              {inPlan && <footer>{minutesText(load)} / {minutesText(capacity)}</footer>}
            </div>
          })}
        </div>
      </> : <div className="calendar-week-list">
        {days.map(date => {
          const inPlan = date >= state.settings.startDate && date <= state.settings.endDate
          const tasks = tasksFor(date)
          const load = inPlan ? loadFor(date) : 0
          const capacity = inPlan ? getCapacity(state, date) : 0
          const config = inPlan ? getDayConfig(state, date) : undefined
          return <article key={date} className={`calendar-week-day ${!inPlan ? 'outside' : ''} ${config ? `day-${config.type}` : ''} ${load > capacity ? 'load-over' : load > capacity * .8 ? 'load-near' : ''} ${moveModeTaskId ? 'calendar-date-selectable' : ''} ${tutorialHighlightDates.includes(date) ? 'tutorial-calendar-changed' : ''}`}>
            <button className="calendar-week-head" disabled={!inPlan} onClick={() => inPlan && chooseCalendarDate(date)}>
              <div><strong>{fmtDate(date)} · {fmtWeekday(date)}</strong><span>{config?.isBufferDay ? t('calendarPage.bufferDayMinutes', { minutes: minutesText(capacity) }) : config ? dayTypeLabel[config.type] : t('calendarPage.outsidePlan')}</span></div>
              <div><strong>{minutesText(load)}</strong><span>/ {minutesText(capacity)}</span></div>
            </button>
            <div className="calendar-week-tasks">
              {tasks.length === 0 && <button className="calendar-week-empty" onClick={() => inPlan && chooseCalendarDate(date)}>{t('calendarPage.noTasksThatDay')}</button>}
              {tasks.map(assignment => <button key={assignment.id} className={assignment.status === 'done' ? 'mini-done' : ''} onPointerDown={() => startLongPress(assignment.id)} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerMove={cancelLongPress} onClick={() => openTaskUnlessLongPressed(assignment.id)}><span className={`subject-dot subject-${groups.get(assignment.groupId)?.subject}`}/><div><strong>{assignment.title}</strong><span>{groups.get(assignment.groupId)?.subject} · {minutesText(assignment.estimatedMinutes)}</span></div>{assignment.locked && <Lock size={13}/>}</button>)}
            </div>
          </article>
        })}
      </div>}
    </section>

    {overflowPanel && <div className="calendar-overflow-backdrop" onMouseDown={() => setOverflowPanel(undefined)}>
      <section className="calendar-overflow-panel" style={{ top: overflowPanel.top, left: overflowPanel.left }} onMouseDown={event => event.stopPropagation()}>
        <header><div><strong>{t('calendarPage.overflowHeader', { date: fmtDate(overflowPanel.date), count: overflowTasks.length })}</strong><span>{t('calendarPage.overflowHint')}</span></div><button className="icon-button" onClick={() => setOverflowPanel(undefined)}><X size={18}/></button></header>
        <div className="overflow-bulk-bar"><span>{t('calendarPage.selectedCount', { count: overflowSelectedIds.length })}</span><div className="button-wrap"><button className="secondary-button" disabled={!overflowSelectedIds.length} onClick={() => bulkMove(overflowSelectedIds)}>{t('calendarPage.bulkMove')}</button><button className="secondary-button" disabled={!overflowSelectedIds.length} onClick={shiftOverflowSelected}>{t('calendarPage.postponeOneDay')}</button><button className="secondary-button" disabled={!overflowSelectedIds.length} onClick={lockOverflowSelected}>{t('calendarPage.lock')}</button></div></div>
        <div className="overflow-task-list">
          {overflowTasks.length === 0 && <p className="muted-text">{t('calendarPage.overflowEmpty')}</p>}
          {overflowTasks.map(assignment => <div
            className="overflow-task-row"
            key={assignment.id}
            draggable={nativeDragEnabled && !assignment.locked}
            onDragStart={event => beginDrag(assignment, event)}
            onDragEnd={() => { setDragAssignmentId(undefined); setDragTargetDate(undefined) }}
            onPointerDown={() => startLongPress(assignment.id)}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onPointerMove={cancelLongPress}
          >
            <input type="checkbox" checked={overflowSelectedIds.includes(assignment.id)} onChange={event => setOverflowSelectedIds(previous => event.target.checked ? [...previous, assignment.id] : previous.filter(id => id !== assignment.id))}/>
            <button className="overflow-task-content" onClick={() => openTaskUnlessLongPressed(assignment.id)}><span className={`subject-dot subject-${groups.get(assignment.groupId)?.subject}`}/><div><strong>{assignment.title}</strong><span>{groups.get(assignment.groupId)?.subject} · {minutesText(assignment.estimatedMinutes)}</span></div></button>
            {assignment.locked ? <small>{t('calendarPage.locked')}</small> : <button className="text-button" onClick={() => setTaskOpenId(assignment.id)}>{t('calendarPage.move')}</button>}
          </div>)}
        </div>
      </section>
    </div>}

    <Modal open={Boolean(dayOpen)} title={dayOpen ? `${fmtDate(dayOpen)} · ${fmtWeekday(dayOpen)}` : t('calendarPage.dateFallback')} mobileSheet onClose={() => { setDayOpen(undefined); setSelectedIds([]); setPendingDayType(undefined); setPendingDayNote(''); setPendingCustomMinutes(undefined); setPendingAvailabilityMode('default'); setPendingAvailableMinutes(60); setPendingBufferReason(''); setPendingBufferPreference('preserve') }} wide>
      {dayOpen && dayCfg && dayPreviewState && <>
        <div className="day-settings-row">
          <label className="field"><span>{t('calendarPage.dayTypeLabel')}</span><select value={pendingDayType ?? dayCfg.type} onChange={event => setPendingDayType(event.target.value as DayType)}>{(['regular', 'study', 'travel', 'custom'] as DayType[]).map(type => <option key={type} value={type}>{dayTypeLabel[type]}</option>)}</select></label>
          {(pendingDayType ?? dayCfg.type) === 'custom' && <label className="field"><span>{t('calendarPage.availableMinutesLabel')}</span><NumericInput min={0} max={1440} value={pendingCustomMinutes ?? dayCfg.customMinutes ?? 210} onValueChange={setPendingCustomMinutes}/></label>}
          <label className="field grow"><span>{t('calendarPage.noteLabel')}</span><input value={pendingDayNote} onChange={event => setPendingDayNote(event.target.value)} placeholder={t('calendarPage.notePlaceholder')}/></label>
        </div>
        <section className="buffer-day-editor">
          <div><strong>{t('calendarPage.availableTimeTitle')}</strong><span>{t('calendarPage.availableTimeHint')}</span></div>
          <div className="segmented-control buffer-mode-control">
            <button className={pendingAvailabilityMode === 'default' ? 'active' : ''} onClick={() => setPendingAvailabilityMode('default')}>{t('calendarPage.defaultCapacity')}</button>
            <button className={pendingAvailabilityMode === 'reduced' ? 'active' : ''} onClick={() => setPendingAvailabilityMode('reduced')}>{t('calendarPage.reducedCapacity')}</button>
            <button className={pendingAvailabilityMode === 'rest' ? 'active' : ''} onClick={() => setPendingAvailabilityMode('rest')}>{t('calendarPage.fullRest')}</button>
          </div>
          {pendingAvailabilityMode !== 'default' && <div className="buffer-fields">
            {pendingAvailabilityMode === 'reduced' && <label className="field"><span>{t('calendarPage.maxStudyMinutes')}</span><NumericInput min={0} max={1440} step={10} value={pendingAvailableMinutes} onValueChange={setPendingAvailableMinutes}/></label>}
            <label className="field grow"><span>{t('calendarPage.reasonLabel')}</span><input value={pendingBufferReason} onChange={event => setPendingBufferReason(event.target.value)} placeholder={t('calendarPage.reasonPlaceholder')}/></label>
            <label className="field"><span>{t('calendarPage.followUpPreferenceLabel')}</span><select value={pendingBufferPreference} onChange={event => setPendingBufferPreference(event.target.value as BufferPreference)}><option value="preserve">{t('calendarPage.preferencePreserve')}</option><option value="goal">{t('calendarPage.preferenceGoal')}</option><option value="spread">{t('calendarPage.preferenceSpread')}</option></select></label>
          </div>}
          {pendingAvailabilityMode !== 'default' && <p className="buffer-protection-note">{t('calendarPage.bufferProtectionNote')}</p>}
        </section>
        <div className="day-load-summary day-load-live"><span>{t('calendarPage.executionLoad', { minutes: minutesText(planningDayLoad(state, dayOpen)) })}</span><span>{t('calendarPage.capacityChange', { before: minutesText(getCapacity(state, dayOpen)), after: minutesText(getCapacity(dayPreviewState, dayOpen)) })}</span><span>{t('calendarPage.doneOfTotal', { done: dayTasks.filter(task => task.status === 'done').length, total: dayTasks.length })}</span><em className={planningDayLoad(dayPreviewState, dayOpen) > getCapacity(dayPreviewState, dayOpen) ? 'over' : ''}>{planningDayLoad(dayPreviewState, dayOpen) > getCapacity(dayPreviewState, dayOpen) ? t('calendarPage.afterAdjustOverload', { minutes: minutesText(planningDayLoad(dayPreviewState, dayOpen) - getCapacity(dayPreviewState, dayOpen)) }) : t('calendarPage.afterAdjustRemaining', { minutes: minutesText(getCapacity(dayPreviewState, dayOpen) - planningDayLoad(dayPreviewState, dayOpen)) })}</em></div>
        <div className="date-detail-primary"><button className="primary-button" onClick={() => onAddTask(dayOpen)}><Plus size={16}/>{t('calendarPage.addToThisDay')}</button><span>{t('calendarPage.addToThisDayHint')}</span></div>
        <div className="bulk-row"><span>{t('calendarPage.selectedCount', { count: selectedIds.length })}</span><div className="button-wrap">
          {JSON.stringify(dayPreviewState.dayConfigs[dayOpen]) !== JSON.stringify(state.dayConfigs[dayOpen] ?? { date: dayOpen, type: 'regular' }) || JSON.stringify(dayPreviewState.calendarConstraints.filter(item => item.startDate === dayOpen && item.endDate === dayOpen)) !== JSON.stringify(state.calendarConstraints.filter(item => item.startDate === dayOpen && item.endDate === dayOpen)) ? <button className="primary-button" onClick={() => {
            const ordinary = dayPreviewState!.assignments.filter(assignment => assignment.scheduledDate === dayOpen && assignment.status !== 'done' && !groups.get(assignment.groupId)?.recurring)
            const newCapacity = getCapacity(dayPreviewState!, dayOpen)
            const newLoad = planningDayLoad(dayPreviewState!, dayOpen)
            if (ordinary.length && ((pendingDayType ?? dayCfg.type) === 'travel' || newLoad > newCapacity || pendingAvailabilityMode !== 'default')) prepareCalendarDayChange(dayOpen, dayPreviewState)
            else updateDayConfig(dayOpen, dayPreviewState!.dayConfigs[dayOpen])
          }}>{t('calendarPage.previewBufferAdjustment')}</button> : <button className="secondary-button" onClick={() => onOpenAdjustment(dayOpen)}>{t('calendarPage.viewAdjustmentSuggestion')}</button>}
          <button className="secondary-button" disabled={!selectedIds.length} onClick={() => bulkMove()}>{t('calendarPage.bulkMove')}</button>
        </div></div>
        <div className="day-task-list">{dayTasks.map(assignment => <label key={assignment.id} className="select-task-row" onPointerDown={() => startLongPress(assignment.id)} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerMove={cancelLongPress}><input type="checkbox" checked={selectedIds.includes(assignment.id)} onChange={event => setSelectedIds(previous => event.target.checked ? [...previous, assignment.id] : previous.filter(id => id !== assignment.id))}/><button className="select-task-content" onClick={event => { event.preventDefault(); openTaskUnlessLongPressed(assignment.id) }}><strong>{assignment.title}</strong><span>{groups.get(assignment.groupId)?.subject} · {minutesText(assignment.estimatedMinutes)}</span></button>{assignment.locked && <small>{t('calendarPage.locked')}</small>}</label>)}</div>
      </>}
    </Modal>

    <Modal open={Boolean(bulkMoveDialog)} title={t('calendarPage.bulkMoveTasksTitle')} onClose={() => setBulkMoveDialog(undefined)} wide mobileFullscreen>
      {bulkMoveDialog && <div className="bulk-move-dialog">
        <div className="bulk-move-summary"><strong>{t('calendarPage.moveMovableCount', { count: bulkMoveDialog.ids.length })}</strong><span>{t('calendarPage.bulkMoveSummaryHint')}</span></div>
        <label className="field"><span>{t('calendarPage.targetDateLabel')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={bulkMoveDialog.target} onChange={event => setBulkMoveDialog(current => current ? { ...current, target: event.target.value } : current)}/></label>
        <details><summary>{t('calendarPage.viewSelectedTasks', { count: bulkMoveDialog.ids.length })}</summary><ul>{bulkMoveDialog.ids.map(id => <li key={id}>{state.assignments.find(item => item.id === id)?.title ?? id}</li>)}</ul></details>
        <div className="modal-actions"><button className="secondary-button" onClick={() => setBulkMoveDialog(undefined)}>{t('calendarPage.cancel')}</button><button className="primary-button" disabled={!bulkMoveDialog.target} onClick={() => { if (bulkMoveTo(bulkMoveDialog.ids, bulkMoveDialog.target)) { setBulkMoveDialog(undefined); setOverflowPanel(undefined) } }}>{t('calendarPage.previewBulkMove')}</button></div>
      </div>}
    </Modal>

    <Drawer open={Boolean(taskOpen)} title={taskOpen?.title ?? t('calendarPage.taskDetailFallback')} subtitle={taskOpenGroup ? `${taskOpenGroup.subject} · ${priorityLabel(taskOpenGroup.priority, t)}${t('calendarPage.prioritySuffix')}` : undefined} onClose={() => setTaskOpenId(undefined)}>
      {taskOpen && taskOpenGroup && <div className="task-quick-editor">
        <div className="task-detail-metrics"><div><span>{t('calendarPage.estimatedTimeLabel')}</span><strong>{minutesText(taskOpen.estimatedMinutes)}</strong></div><div><span>{t('calendarPage.statusLabel')}</span><strong>{taskOpen.status === 'done' ? t('calendarPage.statusDone') : taskOpen.status === 'partial' ? t('calendarPage.statusPartial') : t('calendarPage.statusPending')}</strong></div><div><span>{t('calendarPage.scheduleSourceLabel')}</span><strong>{taskOpen.intentStrength === 'manual' ? t('calendarPage.scheduleSourceManual') : taskOpen.scheduleSource}</strong></div></div>
        <label className="field"><span>{t('calendarPage.taskTitleLabel')}</span><input value={taskTitleDraft} onChange={event => setTaskTitleDraft(event.target.value)}/></label>
        <label className="field"><span>{t('calendarPage.estimatedDurationLabel')}</span><NumericInput min={1} max={1440} value={taskDurationDraft ?? taskOpen.estimatedMinutes} onValueChange={setTaskDurationDraft}/><small>{t('calendarPage.durationChangeHint')}</small></label>
        <label className="field"><span>{t('calendarPage.moveToLabel')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={taskOpen.scheduledDate ?? ''} onChange={event => moveWithValidation(taskOpen.id, event.target.value)}/></label>
        <label className="field"><span>{t('calendarPage.taskGroupLabel')}</span><select value={taskOpen.groupId} onChange={event => {
          if (event.target.value === taskOpen.groupId) return
          setGroupChangeTargetId(event.target.value)
        }}>
          <option value={taskOpen.groupId}>{taskOpenGroup.subject} · {taskOpenGroup.title}{t('calendarPage.currentSuffix')}</option>
          {state.taskGroups.filter(group => group.id !== taskOpen.groupId && !group.hiddenStandalone && !group.recurring && group.status !== 'completed').map(group => <option key={group.id} value={group.id}>{group.subject} · {group.title}</option>)}
        </select><small>{t('calendarPage.changeGroupHint')}</small></label>
        <label className="switch-row"><button type="button" className={`switch ${taskOpen.locked ? 'on' : ''}`} onClick={() => updateAssignment(taskOpen.id, { locked: !taskOpen.locked })}><i/></button><span>{t('calendarPage.lockTaskLabel')}</span></label><div className="task-editor-actions"><button className="primary-button" disabled={(taskTitleDraft.trim() || taskOpen.title) === taskOpen.title && (taskDurationDraft ?? taskOpen.estimatedMinutes) === taskOpen.estimatedMinutes} onClick={saveTaskBasics}>{t('calendarPage.saveBasicInfo')}</button><span>{t('calendarPage.saveBasicInfoHint')}</span></div>
        <div className="task-impact-note"><strong>{t('calendarPage.linkedGoalsTitle')}</strong><span>{t('calendarPage.linkedGoalsBody', { goals: state.goals.filter(goal => goal.linkedAssignmentIds.includes(taskOpen.id) || goal.linkedTaskGroupIds.includes(taskOpen.groupId) || goal.completionConditions.some(condition => condition.groupId === taskOpen.groupId)).map(goal => t('calendarPage.goalLatestDate', { title: goal.title, date: goal.latestDate })).join('；') || t('calendarPage.noLinkedGoals') })}</span></div>
        {taskOpenDurationSuggestion && <div className="task-impact-note duration-detail-suggestion"><strong>{t('calendarPage.historicalDurationSuggestionTitle')}</strong><span>{t('calendarPage.historicalDurationSuggestionBody', { samples: taskOpenDurationSuggestion.sampleCount, average: taskOpenDurationSuggestion.recentAverage, current: taskOpenDurationSuggestion.currentEstimate, suggested: taskOpenDurationSuggestion.suggestedEstimate })}</span><button className="secondary-button" onClick={() => { const prepared = prepareDurationChange(taskOpenDurationSuggestion); setTaskOpenId(undefined); onPrepared(prepared.state, prepared.event) }}>{t('calendarPage.viewDurationAdjustment')}</button></div>}
        <div className="drawer-danger-zone">{taskOpen.status === 'done' && <button className="secondary-button" onClick={() => reopenAssignment(taskOpen.id)}>{t('calendarPage.reopenTask')}</button>}<button className="danger-button" onClick={() => { const prepared = prepareAssignmentDelete(taskOpen.id); setTaskOpenId(undefined); onPrepared(prepared.state, prepared.event) }}><Trash2 size={16}/>{t('calendarPage.removeTask')}</button></div>
      </div>}
    </Drawer>

    <AssignmentGroupChangeDialog
      open={Boolean(taskOpen && groupChangeTarget)}
      state={state}
      assignment={taskOpen}
      targetGroup={groupChangeTarget}
      onClose={() => setGroupChangeTargetId(undefined)}
      onSubmit={options => {
        if (!taskOpen || !groupChangeTarget) return
        try {
          const prepared = prepareAssignmentGroupChange(taskOpen.id, groupChangeTarget.id, options)
          setGroupChangeTargetId(undefined)
          setTaskOpenId(undefined)
          onPrepared(prepared.state, prepared.event)
        } catch (error) {
          window.alert(error instanceof Error ? error.message : t('calendarPage.cannotGenerateGroupChangePreview'))
        }
      }}
    />
  </>
}

function TasksPage({ onOpenIntake, onPrepared, tutorialMode = false, onTutorialBlocked }: { onOpenIntake: () => void; onPrepared: (state: AppState, event: PlanChangeEvent) => void; tutorialMode?: boolean; onTutorialBlocked?: (message?: string) => void }) {
  const { state, editTaskGroup, updateAssignment, finishAssignment, prepareAssignmentDelete, prepareTaskGroupEdit, prepareTaskGroupDelete, prepareDurationChange } = useApp()
  const t = useT()
  const [mode, setMode] = useState<'tasks' | 'groups'>('tasks')
  const [search, setSearch] = useState('')
  const [priority, setPriority] = useState<'all'|Priority>('all')
  const [subject, setSubject] = useState<'all'|Subject>('all')
  const [showHidden, setShowHidden] = useState(false)
  const [taskFilter, setTaskFilter] = useState<'attention'|'unscheduled'|'overdue'|'today'|'future'|'done'|'all'>('attention')
  const [visibleTaskCount, setVisibleTaskCount] = useState(100)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [editing, setEditing] = useState<TaskGroup>()
  const [movingGroup, setMovingGroup] = useState<TaskGroup>()
  const [movingTask, setMovingTask] = useState<Assignment>()
  const [moveDate, setMoveDate] = useState(todayISO())
  const [taskMoveDate, setTaskMoveDate] = useState(todayISO())
  const assignmentsByGroup = useMemo(() => new Map(state.taskGroups.map(group => [group.id, state.assignments.filter(item => item.groupId === group.id)])), [state.taskGroups, state.assignments])
  const groupMap = useMemo(() => new Map(state.taskGroups.map(group => [group.id, group])), [state.taskGroups])
  const subjects = Array.from(new Set([...state.settings.customSubjects, ...state.taskGroups.map(group => group.subject)])).sort()
  const today = todayISO()
  const query = search.trim().toLowerCase()
  const groups = state.taskGroups.filter(group => !group.hiddenStandalone && (showHidden || !group.hidden) && (priority === 'all' || group.priority === priority) && (subject === 'all' || group.subject === subject) && (`${group.subject}${group.title}${group.notes ?? ''}`.toLowerCase().includes(query)))
  const taskCounts = useMemo(() => {
    const active = state.assignments.filter(item => item.status !== 'done')
    return {
      attention: active.filter(item => !item.scheduledDate || item.scheduledDate < today).length,
      unscheduled: active.filter(item => !item.scheduledDate).length,
      overdue: active.filter(item => Boolean(item.scheduledDate && item.scheduledDate < today)).length,
      today: active.filter(item => item.scheduledDate === today).length,
      future: active.filter(item => Boolean(item.scheduledDate && item.scheduledDate > today)).length,
      done: state.assignments.filter(item => item.status === 'done').length,
      all: state.assignments.length,
    }
  }, [state.assignments, today])
  const tasks = useMemo(() => state.assignments
    .filter(item => {
      const group = groupMap.get(item.groupId)
      if (!group || group.status === 'archived') return false
      if (priority !== 'all' && group.priority !== priority) return false
      if (subject !== 'all' && group.subject !== subject) return false
      if (query && !`${item.title} ${item.notes ?? ''} ${group.title} ${group.subject}`.toLowerCase().includes(query)) return false
      if (taskFilter === 'attention') return item.status !== 'done' && (!item.scheduledDate || item.scheduledDate < today)
      if (taskFilter === 'unscheduled') return item.status !== 'done' && !item.scheduledDate
      if (taskFilter === 'overdue') return item.status !== 'done' && Boolean(item.scheduledDate && item.scheduledDate < today)
      if (taskFilter === 'today') return item.status !== 'done' && item.scheduledDate === today
      if (taskFilter === 'future') return item.status !== 'done' && Boolean(item.scheduledDate && item.scheduledDate > today)
      if (taskFilter === 'done') return item.status === 'done'
      return true
    })
    .sort((a, b) => {
      const attentionA = a.status !== 'done' && (!a.scheduledDate || a.scheduledDate < today) ? 0 : 1
      const attentionB = b.status !== 'done' && (!b.scheduledDate || b.scheduledDate < today) ? 0 : 1
      if (attentionA !== attentionB) return attentionA - attentionB
      return (a.scheduledDate ?? '9999-12-31').localeCompare(b.scheduledDate ?? '9999-12-31') || (groupMap.get(b.groupId)?.priority ?? 0) - (groupMap.get(a.groupId)?.priority ?? 0)
    }), [state.assignments, groupMap, priority, subject, query, taskFilter, today])
  const visibleTasks = tasks.slice(0, visibleTaskCount)
  useEffect(() => {
    setVisibleTaskCount(100)
    setSelectedTaskIds([])
  }, [priority, query, subject, taskFilter, mode])

  const selectedTasks = tasks.filter(item => selectedTaskIds.includes(item.id))
  const toggleAllVisible = () => {
    const visibleIds = visibleTasks.map(item => item.id)
    setSelectedTaskIds(current => visibleIds.every(id => current.includes(id))
      ? current.filter(id => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])])
  }
  const batchUpdateLock = (locked: boolean) => {
    selectedTasks.filter(item => item.locked !== locked).forEach(item => updateAssignment(item.id, { locked }))
    setSelectedTaskIds([])
  }
  const batchComplete = () => {
    selectedTasks.filter(item => item.status !== 'done' && item.id !== state.timer.assignmentId).forEach(item => finishAssignment(item.id))
    setSelectedTaskIds([])
  }
  const batchArchiveGroups = () => {
    const groupIds = [...new Set(selectedTasks.map(item => item.groupId))]
    if (!groupIds.length || !window.confirm(t('tasksPage.confirmArchiveGroups', { count: groupIds.length }))) return
    groupIds.forEach(id => {
      const group = state.taskGroups.find(item => item.id === id)
      if (group) editTaskGroup({ ...group, status: 'archived', hidden: true })
    })
    setSelectedTaskIds([])
  }

  const prepareGroupMove = (group: TaskGroup, date: string) => {
    if (!date || date < state.settings.startDate || date > state.settings.endDate) { window.alert(t('tasksPage.alertOutOfRange')); return }
    const candidates = state.assignments.filter(item => item.groupId === group.id && item.status !== 'done' && !item.locked && item.id !== state.timer.assignmentId)
    if (!candidates.length) { window.alert(t('tasksPage.alertNoMovableUnfinished')); return }
    const prepared = cloneActiveState(state)
    const movedAt = new Date().toISOString()
    const affectedDates = new Set<string>([date])
    for (const source of candidates) {
      const item = prepared.assignments.find(candidate => candidate.id === source.id)
      if (!item) continue
      if (item.scheduledDate) affectedDates.add(item.scheduledDate)
      item.previousDate = item.scheduledDate
      item.scheduledDate = date
      item.lastManualMoveAt = movedAt
      item.scheduleSource = 'manual'
      item.intentStrength = 'manual'
    }
    const affectedAssignmentIds = candidates.map(item => item.id)
    const affectedGoalIds = prepared.goals.filter(goal => goal.linkedTaskGroupIds.includes(group.id) || goal.linkedAssignmentIds.some(id => affectedAssignmentIds.includes(id)) || goal.completionConditions.some(condition => condition.groupId === group.id)).map(goal => goal.id)
    const event: PlanChangeEvent = {
      id: uid('event'), type: 'bulk-move', action: 'repair', title: t('tasksPage.groupMoveEventTitle', { title: group.title }),
      description: t('tasksPage.groupMoveEventDesc', { count: candidates.length, date }),
      affectedGoalIds, affectedGroupIds: [group.id], affectedAssignmentIds, affectedDates: Array.from(affectedDates).sort(), createdAt: movedAt,
      metadata: { requestedDate: date, explicitLocalOperation: true, operationScope: 'requested-change-only', requestedChangeLabel: t('tasksPage.groupMoveChangeLabel', { title: group.title, count: candidates.length }), preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'] },
    }
    prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
    prepared.updatedAt = movedAt
    setMovingGroup(undefined)
    onPrepared(prepared, event)
  }

  const prepareTaskMove = (assignment: Assignment, date: string) => {
    const earliest = today > state.settings.startDate ? today : state.settings.startDate
    if (!date || date < earliest || date > state.settings.endDate) { window.alert(t('tasksPage.alertChooseValidDate')); return }
    if (assignment.status === 'done' || assignment.locked || assignment.id === state.timer.assignmentId) { window.alert(t('tasksPage.alertCannotReschedule')); return }
    const prepared = cloneActiveState(state)
    const item = prepared.assignments.find(candidate => candidate.id === assignment.id)
    if (!item) return
    const movedAt = new Date().toISOString()
    const previousDate = item.scheduledDate
    item.previousDate = previousDate
    item.scheduledDate = date
    item.lastManualMoveAt = movedAt
    item.scheduleSource = 'manual'
    item.intentStrength = 'manual'
    const affectedDates = Array.from(new Set([...(previousDate ? [previousDate] : []), date])).sort()
    const affectedGoalIds = prepared.goals.filter(goal => goal.linkedTaskGroupIds.includes(item.groupId) || goal.linkedAssignmentIds.includes(item.id) || goal.completionConditions.some(condition => condition.groupId === item.groupId)).map(goal => goal.id)
    const event: PlanChangeEvent = {
      id: uid('event'), type: 'bulk-move', action: 'repair', title: t('tasksPage.rescheduleEventTitle', { title: item.title }),
      description: t('tasksPage.rescheduleEventDesc', { date: fmtDate(date) }),
      affectedGoalIds, affectedGroupIds: [item.groupId], affectedAssignmentIds: [item.id], affectedDates, createdAt: movedAt,
      metadata: { requestedDate: date, explicitLocalOperation: true, operationScope: 'requested-change-only', requestedChangeLabel: t('tasksPage.rescheduleChangeLabel', { title: item.title }), preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'] },
    }
    prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
    prepared.updatedAt = movedAt
    setMovingTask(undefined)
    onPrepared(prepared, event)
  }

  const filterOptions: Array<{ id: typeof taskFilter; label: string; count: number }> = [
    { id: 'attention', label: t('tasksPage.filterAttention'), count: taskCounts.attention },
    { id: 'unscheduled', label: t('tasksPage.filterUnscheduled'), count: taskCounts.unscheduled },
    { id: 'overdue', label: t('tasksPage.filterOverdue'), count: taskCounts.overdue },
    { id: 'today', label: t('tasksPage.filterToday'), count: taskCounts.today },
    { id: 'future', label: t('tasksPage.filterFuture'), count: taskCounts.future },
    { id: 'done', label: t('tasksPage.filterDone'), count: taskCounts.done },
    { id: 'all', label: t('tasksPage.filterAll'), count: taskCounts.all },
  ]

  return <>
    <section className="tasks-toolbar task-hub-toolbar">
      <div className="segmented-control task-mode-toggle"><button className={mode === 'tasks' ? 'active' : ''} onClick={() => setMode('tasks')}>{t('tasksPage.modeTasks')}</button><button className={mode === 'groups' ? 'active' : ''} onClick={() => setMode('groups')}>{t('tasksPage.modeGroups')}</button></div>
      <div className="search-box"><Search size={18}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder={mode === 'tasks' ? t('tasksPage.searchTasksPlaceholder') : t('tasksPage.searchGroupsPlaceholder')}/></div>
      <select value={priority} onChange={event => setPriority(event.target.value === 'all' ? 'all' : Number(event.target.value) as Priority)}><option value="all">{t('tasksPage.allPriorities')}</option>{[5,3,2,1,0].map(item => <option key={item} value={item}>{priorityLabel(item as Priority, t)}</option>)}</select>
      <select value={subject} onChange={event => setSubject(event.target.value as 'all'|Subject)}><option value="all">{t('tasksPage.allSubjects')}</option>{subjects.map(item => <option key={item}>{item}</option>)}</select>
      {mode === 'groups' && <label className="toggle-label"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)}/><span>{t('tasksPage.showHiddenGroups')}</span></label>}
      <div className="tasks-toolbar-note"><Inbox size={17}/><span>{t('tasksPage.addNewTaskNote')}</span><button className={`text-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.() : onOpenIntake()}>{t('tasksPage.openIntake')}</button></div>
    </section>


    {mode === 'tasks' ? <>
      <div className="task-inbox-summary"><div><strong>{t('tasksPage.taskInboxTitle')}</strong><span>{t('tasksPage.taskInboxHint')}</span></div><div><b>{taskCounts.attention}</b><small>{t('tasksPage.pendingCountUnit')}</small></div></div>
      <div className="task-filter-tabs">{filterOptions.map(item => <button key={item.id} className={taskFilter === item.id ? 'active' : ''} onClick={() => setTaskFilter(item.id)}><span>{item.label}</span><em>{item.count}</em></button>)}</div>
      {tasks.length > 0 && <div className="task-bulk-bar"><label className="task-bulk-select"><input type="checkbox" checked={visibleTasks.length > 0 && visibleTasks.every(item => selectedTaskIds.includes(item.id))} onChange={toggleAllVisible}/><span>{t('tasksPage.selectVisible')}</span></label>{selectedTaskIds.length > 0 ? <><strong>{t('tasksPage.selectedCount', { count: selectedTaskIds.length })}</strong><button className="secondary-button" onClick={batchComplete}>{t('tasksPage.batchComplete')}</button><button className="secondary-button" onClick={() => batchUpdateLock(true)}>{t('tasksPage.batchLock')}</button><button className="secondary-button" onClick={() => batchUpdateLock(false)}>{t('tasksPage.batchUnlock')}</button><button className="text-button" onClick={batchArchiveGroups}>{t('tasksPage.batchArchiveGroups')}</button><button className="text-button" onClick={() => setSelectedTaskIds([])}>{t('tasksPage.clearSelection')}</button></> : <span className="muted-text">{t('tasksPage.bulkActionsHint')}</span>}</div>}
      <section className="assignment-list">{visibleTasks.map(item => {
        const group = groupMap.get(item.groupId)!
        const overdue = item.status !== 'done' && Boolean(item.scheduledDate && item.scheduledDate < today)
        const unscheduled = item.status !== 'done' && !item.scheduledDate
        return <article className={`assignment-list-card ${overdue || unscheduled ? 'needs-attention' : ''} ${selectedTaskIds.includes(item.id) ? 'selected' : ''}`} key={item.id}>
          <label className="assignment-select-checkbox" aria-label={t('tk.036', { title: item.title })}><input type="checkbox" checked={selectedTaskIds.includes(item.id)} onChange={event => setSelectedTaskIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/></label><div className="assignment-list-main"><div className="task-title-row"><span className={`subject-pill subject-${group.subject}`}>{group.subject}</span><span className={`priority-badge priority-${group.priority}`}>{priorityLabel(group.priority, t)}</span><strong>{item.title}</strong></div><div className="task-meta"><span>{group.title}</span><span>{item.status === 'done' ? t('tk.001') : item.status === 'partial' ? t('tk.037', { progress: item.progress }) : t('tk.002')}</span><span>{item.scheduledDate ? (overdue ? t('tk.038', { scheduledDate: fmtDate(item.scheduledDate) }) : fmtDate(item.scheduledDate)) : t('tk.003')}</span><span>{t('tk.034', { estimatedMinutes: minutesText(item.estimatedMinutes) })}</span>{item.actualMinutes > 0 && <span>{t('tk.035', { actualMinutes: minutesText(item.actualMinutes) })}</span>}</div>{item.notes && <p>{item.notes}</p>}</div>
          <div className="assignment-list-actions">{(overdue || unscheduled) && <button className="primary-button" disabled={item.locked || item.id === state.timer.assignmentId} title={item.locked ? t('tk.006') : item.id === state.timer.assignmentId ? t('tk.007') : undefined} onClick={() => { setTaskMoveDate(today > state.settings.startDate ? today : state.settings.startDate); setMovingTask(item) }}>{t('tk.004')}</button>}<button className="secondary-button" onClick={() => updateAssignment(item.id, { locked: !item.locked })}>{item.locked ? t('tk.008') : t('tk.009')}</button><button className="danger-button" onClick={() => { const prepared = prepareAssignmentDelete(item.id); onPrepared(prepared.state, prepared.event) }}><Trash2 size={15}/>{t('tk.005')}</button></div>
        </article>
      })}{tasks.length > visibleTasks.length && <div className="list-pagination"><span>{t('tk.039', { length: visibleTasks.length, length2: tasks.length })}</span><button className="secondary-button" onClick={() => setVisibleTaskCount(value => value + 100)}>{t('tk.010')}</button></div>}{!tasks.length && <div className="empty-state"><CheckCircle2 size={30}/><h3>{taskFilter === 'attention' ? t('tk.011') : t('tk.012')}</h3><p>{taskFilter === 'attention' ? t('tk.013') : t('tk.014')}</p></div>}</section>
    </> : <>
      <section className="group-list">{groups.map(group => { const items = assignmentsByGroup.get(group.id) ?? []; const done = items.filter(item => item.status === 'done').length; const actual = items.reduce((sum,item) => sum + item.actualMinutes,0); const planned = items.reduce((sum,item) => sum + item.estimatedMinutes,0); const durationSuggestion = allDurationSuggestions(state).find(item => item.groupId === group.id); const linkedGoals = state.goals.filter(goal => goal.linkedTaskGroupIds.includes(group.id) || goal.completionConditions.some(condition => condition.groupId === group.id)); return <article className="group-card" key={group.id}><div className="group-card-head"><div><span className={`subject-pill subject-${group.subject}`}>{group.subject}</span><span className={`priority-badge priority-${group.priority}`}>{priorityLabel(group.priority, t)}</span><span className="status-pill">{group.status === 'completed' ? t('tk.001') : group.status === 'archived' ? t('tk.019') : t('tk.020')}</span><h3>{group.title}</h3></div><div className="group-actions"><button className="text-button" onClick={() => { setMoveDate(today); setMovingGroup(group) }}>{t('tk.015')}</button><button className="text-button" onClick={() => setEditing(group)}>{t('tk.016')}</button><button className="icon-button danger-icon" aria-label={t('tk.046', { title: group.title })} onClick={() => { const prepared = prepareTaskGroupDelete(group.id); onPrepared(prepared.state, prepared.event) }}><Trash2 size={17}/></button></div></div><div className="group-stats"><span>{t('tk.040', { done: done, length: items.length })}</span><span>{t('tk.041', { planned: minutesText(planned) })}</span><span>{t('tk.042', { actual: minutesText(actual) })}</span><span>{t('tk.043', { length: linkedGoals.length })}</span>{group.dailyMax && <span>{t('tk.044', { dailyMax: group.dailyMax })}</span>}</div><div className="progress-track"><i style={{width:`${items.length ? done/items.length*100 : 0}%`}}/></div>{(group.notes || group.sourceLabel) && <p className="group-note">{group.notes || group.sourceLabel}</p>}{durationSuggestion && <div className="duration-suggestion"><div><strong>{t('tk.017')}</strong><span>{t('tk.045', { currentEstimate: durationSuggestion.currentEstimate, sampleCount: durationSuggestion.sampleCount, recentAverage: Math.round(durationSuggestion.recentAverage), suggestedEstimate: durationSuggestion.suggestedEstimate })}</span></div><button className="secondary-button" onClick={() => { const prepared = prepareDurationChange(durationSuggestion); onPrepared(prepared.state, prepared.event) }}>{t('tk.018')}</button></div>}</article> })}
        {!groups.length && <div className="empty-state"><CheckCircle2 size={30}/><h3>{state.taskGroups.filter(group => !group.hiddenStandalone).length ? t('tk.022') : t('tk.023')}</h3><p>{state.taskGroups.length ? t('tk.024') : t('tk.025')}</p><button className="primary-button" onClick={onOpenIntake}>{t('tk.021')}</button></div>}
      </section>
    </>}

    <Modal open={Boolean(movingTask)} title={movingTask ? t('tk.047', { title: movingTask.title }) : t('tk.026')} onClose={() => setMovingTask(undefined)}>
      {movingTask && <><p className="muted-text">{t('tk.027')}</p><label className="field"><span>{t('tk.028')}</span><input type="date" min={today > state.settings.startDate ? today : state.settings.startDate} max={state.settings.endDate} value={taskMoveDate} onChange={event => setTaskMoveDate(event.target.value)}/></label><div className="modal-actions"><button className="secondary-button" onClick={() => setMovingTask(undefined)}>{t('tk.029')}</button><button className="primary-button" onClick={() => prepareTaskMove(movingTask, taskMoveDate)}>{t('tk.030')}</button></div></>}
    </Modal>

    <Modal open={Boolean(movingGroup)} title={movingGroup ? t('tk.048', { title: movingGroup.title }) : t('tk.031')} onClose={() => setMovingGroup(undefined)}>
      {movingGroup && <><p className="muted-text">{t('tk.032')}</p><label className="field"><span>{t('tk.033')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={moveDate} onChange={event => setMoveDate(event.target.value)}/></label><div className="modal-actions"><button className="secondary-button" onClick={() => setMovingGroup(undefined)}>{t('tk.029')}</button><button className="primary-button" onClick={() => prepareGroupMove(movingGroup, moveDate)}>{t('tk.030')}</button></div></>}
    </Modal>
    <TaskGroupDialog open={Boolean(editing)} state={state} initial={editing} onClose={() => setEditing(undefined)} onCreate={() => undefined} onEdit={(group, numberingChoice) => {
      const original = state.taskGroups.find(item => item.id === group.id)
      // 科目/分类名称属于纯展示元数据（如“数学”“化学”），重命名不触发调度分析。
      const affectsPlan = Boolean(original && (original.quantity !== group.quantity || original.unitMinutes !== group.unitMinutes
        || original.priority !== group.priority || original.dailyMax !== group.dailyMax || original.activityType !== group.activityType
        || original.highIntensity !== group.highIntensity || original.countInStats !== group.countInStats))
      if (affectsPlan) {
        const prepared = prepareTaskGroupEdit(group, numberingChoice)
        onPrepared(prepared.state, prepared.event)
      } else editTaskGroup(group)
    }}/>
  </>
}

function SettingsPage({ sessionUserId, sessionEmail, cloudMessage, onCloudUpload, onPrepared, onStartTutorial }: { sessionUserId?: string; sessionEmail?: string; cloudMessage?: string; onCloudUpload: () => Promise<string>; onPrepared: (state: AppState, event: PlanChangeEvent) => void; onStartTutorial: () => void }) {
  const t = useT()
  const { state, namespace, updateSettings, undo, canUndo, replaceState, resetAll, restoreReplanHistory, previewPlanVersion, restorePlanVersion } = useApp()
  const [email,setEmail]=useState('')
  const [password,setPassword]=useState('')
  const [authMessage,setAuthMessage]=useState('')
  const [historyEntry,setHistoryEntry]=useState<AppState['replanHistory'][number]>()
  const [planNameDraft,setPlanNameDraft]=useState(state.settings.planName)
  const [subjectDraft,setSubjectDraft]=useState('')
  const [versionOpen,setVersionOpen]=useState<AppState['planVersions'][number]>()
  const [replacementPreview,setReplacementPreview]=useState<{label:string;state:AppState}>()
  const [recoverySnapshots,setRecoverySnapshots]=useState<DataRecoverySnapshot[]>([])
  const fileRef=useRef<HTMLInputElement>(null)
  useEffect(() => setPlanNameDraft(state.settings.planName), [state.settings.planName])
  useEffect(() => { void listRecoverySnapshots(namespace).then(setRecoverySnapshots) }, [namespace, state.schemaVersion])
  const versionDiff = versionOpen ? previewPlanVersion(versionOpen.id) : undefined
  const exportJson=()=>downloadBlob(JSON.stringify(state,null,2),`study-plan-v0.8-${todayISO()}.json`,'application/json')
  const exportCsv=()=>{const groups=new Map(state.taskGroups.map(group=>[group.id,group]));const rows=[[t('set.001'),t('set.002'),t('set.003'),t('set.004'),t('set.005'),t('set.006'),t('set.007'),t('set.008'),t('set.009'),t('set.010')]];for(const item of state.assignments){const group=groups.get(item.groupId);if(group)rows.push([group.subject,item.title,item.scheduledDate??'',item.status,String(item.estimatedMinutes),String(item.actualMinutes),String(item.progress),String(group.priority),item.scheduleSource,item.intentStrength])}downloadBlob('\ufeff'+rows.map(row=>row.map(csvEscape).join(',')).join('\n'),`study-plan-${todayISO()}.csv`,'text/csv;charset=utf-8')}
  const importJson=(file:File)=>{const reader=new FileReader();reader.onload=()=>{void(async()=>{try{const parsed=JSON.parse(String(reader.result)) as unknown;const validation=validateStateInput(parsed,'json');if(!validation.success||!validation.data){await preserveRecoverySnapshot(namespace,parsed,'invalid-data','json',validation.issues);setRecoverySnapshots(await listRecoverySnapshots(namespace));window.alert(t('set.157', { n: validation.issues.slice(0,4).join('\n') }));return}const incomingVersion=Number(validation.data.schemaVersion??validation.data.version??0);if(incomingVersion<SCHEMA_VERSION)await preserveRecoverySnapshot(namespace,parsed,'before-migration','json');await preserveRecoverySnapshot(namespace,state,'before-replacement','json');setRecoverySnapshots(await listRecoverySnapshots(namespace));setReplacementPreview({label:t('set.158', { name: file.name }),state:normalizeState(validation.data)})}catch{window.alert(t('set.172'))}})()};reader.readAsText(file)}
  const login=async(kind:'in'|'up')=>{try{setAuthMessage(t('set.011'));await(kind==='in'?signIn(email,password):signUp(email,password));setAuthMessage(kind==='in'?t('set.012'):t('set.013'))}catch(error){setAuthMessage(error instanceof Error?error.message:t('set.014'))}}
  const cloudUpload=async()=>{try{const timestamp=await onCloudUpload();setAuthMessage(t('set.159', { toLocaleString: new Date(timestamp).toLocaleString() }))}catch(error){setAuthMessage(error instanceof Error?error.message:t('set.015'))}}
  const cloudDownload=async()=>{try{const cloud=await downloadSnapshot(sessionUserId);if(!cloud){setAuthMessage(t('set.016'));return}setReplacementPreview({label:t('set.017'),state:normalizeState({...cloud.state,replanHistory:state.replanHistory,conflictBackups:state.conflictBackups,planVersions:state.planVersions})})}catch(error){setAuthMessage(error instanceof Error?error.message:t('set.018'))}}
  const restoreConflict=(raw:string)=>{try{const parsed=JSON.parse(raw) as AppState;setReplacementPreview({label:t('set.019'),state:normalizeState(parsed)})}catch{window.alert(t('set.173'))}}
  const openRecoverySnapshot=(snapshot:DataRecoverySnapshot)=>{try{const parsed=JSON.parse(snapshot.raw) as unknown;const validation=validateStateInput(parsed,'snapshot');if(!validation.success||!validation.data){window.alert(t('set.160', { n: validation.issues.slice(0,4).join('\n') }));return}setReplacementPreview({label:t('set.161', { toLocaleString: new Date(snapshot.createdAt).toLocaleString() }),state:normalizeState(validation.data)})}catch{window.alert(t('set.174'))}}
  const recoveryReason=(reason:DataRecoverySnapshot['reason'])=>reason==='before-migration'?t('set.020'):reason==='invalid-data'?t('set.021'):reason==='before-replacement'?t('set.022'):t('set.023')
  const addSubject=()=>{const value=subjectDraft.trim();if(!value)return;updateSettings({customSubjects:Array.from(new Set([...state.settings.customSubjects,value]))});setSubjectDraft('')}
  const prepareSettingsChange = (patch: Partial<AppState['settings']>, title: string, type: PlanChangeEvent['type'] = 'rule-change') => {
    const prepared = cloneActiveState(state)
    prepared.settings = { ...prepared.settings, ...patch }
    if (prepared.settings.startDate > prepared.settings.endDate) { window.alert(t('set.175')); return }
    const now = new Date().toISOString()
    const availability = type === 'availability-change'
    let hasIncrease = false
    let hasDecrease = false
    if (availability) {
      for (const key of ['regularMinutes', 'studyMinutes', 'travelMinutes'] as const) {
        if (patch[key] == null) continue
        if (prepared.settings[key] > state.settings[key]) hasIncrease = true
        if (prepared.settings[key] < state.settings[key]) hasDecrease = true
      }
      if (patch.startDate) {
        if (prepared.settings.startDate < state.settings.startDate) hasIncrease = true
        if (prepared.settings.startDate > state.settings.startDate) hasDecrease = true
      }
      if (patch.endDate) {
        if (prepared.settings.endDate > state.settings.endDate) hasIncrease = true
        if (prepared.settings.endDate < state.settings.endDate) hasDecrease = true
      }
    }
    const pureRelaxation = availability && hasIncrease && !hasDecrease
    const affected = prepared.assignments.filter(item => item.status !== 'done' && (!item.scheduledDate || item.scheduledDate >= todayISO()))
    const affectedAssignmentIds = affected.map(item => item.id)
    const affectedGroupIds = Array.from(new Set(affected.map(item => item.groupId)))
    const affectedGoalIds = prepared.goals.filter(goal => goal.status === 'active' && (
      goal.linkedTaskGroupIds.some(id => affectedGroupIds.includes(id))
      || goal.linkedAssignmentIds.some(id => affectedAssignmentIds.includes(id))
      || goal.completionConditions.some(condition => affectedGroupIds.includes(condition.groupId))
    )).map(goal => goal.id)
    const rangeStart = [todayISO(), state.settings.startDate, prepared.settings.startDate].sort().at(-1) ?? todayISO()
    const rangeEnd = state.settings.endDate > prepared.settings.endDate ? state.settings.endDate : prepared.settings.endDate
    const affectedDates = rangeStart <= rangeEnd ? dateRange(rangeStart, rangeEnd) : []
    const event: PlanChangeEvent = {
      id: uid('event'), type, action: pureRelaxation ? 'optimize' : 'repair', title,
      description: pureRelaxation
        ? t('set.024')
        : t('set.025'),
      affectedGoalIds, affectedGroupIds, affectedAssignmentIds, affectedDates, createdAt: now,
      metadata: { settingsPatch: patch, pureRelaxation, hasIncrease, hasDecrease, preferredPreferences: ['preserve', 'balanced', 'goal', 'rest'] },
    }
    prepared.changeEvents = [...prepared.changeEvents, event].slice(-100)
    prepared.updatedAt = now
    onPrepared(prepared, event)
  }
  return <div className="settings-stack">
    <SettingsSection title={t('set.026')} description={t('set.027')}><div className="button-wrap"><button className="secondary-button" onClick={onStartTutorial}>{t('set.028')}</button></div></SettingsSection>
    <SettingsSection title={t('set.029')} description={t('set.030')}><div className="form-grid"><label className="field span-2"><span>{t('set.031')}</span><input value={planNameDraft} onChange={event=>setPlanNameDraft(event.target.value)} onBlur={()=>planNameDraft!==state.settings.planName&&updateSettings({planName:planNameDraft})}/></label><label className="field"><span>{t('set.032')}</span><input type="date" value={state.settings.startDate} onChange={event=>prepareSettingsChange({startDate:event.target.value}, t('set.038'), 'availability-change')}/></label><label className="field"><span>{t('set.033')}</span><input type="date" value={state.settings.endDate} onChange={event=>prepareSettingsChange({endDate:event.target.value}, t('set.039'), 'availability-change')}/></label><label className="field"><span>{t('set.034')}</span><select value={state.settings.planningMode} onChange={event=>updateSettings({planningMode:event.target.value as AppState['settings']['planningMode']})}><option value="sprint">{t('set.035')}</option><option value="balanced">{t('set.036')}</option><option value="relaxed">{t('set.037')}</option></select></label></div></SettingsSection>
    <SettingsSection title={t('set.040')} description={t('set.041')}><div className="form-grid"><label className="field"><span>{t('set.042')}</span><select value={state.settings.theme} onChange={event=>updateSettings({theme:event.target.value as AppState['settings']['theme']})}><option value="system">{t('set.043')}</option><option value="light">{t('set.044')}</option><option value="dark">{t('set.045')}</option></select></label></div></SettingsSection>
    <details className="settings-advanced"><summary>{t('set.046')}</summary><div className="settings-advanced-body">
    <SettingsSection title={t('set.047')} description={t('set.048')}><div className="form-grid three"><label className="field"><span>{t('set.049')}</span><NumericInput commitMode="blur" min={0} max={7} value={state.settings.freezeDays} onValueChange={value=>updateSettings({freezeDays:value})}/></label><label className="field"><span>{t('set.050')}</span><NumericInput commitMode="blur" min={1} max={100} value={state.settings.regularMaxTasks} onValueChange={value=>updateSettings({regularMaxTasks:value})}/></label><label className="field"><span>{t('set.051')}</span><NumericInput commitMode="blur" min={1} max={100} value={state.settings.studyMaxTasks} onValueChange={value=>updateSettings({studyMaxTasks:value})}/></label><label className="field"><span>{t('set.052')}</span><NumericInput commitMode="blur" min={50} max={100} value={Math.round(state.settings.targetUtilization*100)} onValueChange={value=>updateSettings({targetUtilization:value/100})}/></label><label className="field"><span>{t('set.053')}</span><NumericInput commitMode="blur" min={60} max={100} value={Math.round(state.settings.nearFullThreshold*100)} onValueChange={value=>updateSettings({nearFullThreshold:value/100})}/></label><label className="field"><span>{t('set.054')}</span><NumericInput commitMode="blur" min={0} max={80} value={Math.round(state.settings.bufferUtilization*100)} onValueChange={value=>updateSettings({bufferUtilization:value/100})}/></label><label className="field"><span>{t('set.055')}</span><NumericInput commitMode="blur" min={1} max={14} value={state.settings.localRepairRadius} onValueChange={value=>updateSettings({localRepairRadius:value})}/></label><label className="field"><span>{t('set.056')}</span><NumericInput commitMode="blur" min={0} max={10} value={state.settings.maxNewTasksPerDay} onValueChange={value=>updateSettings({maxNewTasksPerDay:value})}/></label><label className="field"><span>{t('set.057')}</span><NumericInput commitMode="blur" min={30} max={600} value={state.settings.longTaskThresholdMinutes} onValueChange={value=>updateSettings({longTaskThresholdMinutes:value})}/><small>{t('set.058')}</small></label><label className="field"><span>{t('set.059')}</span><NumericInput commitMode="blur" min={0} max={20} value={state.settings.longTaskMaxPerDay} onValueChange={value=>updateSettings({longTaskMaxPerDay:value})}/><small>{t('set.060')}</small></label><label className="field"><span>{t('set.061')}</span><NumericInput commitMode="blur" min={0} max={20} value={state.settings.longTaskMaxPerDayLight} onValueChange={value=>updateSettings({longTaskMaxPerDayLight:value})}/><small>{t('set.062')}</small></label><label className="field"><span>{t('set.063')}</span><NumericInput commitMode="blur" min={0} max={100} value={Math.round(state.settings.maxLoadChangeRatio*100)} onValueChange={value=>updateSettings({maxLoadChangeRatio:value/100})}/></label><label className="field"><span>{t('set.064')}</span><NumericInput commitMode="blur" min={30} max={100} value={Math.round(state.settings.subjectShareLimit*100)} onValueChange={value=>updateSettings({subjectShareLimit:value/100})}/></label></div></SettingsSection>
    <SettingsSection title={t('set.065')} description={t('set.066')}><div className="form-grid three"><label className="field"><span>{t('set.071')}</span><NumericInput commitMode="blur" min={0} max={1440} value={state.settings.regularMinutes} onValueChange={value=>prepareSettingsChange({regularMinutes:value}, t('set.074'), 'availability-change')}/></label><label className="field"><span>{t('set.072')}</span><NumericInput commitMode="blur" min={0} max={1440} value={state.settings.studyMinutes} onValueChange={value=>prepareSettingsChange({studyMinutes:value}, t('set.075'), 'availability-change')}/></label><label className="field"><span>{t('set.073')}</span><NumericInput commitMode="blur" min={0} max={1440} value={state.settings.travelMinutes} onValueChange={value=>prepareSettingsChange({travelMinutes:value}, t('set.076'), 'availability-change')}/></label></div><div className="toggle-grid"><Toggle checked={state.settings.countWordsTime} onChange={value=>updateSettings({countWordsTime:value})} label={t('set.067')}/><Toggle checked={state.settings.showWarnings} onChange={value=>updateSettings({showWarnings:value})} label={t('set.068')}/><Toggle checked={state.settings.optionalReview} onChange={value=>updateSettings({optionalReview:value})} label={t('set.069')}/><Toggle checked={state.settings.keepOfflineOnLogout} onChange={value=>updateSettings({keepOfflineOnLogout:value})} label={t('set.070')}/></div></SettingsSection>
    <SettingsSection title={t('set.077')} description={t('set.078')}><div className="setup-confirmation"><div><strong>{state.settings.setupProgress?.availabilityConfirmed ? t('set.079') : t('set.080')}</strong><span>{state.settings.setupProgress?.availabilityConfirmed ? t('set.081') : t('set.082')}</span></div><button className="secondary-button" onClick={()=>updateSettings({setupProgress:{...(state.settings.setupProgress ?? {}), currentStep:3, availabilityConfirmed:true}})}>{state.settings.setupProgress?.availabilityConfirmed ? t('set.083') : t('set.084')}</button></div></SettingsSection>
    <CalendarConstraintManager onPrepared={onPrepared}/>
    <SettingsSection title={t('set.085')} description={t('set.086')}><div className="custom-subject-editor"><div className="button-wrap"><input value={subjectDraft} onChange={event=>setSubjectDraft(event.target.value)} placeholder={t('set.087')}/><button className="primary-button" onClick={addSubject}>{t('set.088')}</button></div><div className="tag-list">{state.settings.customSubjects.map(item=><span key={item}>{item}<button aria-label={t('set.162', { item: item })} onClick={()=>updateSettings({customSubjects:state.settings.customSubjects.filter(subject=>subject!==item)})}>×</button></span>)}</div></div></SettingsSection>
    <SettingsSection title={t('set.089')} description={t('set.090')}><div className="form-grid three"><label className="field"><span>{t('set.092')}</span><NumericInput commitMode="blur" min={3} max={50} value={state.settings.duration.windowSize} onValueChange={value=>updateSettings({duration:{...state.settings.duration,windowSize:value}})}/></label><label className="field"><span>{t('set.093')}</span><NumericInput commitMode="blur" min={2} max={20} value={state.settings.duration.minimumSamples} onValueChange={value=>updateSettings({duration:{...state.settings.duration,minimumSamples:value}})}/></label><label className="field"><span>{t('set.094')}</span><NumericInput commitMode="blur" min={5} max={100} value={Math.round(state.settings.duration.deviationThreshold*100)} onValueChange={value=>updateSettings({duration:{...state.settings.duration,deviationThreshold:value/100}})}/></label></div><Toggle checked={state.settings.duration.enabled} onChange={value=>updateSettings({duration:{...state.settings.duration,enabled:value}})} label={t('set.091')}/></SettingsSection>
    </div></details>
    <details className="settings-advanced"><summary>{t('set.095')}</summary><div className="settings-advanced-body">
    <SettingsSection title={t('set.096')} description={t('set.097')}><div className="history-list">{state.planVersions.length?[...state.planVersions].reverse().map(version=><div className="history-row" key={version.id}><div><strong>{version.reason}</strong><span>{t('set.163', { toLocaleString: new Date(version.timestamp).toLocaleString(), movedTaskCount: version.summary.movedTaskCount, affectedDateCount: version.summary.affectedDateCount })}</span><small>{t('set.164', { schemaVersion: version.schemaVersion })}</small></div><div className="button-wrap"><button className="secondary-button" onClick={()=>setVersionOpen(version)}>{t('set.098')}</button></div></div>):<p className="muted-text">{t('set.099')}</p>}</div></SettingsSection>
    {state.replanHistory.length > 0 && <SettingsSection title={t('set.100')} description={t('set.101')}><div className="history-list">{[...state.replanHistory].reverse().map(entry=><div className="history-row" key={entry.id}><div><strong>{entry.label}</strong><span>{t('set.165', { toLocaleString: new Date(entry.createdAt).toLocaleString(), moveCount: entry.moveCount })}</span></div><div className="button-wrap">{entry.afterSnapshot&&<button className="secondary-button" onClick={()=>setHistoryEntry(entry)}>{t('set.102')}</button>}<button className="secondary-button" onClick={()=>restoreReplanHistory(entry.id)}>{t('set.103')}</button></div></div>)}</div></SettingsSection>}
    </div></details>
    <SettingsSection title={t('set.104')} description={t('set.176',{space:namespace==='guest'?t('set.116'):sessionEmail??t('set.117')})}><div className="button-wrap"><button className="secondary-button" onClick={exportJson}><Download size={16}/>{t('set.105')}</button><button className="secondary-button" onClick={exportCsv}><FileDown size={16}/>{t('set.106')}</button><button className="secondary-button" onClick={()=>window.print()}><FileDown size={16}/>{t('set.107')}</button><button className="secondary-button" onClick={()=>fileRef.current?.click()}><Upload size={16}/>{t('set.108')}</button><input ref={fileRef} type="file" accept="application/json" hidden onChange={event=>event.target.files?.[0]&&importJson(event.target.files[0])}/><button className="secondary-button" disabled={!canUndo} onClick={undo}><RotateCcw size={16}/>{t('set.109')}</button>{namespace==='guest'&&<><button className="secondary-button" onClick={()=>window.confirm(t('set.118'))&&resetAll('demo')}>{t('set.110')}</button><button className="secondary-button" onClick={()=>window.confirm(t('set.119'))&&resetAll('blank')}>{t('set.111')}</button></>}<button className="danger-button" onClick={()=>window.confirm(t('set.120'))&&resetAll(namespace==='guest'?'demo':'blank')}><Trash2 size={16}/>{t('set.112')}</button></div>{state.conflictBackups.length>0&&<div className="conflict-backups"><strong>{t('set.113')}</strong><p>{t('set.114')}</p>{state.conflictBackups.slice(-5).reverse().map((raw,index)=><div key={index}><span>{t('set.166', { index: state.conflictBackups.length-index })}</span><div className="button-wrap"><button className="text-button" onClick={()=>restoreConflict(raw)}>{t('set.103')}</button><button className="text-button" onClick={()=>downloadBlob(raw,`study-plan-conflict-${index+1}.json`,'application/json')}>{t('set.115')}</button></div></div>)}</div>}</SettingsSection>
    {supabaseConfigured && <SettingsSection title={t('set.121')} description={t('set.122')}>{sessionEmail?<div className="cloud-panel"><div><Cloud size={20}/><span>{t('set.167', { sessionEmail: sessionEmail })}</span></div><div className="button-wrap"><button className="secondary-button" onClick={cloudUpload}>{t('set.125')}</button><button className="secondary-button" onClick={cloudDownload}>{t('set.126')}</button><button className="secondary-button" onClick={()=>signOut()}>{t('set.127')}</button></div></div>:<div className="auth-form"><input type="email" placeholder={t('set.123')} value={email} onChange={event=>setEmail(event.target.value)}/><input type="password" placeholder={t('set.124')} value={password} onChange={event=>setPassword(event.target.value)}/><button className="primary-button" onClick={()=>login('in')}>{t('set.128')}</button><button className="secondary-button" onClick={()=>login('up')}>{t('set.129')}</button></div>}{(authMessage||cloudMessage)&&<p className="settings-message">{authMessage||cloudMessage}</p>}</SettingsSection>}

    <Modal open={Boolean(replacementPreview)} title={t('set.130')} onClose={()=>setReplacementPreview(undefined)} wide mobileFullscreen>{replacementPreview&&<><p><strong>{replacementPreview.label}</strong></p><div className="proposal-summary-grid"><div><strong>{state.assignments.length} → {replacementPreview.state.assignments.length}</strong><span>{t('set.002')}</span></div><div><strong>{state.goals.length} → {replacementPreview.state.goals.length}</strong><span>{t('set.131')}</span></div><div><strong>{state.calendarConstraints.length} → {replacementPreview.state.calendarConstraints.length}</strong><span>{t('set.132')}</span></div><div><strong>{state.assignments.filter(item=>item.status==='done').length} → {replacementPreview.state.assignments.filter(item=>item.status==='done').length}</strong><span>{t('set.133')}</span></div></div><div className="alert warning"><Sparkles size={18}/><div><strong>{t('set.134')}</strong><span>{t('set.135')}</span></div></div><div className="modal-actions"><button className="secondary-button" onClick={()=>setReplacementPreview(undefined)}>{t('set.136')}</button><button className="primary-button" onClick={()=>{replaceState(replacementPreview.state,true);setReplacementPreview(undefined);setAuthMessage(t('set.138'))}}>{t('set.137')}</button></div></>}</Modal>
    <SettingsSection title={t('set.139')} description={t('set.140')}>
      {recoverySnapshots.length ? <div className="history-list recovery-list">{[...recoverySnapshots].reverse().map(snapshot=><div className="history-row" key={snapshot.id}><div><strong>{recoveryReason(snapshot.reason)}</strong><span>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.source} · schema v{snapshot.schemaVersion??t('set.145')}</span>{snapshot.issues?.length&&<small>{snapshot.issues.slice(0,2).join('；')}</small>}</div><div className="button-wrap"><button className="secondary-button" onClick={()=>openRecoverySnapshot(snapshot)}>{t('set.141')}</button><button className="text-button" onClick={()=>downloadBlob(snapshot.raw,`study-plan-recovery-${snapshot.createdAt.slice(0,10)}-${snapshot.id}.json`,'application/json')}>{t('set.142')}</button><button className="text-button danger-text" onClick={()=>{if(window.confirm(t('set.146')))void deleteRecoverySnapshot(namespace,snapshot.id).then(()=>listRecoverySnapshots(namespace)).then(setRecoverySnapshots)}}>{t('set.143')}</button></div></div>)}</div>:<p className="muted-text">{t('set.144')}</p>}
    </SettingsSection>
    <HistoryDiffDialog entry={historyEntry} onClose={()=>setHistoryEntry(undefined)}/>
    <Modal open={Boolean(versionOpen)} title={t('set.147')} onClose={()=>setVersionOpen(undefined)} wide mobileFullscreen>{versionOpen&&versionDiff&&<><p><strong>{versionOpen.reason}</strong><br/><span className="muted-text">{t('set.148')}</span></p><div className="proposal-summary-grid"><div><strong>{versionDiff.moved.length}</strong><span>{t('set.149')}</span></div><div><strong>{versionDiff.added.length}</strong><span>{t('set.150')}</span></div><div><strong>{versionDiff.removed.length}</strong><span>{t('set.151')}</span></div><div><strong>{versionDiff.goalChanges.length}</strong><span>{t('set.152')}</span></div></div><details open><summary>{t('set.168', { length: versionDiff.moved.length })}</summary><ul>{versionDiff.moved.map(item=><li key={item.id}>{item.title}：{item.from??t('set.155')} → {item.to??t('set.155')}</li>)}</ul></details><details><summary>{t('set.153')}</summary><ul>{versionDiff.added.map(item=><li key={`a-${item.id}`}>{t('set.169', { title: item.title })}</li>)}{versionDiff.removed.map(item=><li key={`r-${item.id}`}>{t('set.170', { title: item.title })}</li>)}</ul></details><details><summary>{t('set.171', { length: versionDiff.goalChanges.length })}</summary><ul>{versionDiff.goalChanges.map(item=><li key={item.id}>{item.title}：{item.before??t('set.156')} → {item.after??t('set.156')}</li>)}</ul></details><div className="modal-actions"><button className="secondary-button" onClick={()=>setVersionOpen(undefined)}>{t('set.136')}</button><button className="primary-button" onClick={()=>{restorePlanVersion(versionOpen.id);setVersionOpen(undefined)}}>{t('set.154')}</button></div></>}</Modal>
  </div>
}

function SettingsSection({title,description,children}:{title:string;description:string;children:React.ReactNode}){return <section className="settings-section"><div><h2>{title}</h2><p>{description}</p></div><div>{children}</div></section>}
function Toggle({checked,onChange,label}:{checked:boolean;onChange:(v:boolean)=>void;label:string}){return <label className="switch-row"><button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked?'on':''}`} onClick={()=>onChange(!checked)}><i/></button><span>{label}</span></label>}
function EmptyState({title,text}:{title:string;text:string}){return <div className="empty-state"><CheckCircle2 size={30}/><h3>{title}</h3><p>{text}</p></div>}
function downloadBlob(content:string,name:string,type:string){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url)}
function csvEscape(v:string){return `"${v.replaceAll('"','""')}"`}
