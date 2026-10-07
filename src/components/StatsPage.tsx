import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, BarChart3, CalendarDays, CheckCircle2, ChevronRight, Download,
  Clock3, Flame, Focus, Maximize2, Pencil, Table2, Target, Trash2, TrendingUp, X
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts'
import { getDay, parseISO } from 'date-fns'
import { useApp } from '../AppContext'
import { tr, useT } from '../lib/i18n'
import type { Assignment, DailyPlanBaseline, Subject, TaskGroup, TimeEntry } from '../types'
import { dateRange, fmtDate, fmtWeekday, minutesText, shiftDate, todayISO } from '../lib/date'
import { allDurationSuggestions, predictCompletion } from '../lib/planner'
import { allGoalProgress } from '../lib/goals'
import { aggregateDaily, type DailyRow } from '../lib/stats'
import { buildStatisticsReportHtml } from '../lib/exports'
import { Modal } from './Modal'
import { NumericInput } from './NumericInput'
import { assignmentStateAtDate, isInferredTimeEntry, timeEntryDate } from '../lib/execution'

type StatsTab = 'overview' | 'trend' | 'subjects' | 'quality'
type RangePreset = 'today' | '7d' | 'week' | 'all' | 'custom'
type HeatMetric = 'minutes' | 'completion'
type ViewMode = 'chart' | 'table'

interface StatsPageProps {
  onOpenReplan?: (date: string) => void
  tutorialMode?: boolean
  onTutorialExpanded?: () => void
}
interface SubjectRow {
  subject: Subject
  planned: number
  actual: number
  done: number
  total: number
  completion: number
  accuracy?: number
  sampleSize: number
  groups: Array<{
    id: string
    title: string
    done: number
    total: number
    planned: number
    actual: number
    accuracy?: number
  }>
}

interface InsightItem {
  tone: 'positive' | 'warning' | 'neutral'
  title: string
  detail: string
  action?: 'replan' | 'subjects'
}

interface LedgerRow {
  assignmentId: string
  assignmentTitle: string
  groupTitle: string
  subject: Subject
  entry: TimeEntry
}

const SUBJECTS: Subject[] = ['语文', '数学', '英语', '物理', '化学', '生物', '其他']
const SUBJECT_COLORS: Record<Subject, string> = {
  语文: '#8b5cf6', 数学: '#2563eb', 英语: '#f59e0b', 物理: '#0891b2',
  化学: '#16a34a', 生物: '#db2777', 其他: '#64748b'
}

function safeDate(value?: string) {
  if (!value) return undefined
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
}

function progressFraction(assignment: Assignment) {
  if (assignment.status === 'done') return 1
  if (assignment.status === 'partial') return Math.max(0, Math.min(1, assignment.progress / 100))
  return 0
}

function isActiveGroup(group?: TaskGroup) {
  return Boolean(group && !group.hidden)
}

function isCountedGroup(group: TaskGroup | undefined, countWordsTime: boolean) {
  return Boolean(group && !group.hidden && (group.countInStats || countWordsTime))
}

function within(date: string | undefined, start: string, end: string) {
  return Boolean(date && date >= start && date <= end)
}

function percent(value: number) {
  return `${Math.round(value)}%`
}

function calculateStreak(rows: DailyRow[], predicate: (row: DailyRow) => boolean) {
  const today = todayISO()
  const byDate = new Map(rows.map(row => [row.date, row]))
  let cursor = today
  let count = 0
  while (true) {
    const row = byDate.get(cursor)
    if (!row || !predicate(row)) break
    count += 1
    cursor = shiftDate(cursor, -1)
  }
  return count
}

function rangeForPreset(preset: RangePreset, planStart: string, planEnd: string, customStart: string, customEnd: string) {
  const today = todayISO()
  let start = planStart
  let end = planEnd
  if (preset === 'today') start = end = today
  if (preset === '7d') { start = shiftDate(today, -6); end = today }
  if (preset === 'week') {
    const offset = (getDay(parseISO(today)) + 6) % 7
    start = shiftDate(today, -offset)
    end = shiftDate(start, 6)
  }
  if (preset === 'custom') { start = customStart || planStart; end = customEnd || planEnd }
  if (start > end) [start, end] = [end, start]
  return { start, end }
}

function aggregateSubjects(assignments: Assignment[], groupList: TaskGroup[], baselines: DailyPlanBaseline[], countWordsTime: boolean, start: string, end: string, subjectNames: Subject[] = SUBJECTS): SubjectRow[] {
  const rangeBaselines = baselines.filter(item => within(item.date, start, end))
  const capturedDates = new Set(rangeBaselines.map(item => item.date))
  const baselineItems = rangeBaselines.flatMap(item => item.assignments)
  const plannedForGroups = (groupIds: Set<string>) => baselineItems
    .filter(item => groupIds.has(item.groupId))
    .reduce((sum, item) => sum + item.estimatedMinutes, 0)
    + assignments.reduce((sum, item) => sum + (groupIds.has(item.groupId) && within(item.scheduledDate, start, end) && !capturedDates.has(item.scheduledDate!) ? item.estimatedMinutes : 0), 0)
  return subjectNames.map(subject => {
    const subjectGroups = groupList.filter(group => group.subject === subject && !group.hidden)
    const groupIds = new Set(subjectGroups.map(group => group.id))
    const items = assignments.filter(item => groupIds.has(item.groupId))
    const countedIds = new Set(subjectGroups.filter(group => group.countInStats || countWordsTime).map(group => group.id))
    const completedForAccuracy = items.filter(item => item.status === 'done' && item.actualMinutes > 0 && countedIds.has(item.groupId))
    const estimatedAccuracy = completedForAccuracy.reduce((sum, item) => sum + item.estimatedMinutes, 0)
    const actualAccuracy = completedForAccuracy.reduce((sum, item) => sum + item.actualMinutes, 0)
    const accuracy = completedForAccuracy.length >= 3 && estimatedAccuracy > 0
      ? (actualAccuracy - estimatedAccuracy) / estimatedAccuracy * 100
      : undefined
    const actualInRange = (item: Assignment) => {
      if (!countedIds.has(item.groupId)) return 0
      let total = 0
      let recorded = 0
      for (const entry of item.timeEntries ?? []) {
        const minutes = Math.max(0, Number(entry.minutes) || 0)
        if (isInferredTimeEntry(entry)) continue
        recorded += minutes
        if (within(timeEntryDate(entry), start, end)) total += minutes
      }
      const residual = Math.max(0, item.actualMinutes - recorded)
      const fallbackDate = safeDate(item.completedAt) ?? item.scheduledDate
      if (residual > 0 && within(fallbackDate, start, end)) total += residual
      return total
    }
    const groups = subjectGroups.map(group => {
      const groupItems = items.filter(item => item.groupId === group.id)
      const completed = groupItems.filter(item => item.status === 'done' && item.actualMinutes > 0)
      const est = completed.reduce((sum, item) => sum + item.estimatedMinutes, 0)
      const act = completed.reduce((sum, item) => sum + item.actualMinutes, 0)
      return {
        id: group.id,
        title: group.title,
        done: groupItems.filter(item => item.status === 'done').length,
        total: groupItems.length,
        planned: group.countInStats || countWordsTime ? plannedForGroups(new Set([group.id])) : 0,
        actual: groupItems.reduce((sum, item) => sum + actualInRange(item), 0),
        accuracy: completed.length >= 3 && est > 0 ? (act - est) / est * 100 : undefined
      }
    })
    return {
      subject,
      planned: plannedForGroups(countedIds),
      actual: items.reduce((sum, item) => sum + actualInRange(item), 0),
      done: items.filter(item => item.status === 'done').length,
      total: items.length,
      completion: items.length ? items.reduce((sum, item) => sum + progressFraction(item), 0) / items.length * 100 : 0,
      accuracy,
      sampleSize: completedForAccuracy.length,
      groups
    }
  }).filter(item => item.total > 0 || item.planned > 0 || item.actual > 0)
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return <div className="stats-tooltip"><strong>{label}</strong>{payload.map((item: any) => <span key={item.dataKey} style={{ color: item.color }}>{item.name}：{item.dataKey?.includes('Completion') || item.dataKey === 'completion' ? `${Math.round(item.value)}%` : minutesText(Number(item.value))}</span>)}</div>
}

function MetricCard({ icon: Icon, label, value, detail, tone = 'default' }: { icon: any; label: string; value: string; detail: string; tone?: 'default' | 'success' | 'warning' }) {
  return <article className={`stats-kpi ${tone}`}><div className="stats-kpi-icon"><Icon size={19}/></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (value: ViewMode) => void }) {
  const t = useT()
  return <div className="stats-view-toggle"><button className={value === 'chart' ? 'active' : ''} onClick={() => onChange('chart')}><BarChart3 size={14}/>{t('statsPage.chart')}</button><button className={value === 'table' ? 'active' : ''} onClick={() => onChange('table')}><Table2 size={14}/>{t('statsPage.table')}</button></div>
}

function ChartPanel({ title, subtitle, children, onExpand, actions }: { title: string; subtitle?: string; children: any; onExpand?: () => void; actions?: any }) {
  const t = useT()
  return <section className="stats-panel"><header><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div><div className="stats-panel-actions">{actions}{onExpand && <button className="icon-button subtle" onClick={onExpand} title={t('statsPage.enlarge')} aria-label={t('statsPage.enlargeAria', { title })}><Maximize2 size={16}/></button>}</div></header>{children}</section>
}

function DailyTable({ rows, onSelect }: { rows: DailyRow[]; onSelect: (date: string) => void }) {
  const t = useT()
  return <div className="stats-table-wrap"><table className="stats-table"><thead><tr><th>{t('statsPage.colDate')}</th><th>{t('statsPage.colPlanned')}</th><th>{t('statsPage.colActual')}</th><th>{t('statsPage.colInferred')}</th><th>{t('statsPage.colTaskCompletion')}</th><th>{t('statsPage.colWorkloadCompletion')}</th><th>{t('statsPage.colLate')}</th><th>{t('statsPage.colEstimatedStatus')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.date} onClick={() => onSelect(row.date)}><td>{row.shortLabel}</td><td>{minutesText(row.planned)}</td><td>{minutesText(row.actual)}</td><td>{row.inferred > 0 ? minutesText(row.inferred) : '—'}</td><td>{percent(row.taskCompletion)}</td><td>{percent(row.workloadCompletion)}</td><td>{row.lateTasks}</td><td>{row.estimatedStatusTasks || '—'}</td></tr>)}</tbody></table></div>
}

function actualMinutesForDate(assignments: Assignment[], date: string) {
  const result = new Map<string, number>()
  for (const assignment of assignments) {
    let recorded = 0
    let onDate = 0
    for (const entry of assignment.timeEntries ?? []) {
      const minutes = Math.max(0, Number(entry.minutes) || 0)
      if (isInferredTimeEntry(entry)) continue
      recorded += minutes
      if (timeEntryDate(entry) === date) onDate += minutes
    }
    const residual = Math.max(0, assignment.actualMinutes - recorded)
    const fallbackDate = safeDate(assignment.completedAt) ?? assignment.scheduledDate
    if (residual > 0 && fallbackDate === date) onDate += residual
    if (onDate > 0) result.set(assignment.id, onDate)
  }
  return result
}

function DayDetail({ date, assignments, groups, baselines, countWordsTime, onClose }: { date?: string; assignments: Assignment[]; groups: Map<string, TaskGroup>; baselines: DailyPlanBaseline[]; countWordsTime: boolean; onClose: () => void }) {
  const t = useT()
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!date) return
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    window.setTimeout(() => dialogRef.current?.focus(), 0)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      activeElement?.focus()
    }
  }, [date, onClose])
  if (!date) return null
  const baseline = baselines.find(item => item.date === date)
  const assignmentMap = new Map(assignments.map(item => [item.id, item]))
  const plannedItems = baseline?.assignments ?? assignments
    .filter(item => item.scheduledDate === date && isActiveGroup(groups.get(item.groupId)))
    .map(item => ({ assignmentId: item.id, groupId: item.groupId, title: item.title, estimatedMinutes: item.estimatedMinutes }))
  const plannedIds = new Set(plannedItems.map(item => item.assignmentId))
  const actualByAssignment = actualMinutesForDate(assignments, date)
  const actualOnly = assignments.filter(item => (actualByAssignment.get(item.id) ?? 0) > 0 && !plannedIds.has(item.id) && isActiveGroup(groups.get(item.groupId)))
  const planned = plannedItems.reduce((sum, item) => sum + (isCountedGroup(groups.get(item.groupId), countWordsTime) ? item.estimatedMinutes : 0), 0)
  const actual = assignments.reduce((sum, item) => sum + (isCountedGroup(groups.get(item.groupId), countWordsTime) ? actualByAssignment.get(item.id) ?? 0 : 0), 0)
  return <div className="stats-detail-backdrop" onMouseDown={onClose}><section ref={dialogRef} tabIndex={-1} className="stats-day-detail" role="dialog" aria-modal="true" aria-label={t('statsPage.executionDetailsAria', { date: fmtDate(date) })} onMouseDown={event => event.stopPropagation()}><header><div><span>{fmtWeekday(date)}</span><h2>{fmtDate(date)}</h2><p>{t('statsPage.originalPlanVsActual', { planned: minutesText(planned), actual: minutesText(actual) })}</p></div><button className="icon-button" aria-label={t('statsPage.closeDayDetailsAria')} onClick={onClose}><X size={18}/></button></header>{baseline && <p className="stats-baseline-note">{t('statsPage.baselineNote', { time: new Date(baseline.capturedAt).toLocaleString() })}</p>}<div className="stats-day-task-list">{plannedItems.length ? plannedItems.map(plannedItem => { const task = assignmentMap.get(plannedItem.assignmentId); const group = groups.get(plannedItem.groupId); const actualMinutes = actualByAssignment.get(plannedItem.assignmentId) ?? 0; const historical = task ? assignmentStateAtDate(task, date, plannedItem) : undefined; const historicalLabel = !task ? t('statsPage.taskRemoved') : historical?.status === 'done' ? t('statsPage.completedAsOfDate', { estimateSuffix: historical.exact ? '' : t('statsPage.estimatedSuffix') }) : historical?.status === 'partial' ? t('statsPage.partiallyCompletedAsOfDate', { progress: historical.progress, estimateSuffix: historical.exact ? '' : t('statsPage.estimatedSuffix') }) : t('statsPage.notCompletedAsOfDate', { estimateSuffix: historical?.exact ? '' : t('statsPage.estimatedSuffix') }); return <article key={plannedItem.assignmentId}><div><span className={`subject-pill subject-${group?.subject ?? '其他'}`}>{group?.subject ?? '其他'}</span><strong>{plannedItem.title}</strong></div><div className="stats-day-task-numbers"><span>{t('statsPage.originalPlanShort', { minutes: minutesText(plannedItem.estimatedMinutes) })}</span><span>{t('statsPage.actualOnDay', { minutes: minutesText(actualMinutes) })}</span><span>{historicalLabel}</span></div></article> }) : <p className="muted-text">{t('statsPage.noPlannedTasksThatDay')}</p>}</div>{actualOnly.length > 0 && <div className="stats-day-extra"><h3>{t('statsPage.unplannedExecution')}</h3><p>{t('statsPage.unplannedExecutionDesc')}</p>{actualOnly.map(task => { const group = groups.get(task.groupId); return <article key={task.id}><div><span className={`subject-pill subject-${group?.subject ?? '其他'}`}>{group?.subject ?? '其他'}</span><strong>{task.title}</strong></div><span>{t('statsPage.actualOnDay', { minutes: minutesText(actualByAssignment.get(task.id) ?? 0) })}</span></article> })}</div>}</section></div>
}

function FullscreenChart({ title, rows, onClose, onSelect }: { title: string; rows: DailyRow[]; onClose: () => void; onSelect: (date: string) => void }) {
  const t = useT()
  const [mode, setMode] = useState<ViewMode>('chart')
  return <div className="stats-fullscreen" role="dialog" aria-modal="true" aria-label={t('statsPage.fullscreenDetailsAria', { title })}><header><div><span>{t('statsPage.statisticsDetails')}</span><h2>{title}</h2></div><div><ViewToggle value={mode} onChange={setMode}/><button className="icon-button" aria-label={t('statsPage.closeFullscreenAria')} onClick={onClose}><X size={19}/></button></div></header><main>{mode === 'table' ? <DailyTable rows={rows} onSelect={onSelect}/> : <ResponsiveContainer width="100%" height="100%"><ComposedChart data={rows} onClick={(event: any) => event?.activePayload?.[0] && onSelect(event.activePayload[0].payload.date)}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="shortLabel"/><YAxis tickFormatter={(value: number) => `${Math.round(value / 60)}h`}/><Tooltip content={<ChartTooltip/>}/><Legend/><Bar dataKey="actual" name={t('statsPage.actual')} fill="#2563eb" radius={[6, 6, 0, 0]}/><Line type="monotone" dataKey="planned" name={t('statsPage.planned')} stroke="#94a3b8" strokeWidth={2} dot={false}/><Line type="monotone" dataKey="movingAverage" name={t('statsPage.movingAverage7d')} stroke="#8b5cf6" strokeWidth={2} dot={false}/></ComposedChart></ResponsiveContainer>}</main></div>
}

export function StatsPage({ onOpenReplan, tutorialMode = false, onTutorialExpanded }: StatsPageProps) {
  const t = useT()
  const { state, updateTimeEntry, deleteTimeEntry } = useApp()
  const [tab, setTab] = useState<StatsTab>('overview')
  const [preset, setPreset] = useState<RangePreset>(() => {
    if (tutorialMode) return 'today'
    const saved = window.localStorage.getItem('study-planner:stats-range')
    return saved === 'today' || saved === '7d' || saved === 'week' || saved === 'all' || saved === 'custom' ? saved : '7d'
  })
  const [customStart, setCustomStart] = useState(state.settings.startDate)
  const [customEnd, setCustomEnd] = useState(state.settings.endDate)
  const [heatMetric, setHeatMetric] = useState<HeatMetric>('minutes')
  const [trendView, setTrendView] = useState<ViewMode>('chart')
  const [selectedDate, setSelectedDate] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const [expandedSubjects, setExpandedSubjects] = useState<Set<Subject>>(new Set())
  const [planPerspective, setPlanPerspective] = useState<'current'|'history'>('current')
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [ledgerStart, setLedgerStart] = useState(state.settings.startDate)
  const [ledgerEnd, setLedgerEnd] = useState(todayISO())
  const [ledgerEdit, setLedgerEdit] = useState<{ assignmentId: string; entryId: string; minutes: number; date: string }>()
  const [reportNotice, setReportNotice] = useState('')

  useEffect(() => { if (!tutorialMode) window.localStorage.setItem('study-planner:stats-range', preset) }, [preset, tutorialMode])

  const groupMap = useMemo(() => new Map(state.taskGroups.map(group => [group.id, group])), [state.taskGroups])
  const range = rangeForPreset(preset, state.settings.startDate, state.settings.endDate, customStart, customEnd)
  const daily = useMemo(() => aggregateDaily(state.assignments, groupMap, state.settings.countWordsTime, range.start, range.end, state.dailyPlanBaselines), [state.assignments, groupMap, state.settings.countWordsTime, range.start, range.end, state.dailyPlanBaselines])
  const allDaily = useMemo(() => aggregateDaily(state.assignments, groupMap, state.settings.countWordsTime, state.settings.startDate, state.settings.endDate, state.dailyPlanBaselines), [state.assignments, groupMap, state.settings.countWordsTime, state.settings.startDate, state.settings.endDate, state.dailyPlanBaselines])
  const subjectNames = useMemo(() => Array.from(new Set([...SUBJECTS, ...state.settings.customSubjects, ...state.taskGroups.map(group => group.subject)])), [state.settings.customSubjects, state.taskGroups])
  const subjects = useMemo(() => aggregateSubjects(state.assignments, state.taskGroups, state.dailyPlanBaselines, state.settings.countWordsTime, range.start, range.end, subjectNames), [state.assignments, state.taskGroups, state.dailyPlanBaselines, state.settings.countWordsTime, range.start, range.end, subjectNames])
  const goalRows = useMemo(() => allGoalProgress(state), [state.goals, state.assignments, state.taskGroups])
  const durationSuggestions = useMemo(() => allDurationSuggestions(state), [state.assignments, state.taskGroups, state.settings.duration])
  const ledgerRows = useMemo<LedgerRow[]>(() => state.assignments.flatMap(assignment => {
    const group = groupMap.get(assignment.groupId)
    if (!group) return []
    return (assignment.timeEntries ?? []).map(entry => ({ assignmentId: assignment.id, assignmentTitle: assignment.title, groupTitle: group.title, subject: group.subject, entry }))
  }).filter(item => within(timeEntryDate(item.entry) ?? safeDate(item.entry.createdAt), ledgerStart, ledgerEnd)).sort((a, b) => (timeEntryDate(b.entry) ?? b.entry.createdAt).localeCompare(timeEntryDate(a.entry) ?? a.entry.createdAt)), [state.assignments, groupMap, ledgerStart, ledgerEnd])

  const totals = useMemo(() => {
    const planned = daily.reduce((sum, row) => sum + row.planned, 0)
    const actual = daily.reduce((sum, row) => sum + row.actual, 0)
    const extra = daily.reduce((sum, row) => sum + row.extraActual, 0)
    const timer = daily.reduce((sum, row) => sum + row.timerActual, 0)
    const manual = daily.reduce((sum, row) => sum + row.manualActual, 0)
    const legacy = daily.reduce((sum, row) => sum + row.legacyActual, 0)
    const inferred = daily.reduce((sum, row) => sum + row.inferred, 0)
    const estimatedStatusTasks = daily.reduce((sum, row) => sum + row.estimatedStatusTasks, 0)
    const tasks = daily.reduce((sum, row) => sum + row.plannedTasks, 0)
    const completed = daily.reduce((sum, row) => sum + row.completedEquivalent, 0)
    const plannedWork = daily.reduce((sum, row) => sum + row.planned, 0)
    const completedWork = daily.reduce((sum, row) => sum + row.planned * row.workloadCompletion / 100, 0)
    return {
      planned, actual, extra, timer, manual, legacy, inferred, estimatedStatusTasks,
      taskCompletion: tasks ? completed / tasks * 100 : 0,
      workloadCompletion: plannedWork ? completedWork / plannedWork * 100 : 0,
      late: daily.reduce((sum, row) => sum + row.lateTasks, 0),
      focusSessions: daily.reduce((sum, row) => sum + row.focusSessions, 0)
    }
  }, [daily])

  const todayRow = allDaily.find(row => row.date === todayISO())
  const learningStreak = calculateStreak(allDaily, row => row.actual >= 30)
  const targetStreak = calculateStreak(allDaily, row => row.planned > 0 ? row.actual >= row.planned * .5 : row.actual >= 30)
  const corePrediction = predictCompletion(state, group => group.priority === 5)
  const overallPrediction = predictCompletion(state)

  const completedCounted = state.assignments.filter(item => {
    const group = groupMap.get(item.groupId)
    return isCountedGroup(group, state.settings.countWordsTime) && item.status === 'done' && item.completedAt && item.scheduledDate
  })
  const onTime = completedCounted.filter(item => safeDate(item.completedAt)! <= item.scheduledDate!).length
  const onTimeRate = completedCounted.length ? onTime / completedCounted.length * 100 : 0
  const changedTasks = state.assignments.filter(item => item.previousDate && isActiveGroup(groupMap.get(item.groupId))).length
  const activeTasks = state.assignments.filter(item => isActiveGroup(groupMap.get(item.groupId))).length
  const changeRate = activeTasks ? changedTasks / activeTasks * 100 : 0
  const carryovers = state.assignments.filter(item => item.scheduleSource === 'carryover' && isActiveGroup(groupMap.get(item.groupId))).length

  const timerEntries = state.assignments.flatMap(item => {
    const group = groupMap.get(item.groupId)
    if (!isCountedGroup(group, state.settings.countWordsTime)) return []
    return (item.timeEntries ?? []).filter(entry => entry.source === 'timer' && entry.minutes >= 1).map(entry => entry.minutes)
  })
  const averageFocus = timerEntries.length ? Math.round(timerEntries.reduce((sum, value) => sum + value, 0) / timerEntries.length) : 0
  const longestFocus = timerEntries.length ? Math.max(...timerEntries) : 0

  const priorityData = [5, 3, 2, 1, 0].map(priority => {
    const ids = new Set(state.taskGroups.filter(group => group.priority === priority && !group.hidden).map(group => group.id))
    const items = state.assignments.filter(item => ids.has(item.groupId))
    return { priority: priority === 5 ? t('priority.core') : priority === 3 ? t('priority.high') : priority === 2 ? t('priority.medium') : priority === 1 ? t('priority.low') : t('priority.optional'), completion: items.length ? items.reduce((sum, item) => sum + progressFraction(item), 0) / items.length * 100 : 0 }
  }).filter(item => item.completion > 0 || item.priority !== t('priority.optional'))

  const insights = useMemo<InsightItem[]>(() => {
    const result: InsightItem[] = []
    const recent = allDaily.filter(row => row.date <= todayISO()).slice(-7)
    const previous = allDaily.filter(row => row.date <= shiftDate(todayISO(), -7)).slice(-7)
    const recentCompletion = recent.length ? recent.reduce((sum, row) => sum + row.workloadCompletion, 0) / recent.length : 0
    const previousCompletion = previous.length ? previous.reduce((sum, row) => sum + row.workloadCompletion, 0) / previous.length : 0
    const change = recentCompletion - previousCompletion
    if (previous.length && Math.abs(change) >= 5) result.push({ tone: change > 0 ? 'positive' : 'warning', title: t(change > 0 ? 'statsPage.insight.completionUp' : 'statsPage.insight.completionDown', { value: Math.abs(Math.round(change)) }), detail: t('statsPage.insight.completionCompareDetail', { recent: Math.round(recentCompletion), previous: Math.round(previousCompletion) }), action: change < 0 ? 'replan' : undefined })
    const underestimated = subjects.filter(item => item.accuracy !== undefined && item.accuracy > 10).sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0))[0]
    if (underestimated) result.push({ tone: 'warning', title: t('statsPage.insight.underestimatedTitle', { subject: underestimated.subject, value: Math.round(underestimated.accuracy!) }), detail: t('statsPage.insight.underestimatedDetail', { count: underestimated.sampleSize }), action: 'subjects' })
    const weakDays = recent.slice(-3).filter(row => row.planned > 0 && row.actual < row.planned * .5)
    if (weakDays.length >= 2) result.push({ tone: 'warning', title: t('statsPage.insight.weakDaysTitle'), detail: t('statsPage.insight.weakDaysDetail', { days: weakDays.map(row => row.shortLabel).join('、') }), action: 'replan' })
    const riskyGoal = goalRows.find(item => item.latestRisk || item.desiredRisk)
    if (riskyGoal) {
      const goal = state.goals.find(item => item.id === riskyGoal.goalId)
      if (goal) result.push({ tone: 'warning', title: t('statsPage.insight.goalRiskTitle', { title: goal.title }), detail: t('statsPage.insight.goalRiskDetail', { expected: riskyGoal.expectedCompletion ? fmtDate(riskyGoal.expectedCompletion) : t('statsPage.cannotPredictYetShort'), desired: goal.desiredDate ? fmtDate(goal.desiredDate) : t('goalsPage.notSet'), latest: fmtDate(goal.latestDate) }), action: 'replan' })
    }
    const totalSubjectActual = subjects.reduce((sum, item) => sum + item.actual, 0)
    const dominant = subjects.filter(item => totalSubjectActual > 0 && item.actual / totalSubjectActual > state.settings.subjectShareLimit).sort((a, b) => b.actual - a.actual)[0]
    if (dominant) result.push({ tone: 'neutral', title: t('statsPage.insight.dominantSubjectTitle', { subject: dominant.subject, value: Math.round(dominant.actual / totalSubjectActual * 100) }), detail: t('statsPage.insight.dominantSubjectDetail'), action: 'subjects' })
    return result.slice(0, 4)
  }, [allDaily, subjects, state.settings.subjectShareLimit, goalRows, state.goals, t])

  const positiveHeatMinutes = allDaily.map(row => row.actual).filter(value => value > 0).sort((a, b) => a - b)
  const maxHeatMinutes = positiveHeatMinutes.length ? Math.max(1, positiveHeatMinutes[Math.min(positiveHeatMinutes.length - 1, Math.floor(positiveHeatMinutes.length * .9))]) : 1
  const heatOffset = (getDay(parseISO(state.settings.startDate)) + 6) % 7
  const heatCells: Array<DailyRow | undefined> = [...Array.from({ length: heatOffset }, () => undefined), ...allDaily]
  const subjectRanking = [...subjects].sort((a, b) => b.actual - a.actual)
  const heatLevel = (row: DailyRow) => {
    const value = heatMetric === 'minutes' ? row.actual / maxHeatMinutes : row.workloadCompletion / 100
    if (value <= 0) return 0
    if (value < .25) return 1
    if (value < .5) return 2
    if (value < .75) return 3
    return 4
  }

  const toggleSubject = (subject: Subject) => setExpandedSubjects(current => {
    const next = new Set(current)
    if (next.has(subject)) next.delete(subject)
    else next.add(subject)
    return next
  })

  const rangeLabel = preset === 'today' ? t('statsPage.rangeToday') : preset === '7d' ? t('statsPage.rangeLast7Days') : preset === 'week' ? t('statsPage.rangeThisWeek') : preset === 'all' ? t('statsPage.rangeWholePlan') : `${fmtDate(range.start, 'M.d')}—${fmtDate(range.end, 'M.d')}`

  const openStatisticsReport = () => {
    const reportWindow = window.open('', '_blank')
    if (!reportWindow) {
      setReportNotice(t('statsPage.reportWindowBlocked'))
      return
    }
    reportWindow.opener = null
    reportWindow.document.open()
    reportWindow.document.write(buildStatisticsReportHtml(state, range))
    reportWindow.document.close()
    reportWindow.focus()
    window.setTimeout(() => reportWindow.print(), 250)
    setReportNotice(t('statsPage.reportWindowOpened'))
  }

  return <div className="stats-page">
    <section className="plan-perspective-bar"><div className="segmented-control"><button className={planPerspective === 'current' ? 'active' : ''} onClick={() => setPlanPerspective('current')}>{t('statsPage.goalOverview')}</button><button className={planPerspective === 'history' ? 'active' : ''} onClick={() => setPlanPerspective('history')}>{t('statsPage.versionOverview')}</button></div><div className="plan-perspective-actions"><span>{planPerspective === 'current' ? t('statsPage.viewCurrentGoalsHint') : t('statsPage.savedVersionsHint', { count: state.planVersions.length })}</span><button className="secondary-button" onClick={() => { setLedgerStart(range.start); setLedgerEnd(range.end > todayISO() ? todayISO() : range.end); setLedgerOpen(true) }}><Clock3 size={16}/>{t('statsPage.timeLedger')}</button></div></section>
    {planPerspective === 'current' ? <section className="stats-goal-overview"><header><div><h2>{t('statsPage.currentGoalOverview')}</h2><p>{t('statsPage.currentGoalOverviewDesc')}</p></div><span>{t('statsPage.durationSuggestionsCount', { count: durationSuggestions.length })}</span></header><div>{goalRows.length ? goalRows.map(row => { const goal = state.goals.find(item => item.id === row.goalId)!; return <article key={row.goalId}><strong>{goal.title}</strong><span>{row.completedCount}/{row.requiredCount} · {Math.round(row.progress*100)}%</span><small>{t('statsPage.expectedShort')} {row.expectedCompletion ? fmtDate(row.expectedCompletion) : row.completed ? t('common.done') : t('goalsPage.cannotPredictYet')} · {t('statsPage.remainingShort')} {minutesText(row.estimatedRemainingMinutes)}</small><em className={row.latestRisk ? 'risk' : row.desiredRisk ? 'warning' : ''}>{row.latestRisk ? t('statsPage.latestDateRisk') : row.desiredRisk ? t('statsPage.desiredDateRisk') : t('goalsPage.normal')}</em></article> }) : <p className="muted-text">{t('statsPage.noGoalsYet')}</p>}</div></section> : <section className="stats-version-overview"><header><h2>{t('statsPage.planHistoryEvolution')}</h2><p>{t('statsPage.planHistoryDesc')}</p></header>{state.planVersions.length ? <div>{[...state.planVersions].reverse().map(version => <article key={version.id}><div><strong>{version.reason}</strong><span>{new Date(version.timestamp).toLocaleString()}</span></div><div><span>{t('statsPage.versionGoals')} {version.summary.goalCount}</span><span>{t('statsPage.versionGroups')} {version.summary.groupCount}</span><span>{t('statsPage.versionTasks')} {version.summary.assignmentCount}</span><span>{t('statsPage.versionCompleted')} {version.summary.completedCount}</span><span>{t('statsPage.versionMoved')} {version.summary.movedTaskCount}</span><span>{t('statsPage.versionScheduledLoad')} {minutesText(version.summary.scheduledMinutes)}</span></div></article>)}</div> : <p className="muted-text">{t('statsPage.noMajorVersionsYet')}</p>}</section>}
    <section className="stats-toolbar">
      <div className="stats-tabs">{([['overview', t('statsPage.tabOverview')], ['trend', t('statsPage.tabTrend')], ['subjects', t('statsPage.tabSubjects')], ['quality', t('statsPage.tabQuality')]] as const).map(([value, label]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className="stats-toolbar-actions"><div className="stats-range-controls"><select value={preset} onChange={event => setPreset(event.target.value as RangePreset)}><option value="today">{t('statsPage.rangeToday')}</option><option value="7d">{t('statsPage.rangeLast7Days')}</option><option value="week">{t('statsPage.rangeThisWeek')}</option><option value="all">{t('statsPage.rangeAll')}</option><option value="custom">{t('statsPage.rangeCustom')}</option></select>{preset === 'custom' && <><input type="date" value={customStart} onChange={event => setCustomStart(event.target.value)}/><span>{t('statsPage.to')}</span><input type="date" value={customEnd} onChange={event => setCustomEnd(event.target.value)}/></>}<em>{rangeLabel}</em></div><button className="secondary-button" onClick={openStatisticsReport}><Download size={16}/>{t('statsPage.exportStatsPdf')}</button></div>
    </section>
    {reportNotice && <div className="export-notice stats-report-notice" role="status"><CheckCircle2 size={17}/><span>{reportNotice}</span></div>}

    {tab === 'overview' && <>
      <section className="stats-kpi-grid">
        <MetricCard icon={Clock3} label={t('statsPage.todayActual')} value={minutesText(todayRow?.actual ?? 0)} detail={t('statsPage.todayActualDetail', { planned: minutesText(todayRow?.planned ?? 0), inferred: minutesText(todayRow?.inferred ?? 0), extra: minutesText(todayRow?.extraActual ?? 0) })} tone={(todayRow?.actual ?? 0) >= (todayRow?.planned ?? Infinity) ? 'success' : 'default'}/>
        <MetricCard icon={CheckCircle2} label={t('statsPage.rangeCompletionRate', { range: rangeLabel })} value={`${Math.round(totals.taskCompletion)}% / ${Math.round(totals.workloadCompletion)}%`} detail={t('statsPage.taskCountVsWeighted')} tone={totals.workloadCompletion >= 80 ? 'success' : totals.workloadCompletion < 50 ? 'warning' : 'default'}/>
        <MetricCard icon={Activity} label={t('statsPage.cumulativeActual')} value={minutesText(allDaily.reduce((sum, row) => sum + row.actual, 0))} detail={t('statsPage.cumulativeActualDetail', { range: minutesText(totals.actual), inferred: minutesText(totals.inferred), excluded: minutesText(totals.extra) })}/>
        <MetricCard icon={Target} label={t('statsPage.expectedCompletion')} value={overallPrediction === tr('pl.042') ? t('statsPage.allCompleted') : overallPrediction ? fmtDate(overallPrediction) : t('statsPage.hasUnscheduled')} detail={t('statsPage.priority5Label', { value: corePrediction === '已完成' ? t('common.done') : corePrediction ? fmtDate(corePrediction) : t('statsPage.awaitingSchedule') })} tone={goalRows.some(row => row.latestRisk) ? 'warning' : 'success'}/>
      </section>

      <details className="stats-overview-more" onToggle={event => { if (tutorialMode && event.currentTarget.open) onTutorialExpanded?.() }}><summary data-tutorial-target={tutorialMode ? "tutorial-stats-expand" : undefined}>{t('statsPage.viewStreaksAndHeatmap')}</summary><div className="stats-overview-more-body">
      <section className="stats-streak-row"><div><Flame size={20}/><strong>{t('statsPage.daysCount', { count: learningStreak })}</strong><span>{t('statsPage.learningStreakLabel')}</span></div><div><Target size={20}/><strong>{t('statsPage.daysCount', { count: targetStreak })}</strong><span>{t('statsPage.targetStreakLabel')}</span></div><div><Focus size={20}/><strong>{t('statsPage.timesCount', { count: totals.focusSessions })}</strong><span>{t('statsPage.effectiveFocusInRange', { range: rangeLabel, minutes: minutesText(averageFocus) })}</span></div></section>

      <section className="stats-insights"><header><div><TrendingUp size={20}/><div><h3>{t('statsPage.weeklyInsights')}</h3><p>{t('statsPage.weeklyInsightsDesc')}</p></div></div></header><div>{insights.length ? insights.map((item, index) => <article key={index} className={item.tone}><div>{item.tone === 'warning' ? <AlertTriangle size={18}/> : item.tone === 'positive' ? <CheckCircle2 size={18}/> : <Activity size={18}/>}<span><strong>{item.title}</strong><small>{item.detail}</small></span></div>{item.action && <button className="secondary-button" onClick={() => item.action === 'replan' ? onOpenReplan?.(todayISO()) : setTab('subjects')}>{item.action === 'replan' ? t('statsPage.viewAdjustmentSuggestions') : t('statsPage.viewSubjectAnalysis')}<ChevronRight size={15}/></button>}</article>) : <p className="muted-text">{t('statsPage.noInsightsYet')}</p>}</div></section>

      <ChartPanel title={t('statsPage.learningHeatmap')} subtitle={t('statsPage.heatmapSubtitle', { start: state.settings.startDate.slice(5).replace('-', '.'), end: state.settings.endDate.slice(5).replace('-', '.') })} actions={<div className="stats-segmented"><button className={heatMetric === 'minutes' ? 'active' : ''} onClick={() => setHeatMetric('minutes')}>{t('statsPage.studyTime')}</button><button className={heatMetric === 'completion' ? 'active' : ''} onClick={() => setHeatMetric('completion')}>{t('statsPage.completionRate')}</button></div>}>
        <div className="stats-heatmap-shell"><div className="stats-heat-weekdays"><span>{t('intakePage.weekdayMon')}</span><span></span><span>{t('intakePage.weekdayWed')}</span><span></span><span>{t('intakePage.weekdayFri')}</span><span></span><span>{t('intakePage.weekdaySun')}</span></div><div className="stats-heatmap">{heatCells.map((row, index) => row ? <button key={row.date} className={`level-${heatLevel(row)}`} onClick={() => setSelectedDate(row.date)} title={`${row.label} · ${heatMetric === 'minutes' ? minutesText(row.actual) : percent(row.workloadCompletion)}`}><span>{Number(row.date.slice(8))}</span><small>{row.date.endsWith('-01') || index === heatOffset ? t('statsPage.monthLabel', { month: Number(row.date.slice(5, 7)) }) : ''}</small></button> : <i className="heat-empty" key={`empty-${index}`}/>)}</div></div>
        <div className="stats-heat-legend"><span>{t('statsPage.legendLess')}</span>{[0,1,2,3,4].map(level => <i key={level} className={`level-${level}`}/>)}<span>{t('statsPage.legendMore')}</span></div>
      </ChartPanel>
      </div></details>

      <ChartPanel title={t('statsPage.dailyPlanVsActual')} subtitle={t('statsPage.dailyPlanVsActualSubtitle')} onExpand={() => setExpanded(true)} actions={<ViewToggle value={trendView} onChange={setTrendView}/>}>
        {trendView === 'table' ? <DailyTable rows={daily} onSelect={setSelectedDate}/> : <div className="stats-chart-lg"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={daily} onClick={(event: any) => event?.activePayload?.[0] && setSelectedDate(event.activePayload[0].payload.date)}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="shortLabel" minTickGap={22}/><YAxis tickFormatter={(value: number) => `${Math.round(value / 60)}h`}/><Tooltip content={<ChartTooltip/>}/><Legend/><Bar dataKey="actual" name={t('statsPage.actual')} fill="#2563eb" radius={[6,6,0,0]}/><Line type="monotone" dataKey="planned" name={t('statsPage.planned')} stroke="#94a3b8" strokeWidth={2} dot={false}/><Line type="monotone" dataKey="movingAverage" name={t('statsPage.movingAverage7d')} stroke="#8b5cf6" strokeWidth={2} dot={false}/></ComposedChart></ResponsiveContainer></div>}
      </ChartPanel>
    </>}

    {tab === 'trend' && <>
      <section className="stats-kpi-grid stats-kpi-grid-three"><MetricCard icon={Clock3} label={t('statsPage.actualInRange')} value={minutesText(totals.actual)} detail={t('statsPage.plannedAndInferred', { planned: minutesText(totals.planned), inferred: minutesText(totals.inferred) })}/><MetricCard icon={Focus} label={t('statsPage.timerAndManual')} value={`${minutesText(totals.timer)} / ${minutesText(totals.manual)}`} detail={t('statsPage.legacyUnsourced', { minutes: minutesText(totals.legacy) })}/><MetricCard icon={Activity} label={t('statsPage.excludedFromStats')} value={minutesText(totals.extra)} detail={t('statsPage.excludedFromStatsDetail')}/></section>
      <ChartPanel title={t('statsPage.studyTimeTrend')} subtitle={t('statsPage.clickDataPointHint')} onExpand={() => setExpanded(true)} actions={<ViewToggle value={trendView} onChange={setTrendView}/>}>
        {trendView === 'table' ? <DailyTable rows={daily} onSelect={setSelectedDate}/> : <div className="stats-chart-xl"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={daily} onClick={(event: any) => event?.activePayload?.[0] && setSelectedDate(event.activePayload[0].payload.date)}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="shortLabel" minTickGap={18}/><YAxis/><Tooltip content={<ChartTooltip/>}/><Legend/><Bar dataKey="actual" name={t('statsPage.actual')} fill="#2563eb" radius={[6,6,0,0]}/><Bar dataKey="extraActual" name={t('statsPage.extraStudy')} fill="#cbd5e1" radius={[6,6,0,0]}/><Line type="monotone" dataKey="planned" name={t('statsPage.planned')} stroke="#64748b" strokeWidth={2} dot={false}/><Line type="monotone" dataKey="movingAverage" name={t('statsPage.movingAverage7d')} stroke="#8b5cf6" strokeWidth={2.4} dot={false}/></ComposedChart></ResponsiveContainer></div>}
      </ChartPanel>
      <section className="stats-two-column"><ChartPanel title={t('statsPage.completionRateTrend')} subtitle={t('statsPage.completionRateTrendSubtitle')}><div className="stats-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={daily}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="shortLabel" minTickGap={18}/><YAxis domain={[0,100]} tickFormatter={(value: number) => `${value}%`}/><Tooltip content={<ChartTooltip/>}/><Legend/><Line type="monotone" dataKey="taskCompletion" name={t('statsPage.taskCompletionRate')} stroke="#2563eb" strokeWidth={2}/><Line type="monotone" dataKey="workloadCompletion" name={t('statsPage.workloadCompletionRate')} stroke="#16a34a" strokeWidth={2}/></LineChart></ResponsiveContainer></div></ChartPanel><ChartPanel title={t('statsPage.focusCountAndDuration')} subtitle={t('statsPage.focusCountAndDurationSubtitle')}><div className="stats-chart"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={daily}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="shortLabel" minTickGap={18}/><YAxis yAxisId="time"/><YAxis yAxisId="count" orientation="right" allowDecimals={false}/><Tooltip/><Legend/><Bar yAxisId="time" dataKey="timerActual" name={t('statsPage.focusMinutes')} fill="#8b5cf6" radius={[5,5,0,0]}/><Line yAxisId="count" type="monotone" dataKey="focusSessions" name={t('statsPage.focusSessions')} stroke="#f59e0b" strokeWidth={2}/></ComposedChart></ResponsiveContainer></div></ChartPanel></section>
    </>}

    {tab === 'subjects' && <>
      <ChartPanel title={t('statsPage.subjectInvestmentRanking')} subtitle={t('statsPage.subjectInvestmentRankingSubtitle')}><div className="stats-chart-subject"><ResponsiveContainer width="100%" height="100%"><BarChart data={subjectRanking} layout="vertical" margin={{ left: 6, right: 18 }}><CartesianGrid strokeDasharray="3 3" horizontal={false}/><XAxis type="number"/><YAxis type="category" dataKey="subject" width={42}/><Tooltip formatter={(value: number) => minutesText(value)}/><Legend/><Bar dataKey="planned" name={t('statsPage.planned')} fill="#cbd5e1" radius={[0,6,6,0]}/><Bar dataKey="actual" name={t('statsPage.actual')} fill="#2563eb" radius={[0,6,6,0]}>{subjectRanking.map(item => <Cell key={item.subject} fill={SUBJECT_COLORS[item.subject] ?? '#64748b'}/>)}</Bar></BarChart></ResponsiveContainer></div></ChartPanel>
      <section className="subject-analytics-list">{subjectRanking.map(item => <article key={item.subject} className="subject-analytics-card"><button className="subject-analytics-head" onClick={() => toggleSubject(item.subject)}><div><span className={`subject-pill subject-${item.subject}`}>{item.subject}</span><strong>{t('statsPage.completedOfTotal', { done: item.done, total: item.total })}</strong></div><div><span>{t('statsPage.actualShort')} {minutesText(item.actual)}</span><span>{t('statsPage.plannedShort')} {minutesText(item.planned)}</span><span>{t('statsPage.completionShort')} {Math.round(item.completion)}%</span>{item.accuracy !== undefined && <em className={item.accuracy > 10 ? 'under' : item.accuracy < -10 ? 'over' : 'accurate'}>{item.accuracy > 0 ? t('statsPage.underestimatedBy', { value: Math.round(item.accuracy) }) : item.accuracy < 0 ? t('statsPage.overestimatedBy', { value: Math.abs(Math.round(item.accuracy)) }) : t('statsPage.accurateEstimate')}</em>}<ChevronRight size={17}/></div></button><div className="subject-progress"><i style={{ width: `${Math.min(100,item.completion)}%`, background: SUBJECT_COLORS[item.subject] ?? '#64748b' }}/></div>{expandedSubjects.has(item.subject) && <div className="subject-group-breakdown">{item.groups.map(group => { const suggestion = durationSuggestions.find(candidate => candidate.groupId === group.id); const sourceGroup = state.taskGroups.find(candidate => candidate.id === group.id); return <div key={group.id}><span><strong>{group.title}</strong><small>{t('statsPage.completedOfTotal', { done: group.done, total: group.total })} · {t('statsPage.plannedShort')} {minutesText(group.planned)} · {t('statsPage.actualShort')} {minutesText(group.actual)}</small></span><div className="subject-group-actions">{group.accuracy !== undefined && <em>{group.accuracy > 0 ? t('statsPage.averageUnderestimateBy', { value: Math.round(group.accuracy) }) : t('statsPage.averageOverestimateBy', { value: Math.abs(Math.round(group.accuracy)) })}</em>}{suggestion && sourceGroup && <span className="muted-text">{t('statsPage.suggestedMinutes', { minutes: suggestion.suggestedEstimate, samples: suggestion.sampleCount })}</span>}</div></div> })}</div>}</article>)}</section>
      <ChartPanel title={t('statsPage.durationAccuracy')} subtitle={t('statsPage.durationAccuracySubtitle')}><div className="accuracy-list">{subjects.filter(item => item.accuracy !== undefined).sort((a,b)=>Math.abs(b.accuracy!)-Math.abs(a.accuracy!)).map(item => <article key={item.subject}><span className={`subject-pill subject-${item.subject}`}>{item.subject}</span><div><strong>{item.accuracy! > 0 ? t('statsPage.averageUnderestimateBy', { value: Math.round(item.accuracy!) }) : t('statsPage.averageOverestimateBy', { value: Math.abs(Math.round(item.accuracy!)) })}</strong><small>{t('statsPage.sampleCountTasks', { count: item.sampleSize })}</small></div><div className="accuracy-axis"><i style={{ left: `${Math.max(2,Math.min(98,50+item.accuracy!/2))}%` }}/></div></article>)}{!subjects.some(item => item.accuracy !== undefined) && <p className="muted-text">{t('statsPage.noAccuracyDataYet')}</p>}</div></ChartPanel>
    </>}

    {tab === 'quality' && <>
      <section className="stats-kpi-grid"><MetricCard icon={CheckCircle2} label={t('statsPage.onTimeRate')} value={percent(onTimeRate)} detail={t('statsPage.onTimeRateDetail', { onTime, total: completedCounted.length })} tone={onTimeRate >= 80 ? 'success' : 'warning'}/><MetricCard icon={AlertTriangle} label={t('statsPage.currentLate')} value={t('statsPage.itemsCount', { count: state.assignments.filter(item => item.scheduledDate && item.scheduledDate < todayISO() && item.status !== 'done' && isActiveGroup(groupMap.get(item.groupId))).length })} detail={t('statsPage.visibleInRange', { count: totals.late })} tone={totals.late > 0 ? 'warning' : 'success'}/><MetricCard icon={CalendarDays} label={t('statsPage.carriedOverTasks')} value={t('statsPage.itemsCount', { count: carryovers })} detail={t('statsPage.carriedOverDetail')}/><MetricCard icon={Activity} label={t('statsPage.planChangeRate')} value={percent(changeRate)} detail={t('statsPage.planChangeRateDetail', { changed: changedTasks, active: activeTasks })}/></section>
      <section className="stats-two-column"><ChartPanel title={t('statsPage.priorityCompletionProgress')} subtitle={t('statsPage.priorityCompletionProgressSubtitle')}><div className="stats-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={priorityData} layout="vertical"><CartesianGrid strokeDasharray="3 3" horizontal={false}/><XAxis type="number" domain={[0,100]} tickFormatter={(value: number) => `${value}%`}/><YAxis type="category" dataKey="priority"/><Tooltip formatter={(value: number) => `${Math.round(value)}%`}/><Bar dataKey="completion" name={t('statsPage.completionRate')} fill="#2563eb" radius={[0,6,6,0]}/></BarChart></ResponsiveContainer></div></ChartPanel><ChartPanel title={t('statsPage.focusStats')} subtitle={t('statsPage.focusStatsSubtitle')}><div className="focus-stat-grid"><div><strong>{minutesText(timerEntries.reduce((sum,value)=>sum+value,0))}</strong><span>{t('statsPage.totalFocusDuration')}</span></div><div><strong>{timerEntries.length}</strong><span>{t('statsPage.effectiveFocusCount')}</span></div><div><strong>{minutesText(averageFocus)}</strong><span>{t('statsPage.averagePerSession')}</span></div><div><strong>{minutesText(longestFocus)}</strong><span>{t('statsPage.longestSession')}</span></div></div></ChartPanel></section>
      <ChartPanel title={t('statsPage.dailyExecutionTrace')} subtitle={t('statsPage.dailyExecutionTraceSubtitle')}><DailyTable rows={daily} onSelect={setSelectedDate}/></ChartPanel>
      <div className="stats-data-note"><AlertTriangle size={17}/><p><strong>{t('statsPage.dataDefinitionLabel')}</strong>{t('statsPage.dataDefinitionBody', { count: totals.estimatedStatusTasks })}</p></div>
    </>}

    <DayDetail date={selectedDate} assignments={state.assignments} groups={groupMap} baselines={state.dailyPlanBaselines} countWordsTime={state.settings.countWordsTime} onClose={() => setSelectedDate(undefined)}/>
    {expanded && <FullscreenChart title={t('statsPage.dailyPlanVsActual')} rows={daily} onClose={() => setExpanded(false)} onSelect={date => { setExpanded(false); setSelectedDate(date) }}/>}
    <Modal open={ledgerOpen} title={t('statsPage.executionTimeLedger')} onClose={() => { setLedgerOpen(false); setLedgerEdit(undefined) }} wide mobileFullscreen>
      <div className="ledger-toolbar"><div><strong>{t('statsPage.attributedByActualDate')}</strong><span>{t('statsPage.attributedByActualDateDesc')}</span></div><div><label><span>{t('statsPage.startDate')}</span><input type="date" value={ledgerStart} onChange={event => setLedgerStart(event.target.value)}/></label><label><span>{t('statsPage.endDate')}</span><input type="date" value={ledgerEnd} max={todayISO()} onChange={event => setLedgerEnd(event.target.value)}/></label></div></div>
      <div className="ledger-list">{ledgerRows.length ? ledgerRows.map(row => { const editing = ledgerEdit?.entryId === row.entry.id; const ownedDate = timeEntryDate(row.entry) ?? todayISO(); return <article key={`${row.assignmentId}-${row.entry.id}`} className={editing ? 'editing' : ''}><div className="ledger-main"><span className={`subject-pill subject-${row.subject}`}>{row.subject}</span><div><strong>{row.assignmentTitle}</strong><small>{row.groupTitle}</small></div></div>{editing ? <div className="ledger-edit-grid"><label><span>{t('statsPage.attributedDate')}</span><input type="date" max={todayISO()} value={ledgerEdit.date} onChange={event => setLedgerEdit({ ...ledgerEdit, date: event.target.value })}/></label><label><span>{t('statsPage.minutesLabel')}</span><NumericInput min={0} max={1440} value={ledgerEdit.minutes} onValueChange={minutes => setLedgerEdit({ ...ledgerEdit, minutes })}/></label></div> : <div className="ledger-facts"><strong>{minutesText(row.entry.minutes)}</strong><span>{fmtDate(ownedDate)}</span><small>{row.entry.source === 'timer' ? t('statsPage.sourceTimer') : row.entry.source === 'finish' ? t('statsPage.sourceFinish') : row.entry.source === 'inferred' ? t('statsPage.sourceInferred') : t('statsPage.sourceManual')}</small><small>{t('statsPage.createdAt', { time: new Date(row.entry.originalCreatedAt ?? row.entry.createdAt).toLocaleString() })}</small>{row.entry.updatedAt && <small>{t('statsPage.updatedAt', { time: new Date(row.entry.updatedAt).toLocaleString() })}</small>}</div>}<div className="ledger-actions">{editing ? <><button className="secondary-button" onClick={() => setLedgerEdit(undefined)}>{t('common.cancel')}</button><button className="primary-button" disabled={!ledgerEdit.date || ledgerEdit.minutes <= 0} onClick={() => { updateTimeEntry(row.assignmentId, row.entry.id, { date: ledgerEdit.date, minutes: ledgerEdit.minutes }); setLedgerEdit(undefined) }}>{t('common.save')}</button></> : <><button className="icon-button" aria-label={t('statsPage.editEntryAria', { title: row.assignmentTitle })} onClick={() => setLedgerEdit({ assignmentId: row.assignmentId, entryId: row.entry.id, minutes: row.entry.minutes, date: ownedDate })}><Pencil size={16}/></button><button className="icon-button danger-icon" aria-label={t('statsPage.deleteEntryAria', { title: row.assignmentTitle })} onClick={() => { if (window.confirm(t('statsPage.confirmDeleteEntry', { title: row.assignmentTitle, date: fmtDate(ownedDate), minutes: row.entry.minutes }))) deleteTimeEntry(row.assignmentId, row.entry.id) }}><Trash2 size={16}/></button></>}</div></article> }) : <div className="empty-state"><Clock3 size={28}/><h3>{t('statsPage.noEntriesInRange')}</h3><p>{t('statsPage.noEntriesInRangeHint')}</p></div>}</div>
    </Modal>
  </div>
}
