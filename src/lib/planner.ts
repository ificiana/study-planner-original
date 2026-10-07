import { differenceInCalendarDays, isAfter, isBefore, parseISO } from 'date-fns'
import type {
  AppState, Assignment, DayTypeSuggestion, LoadChange, ReplanBundle, ReplanConstraintConflict,
  ReplanDisturbance, ReplanLimitOverride, ReplanMove, ReplanRejectedAlternative, ReplanRequest,
  ReplanResult, ReplanStrategy, ReplanMode, TaskActivityType, TaskGroup, PlanChangeEvent, SchedulingProposal,
  ProposalIssue, TaskMovement, DateLoadChange, GoalImpact, AppStatePortable, SchedulingPreference, ConstraintException, ProposalStructuralChange, ReviewDaySnapshot
} from '../types'
import { constraintsForDate, dateRange, getBaseCapacity, getCapacity, getDayConfig, isDateProtected, shiftDate, todayISO } from './date'
import { uid } from './id'
import { isInferredTimeEntry, timeEntryDate } from './execution'
import { cloneActiveState, hydratePortableState, portableState, stableSignature } from './state'
import { goalNamesForAssignment, goalProgress, nearestRelevantGoalDate, nearestRelevantLatestDate, relevantGoalPriority, relevantGoalsForAssignment } from './goals'
import { mergeConstraintExceptions } from './conflicts'
import { dependencyCycleLabels } from './dependencies'
import { translate, tr, type Language } from './i18n'

const before = (a: string, b: string) => isBefore(parseISO(a), parseISO(b))
const after = (a: string, b: string) => isAfter(parseISO(a), parseISO(b))
const between = (date: string, start: string, end: string) => !before(date, start) && !after(date, end)
const dayOf = (value?: string) => value ? value.slice(0, 10) : undefined
const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function isTodayIncomingConstraint(key?: string) {
  return key === 'today-closed' || key === 'today-extra'
}

function todayIncomingAssignmentIds(exceptions: ConstraintException[] = []) {
  return Array.from(new Set(exceptions
    .filter(item => isTodayIncomingConstraint(item.rawKey ?? item.key))
    .flatMap(item => item.affectedAssignmentIds ?? [])))
}

function groupMap(state: AppState) {
  return new Map(state.taskGroups.map(group => [group.id, group]))
}

interface PlannerIndex {
  groups: Map<string, TaskGroup>
  assignmentsByGroup: Map<string, Assignment[]>
  assignmentsByDate: Map<string, Assignment[]>
}

function plannerIndex(state: AppState): PlannerIndex {
  const groups = groupMap(state)
  const assignmentsByGroup = new Map<string, Assignment[]>()
  const assignmentsByDate = new Map<string, Assignment[]>()
  for (const assignment of state.assignments) {
    assignmentsByGroup.set(assignment.groupId, [...(assignmentsByGroup.get(assignment.groupId) ?? []), assignment])
    if (assignment.scheduledDate) assignmentsByDate.set(assignment.scheduledDate, [...(assignmentsByDate.get(assignment.scheduledDate) ?? []), assignment])
  }
  return { groups, assignmentsByGroup, assignmentsByDate }
}

/** v0.8 当前调度只认 Goal；任务组旧 target/due 字段仅供 v0.7 迁移。 */
function relevantDesiredDate(state: AppState, assignment: Assignment): string | undefined {
  return nearestRelevantGoalDate(state, assignment)
}

function relevantLatestOrPlanEnd(state: AppState, assignment: Assignment): string {
  return nearestRelevantLatestDate(state, assignment) ?? state.settings.endDate
}

export function effectiveMinutes(assignment: Assignment) {
  if (assignment.status === 'done') return 0
  if (typeof assignment.remainingMinutes === 'number' && assignment.remainingMinutes >= 0) {
    return Math.max(1, Math.round(assignment.remainingMinutes))
  }
  return Math.max(1, Math.round(assignment.estimatedMinutes * (1 - clamp01(assignment.progress / 100))))
}

function taskActivity(group: TaskGroup): TaskActivityType {
  if (group.activityType && group.activityType !== 'normal') return group.activityType
  const text = `${group.subject}${group.title}${group.notes ?? ''}`.replaceAll(' ', '')
  if (/默写|听写/.test(text) && group.subject === '语文') return 'classical-dictation'
  if (/背诵|默背/.test(text)) return 'recitation'
  if (/文言文|古文|古诗文/.test(text) && group.subject === '语文') return 'classical-study'
  if (group.subject === '化学' && /预习|微课|预习课/.test(text)) return 'chem-preview'
  if (group.subject === '数学' && /套卷|试卷|周练|真题|模拟卷|测试卷/.test(text)) return 'math-paper'
  return 'normal'
}

function isHighIntensity(group: TaskGroup, assignment: Assignment) {
  if (group.highIntensity) return true
  const text = `${group.title}${assignment.title}`
  return assignment.estimatedMinutes >= 75 && /套卷|试卷|章末|综合|模拟|专题复习|考试/.test(text)
}

function isLongTask(assignment: Assignment, thresholdMinutes = 90) {
  return effectiveMinutes(assignment) >= thresholdMinutes || assignment.estimatedMinutes >= thresholdMinutes
}

interface DayStats {
  actualMinutes: number
  inferredMinutes: number
  plannedMinutes: number
  totalMinutes: number
  taskCount: number
  subjectMinutes: Map<string, number>
  counts: Map<string, number>
  longCount: number
  highIntensityCount: number
  longOrHighCount: number
  incomingTodayMinutes: number
}

function blankStats(): DayStats {
  return {
    actualMinutes: 0,
    inferredMinutes: 0,
    plannedMinutes: 0,
    totalMinutes: 0,
    taskCount: 0,
    subjectMinutes: new Map(),
    counts: new Map(),
    longCount: 0,
    highIntensityCount: 0,
    longOrHighCount: 0,
    incomingTodayMinutes: 0
  }
}

function addCount(day: DayStats, key: string, amount = 1) {
  day.counts.set(key, (day.counts.get(key) ?? 0) + amount)
}

function activityKeys(group: TaskGroup, assignment: Assignment, thresholdMinutes = 90) {
  const keys = [`group:${group.id}`]
  const activity = taskActivity(group)
  if (activity !== 'normal') keys.push(`activity:${activity}`)
  if (isLongTask(assignment, thresholdMinutes)) keys.push('long')
  if (isHighIntensity(group, assignment)) keys.push('high-intensity')
  return keys
}

function defaultLimit(state: AppState, date: string, key: string, group?: TaskGroup) {
  if (key.startsWith('group:')) return group?.dailyMax
  if (key === 'activity:classical-study') return 4
  if (key === 'activity:classical-dictation') return 1
  if (key === 'activity:recitation') return 1
  if (key === 'activity:chem-preview') return 1
  if (key === 'activity:math-paper') return 1
  if (key === 'long') return getDayConfig(state, date).type === 'study' ? state.settings.longTaskMaxPerDay : state.settings.longTaskMaxPerDayLight
  if (key === 'high-intensity') return 2
  return undefined
}

function limitLabel(key: string, group?: TaskGroup, language: Language = 'zh') {
  if (key.startsWith('group:')) return translate(language, 'planner.limit.groupDaily', { title: group?.title ?? translate(language, 'planner.limit.taskGroupFallback') })
  const labels: Record<string, string> = {
    'activity:classical-study': translate(language, 'planner.limit.classicalStudy'),
    'activity:classical-dictation': translate(language, 'planner.limit.classicalDictation'),
    'activity:recitation': translate(language, 'planner.limit.recitation'),
    'activity:chem-preview': translate(language, 'planner.limit.chemPreview'),
    'activity:math-paper': translate(language, 'planner.limit.mathPaper'),
    long: translate(language, 'planner.limit.long'),
    'high-intensity': translate(language, 'planner.limit.highIntensity')
  }
  return labels[key] ?? key
}

function acceptedLimit(state: AppState, date: string, key: string, fallback?: number) {
  const accepted = [...(state.acceptedConstraintExceptions ?? [])].reverse().find(item => item.date === date && (item.rawKey ? item.rawKey === key : item.key === rawConstraintKey(key)))
  return accepted?.overrideLimit ?? fallback
}

function overrideLimit(state: AppState, request: ReplanRequest, date: string, key: string, fallback?: number, assignmentId?: string) {
  // 已接受的例外是一次性的历史记录，不会自动成为以后排期的永久新上限。
  // 本轮覆盖可精确到任务：候选任务不在授权范围内时，不得借用别人接受的例外。
  const matching = (request.limitOverrides ?? []).filter(item => item.date === date && item.key === key)
  const applicable = matching.filter(item => {
    if (!item.affectedAssignmentIds?.length) return true
    if (assignmentId) return item.affectedAssignmentIds.includes(assignmentId)
    // 在扫描现有日期负载时，仅当被授权任务仍实际位于该日期，才保留该例外。
    return item.affectedAssignmentIds.some(id => state.assignments.find(candidate => candidate.id === id)?.scheduledDate === date)
  })
  if (!applicable.length) return fallback
  return Math.max(fallback ?? 0, ...applicable.map(item => item.limit))
}

function currentUseForRawLimit(state: AppState, date: string, key: string) {
  const day = statsMap(state).get(date) ?? blankStats()
  if (key === 'capacity') return day.totalMinutes
  if (key.startsWith('group:') || key.startsWith('activity:')) return day.counts.get(key) ?? 0
  if (key === 'long') return day.longCount
  if (key === 'high-intensity') return day.highIntensityCount
  return 0
}

function baseLimitForRawKey(state: AppState, date: string, key: string) {
  if (key === 'capacity') return getCapacity(state, date)
  if (key.startsWith('group:')) {
    const group = state.taskGroups.find(item => item.id === key.slice('group:'.length))
    return defaultLimit(state, date, key, group)
  }
  return defaultLimit(state, date, key)
}

/**
 * 旧例外只“祖父化”当前已经存在的占用：允许现状继续存在，但不能借旧例外再塞入新任务。
 * 例如曾把某日化学上限一次性放宽到 2，而当前只剩 1 项，则下一次排期仍按 1 校验。
 */
function grandfatheredLimitOverrides(state: AppState): ReplanLimitOverride[] {
  const result = new Map<string, ReplanLimitOverride>()
  for (const item of state.acceptedConstraintExceptions ?? []) {
    if (item.overrideLimit == null) continue
    const key = item.rawKey ?? item.key
    const base = baseLimitForRawKey(state, item.date, key)
    if (base == null) continue
    const limit = Math.max(base, currentUseForRawLimit(state, item.date, key))
    const signature = `${item.date}:${key}`
    const previous = result.get(signature)
    if (!previous || limit > previous.limit) result.set(signature, { date: item.date, key, limit, affectedAssignmentIds: item.affectedAssignmentIds ? [...item.affectedAssignmentIds] : undefined })
  }
  return [...result.values()]
}

function grandfatheredAcceptedExceptions(state: AppState, language: Language = 'zh') {
  const now = new Date().toISOString()
  return grandfatheredLimitOverrides(state).map(item => ({
    id: uid('grandfathered-exception'), eventId: 'grandfathered-current-state', accepted: true as const, createdAt: now,
    date: item.date, key: rawConstraintKey(item.key), rawKey: item.key, label: translate(language, 'planner.exception.grandfathered'), permanent: false as const,
    currentLimit: baseLimitForRawKey(state, item.date, item.key), overrideLimit: item.limit,
  }))
}

function rawConstraintKey(key: string): import('../types').ConstraintKey {
  if (key === 'capacity') return 'capacity'
  if (key.startsWith('group:')) return 'group-daily-max'
  if (key.startsWith('activity:')) return 'activity-daily-max'
  if (key === 'long') return 'long-task-max'
  if (key === 'high-intensity') return 'high-intensity-max'
  if (key === 'date-protection' || key === 'protected-buffer') return 'date-protection'
  if (key === 'goal-latest') return 'goal-latest'
  if (key === 'past') return 'past-freeze'
  return 'capacity'
}

function assignmentActualBreakdown(state: AppState) {
  const actualByDate = new Map<string, number>()
  const inferredByDate = new Map<string, number>()
  const assignmentDates = new Map<string, string>()
  const groups = groupMap(state)

  for (const assignment of state.assignments) {
    let entryTotal = 0
    let inferredEntryTotal = 0
    for (const entry of assignment.timeEntries ?? []) {
      const date = timeEntryDate(entry)
      if (!date) continue
      if (isInferredTimeEntry(entry)) {
        inferredEntryTotal += entry.minutes
        inferredByDate.set(date, (inferredByDate.get(date) ?? 0) + entry.minutes)
      } else {
        entryTotal += entry.minutes
        actualByDate.set(date, (actualByDate.get(date) ?? 0) + entry.minutes)
      }
      assignmentDates.set(assignment.id, date)
    }
    const residual = Math.max(0, assignment.actualMinutes - entryTotal)
    const fallbackDate = dayOf(assignment.completedAt) ?? assignment.scheduledDate
    if (residual > 0 && fallbackDate) {
      actualByDate.set(fallbackDate, (actualByDate.get(fallbackDate) ?? 0) + residual)
      assignmentDates.set(assignment.id, fallbackDate)
    }
    if (assignment.status === 'done' && assignment.actualMinutes <= 0 && entryTotal <= 0 && inferredEntryTotal <= 0) {
      const date = dayOf(assignment.completedAt) ?? assignment.scheduledDate
      const group = groups.get(assignment.groupId)
      if (date && group) {
        const inferred = Math.max(1, assignment.estimatedMinutes)
        inferredByDate.set(date, (inferredByDate.get(date) ?? 0) + inferred)
        assignmentDates.set(assignment.id, date)
      }
    }
  }

  if (state.timer.assignmentId) {
    let seconds = state.timer.accumulatedSeconds
    if (state.timer.running && state.timer.startedAt) seconds += Math.max(0, Math.floor((Date.now() - state.timer.startedAt) / 1000))
    if (seconds > 0) {
      const minutes = Math.max(1, Math.round(seconds / 60))
      const date = todayISO()
      actualByDate.set(date, (actualByDate.get(date) ?? 0) + minutes)
      assignmentDates.set(state.timer.assignmentId, date)
    }
  }

  return { actualByDate, inferredByDate, assignmentDates }
}

/**
 * 返回某项任务在指定自然日真实记录的分钟数。
 * 任务后来被顺延到其他日期时，历史计时仍归属于真实发生日；运行中的计时只计入今天。
 */
export function actualMinutesForAssignmentOnDate(state: AppState, assignment: Assignment, date: string): number {
  let minutes = 0
  let recordedTotal = 0
  for (const entry of assignment.timeEntries ?? []) {
    if (isInferredTimeEntry(entry)) continue
    recordedTotal += Math.max(0, entry.minutes)
    if (timeEntryDate(entry) === date) minutes += Math.max(0, entry.minutes)
  }
  const residual = Math.max(0, assignment.actualMinutes - recordedTotal)
  const fallbackDate = dayOf(assignment.completedAt) ?? assignment.scheduledDate
  if (residual > 0 && fallbackDate === date) minutes += residual
  if (state.timer.assignmentId === assignment.id && date === todayISO()) {
    let seconds = state.timer.accumulatedSeconds
    if (state.timer.running && state.timer.startedAt) seconds += Math.max(0, Math.floor((Date.now() - state.timer.startedAt) / 1000))
    if (seconds > 0) minutes += Math.max(1, Math.round(seconds / 60))
  }
  return Math.max(0, Math.round(minutes))
}

function statsMap(state: AppState, excluded = new Set<string>()) {
  const groups = groupMap(state)
  const map = new Map<string, DayStats>()
  const actual = assignmentActualBreakdown(state)
  const longThreshold = state.settings.longTaskThresholdMinutes

  for (const [date, minutes] of actual.actualByDate) {
    const day = map.get(date) ?? blankStats()
    day.actualMinutes += minutes
    day.totalMinutes += minutes
    map.set(date, day)
  }
  for (const [date, minutes] of actual.inferredByDate) {
    const day = map.get(date) ?? blankStats()
    day.inferredMinutes += minutes
    day.totalMinutes += minutes
    map.set(date, day)
  }

  for (const assignment of state.assignments) {
    const group = groups.get(assignment.groupId)
    if (!group) continue
    if (assignment.status === 'done') {
      const date = dayOf(assignment.completedAt) ?? actual.assignmentDates.get(assignment.id) ?? assignment.scheduledDate
      if (!date) continue
      const day = map.get(date) ?? blankStats()
      day.taskCount += group.recurring ? 0 : 1
      for (const key of activityKeys(group, assignment, longThreshold)) addCount(day, key)
      if (isLongTask(assignment, longThreshold)) day.longCount += 1
      if (isHighIntensity(group, assignment)) day.highIntensityCount += 1
      if (isLongTask(assignment, longThreshold) || isHighIntensity(group, assignment)) day.longOrHighCount += 1
      const minutes = assignment.actualMinutes > 0 ? assignment.actualMinutes : assignment.estimatedMinutes
      day.subjectMinutes.set(group.subject, (day.subjectMinutes.get(group.subject) ?? 0) + minutes)
      map.set(date, day)
      continue
    }
    if (!assignment.scheduledDate || excluded.has(assignment.id)) continue
    const day = map.get(assignment.scheduledDate) ?? blankStats()
    const minutes = effectiveMinutes(assignment)
    day.plannedMinutes += minutes
    day.totalMinutes += minutes
    day.taskCount += group.recurring ? 0 : 1
    day.subjectMinutes.set(group.subject, (day.subjectMinutes.get(group.subject) ?? 0) + minutes)
    for (const key of activityKeys(group, assignment, longThreshold)) addCount(day, key)
    if (isLongTask(assignment, longThreshold)) day.longCount += 1
    if (isHighIntensity(group, assignment)) day.highIntensityCount += 1
    if (isLongTask(assignment, longThreshold) || isHighIntensity(group, assignment)) day.longOrHighCount += 1
    map.set(assignment.scheduledDate, day)
  }
  return map
}

function addToStats(stats: Map<string, DayStats>, date: string, assignment: Assignment, group: TaskGroup, originalDate?: string, thresholdMinutes = 90) {
  const day = stats.get(date) ?? blankStats()
  const minutes = effectiveMinutes(assignment)
  day.plannedMinutes += minutes
  day.totalMinutes += minutes
  day.taskCount += group.recurring ? 0 : 1
  day.subjectMinutes.set(group.subject, (day.subjectMinutes.get(group.subject) ?? 0) + minutes)
  for (const key of activityKeys(group, assignment, thresholdMinutes)) addCount(day, key)
  if (isLongTask(assignment, thresholdMinutes)) day.longCount += 1
  if (isHighIntensity(group, assignment)) day.highIntensityCount += 1
  if (isLongTask(assignment, thresholdMinutes) || isHighIntensity(group, assignment)) day.longOrHighCount += 1
  if (date === todayISO() && originalDate !== date) day.incomingTodayMinutes += minutes
  stats.set(date, day)
}

function removeFromStats(stats: Map<string, DayStats>, date: string, assignment: Assignment, group: TaskGroup, originalDate?: string, thresholdMinutes = 90) {
  const current = stats.get(date)
  if (!current) return
  const day: DayStats = { ...current, subjectMinutes: new Map(current.subjectMinutes), counts: new Map(current.counts) }
  const minutes = effectiveMinutes(assignment)
  day.plannedMinutes = Math.max(0, day.plannedMinutes - minutes)
  day.totalMinutes = Math.max(0, day.totalMinutes - minutes)
  day.taskCount = Math.max(0, day.taskCount - (group.recurring ? 0 : 1))
  day.subjectMinutes.set(group.subject, Math.max(0, (day.subjectMinutes.get(group.subject) ?? 0) - minutes))
  for (const key of activityKeys(group, assignment, thresholdMinutes)) day.counts.set(key, Math.max(0, (day.counts.get(key) ?? 0) - 1))
  if (isLongTask(assignment, thresholdMinutes)) day.longCount = Math.max(0, day.longCount - 1)
  if (isHighIntensity(group, assignment)) day.highIntensityCount = Math.max(0, day.highIntensityCount - 1)
  if (isLongTask(assignment, thresholdMinutes) || isHighIntensity(group, assignment)) day.longOrHighCount = Math.max(0, day.longOrHighCount - 1)
  if (date === todayISO() && originalDate !== date) day.incomingTodayMinutes = Math.max(0, day.incomingTodayMinutes - minutes)
  stats.set(date, day)
}

function statsWithoutAssignment(base: Map<string, DayStats>, assignment: Assignment, group: TaskGroup, originalDate?: string, thresholdMinutes = 90) {
  const result = new Map(base)
  if (assignment.scheduledDate && assignment.status !== 'done') removeFromStats(result, assignment.scheduledDate, assignment, group, originalDate, thresholdMinutes)
  return result
}

function loadConstraintForDate(request: ReplanRequest, date: string) {
  const constraints = request.loadConstraints
  if (!constraints || date < constraints.startDate || date > constraints.endDate) return undefined
  return constraints
}

function hardCapacity(state: AppState, date: string, request: ReplanRequest, day?: DayStats, assignmentId?: string) {
  const configured = overrideLimit(state, request, date, 'capacity', getCapacity(state, date), assignmentId) ?? getCapacity(state, date)
  const loadConstraint = loadConstraintForDate(request, date)
  const base = loadConstraint?.maxMinutesPerDay != null ? Math.min(configured, Math.max(0, Math.round(loadConstraint.maxMinutesPerDay))) : configured
  if (date !== todayISO()) return base
  const actual = (day?.actualMinutes ?? 0) + (day?.inferredMinutes ?? 0)
  return Math.max(base, actual + Math.max(0, request.todayExtraMinutes ?? 0))
}

function targetUtilization(state: AppState, date: string, strategy: ReplanStrategy) {
  const config = getDayConfig(state, date)
  if (config.isBufferDay) return state.settings.bufferUtilization
  if (strategy === 'goal') return 1
  if (strategy === 'rest') return 0.78
  if (strategy === 'preserve') return Math.max(state.settings.targetUtilization, 0.9)
  return state.settings.targetUtilization
}

function protectedDateAllowed(request: ReplanRequest, date: string, assignmentId: string) {
  const scoped = request.allowProtectedDateAssignments?.filter(item => item.date === date) ?? []
  if (scoped.length) return scoped.some(item => item.assignmentIds.includes(assignmentId))
  return request.allowBufferUseDates?.includes(date) ?? false
}

function todayIncomingAllowed(request: ReplanRequest, date: string, assignmentId: string) {
  return date === todayISO() && (request.allowTodayIncomingAssignments ?? []).includes(assignmentId)
}

interface PlacementViolation {
  key: string
  label: string
  current: number
  limit: number
  hard: boolean
}

function prerequisiteDepth(groupId: string, groups: Map<string, TaskGroup>, memo: Map<string, number>, visiting = new Set<string>()): number {
  const cached = memo.get(groupId)
  if (cached !== undefined) return cached
  if (visiting.has(groupId)) return 10_000
  visiting.add(groupId)
  const group = groups.get(groupId)
  const depth = group?.prerequisiteGroupIds?.length
    ? 1 + Math.max(...group.prerequisiteGroupIds.map(id => prerequisiteDepth(id, groups, memo, new Set(visiting))))
    : 0
  memo.set(groupId, depth)
  return depth
}

function validatePlacement(
  state: AppState,
  stats: Map<string, DayStats>,
  assignment: Assignment,
  group: TaskGroup,
  date: string,
  request: ReplanRequest,
  originalDate?: string,
  index = plannerIndex(state),
  language: Language = 'zh'
) {
  const violations: PlacementViolation[] = []
  const day = stats.get(date) ?? blankStats()
  const config = getDayConfig(state, date)
  const minutes = effectiveMinutes(assignment)

  if (!between(date, state.settings.startDate, state.settings.endDate)) {
    violations.push({ key: 'plan-range', label: translate(language, 'planner.violation.planRange'), current: 1, limit: 0, hard: true })
    return violations
  }
  if (before(date, todayISO())) violations.push({ key: 'past', label: translate(language, 'planner.violation.past'), current: 1, limit: 0, hard: true })
  const goalLatest = nearestRelevantLatestDate(state, assignment)
  if (goalLatest && after(date, goalLatest)) violations.push({ key: 'goal-latest', label: translate(language, 'planner.violation.goalLatest', { date: goalLatest }), current: 1, limit: 0, hard: true })
  for (const prerequisiteId of group.prerequisiteGroupIds ?? []) {
    const prerequisiteGroup = index.groups.get(prerequisiteId)
    const prerequisiteTasks = index.assignmentsByGroup.get(prerequisiteId) ?? []
    const prerequisiteDates = prerequisiteTasks.map(item => item.status === 'done' && item.completedAt ? item.completedAt.slice(0, 10) : item.scheduledDate)
    if (!prerequisiteGroup || !prerequisiteTasks.length || prerequisiteDates.some(value => !value)) {
      violations.push({ key: `prerequisite:${prerequisiteId}`, label: translate(language, 'planner.violation.prerequisiteIncomplete', { title: prerequisiteGroup?.title ?? translate(language, 'planner.deletedGroup') }), current: 1, limit: 0, hard: true })
      continue
    }
    const latestPrerequisiteDate = prerequisiteDates.filter((value): value is string => Boolean(value)).sort().at(-1)!
    if (!after(date, latestPrerequisiteDate)) {
      violations.push({ key: `prerequisite:${prerequisiteId}`, label: translate(language, 'planner.violation.prerequisiteAfter', { title: prerequisiteGroup.title, date: latestPrerequisiteDate }), current: 1, limit: 0, hard: true })
    }
  }
  if (config.type === 'travel' && originalDate !== date) violations.push({ key: 'travel-day', label: translate(language, 'planner.violation.travelDay'), current: 1, limit: 0, hard: true })
  if (isDateProtected(state, date) && originalDate !== date && !protectedDateAllowed(request, date, assignment.id)) {
    violations.push({ key: 'date-protection', label: translate(language, 'planner.violation.dateProtection'), current: 1, limit: 0, hard: true })
  }

  const manualBufferProtected = Boolean(config.isBufferDay && (config.bufferProtected ?? config.userSet))
  if (manualBufferProtected && originalDate !== date && !protectedDateAllowed(request, date, assignment.id)) {
    violations.push({ key: 'protected-buffer', label: translate(language, 'planner.violation.protectedBuffer'), current: 1, limit: 0, hard: true })
  }
  if (config.isBufferDay && isHighIntensity(group, assignment)) {
    violations.push({ key: 'buffer-high-intensity', label: translate(language, 'planner.violation.bufferHighIntensity'), current: day.highIntensityCount + 1, limit: 0, hard: true })
  }
  if (config.isBufferDay && isLongTask(assignment, state.settings.longTaskThresholdMinutes)) {
    violations.push({ key: 'buffer-long-task', label: translate(language, 'planner.violation.bufferLongTask'), current: day.longCount + 1, limit: 0, hard: true })
  }

  if (date === todayISO() && originalDate !== date && !todayIncomingAllowed(request, date, assignment.id)) {
    const extra = Math.max(0, request.todayExtraMinutes ?? 0)
    const incoming = day.incomingTodayMinutes + minutes
    if (extra <= 0) violations.push({ key: 'today-closed', label: translate(language, 'planner.violation.todayClosed'), current: incoming, limit: 0, hard: true })
    else if (incoming > extra) {
      violations.push({ key: 'today-extra', label: translate(language, 'planner.violation.todayExtra'), current: incoming, limit: extra, hard: true })
    }
  }

  const projected = day.totalMinutes + minutes
  const capacity = hardCapacity(state, date, request, day, assignment.id)
  if (projected > capacity) violations.push({ key: 'capacity', label: translate(language, 'planner.violation.capacity'), current: projected, limit: capacity, hard: true })

  const loadConstraint = loadConstraintForDate(request, date)
  if (loadConstraint?.maxLongHighPerDay != null) {
    const projectedLongHigh = day.longOrHighCount + (isLongTask(assignment, state.settings.longTaskThresholdMinutes) || isHighIntensity(group, assignment) ? 1 : 0)
    if (projectedLongHigh > loadConstraint.maxLongHighPerDay) {
      violations.push({ key: 'load-long-high-max', label: translate(language, 'planner.violation.loadLongHighMax'), current: projectedLongHigh, limit: loadConstraint.maxLongHighPerDay, hard: true })
    }
  }
  if (loadConstraint?.maxHighLoadStreak != null) {
    const highThreshold = state.settings.highLoadThreshold
    const projectedRatio = capacity > 0 ? projected / capacity : 1
    let streak = projectedRatio >= highThreshold ? 1 : 0
    for (let offset = 1; streak > 0 && offset <= 31; offset += 1) {
      const previousDate = shiftDate(date, -offset)
      if (previousDate < loadConstraint.startDate) break
      const previous = stats.get(previousDate)
      const previousCapacity = hardCapacity(state, previousDate, request, previous)
      if (!previous || previousCapacity <= 0 || previous.totalMinutes / previousCapacity < highThreshold) break
      streak += 1
    }
    if (streak > loadConstraint.maxHighLoadStreak) {
      violations.push({ key: 'load-high-streak', label: tr('pl.001'), current: streak, limit: loadConstraint.maxHighLoadStreak, hard: true })
    }
  }

  for (const key of activityKeys(group, assignment)) {
    const fallback = defaultLimit(state, date, key, group)
    if (fallback === undefined) continue
    const limit = overrideLimit(state, request, date, key, fallback, assignment.id) ?? fallback
    const current = (day.counts.get(key) ?? 0) + 1
    if (current > limit) violations.push({ key, label: limitLabel(key, group), current, limit, hard: true })
  }
  return violations
}

function daysFrom(start: string, date: string) {
  return Math.max(0, differenceInCalendarDays(parseISO(date), parseISO(start)))
}

function baselineMaps(state: AppState) {
  const stats = statsMap(state)
  return {
    load: new Map([...stats.entries()].map(([date, day]) => [date, day.totalMinutes])),
    count: new Map([...stats.entries()].map(([date, day]) => [date, day.taskCount]))
  }
}

function candidateScore(
  state: AppState,
  stats: Map<string, DayStats>,
  assignment: Assignment,
  group: TaskGroup,
  date: string,
  strategy: ReplanStrategy,
  originalDate: string | undefined,
  baseline: ReturnType<typeof baselineMaps>,
  preferredShift?: number,
  request: ReplanRequest = { mode: 'repair', fromDate: todayISO() }
) {
  const day = stats.get(date) ?? blankStats()
  const minutes = effectiveMinutes(assignment)
  const projected = day.totalMinutes + minutes
  const capacity = Math.max(1, hardCapacity(state, date, request, day))
  const ratio = projected / capacity
  const distance = originalDate ? Math.abs(differenceInCalendarDays(parseISO(date), parseISO(originalDate))) : daysFrom(state.settings.startDate, date)
  const moveWeight = strategy === 'preserve' ? 240 : strategy === 'rest' ? 150 : strategy === 'balanced' ? 85 : 35
  let score = distance * moveWeight

  if (originalDate && date !== originalDate) score += moveWeight * 2
  if (originalDate && getDayConfig(state, originalDate).isBufferDay && before(date, originalDate)) score += strategy === 'preserve' ? 14000 : 6000
  if (originalDate && preferredShift !== undefined) {
    const shift = differenceInCalendarDays(parseISO(date), parseISO(originalDate))
    score += Math.abs(shift - preferredShift) * (strategy === 'preserve' ? 1200 : 500)
  }
  if (assignment.intentStrength === 'manual') score += date === originalDate ? -25000 : 18000
  if (assignment.status === 'partial') score += date === originalDate ? -15000 : 8000
  const relevantGoalDate = relevantDesiredDate(state, assignment)
  const effectivePriority = Math.max(group.priority, relevantGoalPriority(state, assignment))
  if (relevantGoalDate && after(date, relevantGoalDate)) score += (effectivePriority === 5 ? 36000 : 8000) + daysFrom(relevantGoalDate, date) * (effectivePriority === 5 ? 4500 : 1000)

  const target = targetUtilization(state, date, strategy)
  if (ratio > target) score += Math.pow(ratio - target, 2) * (strategy === 'goal' ? 3500 : 18000)
  else score += Math.pow(ratio, 2) * (strategy === 'balanced' ? 900 : 400)

  const projectedCount = day.taskCount + (group.recurring ? 0 : 1)
  const maxTasks = getDayConfig(state, date).type === 'study' ? state.settings.studyMaxTasks : state.settings.regularMaxTasks
  if (projectedCount > maxTasks) score += (projectedCount - maxTasks) * 4000

  const subjectMinutes = (day.subjectMinutes.get(group.subject) ?? 0) + minutes
  if (projected > 90 && subjectMinutes / projected > state.settings.subjectShareLimit) score += 5000

  const originalLoad = baseline.load.get(date) ?? 0
  const originalCount = baseline.count.get(date) ?? 0
  const addedCount = projectedCount - originalCount
  const addedLoad = projected - originalLoad
  if (addedCount > state.settings.maxNewTasksPerDay) score += (addedCount - state.settings.maxNewTasksPerDay) * (strategy === 'preserve' ? 9000 : 3500)
  if (addedLoad > getBaseCapacity(state, date) * state.settings.maxLoadChangeRatio) {
    score += (addedLoad - getBaseCapacity(state, date) * state.settings.maxLoadChangeRatio) * (strategy === 'preserve' ? 90 : 35)
  }

  const precedingHigh = Array.from({ length: Math.max(1, state.settings.highLoadStreak - 1) }, (_, index) => shiftDate(date, -(index + 1)))
    .every(previousDate => {
      const previous = stats.get(previousDate)
      const cap = hardCapacity(state, previousDate, request, previous)
      return Boolean(previous && cap > 0 && previous.totalMinutes / cap >= state.settings.highLoadThreshold)
    })
  if (precedingHigh && ratio >= state.settings.highLoadThreshold) score += strategy === 'goal' ? 1800 : 10000
  if (getDayConfig(state, date).isBufferDay) score += strategy === 'rest' ? -200 : 5000

  const earlyWeight = strategy === 'goal' ? 120 : strategy === 'balanced' ? 40 : 10
  if (effectivePriority === 5) score += daysFrom(state.settings.startDate, date) * earlyWeight
  return score
}

function planningStart(request: ReplanRequest) {
  const today = todayISO()
  const requested = request.fromDate || today
  if (request.mode === 'full' && !after(requested, today) && !request.includeToday && !(request.todayExtraMinutes && request.todayExtraMinutes > 0)) return shiftDate(today, 1)
  return before(requested, today) ? today : requested
}

function frozenDates(request: ReplanRequest) {
  const start = planningStart(request)
  const count = Math.max(0, request.freezeDays ?? 0)
  return new Set(count ? dateRange(start, shiftDate(start, count - 1)) : [])
}

function fixedAssignmentIds(request: ReplanRequest) {
  const raw = request.event?.metadata?.fixedAssignmentIds
  return new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [])
}

function movableRank(state: AppState, assignments: Assignment[]) {
  const groups = groupMap(state)
  return [...assignments].sort((a, b) => {
    const ga = groups.get(a.groupId)!
    const gb = groups.get(b.groupId)!
    if (a.intentStrength !== b.intentStrength) return a.intentStrength === 'manual' ? 1 : b.intentStrength === 'manual' ? -1 : 0
    if (a.status !== b.status) return a.status === 'partial' ? 1 : b.status === 'partial' ? -1 : 0
    const deadlineA = relevantDesiredDate(state, a) ?? state.settings.endDate
    const deadlineB = relevantDesiredDate(state, b) ?? state.settings.endDate
    if (deadlineA !== deadlineB) return deadlineB.localeCompare(deadlineA)
    const priorityA = Math.max(ga.priority, relevantGoalPriority(state, a))
    const priorityB = Math.max(gb.priority, relevantGoalPriority(state, b))
    if (priorityA !== priorityB) return priorityA - priorityB
    return effectiveMinutes(b) - effectiveMinutes(a)
  })
}

function identifyRepairCandidates(state: AppState, request: ReplanRequest) {
  const index = plannerIndex(state)
  const groups = index.groups
  const candidateIds = new Set<string>()
  const softManualIds = new Set<string>()
  const hardRequired = new Set<string>()
  const fixedIds = fixedAssignmentIds(request)
  const issues: string[] = []
  const start = before(request.fromDate, todayISO()) ? todayISO() : request.fromDate
  const stats = statsMap(state)
  const cycles = dependencyCycleLabels(state.taskGroups)
  cycles.forEach(cycle => issues.push(tr('pl.002', { cycle })))

  const mark = (assignment: Assignment, hard: boolean, message?: string) => {
    if (fixedIds.has(assignment.id) || assignment.locked || assignment.status === 'done' || state.timer.assignmentId === assignment.id) return
    if (assignment.intentStrength === 'manual') softManualIds.add(assignment.id)
    else candidateIds.add(assignment.id)
    if (hard) hardRequired.add(assignment.id)
    if (message) issues.push(message)
  }

  for (const assignment of state.assignments) {
    const group = groups.get(assignment.groupId)
    if (!group || group.recurring || assignment.status === 'done' || assignment.locked || state.timer.assignmentId === assignment.id) continue
    if (!assignment.scheduledDate) {
      mark(assignment, true, tr('pl.003', { subject: group.subject, title: assignment.title }))
      continue
    }
    if (before(assignment.scheduledDate, todayISO())) {
      mark(assignment, true, tr('pl.004', { subject: group.subject, title: assignment.title }))
      continue
    }
    if (before(assignment.scheduledDate, start)) continue
    const config = getDayConfig(state, assignment.scheduledDate)
    if (config.type === 'travel') mark(assignment, true, tr('pl.005', { scheduledDate: assignment.scheduledDate }))
    const goalLatest = nearestRelevantLatestDate(state, assignment)
    if (goalLatest && after(assignment.scheduledDate, goalLatest)) mark(assignment, true, tr('pl.006', { subject: group.subject, title: assignment.title, goalLatest }))
  }

  for (const date of dateRange(start, state.settings.endDate)) {
    const day = stats.get(date) ?? blankStats()
    const config = getDayConfig(state, date)
    const unfinished = (index.assignmentsByDate.get(date) ?? []).filter(item => item.status !== 'done' && !groups.get(item.groupId)?.recurring)
    const sourceProtected = isDateProtected(state, date)
    const availabilityEventAllowsEvacuation = request.event?.type === 'availability-change' && request.event.affectedDates.some(item => item === date)
    // 创建或修改日期约束本身就是用户对该日期的新明确意图。无论是完全不可用、
    // 降低容量还是设置缓冲日，都必须允许把原有普通任务移出该日期；其他事件仍
    // 不得静默破坏日期保护。
    const allowMoveOut = !sourceProtected || availabilityEventAllowsEvacuation
    const movable = movableRank(state, unfinished.filter(item => !item.locked && state.timer.assignmentId !== item.id && allowMoveOut))

    if (config.isBufferDay) {
      for (const item of unfinished) {
        const itemGroup = groups.get(item.groupId)
        if (!itemGroup) continue
        if (isHighIntensity(itemGroup, item) || isLongTask(item, state.settings.longTaskThresholdMinutes)) {
          mark(item, true, tr('pl.009', { date, title: item.title, v: isHighIntensity(itemGroup, item) ? tr('pl.007') : tr('pl.008') }))
        }
      }
    }

    const limitKeys = new Set<string>()
    for (const item of unfinished) {
      const group = groups.get(item.groupId)
      if (!group) continue
      for (const key of activityKeys(group, item, state.settings.longTaskThresholdMinutes)) limitKeys.add(key)
    }
    for (const key of limitKeys) {
      const sample = unfinished.find(item => {
        const group = groups.get(item.groupId)
        return Boolean(group && activityKeys(group, item, state.settings.longTaskThresholdMinutes).includes(key))
      })
      const group = sample ? groups.get(sample.groupId) : undefined
      const fallback = defaultLimit(state, date, key, group)
      if (fallback === undefined) continue
      const limit = overrideLimit(state, request, date, key, fallback) ?? fallback
      const count = day.counts.get(key) ?? 0
      if (count <= limit) continue
      let need = count - limit
      const choices = movable.filter(item => {
        const g = groups.get(item.groupId)
        return Boolean(g && activityKeys(g, item).includes(key))
      })
      for (const item of choices) {
        if (need <= 0) break
        mark(item, true)
        need -= 1
      }
      issues.push(tr('pl.010', { date, v: limitLabel(key, group), count, limit }))
    }

    const capacity = hardCapacity(state, date, request, day)
    let projected = day.totalMinutes
    let count = day.taskCount
    const maxCount = config.type === 'study' ? state.settings.studyMaxTasks : state.settings.regularMaxTasks
    const shouldReduce = projected > capacity || count > maxCount || (config.isBufferDay && projected > capacity)
    if (shouldReduce) {
      for (const item of movable) {
        if (projected <= capacity && count <= maxCount) break
        const group = groups.get(item.groupId)
        if (!group || candidateIds.has(item.id) || softManualIds.has(item.id)) continue
        mark(item, projected > capacity)
        projected -= effectiveMinutes(item)
        count -= 1
      }
      if (day.totalMinutes > capacity) issues.push(tr('pl.011', { date, v: Math.round(day.totalMinutes), capacity }))
      if (day.taskCount > maxCount) issues.push(tr('pl.012', { date, taskCount: day.taskCount, maxCount }))
    }

    if (date === todayISO()) {
      const actual = day.actualMinutes + day.inferredMinutes
      if (actual >= getCapacity(state, date) && unfinished.length) {
        issues.push(tr('pl.013', { v: Math.round(actual) }))
      }
    }
  }

  return { candidateIds, softManualIds, hardRequired, issues }
}

function applyAutomaticBufferDays(state: AppState, request: ReplanRequest) {
  const start = planningStart(request)
  const end = state.settings.endDate
  const dates = dateRange(start, end)
  const groups = groupMap(state)
  const remainingWork = state.assignments
    .filter(item => item.status !== 'done' && !groups.get(item.groupId)?.recurring)
    .reduce((sum, item) => sum + effectiveMinutes(item), 0)
  let targetSlack = dates.reduce((sum, date) => sum + getCapacity(state, date) * state.settings.targetUtilization, 0) - remainingWork
  const minimumSafetySlack = Math.max(30, Math.round(state.settings.regularMinutes * 0.15))
  const baseline = statsMap(state)
  const manuallyProtectedDates = new Set(state.assignments.filter(item => item.scheduledDate && !groups.get(item.groupId)?.recurring && (item.locked || item.intentStrength === 'manual')).map(item => item.scheduledDate!))
  const requestedLightDays = request.loadConstraints?.lightDaysPerWeek == null
    ? 1
    : Math.max(0, Math.min(7, Math.round(request.loadConstraints.lightDaysPerWeek)))

  for (let offset = 0; offset < dates.length; offset += 7) {
    const block = dates.slice(offset, offset + 7)
    if (block.some(date => getDayConfig(state, date).isBufferDay || getDayConfig(state, date).type === 'travel')) continue
    const candidates = block.filter(date => {
      const config = getDayConfig(state, date)
      if (config.userSet || config.type === 'travel') return false
      return !manuallyProtectedDates.has(date)
    })
    if (!candidates.length || requestedLightDays <= 0) continue
    const ordered = candidates.sort((a, b) => (baseline.get(a)?.totalMinutes ?? 0) - (baseline.get(b)?.totalMinutes ?? 0) || b.localeCompare(a))
    let selectedCount = 0
    for (const selected of ordered) {
      if (selectedCount >= requestedLightDays) break
      const originalCapacity = getCapacity(state, selected)
      const base = getBaseCapacity(state, selected)
      const bufferCapacity = Math.round(base * state.settings.bufferUtilization)
      const targetCapacityReduction = Math.max(0, originalCapacity - bufferCapacity) * state.settings.targetUtilization

      // 休息方案不能为了“凑出缓冲日”而把其余日期重新压满，甚至制造无处可排的任务。
      // 只有剩余工作量在目标利用率下仍留有安全余量时，才自动新增这一周的缓冲日。
      if (targetSlack - targetCapacityReduction < minimumSafetySlack) continue

      state.dayConfigs[selected] = {
        ...(state.dayConfigs[selected] ?? { date: selected, type: 'regular' as const }),
        date: selected,
        isBufferDay: true,
        availableMinutes: bufferCapacity,
        bufferReason: tr('pl.014'),
        bufferPreference: 'preserve',
        bufferProtected: false,
        userSet: false
      }
      targetSlack -= targetCapacityReduction
      selectedCount += 1
    }
  }
}

function supportCandidateIds(state: AppState, request: ReplanRequest, alreadySelected: Set<string>) {
  if (request.mode !== 'repair' || !request.event) return new Set<string>()
  const supportedEvents: PlanChangeEvent['type'][] = [
    'new-task-insertion', 'task-group-size-increase', 'goal-tightening', 'availability-change',
    'execution-difference', 'rule-change', 'bulk-move',
  ]
  if (!supportedEvents.includes(request.event.type)) return new Set<string>()

  const groups = groupMap(state)
  const frozen = frozenDates(request)
  const fixedIds = fixedAssignmentIds(request)
  const radius = Math.max(1, request.localRadius ?? state.settings.localRepairRadius)
  const anchors = new Set<string>(request.event.affectedDates)
  for (const id of request.event.affectedAssignmentIds) {
    const item = state.assignments.find(candidate => candidate.id === id)
    if (item?.scheduledDate) anchors.add(item.scheduledDate)
    const goalDate = item ? relevantDesiredDate(state, item) : undefined
    if (goalDate) anchors.add(goalDate)
  }
  if (!anchors.size) anchors.add(planningStart(request))
  const affectedGroups = new Set(request.event.affectedGroupIds)
  const affectedGoals = new Set(request.event.affectedGoalIds)
  const candidates = state.assignments.filter(item => {
    const group = groups.get(item.groupId)
    if (!group || group.recurring || !item.scheduledDate || alreadySelected.has(item.id) || fixedIds.has(item.id)) return false
    if (item.status !== 'todo' || item.progress > 0 || item.actualMinutes > 0) return false
    if (item.locked || item.intentStrength === 'manual' || state.timer.assignmentId === item.id) return false
    if (before(item.scheduledDate, planningStart(request)) || frozen.has(item.scheduledDate)) return false
    if (isDateProtected(state, item.scheduledDate)) return false
    const nearAnchor = [...anchors].some(anchor => Math.abs(differenceInCalendarDays(parseISO(item.scheduledDate!), parseISO(anchor))) <= radius)
    const sameGroup = affectedGroups.has(item.groupId)
    const sameGoal = affectedGoals.size > 0 && relevantGoalsForAssignment(state, item).some(goal => affectedGoals.has(goal.id))
    return nearAnchor || sameGroup || sameGoal
  })

  // 扩大候选范围时增加可被挪动的自动任务，但始终设置上限，避免小事件直接退化为整盘重排。
  const limit = request.strategy === 'preserve' ? Math.max(8, radius * 4) : Math.max(16, radius * 8)
  return new Set(movableRank(state, candidates).slice(0, limit).map(item => item.id))
}

function assignmentCandidates(state: AppState, request: ReplanRequest, repair: ReturnType<typeof identifyRepairCandidates>) {
  const groups = groupMap(state)
  const frozen = frozenDates(request)
  const fixedIds = fixedAssignmentIds(request)
  const start = planningStart(request)
  const ids = new Set<string>()
  for (const assignment of state.assignments) {
    const group = groups.get(assignment.groupId)
    if (!group || group.recurring || fixedIds.has(assignment.id) || assignment.status === 'done' || assignment.locked || state.timer.assignmentId === assignment.id) continue
    const date = assignment.scheduledDate
    if (request.affectedAssignmentIds?.includes(assignment.id)) {
      ids.add(assignment.id)
      continue
    }
    if (request.mode === 'repair') {
      if (repair.candidateIds.has(assignment.id)) ids.add(assignment.id)
      if (request.strategy !== 'preserve' && repair.softManualIds.has(assignment.id)) ids.add(assignment.id)
      continue
    }

    if (repair.hardRequired.has(assignment.id)) {
      ids.add(assignment.id)
      continue
    }
    if (request.strategy === 'preserve') {
      if (repair.candidateIds.has(assignment.id) || !date) ids.add(assignment.id)
      continue
    }
    if (assignment.status === 'partial' && date && !before(date, todayISO())) continue
    if (assignment.intentStrength === 'manual') continue
    if (!date) {
      ids.add(assignment.id)
      continue
    }
    if (date === todayISO()) {
      if (repair.candidateIds.has(assignment.id)) ids.add(assignment.id)
      continue
    }
    const sourceDateExplicitlyChanged = request.event?.type === 'availability-change' && request.event.affectedDates.includes(date)
    if (isDateProtected(state, date) && !sourceDateExplicitlyChanged) continue
    if (before(date, start)) continue
    if (frozen.has(date)) continue
    ids.add(assignment.id)
  }
  for (const id of supportCandidateIds(state, request, ids)) ids.add(id)
  return ids
}

function possibleDateRange(state: AppState, request: ReplanRequest, group: TaskGroup, originalDate?: string, assignment?: Assignment) {
  const start = planningStart(request)
  const goalLatest = assignment ? nearestRelevantLatestDate(state, assignment) : undefined
  const candidates = [state.settings.endDate, goalLatest].filter((item): item is string => Boolean(item)).sort()
  const end = candidates[0] ?? state.settings.endDate
  const all = dateRange(start, end)
  if (request.mode !== 'repair' || !originalDate) return all
  const radius = Math.max(1, request.localRadius ?? state.settings.localRepairRadius)
  const local = all.filter(date => Math.abs(differenceInCalendarDays(parseISO(date), parseISO(originalDate))) <= radius)
  const localSet = new Set(local)
  const rest = all.filter(date => !localSet.has(date))
  return [...local, ...rest]
}

function rejectedAlternative(date: string, violations: PlacementViolation[]): ReplanRejectedAlternative {
  return { date, reasons: violations.map(item => `${item.label}（${Math.round(item.current)}/${Math.round(item.limit)}）`) }
}

function conflictFromRejections(
  assignment: Assignment,
  rejected: { date: string; violations: PlacementViolation[] }[],
  existing: ReplanConstraintConflict[]
) {
  const limitViolations = rejected.flatMap(item => item.violations.map(violation => ({ date: item.date, violation })))
    .filter(item => item.violation.key === 'capacity' || item.violation.key.startsWith('group:') || item.violation.key.startsWith('activity:') || item.violation.key === 'long' || item.violation.key === 'high-intensity' || item.violation.key === 'load-long-high-max' || item.violation.key === 'load-high-streak' || item.violation.key === 'date-protection' || item.violation.key === 'protected-buffer' || item.violation.key === 'buffer-high-intensity' || item.violation.key === 'buffer-long-task' || isTodayIncomingConstraint(item.violation.key))
  if (!limitViolations.length) return
  const chosen = limitViolations.sort((a, b) => a.violation.current - b.violation.current)[0]
  const key = `${chosen.date}:${chosen.violation.key}`
  const found = existing.find(item => `${item.date}:${item.key}` === key)
  if (found) {
    if (!found.affectedAssignmentIds.includes(assignment.id)) found.affectedAssignmentIds.push(assignment.id)
    found.current = Math.max(found.current, chosen.violation.current)
    found.suggestedLimit = Math.max(found.suggestedLimit, chosen.violation.current, chosen.violation.limit + 1)
    found.deficit = Math.max(0, found.current - found.limit)
    found.minimumFeasibleLimit = Math.max(found.minimumFeasibleLimit, found.suggestedLimit)
    return
  }
  existing.push({
    date: chosen.date,
    key: chosen.violation.key,
    label: chosen.violation.label,
    current: chosen.violation.current,
    limit: chosen.violation.limit,
    suggestedLimit: Math.max(chosen.violation.current, chosen.violation.limit + 1),
    deficit: Math.max(0, chosen.violation.current - chosen.violation.limit),
    minimumFeasibleLimit: Math.max(chosen.violation.current, chosen.violation.limit + 1),
    affectedAssignmentIds: [assignment.id],
    options: [
      tr('pl.015', { date: chosen.date, v: Math.max(chosen.violation.current, chosen.violation.limit + 1) }),
      tr('pl.016'),
      tr('pl.017'),
      tr('pl.018')
    ]
  })
}

function calculateDisturbance(beforeState: AppState, afterState: AppState, beforeStats = statsMap(beforeState), afterStats = statsMap(afterState)): ReplanDisturbance {
  const dates = dateRange(beforeState.settings.startDate, beforeState.settings.endDate)
  const deltas = dates.map(date => Math.abs((afterStats.get(date)?.totalMinutes ?? 0) - (beforeStats.get(date)?.totalMinutes ?? 0)))
  const changedDays = deltas.filter(value => value > 0).length
  const scheduled = beforeState.assignments.filter(item => item.scheduledDate)
  const afterById = new Map(afterState.assignments.map(item => [item.id, item]))
  const retained = scheduled.filter(item => afterById.get(item.id)?.scheduledDate === item.scheduledDate).length
  const movedByOrigin = new Map<string, number[]>()
  for (const item of scheduled) {
    const nextDate = afterById.get(item.id)?.scheduledDate
    if (!item.scheduledDate || !nextDate || item.scheduledDate === nextDate) continue
    const shift = differenceInCalendarDays(parseISO(nextDate), parseISO(item.scheduledDate))
    movedByOrigin.set(item.scheduledDate, [...(movedByOrigin.get(item.scheduledDate) ?? []), shift])
  }
  const preservedDailyBundles = [...movedByOrigin.values()].filter(shifts => shifts.length > 1 && shifts.every(value => value === shifts[0])).length
  return {
    changedDays,
    movedTasks: beforeState.assignments.filter(item => afterById.get(item.id)?.scheduledDate !== item.scheduledDate).length,
    originalDateRetentionRate: scheduled.length ? retained / scheduled.length : 1,
    averageLoadDelta: dates.length ? deltas.reduce((sum, value) => sum + value, 0) / dates.length : 0,
    maximumLoadDelta: Math.max(0, ...deltas),
    preservedDailyBundles
  }
}

function explainMove(
  beforeState: AppState,
  afterState: AppState,
  assignment: Assignment,
  group: TaskGroup,
  from: string | undefined,
  to: string | undefined,
  hardRequired: boolean,
  beforeStatsMap: Map<string, DayStats>,
  afterStatsMap: Map<string, DayStats>
) {
  if (!to) return {
    reason: tr('pl.019'),
    impact: tr('pl.020')
  }
  if (!from) {
    const desired = relevantDesiredDate(afterState, assignment)
    return {
      reason: tr('pl.021'),
      impact: desired ? (after(to, desired) ? tr('pl.022', { desired }) : tr('pl.023', { desired })) : tr('pl.024')
    }
  }
  const beforeStats = beforeStatsMap.get(from) ?? blankStats()
  const targetBefore = beforeStatsMap.get(to) ?? blankStats()
  const targetAfter = afterStatsMap.get(to) ?? blankStats()
  const sourceReason = getDayConfig(beforeState, from).isBufferDay
    ? tr('pl.025', { from })
    : hardRequired
      ? tr('pl.026', { from })
      : tr('pl.027', { from })
  const desired = relevantDesiredDate(afterState, assignment)
  return {
    reason: tr('pl.028', { sourceReason, to }),
    impact: tr('pl.032', { from, v: Math.round(beforeStats.totalMinutes), to, v2: Math.round(targetBefore.totalMinutes), v3: Math.round(targetAfter.totalMinutes), v4: desired ? (after(to, desired) ? tr('pl.029', { desired }) : tr('pl.030', { desired })) : tr('pl.031') })
  }
}

function buildScenario(input: AppState, request: ReplanRequest, strategy: ReplanStrategy, repair: ReturnType<typeof identifyRepairCandidates>): ReplanResult {
  const state = cloneActiveState(input)
  if (strategy === 'rest') applyAutomaticBufferDays(state, request)
  const scenarioRepair = strategy === 'rest' ? identifyRepairCandidates(state, request) : repair
  const groups = groupMap(state)
  const index = plannerIndex(state)
  const oldDates = new Map(input.assignments.map(item => [item.id, item.scheduledDate]))
  const candidates = assignmentCandidates(state, { ...request, strategy }, scenarioRepair)
  const baseline = baselineMaps(input)
  const forbiddenReturn = new Map<string, string>()
  for (const assignment of state.assignments) {
    if (!candidates.has(assignment.id) || !assignment.previousDate || !assignment.lastManualMoveAt) continue
    if (Date.now() - Date.parse(assignment.lastManualMoveAt) < 72 * 60 * 60 * 1000) forbiddenReturn.set(assignment.id, assignment.previousDate)
  }

  for (const assignment of state.assignments) if (candidates.has(assignment.id)) assignment.scheduledDate = undefined
  const stats = statsMap(state, candidates)
  const unresolved: Assignment[] = []
  const rejectionMap = new Map<string, ReplanRejectedAlternative[]>()
  const constraintConflicts: ReplanConstraintConflict[] = []
  const preferredShiftByOrigin = new Map<string, number>()
  const candidateDateCache = new Map<string, string[]>()

  const affectedIds = new Set(request.affectedAssignmentIds ?? [])
  const dependencyDepth = new Map<string, number>()
  const candidateItems = [...state.assignments.filter(item => candidates.has(item.id))].sort((a, b) => {
    const ga = groups.get(a.groupId)!
    const gb = groups.get(b.groupId)!
    const depthA = prerequisiteDepth(ga.id, groups, dependencyDepth)
    const depthB = prerequisiteDepth(gb.id, groups, dependencyDepth)
    if (depthA !== depthB) return depthA - depthB
    if (a.intentStrength !== b.intentStrength) return a.intentStrength === 'manual' ? -1 : b.intentStrength === 'manual' ? 1 : 0
    if (a.status !== b.status) return a.status === 'partial' ? -1 : b.status === 'partial' ? 1 : 0
    const deadlineA = relevantDesiredDate(state, a) ?? state.settings.endDate
    const deadlineB = relevantDesiredDate(state, b) ?? state.settings.endDate
    if (deadlineA !== deadlineB) return deadlineA.localeCompare(deadlineB)
    const priorityA = Math.max(ga.priority, relevantGoalPriority(state, a))
    const priorityB = Math.max(gb.priority, relevantGoalPriority(state, b))
    if (priorityA !== priorityB) return priorityB - priorityA
    if (scenarioRepair.hardRequired.has(a.id) !== scenarioRepair.hardRequired.has(b.id)) return scenarioRepair.hardRequired.has(a.id) ? -1 : 1
    if (affectedIds.has(a.id) !== affectedIds.has(b.id)) return affectedIds.has(a.id) ? -1 : 1
    return effectiveMinutes(b) - effectiveMinutes(a)
  })

  for (const assignment of candidateItems) {
    const group = groups.get(assignment.groupId)!
    const originalDate = oldDates.get(assignment.id)
    const latest = nearestRelevantLatestDate(state, assignment) ?? state.settings.endDate
    const dateCacheKey = `${planningStart(request)}|${latest}|${request.mode}|${originalDate ?? ''}|${request.localRadius ?? ''}`
    let candidateDates = candidateDateCache.get(dateCacheKey)
    if (!candidateDates) {
      candidateDates = possibleDateRange(state, request, group, originalDate, assignment)
      candidateDateCache.set(dateCacheKey, candidateDates)
    }
    const dates = candidateDates
      .filter(date => forbiddenReturn.get(assignment.id) !== date)
    const legal: { date: string; score: number }[] = []
    const rejected: { date: string; violations: PlacementViolation[] }[] = []
    for (const date of dates) {
      const violations = validatePlacement(state, stats, assignment, group, date, request, originalDate, index)
      if (violations.some(item => item.hard)) {
        rejected.push({ date, violations })
        continue
      }
      const preferredShift = originalDate ? preferredShiftByOrigin.get(originalDate) : undefined
      legal.push({ date, score: candidateScore(state, stats, assignment, group, date, strategy, originalDate, baseline, preferredShift, request) })
    }
    legal.sort((a, b) => a.score - b.score || a.date.localeCompare(b.date))
    const radius = Math.max(1, request.localRadius ?? state.settings.localRepairRadius)
    const broadEventTypes: PlanChangeEvent['type'][] = ['new-task-insertion', 'task-group-size-increase', 'goal-tightening', 'availability-change', 'execution-difference', 'rule-change', 'bulk-move']
    const useStrictLocalWindow = request.mode === 'repair' && originalDate && !broadEventTypes.includes(request.event?.type ?? 'future-replanning')
    const localLegal = useStrictLocalWindow
      ? legal.filter(item => Math.abs(differenceInCalendarDays(parseISO(item.date), parseISO(originalDate))) <= radius)
      : legal
    const preferredShift = originalDate ? preferredShiftByOrigin.get(originalDate) : undefined
    const originalConfig = originalDate ? getDayConfig(state, originalDate) : undefined
    const preserveBundle = Boolean(originalDate && originalConfig?.isBufferDay && originalConfig.bufferPreference === 'preserve' && preferredShift !== undefined)
    const exactBundleDate = preserveBundle && originalDate ? shiftDate(originalDate, preferredShift!) : undefined
    const exactBundleCandidate = exactBundleDate ? legal.find(item => item.date === exactBundleDate) : undefined
    const selected = exactBundleCandidate?.date ?? (localLegal.length ? localLegal : legal)[0]?.date
    rejectionMap.set(assignment.id, rejected.slice(0, 8).map(item => rejectedAlternative(item.date, item.violations)))
    if (!selected) {
      unresolved.push(assignment)
      conflictFromRejections(assignment, rejected, constraintConflicts)
      continue
    }
    assignment.scheduledDate = selected
    assignment.scheduleSource = 'replan'
    if (assignment.intentStrength !== 'locked') assignment.intentStrength = assignment.intentStrength === 'manual' ? 'manual' : 'normal'
    addToStats(stats, selected, assignment, group, originalDate, input.settings.longTaskThresholdMinutes)
    if (originalDate && !preferredShiftByOrigin.has(originalDate) && originalDate !== selected) {
      preferredShiftByOrigin.set(originalDate, differenceInCalendarDays(parseISO(selected), parseISO(originalDate)))
    }
  }

  // Bounded local exchange: if the greedy pass leaves a task unplaced, move one
  // ordinary automatic task out of a candidate date and try both placements again.
  let swapBudget = 48
  const remainingUnresolved: Assignment[] = []
  for (const assignment of unresolved) {
    let resolved = false
    const group = groups.get(assignment.groupId)!
    const originalDate = oldDates.get(assignment.id)
    const dates = possibleDateRange(state, request, group, originalDate, assignment).slice(0, 12)
    for (const date of dates) {
      if (resolved || swapBudget <= 0) break
      const blockers = state.assignments.filter(item => item.scheduledDate === date && item.id !== assignment.id && candidates.has(item.id) && item.status === 'todo' && !item.locked && item.intentStrength !== 'manual').slice(0, 8)
      for (const blocker of blockers) {
        if (swapBudget-- <= 0) break
        const blockerGroup = groups.get(blocker.groupId)
        if (!blockerGroup || !blocker.scheduledDate) continue
        const blockerDate = blocker.scheduledDate
        removeFromStats(stats, blockerDate, blocker, blockerGroup, oldDates.get(blocker.id), input.settings.longTaskThresholdMinutes)
        const placementIssues = validatePlacement(state, stats, assignment, group, date, request, originalDate, index)
        if (!placementIssues.some(item => item.hard)) {
          assignment.scheduledDate = date
          addToStats(stats, date, assignment, group, originalDate, input.settings.longTaskThresholdMinutes)
          const blockerDates = possibleDateRange(state, request, blockerGroup, oldDates.get(blocker.id), blocker).filter(item => item !== date).slice(0, 20)
          const alternate = blockerDates.find(candidate => !validatePlacement(state, stats, blocker, blockerGroup, candidate, request, oldDates.get(blocker.id), index).some(item => item.hard))
          if (alternate) {
            blocker.scheduledDate = alternate
            blocker.scheduleSource = 'replan'
            assignment.scheduleSource = 'replan'
            addToStats(stats, alternate, blocker, blockerGroup, oldDates.get(blocker.id), input.settings.longTaskThresholdMinutes)
            resolved = true
            break
          }
          removeFromStats(stats, date, assignment, group, originalDate, input.settings.longTaskThresholdMinutes)
          assignment.scheduledDate = undefined
        }
        blocker.scheduledDate = blockerDate
        addToStats(stats, blockerDate, blocker, blockerGroup, oldDates.get(blocker.id), input.settings.longTaskThresholdMinutes)
      }
    }
    if (!resolved) remainingUnresolved.push(assignment)
  }

  const warnings: string[] = []
  for (const assignment of remainingUnresolved) {
    const group = groups.get(assignment.groupId)!
    warnings.push(tr('pl.033', { subject: group.subject, title: assignment.title }))
  }

  const analyzed = analyzePlan(state, planningStart(request), index, stats)
  warnings.push(...analyzed.filter(issue => issue.level !== 'info').map(issue => issue.message))

  const beforeStats = statsMap(input)
  const afterStats = statsMap(state)
  const inputById = new Map(input.assignments.map(item => [item.id, item]))
  const includeFullExplanations = request.explanationLevel === 'full'
  const moves: ReplanMove[] = state.assignments
    .filter(assignment => oldDates.get(assignment.id) !== assignment.scheduledDate)
    .map(assignment => {
      const group = groups.get(assignment.groupId)!
      const from = oldDates.get(assignment.id)
      const to = assignment.scheduledDate
      const explanation = includeFullExplanations
        ? explainMove(input, state, assignment, group, from, to, scenarioRepair.hardRequired.has(assignment.id), beforeStats, afterStats)
        : { reason: from ? tr('pl.034') : tr('pl.035'), impact: to ? `${from ?? tr('pl.036')} → ${to}` : tr('pl.037') }
      const alternativeStats = includeFullExplanations ? statsWithoutAssignment(afterStats, assignment, group, from, input.settings.longTaskThresholdMinutes) : undefined
      const alternatives = includeFullExplanations ? dateRange(planningStart(request), relevantLatestOrPlanEnd(state, assignment))
        .filter(date => date !== to)
        .map(date => ({ date, violations: validatePlacement(state, alternativeStats!, assignment, group, date, request, from, index) }))
        .filter(item => !item.violations.some(violation => violation.hard))
        .slice(0, 3)
        .map(item => { const desired = relevantDesiredDate(state, assignment); return { date: item.date, label: item.date, impact: desired && after(item.date, desired) ? tr('pl.038', { desired }) : desired ? tr('pl.039', { desired }) : tr('pl.040') } }) : []
      return {
        assignmentId: assignment.id,
        title: assignment.title,
        subject: group.subject,
        from,
        to,
        reason: explanation.reason,
        impact: explanation.impact,
        alternatives,
        rejectedAlternatives: rejectionMap.get(assignment.id)?.slice(0, 3),
        wasManual: inputById.get(assignment.id)?.intentStrength === 'manual',
        hardRequired: scenarioRepair.hardRequired.has(assignment.id)
      }
    })

  const start = planningStart(request)
  const loadChanges: LoadChange[] = dateRange(start, state.settings.endDate)
    .map(date => ({
      date,
      beforeMinutes: Math.round(beforeStats.get(date)?.totalMinutes ?? 0),
      afterMinutes: Math.round(afterStats.get(date)?.totalMinutes ?? 0),
      capacity: getCapacity(state, date)
    }))
    .filter(change => change.beforeMinutes !== change.afterMinutes || getCapacity(input, change.date) !== change.capacity)

  const dayTypeSuggestions: DayTypeSuggestion[] = []
  for (const date of dateRange(start, state.settings.endDate)) {
    const config = getDayConfig(state, date)
    const load = afterStats.get(date)?.totalMinutes ?? 0
    if (!config.isBufferDay && config.type === 'regular' && load > state.settings.regularMinutes && load <= state.settings.studyMinutes) {
      dayTypeSuggestions.push({
        date,
        from: 'regular',
        to: 'study',
        reason: tr('pl.041', { v: Math.round(load) }),
        capacityGain: state.settings.studyMinutes - state.settings.regularMinutes
      })
    }
  }

  const disturbance = calculateDisturbance(input, state, beforeStats, afterStats)
  // ReplanSummary 的 core* 字段仅为 v0.7 兼容名称；v0.8 实际承载“最近活跃目标”的预计结果。
  const nearestGoal = (source: AppState) => source.goals
    .filter(goal => goal.status === 'active')
    .sort((a, b) => (a.desiredDate ?? a.latestDate).localeCompare(b.desiredDate ?? b.latestDate))[0]
  const goalSummary = (source: AppState) => {
    const goal = nearestGoal(source)
    if (!goal) return undefined
    const progress = goalProgress(source, goal)
    return progress.completed ? tr('pl.042') : progress.expectedCompletion
  }
  const coreBefore = goalSummary(input)
  const coreAfter = goalSummary(state)
  const chemistryBefore = predictCompletion(input, group => taskActivity(group) === 'chem-preview')
  const chemistryAfter = predictCompletion(state, group => taskActivity(group) === 'chem-preview')
  const allBefore = predictCompletion(input, group => !group.recurring && group.priority > 0)
  const allAfter = predictCompletion(state, group => !group.recurring && group.priority > 0)
  const titles: Record<ReplanStrategy, string> = {
    preserve: tr('pl.043'),
    balanced: tr('pl.044'),
    goal: tr('pl.045'),
    rest: tr('pl.046')
  }
  const descriptions: Record<ReplanStrategy, string> = {
    preserve: tr('pl.047'),
    balanced: tr('pl.048'),
    goal: tr('pl.049'),
    rest: tr('pl.050')
  }
  const bufferDates = dateRange(start, state.settings.endDate).filter(date => getDayConfig(state, date).isBufferDay)
  const consequences = [
    scenarioRepair.issues.length ? tr('pl.051', { length: scenarioRepair.issues.length }) : tr('pl.052'),
    moves.length ? tr('pl.053', { length: moves.length, changedDays: disturbance.changedDays }) : tr('pl.054'),
    tr('pl.055', { v: Math.round(disturbance.originalDateRetentionRate * 100), v2: Math.round(disturbance.averageLoadDelta) }),
    bufferDates.length ? tr('pl.056', { length: bufferDates.length }) : tr('pl.057'),
    remainingUnresolved.length ? tr('pl.058', { length: remainingUnresolved.length }) : tr('pl.059')
  ]

  state.updatedAt = new Date().toISOString()
  return {
    id: uid('scenario'),
    strategy,
    title: titles[strategy],
    description: descriptions[strategy],
    request: { ...request, strategy },
    nextState: state,
    moves,
    warnings: [...new Set(warnings)],
    consequences,
    dayTypeSuggestions,
    loadChanges,
    constraintConflicts,
    disturbance,
    summary: {
      moved: moves.length,
      preservedManual: state.assignments.filter(item => item.intentStrength === 'manual' && oldDates.get(item.id) === item.scheduledDate).length,
      locked: state.assignments.filter(item => item.locked).length,
      unresolved: remainingUnresolved.length,
      coreBefore,
      coreAfter,
      chemistryBefore,
      chemistryAfter,
      allBefore,
      allAfter,
      bufferDays: bufferDates.length,
      changedDays: disturbance.changedDays,
      originalRetentionRate: disturbance.originalDateRetentionRate
    }
  }
}

export function autoConfigureDayTypes(state: AppState): AppState {
  const next = cloneActiveState(state)
  for (const date of dateRange(next.settings.startDate, next.settings.endDate)) {
    if (!next.dayConfigs[date]) next.dayConfigs[date] = { date, type: 'regular', userSet: false }
  }
  const remaining = next.assignments.filter(item => item.status !== 'done' && !next.taskGroups.find(group => group.id === item.groupId)?.recurring)
    .reduce((sum, item) => sum + effectiveMinutes(item), 0)
  const dates = dateRange(next.settings.startDate, next.settings.endDate)
  const current = dates.reduce((sum, date) => sum + getCapacity(next, date) * next.settings.targetUtilization, 0)
  let shortfall = Math.max(0, remaining - current)
  const gain = Math.max(1, next.settings.studyMinutes - next.settings.regularMinutes)
  for (const date of dates) {
    if (shortfall <= 0) break
    const config = next.dayConfigs[date]
    if (config.type === 'regular' && !config.userSet && !config.isBufferDay) {
      config.type = 'study'
      shortfall -= gain
    }
  }
  next.updatedAt = new Date().toISOString()
  return next
}

function normalizeReplanRequest(input: AppState, request: ReplanRequest): ReplanRequest {
  return {
    ...request,
    fromDate: request.fromDate || todayISO(),
    freezeDays: request.freezeDays ?? input.settings.freezeDays,
    includeToday: request.includeToday === true,
    todayExtraMinutes: Math.max(0, request.todayExtraMinutes ?? 0),
    allowTodayIncomingAssignments: request.allowTodayIncomingAssignments ?? [],
    localRadius: request.localRadius ?? input.settings.localRepairRadius,
    allowBufferUseDates: request.allowBufferUseDates ?? [],
    limitOverrides: request.limitOverrides ?? [],
    explanationLevel: request.explanationLevel ?? 'summary'
  }
}

const replanBundleCache = new Map<string, ReplanBundle>()

function replanInputSignature(input: AppState, request: ReplanRequest, strategies: ReplanStrategy[]) {
  // AppContext increments dataRevision for every semantic mutation. Using that
  // stable version avoids serializing every time-entry and nested rule on each
  // preview while still invalidating the cache whenever the input changes.
  // Legacy/demo fixtures may not have a revision yet; never let two such states
  // share a preview just because they happen to have the same updatedAt value.
  const revision = input.dataRevision ?? stableSignature({
    settings: input.settings,
    dayConfigs: input.dayConfigs,
    taskGroups: input.taskGroups,
    goals: input.goals,
    calendarConstraints: input.calendarConstraints,
    acceptedConstraintExceptions: input.acceptedConstraintExceptions,
    assignments: input.assignments.map(item => ({
      ...item,
      timeEntries: item.timeEntries.map(entry => ({
        date: timeEntryDate(entry),
        minutes: entry.minutes,
        source: entry.source,
        countInStatistics: entry.countInStatistics,
      })),
    })),
  })
  return stableSignature({ revision, updatedAt: input.updatedAt, day: todayISO(), request, strategies })
}

export function generateReplanScenario(input: AppState, request: ReplanRequest, strategy: ReplanStrategy): ReplanResult {
  const normalized = normalizeReplanRequest(input, { ...request, strategy })
  const repair = identifyRepairCandidates(input, normalized)
  return buildScenario(input, normalized, strategy, repair)
}

export function generateReplanBundle(input: AppState, request: ReplanRequest, requestedStrategies: ReplanStrategy[] = ['preserve', 'balanced', 'goal', 'rest']): ReplanBundle {
  const normalized = normalizeReplanRequest(input, request)
  const strategies: ReplanStrategy[] = Array.from(new Set<ReplanStrategy>(requestedStrategies.length ? requestedStrategies : ['preserve']))
  const cacheKey = input.timer.running ? undefined : replanInputSignature(input, normalized, strategies)
  const cached = cacheKey ? replanBundleCache.get(cacheKey) : undefined
  if (cached && cacheKey) {
    replanBundleCache.delete(cacheKey)
    replanBundleCache.set(cacheKey, cached)
    return structuredClone(cached)
  }
  const repair = identifyRepairCandidates(input, normalized)
  const actual = assignmentActualBreakdown(input)
  const today = todayISO()
  const todayStats = statsMap(input).get(today) ?? blankStats()
  const actualToday = todayStats.actualMinutes
  const inferredToday = todayStats.inferredMinutes
  const baseCapacity = getCapacity(input, today)
  const automaticRemaining = Math.max(0, baseCapacity - actualToday - inferredToday)
  const allowedIncoming = Math.max(0, normalized.todayExtraMinutes ?? 0)
  void actual
  const bundle: ReplanBundle = {
    request: normalized,
    issues: [...new Set(repair.issues)],
    todaySnapshot: {
      date: today,
      actualMinutes: Math.round(actualToday),
      inferredMinutes: Math.round(inferredToday),
      completedCount: input.assignments.filter(item => item.status === 'done' && (dayOf(item.completedAt) ?? item.scheduledDate) === today).length,
      remainingCapacity: Math.round(automaticRemaining),
      allowedIncomingMinutes: allowedIncoming,
      message: allowedIncoming > 0
        ? tr('pl.060', { v: Math.round(actualToday + inferredToday), v2: Math.round(allowedIncoming) })
        : actualToday + inferredToday >= baseCapacity
          ? tr('pl.061', { v: Math.round(actualToday + inferredToday) })
          : tr('pl.062', { v: Math.round(automaticRemaining) })
    },
    scenarios: strategies.map(strategy => buildScenario(input, normalized, strategy, repair))
  }
  if (cacheKey) {
    replanBundleCache.set(cacheKey, bundle)
    while (replanBundleCache.size > 4) replanBundleCache.delete(replanBundleCache.keys().next().value!)
  }
  return bundle
}

export function replanState(input: AppState, fromDate = todayISO()): ReplanResult {
  const bundle = generateReplanBundle(input, { mode: 'repair', fromDate, freezeDays: input.settings.freezeDays })
  return bundle.scenarios.find(item => item.strategy === 'balanced') ?? bundle.scenarios[0]
}

export interface PlanIssue {
  level: 'info' | 'warning' | 'danger'
  date?: string
  message: string
}

/**
 * 可执行计划中的“硬约束事实”。
 *
 * 这里刻意把已经完成的真实执行和仍可调整的剩余计划分开：
 * - 已经完成/已经发生的用时与任务数量只作为历史基线；
 * - 只有当天仍存在未完成任务，且这些任务继续保留会超过约束时，才形成待处理事实；
 * - 已完成历史不会独自生成硬冲突，也不会阻止其他合法改动应用。
 */
interface HardConstraintFact {
  id: string
  date?: string
  key: string
  current: number
  limit: number
  adjustableAssignmentIds: string[]
  message: string
}

function hardConstraintFacts(state: AppState, fromDate = state.settings.startDate, index = plannerIndex(state), stats = statsMap(state)): HardConstraintFact[] {
  const groups = index.groups
  const facts: HardConstraintFact[] = []
  const start = before(fromDate, todayISO()) ? fromDate : fromDate

  for (const date of dateRange(start, state.settings.endDate)) {
    const day = stats.get(date) ?? blankStats()
    const unfinished = (index.assignmentsByDate.get(date) ?? []).filter(item => item.status !== 'done')
    const ordinaryUnfinished = unfinished.filter(item => !groups.get(item.groupId)?.recurring)
    const capacity = acceptedLimit(state, date, 'capacity', getCapacity(state, date)) ?? getCapacity(state, date)
    const actualHistory = day.actualMinutes + day.inferredMinutes

    if (ordinaryUnfinished.length > 0 && day.plannedMinutes > 0 && day.totalMinutes > capacity) {
      const remaining = Math.max(0, day.plannedMinutes)
      const historyText = actualHistory > 0
        ? tr('pl.063', { v: Math.round(actualHistory) })
        : ''
      facts.push({
        id: `${date}:capacity`, date, key: 'capacity', current: day.totalMinutes, limit: capacity,
        adjustableAssignmentIds: ordinaryUnfinished.map(item => item.id),
        message: tr('pl.064', { date, historyText, v: Math.round(remaining), v2: Math.round(day.totalMinutes), v3: Math.round(day.totalMinutes - capacity) }),
      })
    }

    const keys = new Set(day.counts.keys())
    for (const key of keys) {
      const contributors = ordinaryUnfinished.filter(item => {
        const group = groups.get(item.groupId)
        return Boolean(group && activityKeys(group, item, state.settings.longTaskThresholdMinutes).includes(key))
      })
      if (!contributors.length) continue
      const sample = contributors[0] ?? state.assignments.find(item => {
        const group = groups.get(item.groupId)
        return Boolean(group && activityKeys(group, item, state.settings.longTaskThresholdMinutes).includes(key))
      })
      const group = sample ? groups.get(sample.groupId) : undefined
      const baseLimit = defaultLimit(state, date, key, group)
      const limit = acceptedLimit(state, date, key, baseLimit)
      const current = day.counts.get(key) ?? 0
      if (limit === undefined || current <= limit) continue
      const historicalCount = Math.max(0, current - contributors.length)
      const historyText = historicalCount > 0 ? tr('pl.065', { historicalCount }) : ''
      facts.push({
        id: `${date}:${key}`, date, key, current, limit,
        adjustableAssignmentIds: contributors.map(item => item.id),
        message: tr('pl.066', { date, v: limitLabel(key, group), current, limit, historyText, length: contributors.length }),
      })
    }

    const config = getDayConfig(state, date)
    const isBufferDay = Boolean(config.isBufferDay || constraintsForDate(state, date).some(item => item.kind === 'protected-buffer'))
    if (isBufferDay) {
      const longTasks = ordinaryUnfinished.filter(item => isLongTask(item, state.settings.longTaskThresholdMinutes))
      if (longTasks.length) facts.push({
        id: `${date}:buffer-long-task`, date, key: 'buffer-long-task', current: longTasks.length, limit: 0,
        adjustableAssignmentIds: longTasks.map(item => item.id),
        message: tr('pl.067', { date, length: longTasks.length }),
      })
      const highTasks = ordinaryUnfinished.filter(item => {
        const group = groups.get(item.groupId)
        return Boolean(group && isHighIntensity(group, item))
      })
      if (highTasks.length) facts.push({
        id: `${date}:buffer-high-intensity`, date, key: 'buffer-high-intensity', current: highTasks.length, limit: 0,
        adjustableAssignmentIds: highTasks.map(item => item.id),
        message: tr('pl.068', { date, length: highTasks.length }),
      })
    }
  }

  for (const assignment of state.assignments.filter(item => item.status !== 'done' && item.scheduledDate)) {
    const group = groups.get(assignment.groupId)
    const latest = nearestRelevantLatestDate(state, assignment)
    if (!group || !latest || !after(assignment.scheduledDate!, latest)) continue
    facts.push({
      id: `${assignment.scheduledDate}:goal-latest:${assignment.id}`, date: assignment.scheduledDate,
      key: 'goal-latest', current: 1, limit: 0, adjustableAssignmentIds: [assignment.id],
      message: tr('pl.069', { subject: group.subject, title: assignment.title, latest }),
    })
  }

  return [...new Map(facts.map(fact => [fact.id, fact])).values()]
}

/**
 * 只返回相对基线“新增或恶化”的硬约束事实。
 * 使用约束身份与超额值比较，而不是比较带数字的提示文案，避免把“609 分钟降到 594 分钟”
 * 误判成一个全新的冲突。若非法占用中出现了新的任务，即使超额相同，也仍视为新增使用。
 */
function worsenedHardConstraintFacts(baseline: AppState, candidate: AppState, fromDate: string) {
  const beforeFacts = new Map(hardConstraintFacts(baseline, fromDate).map(item => [item.id, item]))
  return hardConstraintFacts(candidate, fromDate).filter(item => {
    const beforeFact = beforeFacts.get(item.id)
    if (!beforeFact) return true
    const beforeExcess = Math.max(0, beforeFact.current - beforeFact.limit)
    const afterExcess = Math.max(0, item.current - item.limit)
    if (afterExcess > beforeExcess + 1e-6) return true
    const oldAssignments = new Set(beforeFact.adjustableAssignmentIds)
    return item.adjustableAssignmentIds.some(id => !oldAssignments.has(id))
  })
}

function hardConstraintIssueDelta(baseline: AppState, candidate: AppState, fromDate: string) {
  const before = new Map(hardConstraintFacts(baseline, fromDate).map(item => [item.id, item]))
  const after = new Map(hardConstraintFacts(candidate, fromDate).map(item => [item.id, item]))
  let resolvedPreExistingCount = 0
  let improvedPreExistingCount = 0
  let remainingPreExistingCount = 0
  for (const [id, oldFact] of before) {
    const nextFact = after.get(id)
    if (!nextFact) {
      resolvedPreExistingCount += 1
      continue
    }
    remainingPreExistingCount += 1
    const oldExcess = Math.max(0, oldFact.current - oldFact.limit)
    const nextExcess = Math.max(0, nextFact.current - nextFact.limit)
    if (nextExcess + 1e-6 < oldExcess) improvedPreExistingCount += 1
  }
  return {
    preExistingCount: before.size,
    remainingPreExistingCount,
    resolvedPreExistingCount,
    improvedPreExistingCount,
    newOrWorsenedCount: worsenedHardConstraintFacts(baseline, candidate, fromDate).length,
  }
}

export function analyzePlan(state: AppState, fromDate = state.settings.startDate, index = plannerIndex(state), stats = statsMap(state)): PlanIssue[] {
  const groups = index.groups
  const issues: PlanIssue[] = hardConstraintFacts(state, fromDate, index, stats).map(fact => ({ level: 'danger', date: fact.date, message: fact.message }))
  for (const cycle of dependencyCycleLabels(state.taskGroups)) issues.push({ level: 'danger', message: tr('pl.070', { cycle }) })
  let highStreak = 0
  const start = before(fromDate, todayISO()) ? fromDate : fromDate
  for (const date of dateRange(start, state.settings.endDate)) {
    const day = stats.get(date) ?? blankStats()
    const capacity = acceptedLimit(state, date, 'capacity', getCapacity(state, date)) ?? getCapacity(state, date)
    const config = getDayConfig(state, date)
    const unfinished = (index.assignmentsByDate.get(date) ?? []).filter(item => item.status !== 'done' && !groups.get(item.groupId)?.recurring)

    // 已完成的真实执行可能远高于计划容量，但它是历史事实，不再作为计划冲突或满载提醒展示。
    if (unfinished.length > 0 && capacity > 0 && day.totalMinutes <= capacity && day.totalMinutes / capacity > state.settings.nearFullThreshold) {
      issues.push({ level: 'warning', date, message: tr('pl.071', { date, v: Math.round(day.totalMinutes / capacity * 100) }) })
    }
    const maxTasks = config.type === 'study' ? state.settings.studyMaxTasks : state.settings.regularMaxTasks
    if (unfinished.length > 0 && day.taskCount > maxTasks) issues.push({ level: 'warning', date, message: tr('pl.072', { date, taskCount: day.taskCount, length: unfinished.length, maxTasks }) })

    const subjectOver = unfinished.length > 0
      ? [...day.subjectMinutes.entries()].find(([, minutes]) => day.totalMinutes > 90 && minutes / day.totalMinutes > state.settings.subjectShareLimit)
      : undefined
    if (subjectOver) issues.push({ level: 'info', date, message: tr('pl.073', { date, v: subjectOver[0] }) })
    if (config.type === 'travel' && unfinished.length) issues.push({ level: 'warning', date, message: tr('pl.074', { date, length: unfinished.length }) })

    const ratio = capacity > 0 && unfinished.length > 0 ? day.totalMinutes / capacity : 0
    highStreak = ratio >= state.settings.highLoadThreshold ? highStreak + 1 : 0
    if (highStreak >= state.settings.highLoadStreak) {
      issues.push({ level: 'info', date, message: tr('pl.075', { date, highStreak }) })
      highStreak = 0
    }
  }
  return [...new Map(issues.map(issue => [`${issue.level}:${issue.date ?? ''}:${issue.message}`, issue])).values()]
}

export function predictCompletion(state: AppState, predicate?: (group: TaskGroup) => boolean): string | undefined {
  const groups = groupMap(state)
  const remaining = state.assignments.filter(assignment => {
    const group = groups.get(assignment.groupId)
    return Boolean(group && assignment.status !== 'done' && (!predicate || predicate(group)))
  })
  if (!remaining.length) return tr('pl.042')
  const scheduled = remaining.map(item => item.scheduledDate).filter(Boolean) as string[]
  if (scheduled.length !== remaining.length) return undefined
  return [...scheduled].sort().at(-1)
}

export interface PlacementCheckItem {
  key: string
  label: string
  current: number
  limit: number
  hard: boolean
}

export function checkAssignmentPlacement(state: AppState, assignmentId: string, date: string): PlacementCheckItem[] {
  const assignment = state.assignments.find(item => item.id === assignmentId)
  if (!assignment) return [{ key: 'missing-task', label: tr('pl.076'), current: 1, limit: 0, hard: true }]
  const group = state.taskGroups.find(item => item.id === assignment.groupId)
  if (!group) return [{ key: 'missing-group', label: tr('pl.077'), current: 1, limit: 0, hard: true }]
  const stats = statsMap(state, new Set([assignment.id]))
  const today = stats.get(todayISO()) ?? blankStats()
  const automaticTodayRemaining = Math.max(0, getCapacity(state, todayISO()) - today.actualMinutes - today.inferredMinutes)
  const request: ReplanRequest = {
    mode: 'repair',
    fromDate: todayISO(),
    todayExtraMinutes: automaticTodayRemaining,
    allowBufferUseDates: [],
    limitOverrides: []
  }
  return validatePlacement(state, stats, assignment, group, date, request, assignment.scheduledDate)
}

export function suggestMoveDates(state: AppState, assignmentId: string, limit = 5): string[] {
  const assignment = state.assignments.find(item => item.id === assignmentId)
  if (!assignment) return []
  const group = state.taskGroups.find(item => item.id === assignment.groupId)
  if (!group) return []
  const request: ReplanRequest = { mode: 'repair', fromDate: todayISO(), todayExtraMinutes: 0, limitOverrides: [], allowBufferUseDates: [] }
  const stats = statsMap(state, new Set([assignment.id]))
  const baseline = baselineMaps(state)
  return dateRange(todayISO(), relevantLatestOrPlanEnd(state, assignment))
    .filter(date => !validatePlacement(state, stats, assignment, group, date, request, assignment.scheduledDate).some(item => item.hard))
    .map(date => ({ date, score: candidateScore(state, stats, assignment, group, date, 'balanced', assignment.scheduledDate, baseline) }))
    .sort((a, b) => a.score - b.score || a.date.localeCompare(b.date))
    .slice(0, limit)
    .map(item => item.date)
}

export function moveOneDay(date: string, direction: -1 | 1) {
  return shiftDate(date, direction)
}

export function plannerActivityType(group: TaskGroup) {
  return taskActivity(group)
}

export function actualLearningSnapshot(state: AppState, date = todayISO()) {
  const stats = statsMap(state).get(date) ?? blankStats()
  return {
    actualMinutes: Math.round(stats.actualMinutes),
    inferredMinutes: Math.round(stats.inferredMinutes),
    plannedMinutes: Math.round(stats.plannedMinutes),
    totalMinutes: Math.round(stats.totalMinutes),
    taskCount: stats.taskCount
  }
}

/**
 * 每日复盘同时看“原计划在这一天的任务”和“真实在这一天执行的任务”。
 * 这样提前完成、补做逾期任务或跨日计时不会从复盘中消失；历史日期也不会
 * 因为任务后来才完成而被错误改写为当日已完成。
 */
export function reviewDaySnapshot(state: AppState, date: string): ReviewDaySnapshot {
  const groups = groupMap(state)
  const baseline = state.dailyPlanBaselines.find(item => item.date === date)
  const plannedAssignmentIds = baseline
    ? baseline.assignments.map(item => item.assignmentId)
    : state.assignments.filter(item => item.scheduledDate === date).map(item => item.id)
  const plannedIdSet = new Set(plannedAssignmentIds)
  const planned = state.assignments.filter(item => plannedIdSet.has(item.id))
  const executed = state.assignments.filter(item => {
    const completedDate = dayOf(item.completedAt) ?? (item.status === 'done' ? item.scheduledDate : undefined)
    return actualMinutesForAssignmentOnDate(state, item, date) > 0 || completedDate === date
  })
  const assignmentIds = Array.from(new Set([...plannedAssignmentIds, ...executed.map(item => item.id)]))
  const completedAssignmentIds = assignmentIds.filter(id => {
    const item = state.assignments.find(candidate => candidate.id === id)
    if (!item || item.status !== 'done') return false
    const completedDate = dayOf(item.completedAt) ?? item.scheduledDate
    return Boolean(completedDate && completedDate <= date)
  })
  const completedSet = new Set(completedAssignmentIds)
  const unfinishedPlanned = planned.filter(item => !completedSet.has(item.id))
  const stats = statsMap(state).get(date) ?? blankStats()
  return {
    date,
    plannedAssignmentIds,
    executedAssignmentIds: executed.map(item => item.id),
    assignmentIds,
    completedAssignmentIds,
    unfinishedAssignmentIds: unfinishedPlanned.filter(item => !groups.get(item.groupId)?.recurring).map(item => item.id),
    recurringUnfinishedAssignmentIds: unfinishedPlanned.filter(item => groups.get(item.groupId)?.recurring).map(item => item.id),
    plannedMinutes: baseline
      ? baseline.assignments.reduce((sum, item) => sum + item.estimatedMinutes, 0)
      : planned.reduce((sum, item) => sum + item.estimatedMinutes, 0),
    actualMinutes: Math.round(stats.actualMinutes),
    inferredMinutes: Math.round(stats.inferredMinutes),
  }
}

export function planningDayLoad(state: AppState, date: string) {
  return Math.round(statsMap(state).get(date)?.totalMinutes ?? 0)
}

function proposalIssueFromText(text: string, event: PlanChangeEvent): ProposalIssue {
  return {
    id: uid('issue'),
    type: 'unscheduled',
    title: tr('pl.078'),
    detail: text,
    assignmentIds: event.affectedAssignmentIds,
    consequence: tr('pl.079'),
    resolution: tr('pl.080'),
  }
}

function proposalIssuesFromScenario(event: PlanChangeEvent, bundleIssues: string[], scenario: ReplanResult): ProposalIssue[] {
  const issues = bundleIssues.map(text => proposalIssueFromText(text, event))
  for (const conflict of scenario.constraintConflicts) {
    const todayIncoming = isTodayIncomingConstraint(conflict.key)
    const type = conflict.key === 'long' ? 'long-task-max'
      : conflict.key === 'high-intensity' ? 'high-intensity-max'
        : conflict.key.startsWith('group:') ? 'group-daily-max'
          : conflict.key.startsWith('activity:') ? 'activity-daily-max'
            : conflict.key === 'date-protection' || conflict.key === 'protected-buffer' ? 'date-protection'
              : 'capacity'
    const groupId = conflict.key.startsWith('group:') ? conflict.key.slice('group:'.length) : undefined
    const durationEvidence = groupId ? allDurationSuggestions(scenario.nextState).find(item => item.groupId === groupId) : undefined
    const durationCapSuggestion = durationEvidence
      ? tr('pl.081', { sampleCount: durationEvidence.sampleCount, v: Math.round(durationEvidence.recentAverage) })
      : ''
    issues.push({
      id: uid('issue'), type, title: conflict.label,
      detail: tr('pl.082', { date: conflict.date, v: Math.round(conflict.current), v2: Math.round(conflict.limit) }),
      date: conflict.date, currentValue: String(conflict.current), allowedValue: String(conflict.limit),
      assignmentIds: conflict.affectedAssignmentIds,
      consequence: tr('pl.083'),
      resolution: [conflict.options.join('；'), durationCapSuggestion].filter(Boolean).join('；'),
      rawConstraintKey: conflict.key,
      suggestedLimit: conflict.suggestedLimit,
      conflictCategory: conflict.key === 'date-protection' || conflict.key === 'protected-buffer' ? 'protected-intent' : 'waivable-rule',
      allowedResolutions: todayIncoming
        ? ['accept-once', 'system-find-another-date', 'keep-original', 'change-capacity']
        : conflict.key === 'date-protection' || conflict.key === 'protected-buffer'
        ? ['accept-once', 'system-find-another-date', 'keep-original']
        : ['accept-once', 'system-find-another-date', 'leave-unscheduled'],
    })
  }
  const leaveUnscheduled = new Set(Array.isArray(event.metadata?.leaveUnscheduledIds) ? event.metadata?.leaveUnscheduledIds.filter((item): item is string => typeof item === 'string') : [])
  const unresolvedIds = scenario.nextState.assignments
    .filter(item => event.affectedAssignmentIds.includes(item.id) && !item.scheduledDate && !leaveUnscheduled.has(item.id))
    .map(item => item.id)
  if (unresolvedIds.length) issues.push({
    id: uid('issue'), type: 'unscheduled', title: tr('pl.084'),
    detail: tr('pl.085', { length: unresolvedIds.length }), assignmentIds: unresolvedIds,
    currentValue: String(unresolvedIds.length), allowedValue: '0',
    consequence: tr('pl.086'),
    resolution: tr('pl.087'),
  })
  return issues
}

function proposalMovements(before: AppState, afterState: AppState, scenario: ReplanResult): TaskMovement[] {
  const byId = new Map(before.assignments.map(item => [item.id, item]))
  return scenario.moves.map(move => {
    const beforeTask = byId.get(move.assignmentId)
    const afterTask = afterState.assignments.find(item => item.id === move.assignmentId)
    const goals = afterTask ? goalNamesForAssignment(afterState, afterTask) : []
    return {
      assignmentId: move.assignmentId,
      fromDate: move.from,
      toDate: move.to,
      reason: move.reason,
      beforeLoad: move.from ? planningDayLoad(before, move.from) : 0,
      afterLoad: move.to ? planningDayLoad(afterState, move.to) : 0,
      goalImpact: goals.length ? tr('pl.088', { v: goals.join('、') }) : tr('pl.089'),
      manualIntentImpact: beforeTask?.locked ? 'locked-blocked'
        : beforeTask?.intentStrength === 'manual' && move.from !== move.to ? 'moved-manual'
          : beforeTask?.intentStrength === 'manual' ? 'preserved' : 'none',
      rejectedAlternatives: (move.rejectedAlternatives ?? []).map(item => ({ date: item.date, reasons: item.reasons })),
    }
  })
}

function proposalDateChanges(before: AppState, afterState: AppState, scenario: ReplanResult, event: PlanChangeEvent): DateLoadChange[] {
  const dates = new Set<string>([
    ...event.affectedDates,
    ...scenario.loadChanges.map(item => item.date),
    ...scenario.moves.flatMap(item => [item.from, item.to].filter((date): date is string => Boolean(date))),
  ])
  return [...dates].sort().map(date => ({
    date,
    beforeMinutes: planningDayLoad(before, date),
    afterMinutes: planningDayLoad(afterState, date),
    beforeCapacity: getCapacity(before, date),
    afterCapacity: getCapacity(afterState, date),
    beforeTaskIds: before.assignments.filter(item => item.scheduledDate === date).map(item => item.id),
    afterTaskIds: afterState.assignments.filter(item => item.scheduledDate === date).map(item => item.id),
  })).filter(item => item.beforeMinutes !== item.afterMinutes || item.beforeCapacity !== item.afterCapacity || stableSignature(item.beforeTaskIds) !== stableSignature(item.afterTaskIds))
}

function proposalGoalImpacts(before: AppState, afterState: AppState): GoalImpact[] {
  const ids = new Set([...before.goals.map(goal => goal.id), ...afterState.goals.map(goal => goal.id)])
  return [...ids].flatMap(goalId => {
    const beforeGoal = before.goals.find(goal => goal.id === goalId)
    const afterGoal = afterState.goals.find(goal => goal.id === goalId)
    if (!beforeGoal && !afterGoal) return []
    const beforeProgress = beforeGoal ? goalProgress(before, beforeGoal) : undefined
    const afterProgress = afterGoal ? goalProgress(afterState, afterGoal) : undefined
    const changed = !beforeProgress || !afterProgress
      || beforeProgress.expectedCompletion !== afterProgress.expectedCompletion
      || beforeProgress.desiredRisk !== afterProgress.desiredRisk
      || beforeProgress.latestRisk !== afterProgress.latestRisk
      || Math.abs(beforeProgress.progress - afterProgress.progress) > 0.0001
    if (!changed) return []
    const title = afterGoal?.title ?? beforeGoal?.title ?? tr('pl.090')
    return [{
      goalId,
      beforeProgress: beforeProgress?.progress ?? 0,
      afterProgress: afterProgress?.progress ?? 0,
      beforeExpectedCompletion: beforeProgress?.expectedCompletion,
      afterExpectedCompletion: afterProgress?.expectedCompletion,
      desiredRiskBefore: beforeProgress?.desiredRisk ?? false,
      desiredRiskAfter: afterProgress?.desiredRisk ?? false,
      latestRiskBefore: beforeProgress?.latestRisk ?? false,
      latestRiskAfter: afterProgress?.latestRisk ?? false,
      summary: tr('pl.094', { title, v: beforeProgress?.expectedCompletion ?? tr('pl.091'), v2: afterProgress?.expectedCompletion ?? tr('pl.091'), v3: beforeProgress?.latestRisk ? tr('pl.092') : tr('pl.093'), v4: afterProgress?.latestRisk ? tr('pl.092') : tr('pl.093') }),
    }]
  })
}


function textValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value ? tr('pl.095') : tr('pl.096')
  return String(value)
}

function structuralChanges(before: AppState, afterState: AppState): ProposalStructuralChange[] {
  const changes: ProposalStructuralChange[] = []
  const beforeGroups = new Map(before.taskGroups.map(item => [item.id, item]))
  const afterGroups = new Map(afterState.taskGroups.map(item => [item.id, item]))
  const add = (change: ProposalStructuralChange) => {
    if (change.changeType !== 'updated' || change.fields.length) changes.push(change)
  }
  const fields = (pairs: Array<[string, unknown, unknown]>) => pairs.flatMap(([label, oldValue, newValue]) => {
    const oldText = textValue(oldValue)
    const newText = textValue(newValue)
    return oldText === newText ? [] : [{ label, before: oldText, after: newText }]
  })

  const beforeAssignments = new Map(before.assignments.map(item => [item.id, item]))
  const afterAssignments = new Map(afterState.assignments.map(item => [item.id, item]))
  for (const id of new Set([...beforeAssignments.keys(), ...afterAssignments.keys()])) {
    const oldItem = beforeAssignments.get(id)
    const newItem = afterAssignments.get(id)
    if (!oldItem && newItem) continue // 新增任务已有独立且可展开的“新增任务”权威入口。
    if (oldItem && !newItem) {
      add({ entityType: 'assignment', entityId: id, title: oldItem.title, changeType: 'removed', fields: [
        { label: tr('pl.097'), before: beforeGroups.get(oldItem.groupId)?.title ?? oldItem.groupId },
        { label: tr('pl.098'), before: tr('pl.099', { estimatedMinutes: oldItem.estimatedMinutes }) },
        { label: tr('pl.100'), before: oldItem.scheduledDate ?? tr('pl.036') },
      ] })
      continue
    }
    if (!oldItem || !newItem) continue
    add({ entityType: 'assignment', entityId: id, title: newItem.title, changeType: 'updated', fields: fields([
      [tr('pl.101'), oldItem.title, newItem.title],
      [tr('pl.102'), beforeGroups.get(oldItem.groupId)?.title ?? oldItem.groupId, afterGroups.get(newItem.groupId)?.title ?? newItem.groupId],
      [tr('pl.103'), tr('pl.099', { estimatedMinutes: oldItem.estimatedMinutes }), tr('pl.099', { estimatedMinutes: newItem.estimatedMinutes })],
      [tr('pl.104'), Boolean(oldItem.durationCustomized || oldItem.manuallyEstimated), Boolean(newItem.durationCustomized || newItem.manuallyEstimated)],
      [tr('pl.105'), oldItem.locked, newItem.locked],
      [tr('pl.106'), oldItem.intentStrength, newItem.intentStrength],
    ]) })
  }

  for (const id of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const oldItem = beforeGroups.get(id)
    const newItem = afterGroups.get(id)
    if (!oldItem && newItem) {
      add({ entityType: 'task-group', entityId: id, title: newItem.title, changeType: 'added', fields: fields([
        [tr('pl.107'), undefined, newItem.subject], [tr('pl.108'), undefined, newItem.priority], [tr('pl.109'), undefined, newItem.quantity],
        [tr('pl.110'), undefined, tr('pl.111', { unitMinutes: newItem.unitMinutes })], [tr('pl.112'), undefined, newItem.dailyMax ?? tr('pl.113')],
      ]) })
      continue
    }
    if (oldItem && !newItem) {
      add({ entityType: 'task-group', entityId: id, title: oldItem.title, changeType: 'removed', fields: [{ label: tr('pl.114'), before: oldItem.title }] })
      continue
    }
    if (!oldItem || !newItem) continue
    add({ entityType: 'task-group', entityId: id, title: newItem.title, changeType: 'updated', fields: fields([
      [tr('pl.115'), oldItem.title, newItem.title], [tr('pl.107'), oldItem.subject, newItem.subject], [tr('pl.108'), oldItem.priority, newItem.priority],
      [tr('pl.109'), oldItem.quantity, newItem.quantity], [tr('pl.110'), tr('pl.111', { unitMinutes: oldItem.unitMinutes }), tr('pl.111', { unitMinutes: newItem.unitMinutes })],
      [tr('pl.112'), oldItem.dailyMax ?? tr('pl.113'), newItem.dailyMax ?? tr('pl.113')], [tr('pl.116'), oldItem.activityType ?? 'normal', newItem.activityType ?? 'normal'],
      [tr('pl.007'), Boolean(oldItem.highIntensity), Boolean(newItem.highIntensity)], [tr('pl.117'), oldItem.countInStats, newItem.countInStats],
    ]) })
  }

  const conditionText = (goal: AppState['goals'][number]) => goal.completionConditions.map(condition => `${afterGroups.get(condition.groupId)?.title ?? beforeGroups.get(condition.groupId)?.title ?? condition.groupId}:${condition.mode}:${condition.value ?? ''}`).join('；')
  const beforeGoals = new Map(before.goals.map(item => [item.id, item]))
  const afterGoals = new Map(afterState.goals.map(item => [item.id, item]))
  for (const id of new Set([...beforeGoals.keys(), ...afterGoals.keys()])) {
    const oldItem = beforeGoals.get(id)
    const newItem = afterGoals.get(id)
    if (!oldItem && newItem) {
      add({ entityType: 'goal', entityId: id, title: newItem.title, changeType: 'added', fields: fields([
        [tr('pl.118'), undefined, newItem.desiredDate ?? tr('pl.119')], [tr('pl.120'), undefined, newItem.latestDate], [tr('pl.108'), undefined, newItem.priority], [tr('pl.121'), undefined, conditionText(newItem)],
      ]) })
      continue
    }
    if (oldItem && !newItem) { add({ entityType: 'goal', entityId: id, title: oldItem.title, changeType: 'removed', fields: [{ label: tr('pl.090'), before: oldItem.title }] }); continue }
    if (!oldItem || !newItem) continue
    add({ entityType: 'goal', entityId: id, title: newItem.title, changeType: 'updated', fields: fields([
      [tr('pl.122'), oldItem.title, newItem.title], [tr('pl.123'), oldItem.description, newItem.description], [tr('pl.108'), oldItem.priority, newItem.priority],
      [tr('pl.118'), oldItem.desiredDate ?? tr('pl.119'), newItem.desiredDate ?? tr('pl.119')], [tr('pl.120'), oldItem.latestDate, newItem.latestDate],
      [tr('pl.121'), conditionText(oldItem), conditionText(newItem)], [tr('pl.124'), oldItem.linkedAssignmentIds.length, newItem.linkedAssignmentIds.length], [tr('pl.125'), oldItem.status, newItem.status],
    ]) })
  }

  const beforeConstraints = new Map(before.calendarConstraints.map(item => [item.id, item]))
  const afterConstraints = new Map(afterState.calendarConstraints.map(item => [item.id, item]))
  for (const id of new Set([...beforeConstraints.keys(), ...afterConstraints.keys()])) {
    const oldItem = beforeConstraints.get(id)
    const newItem = afterConstraints.get(id)
    if (!oldItem && newItem) {
      add({ entityType: 'calendar-constraint', entityId: id, title: newItem.reason ?? `${newItem.startDate}－${newItem.endDate}`, changeType: 'added', fields: fields([
        [tr('pl.126'), undefined, `${newItem.startDate}－${newItem.endDate}`], [tr('pl.127'), undefined, newItem.kind], [tr('pl.128'), undefined, newItem.capacityMinutes != null ? tr('pl.129', { capacityMinutes: newItem.capacityMinutes }) : undefined], [tr('pl.130'), undefined, newItem.protected],
      ]) })
      continue
    }
    if (oldItem && !newItem) { add({ entityType: 'calendar-constraint', entityId: id, title: oldItem.reason ?? `${oldItem.startDate}－${oldItem.endDate}`, changeType: 'removed', fields: [{ label: tr('pl.131'), before: `${oldItem.startDate}－${oldItem.endDate}` }] }); continue }
    if (!oldItem || !newItem) continue
    add({ entityType: 'calendar-constraint', entityId: id, title: newItem.reason ?? `${newItem.startDate}－${newItem.endDate}`, changeType: 'updated', fields: fields([
      [tr('pl.126'), `${oldItem.startDate}－${oldItem.endDate}`, `${newItem.startDate}－${newItem.endDate}`], [tr('pl.127'), oldItem.kind, newItem.kind],
      [tr('pl.128'), oldItem.capacityMinutes != null ? tr('pl.129', { capacityMinutes: oldItem.capacityMinutes }) : undefined, newItem.capacityMinutes != null ? tr('pl.129', { capacityMinutes: newItem.capacityMinutes }) : undefined],
      [tr('pl.130'), oldItem.protected, newItem.protected], [tr('pl.132'), oldItem.reason, newItem.reason],
    ]) })
  }

  const settingFields = fields([
    [tr('pl.133'), before.settings.startDate, afterState.settings.startDate], [tr('pl.134'), before.settings.endDate, afterState.settings.endDate],
    [tr('pl.135'), tr('pl.136', { regularMinutes: before.settings.regularMinutes }), tr('pl.136', { regularMinutes: afterState.settings.regularMinutes })], [tr('pl.137'), tr('pl.138', { studyMinutes: before.settings.studyMinutes }), tr('pl.138', { studyMinutes: afterState.settings.studyMinutes })],
    [tr('pl.139'), tr('pl.140', { travelMinutes: before.settings.travelMinutes }), tr('pl.140', { travelMinutes: afterState.settings.travelMinutes })], [tr('pl.141'), before.settings.targetUtilization, afterState.settings.targetUtilization],
  ])
  if (settingFields.length) add({ entityType: 'settings', entityId: 'settings', title: tr('pl.142'), changeType: 'updated', fields: settingFields })
  return changes
}

function proposalMetrics(before: AppState, afterState: AppState, event: PlanChangeEvent, issues: ProposalIssue[], movements: TaskMovement[], dates: DateLoadChange[], goals: GoalImpact[]) {
  const existingBefore = before.assignments.filter(item => item.scheduledDate)
  const retained = existingBefore.filter(item => afterState.assignments.find(next => next.id === item.id)?.scheduledDate === item.scheduledDate).length
  const beforeLoads = dateRange(before.settings.startDate, before.settings.endDate).map(date => planningDayLoad(before, date))
  const afterLoads = dateRange(afterState.settings.startDate, afterState.settings.endDate).map(date => planningDayLoad(afterState, date))
  const manualMoves = movements.filter(item => item.manualIntentImpact === 'moved-manual').length
  const protectedUse = movements.filter(item => item.toDate && isDateProtected(afterState, item.toDate)).length
  const moveDistance = movements.reduce((sum, item) => {
    if (!item.fromDate || !item.toDate) return sum + 1
    return sum + Math.abs(differenceInCalendarDays(parseISO(item.toDate), parseISO(item.fromDate)))
  }, 0)
  const loadDeltaHours = dates.reduce((sum, item) => sum + Math.abs(item.afterMinutes - item.beforeMinutes), 0) / 60
  const introducedGoalRisk = goals.filter(item => (!item.latestRiskBefore && item.latestRiskAfter) || (!item.desiredRiskBefore && item.desiredRiskAfter)).length
  const disturbance = movements.length * 5 + Math.min(25, moveDistance * 1.5) + manualMoves * 22 + dates.length * 2 + protectedUse * 15 + Math.min(15, loadDeltaHours * 1.5) + introducedGoalRisk * 20
  const stabilityScore = Math.max(0, Math.round(100 - disturbance))
  const impactLevel = movements.length > 12 || dates.length > 7 || manualMoves > 0 || introducedGoalRisk > 0 ? 'large' : movements.length > 4 || dates.length > 3 ? 'medium' : 'small'
  return {
    newTaskCount: event.type === 'new-task-insertion' || event.type === 'task-group-size-increase' ? event.affectedAssignmentIds.length : 0,
    movedTaskCount: movements.length,
    affectedDateCount: dates.length,
    issueCount: issues.length,
    manualTaskMoveCount: manualMoves,
    protectedDateUseCount: protectedUse,
    beforeAverageLoad: beforeLoads.length ? beforeLoads.reduce((sum, value) => sum + value, 0) / beforeLoads.length : 0,
    afterAverageLoad: afterLoads.length ? afterLoads.reduce((sum, value) => sum + value, 0) / afterLoads.length : 0,
    beforeMaxLoad: Math.max(0, ...beforeLoads),
    afterMaxLoad: Math.max(0, ...afterLoads),
    originalDateRetention: existingBefore.length ? retained / existingBefore.length : 1,
    stabilityScore,
    impactLevel: impactLevel as 'small' | 'medium' | 'large',
  }
}


function exceptionsFromConflicts(conflicts: ReplanConstraintConflict[]): ConstraintException[] {
  const result: ConstraintException[] = []
  for (const conflict of conflicts) {
    const todayIncoming = isTodayIncomingConstraint(conflict.key)
    const supported = todayIncoming || conflict.key === 'capacity' || conflict.key.startsWith('group:') || conflict.key.startsWith('activity:')
      || conflict.key === 'long' || conflict.key === 'high-intensity'
      || conflict.key === 'date-protection' || conflict.key === 'protected-buffer'
    if (!supported) continue
    const protectedDate = conflict.key === 'date-protection' || conflict.key === 'protected-buffer'
    result.push({
      date: conflict.date,
      key: todayIncoming ? 'capacity' : rawConstraintKey(conflict.key),
      rawKey: todayIncoming ? 'today-extra' : conflict.key,
      label: todayIncoming
        ? tr('pl.143', { label: conflict.label })
        : protectedDate ? tr('pl.144', { label: conflict.label }) : tr('pl.145', { label: conflict.label, v: Math.round(conflict.limit), v2: Math.round(conflict.suggestedLimit) }),
      permanent: false,
      currentLimit: conflict.limit,
      overrideLimit: protectedDate || todayIncoming ? undefined : conflict.suggestedLimit,
      affectedAssignmentIds: [...conflict.affectedAssignmentIds],
    })
  }
  return mergeConstraintExceptions(result)
}


function exceptionUsedByResult(state: AppState, exception: ConstraintException, movements: TaskMovement[]) {
  const rawKey = exception.rawKey ?? exception.key
  if (isTodayIncomingConstraint(rawKey)) {
    const scoped = new Set(exception.affectedAssignmentIds ?? [])
    return movements.some(move => {
      if (scoped.size && !scoped.has(move.assignmentId)) return false
      return move.toDate === exception.date && move.fromDate !== move.toDate
    })
  }
  if (exception.key === 'date-protection' || rawKey === 'date-protection' || rawKey === 'protected-buffer' || rawKey === 'source-date-protection') {
    const scoped = new Set(exception.affectedAssignmentIds ?? [])
    return movements.some(move => {
      if (scoped.size && !scoped.has(move.assignmentId)) return false
      return rawKey === 'source-date-protection'
        ? move.fromDate === exception.date && move.fromDate !== move.toDate
        : move.toDate === exception.date && move.fromDate !== move.toDate
    })
  }
  if (exception.overrideLimit == null) return false
  const base = baseLimitForRawKey(state, exception.date, rawKey)
  if (base == null) return false
  return currentUseForRawLimit(state, exception.date, rawKey) > base
}

function proposalFromScenario(
  baseline: AppState,
  input: AppState,
  event: PlanChangeEvent,
  bundleIssues: string[],
  scenario: ReplanResult,
  exceptions: ConstraintException[] = [],
): SchedulingProposal {
  const afterState = scenario.nextState
  const issues = proposalIssuesFromScenario(event, bundleIssues, scenario)
  const movements = proposalMovements(baseline, afterState, scenario)
  const dateChanges = proposalDateChanges(baseline, afterState, scenario, event)
  const goalImpacts = proposalGoalImpacts(baseline, afterState)
  for (const impact of goalImpacts.filter(item => (!item.latestRiskBefore && item.latestRiskAfter) || (!item.desiredRiskBefore && item.desiredRiskAfter))) {
    const goal = afterState.goals.find(item => item.id === impact.goalId) ?? baseline.goals.find(item => item.id === impact.goalId)
    issues.push({
      id: uid('issue'), type: 'goal-risk', title: tr('pl.146', { v: goal?.title ?? impact.goalId }),
      detail: impact.summary, goalId: impact.goalId,
      assignmentIds: goal ? goalProgress(afterState, goal).remainingAssignmentIds : [],
      consequence: impact.latestRiskAfter ? tr('pl.147') : tr('pl.148'),
      resolution: tr('pl.149'),
    })
  }
  const nonDateChanges = structuralChanges(baseline, afterState)
  const excludedDates = movements.flatMap(item => item.rejectedAlternatives)
  let effectiveExceptions = mergeConstraintExceptions(exceptions.filter(item => exceptionUsedByResult(afterState, item, movements)))
  const addEffectiveException = (item: ConstraintException) => { effectiveExceptions = mergeConstraintExceptions([...effectiveExceptions, item]) }
  const availabilitySourceDates = event.type === 'availability-change' ? new Set(event.affectedDates) : new Set<string>()
  for (const move of movements) {
    if (move.fromDate && move.fromDate !== move.toDate && isDateProtected(baseline, move.fromDate) && !availabilitySourceDates.has(move.fromDate)) {
      addEffectiveException({
        date: move.fromDate, key: 'date-protection', rawKey: 'source-date-protection', permanent: false,
        label: tr('pl.150', { fromDate: move.fromDate }),
        affectedAssignmentIds: [move.assignmentId],
      })
    }
    if (move.toDate && move.fromDate !== move.toDate && isDateProtected(afterState, move.toDate)) {
      addEffectiveException({
        date: move.toDate, key: 'date-protection', rawKey: 'date-protection', permanent: false,
        label: tr('pl.151', { toDate: move.toDate }),
        affectedAssignmentIds: [move.assignmentId],
      })
    }
  }

  // A preferred/locked draft may already contain an illegal date and therefore never enter
  // the movable-candidate loop. Compare the resulting hard dangers against the baseline so
  // a proposal cannot look valid merely because the engine correctly refused to move it.
  const analysisState = cloneActiveState(afterState)
  const acceptedAt = new Date().toISOString()
  analysisState.acceptedConstraintExceptions = [
    ...grandfatheredAcceptedExceptions(baseline),
    ...effectiveExceptions.map(item => ({ ...item, id: uid('preview-exception'), eventId: event.id, accepted: true as const, createdAt: acceptedAt })),
  ]
  const analysisFrom = proposalPlanningStart(afterState, event)
  const newDangers = worsenedHardConstraintFacts(baseline, analysisState, analysisFrom)
  for (const danger of newDangers) issues.push(issueFromHardConstraintFact(danger, tr('pl.152')))
  const protectedMoveViolations = movements.filter(move => move.toDate && move.fromDate !== move.toDate && isDateProtected(afterState, move.toDate)
    && !effectiveExceptions.some(item => item.date === move.toDate && item.key === 'date-protection'))
  for (const move of protectedMoveViolations) issues.push({
    id: uid('issue'), type: 'date-protection', title: tr('pl.153'),
    detail: tr('pl.154', { toDate: move.toDate ?? '' }), date: move.toDate,
    assignmentIds: [move.assignmentId], consequence: tr('pl.155'),
    resolution: tr('pl.156'),
  })

  const metrics = proposalMetrics(baseline, afterState, event, issues, movements, dateChanges, goalImpacts)
  const signature = stableSignature({
    moves: movements.map(item => [item.assignmentId, item.toDate]),
    dates: dateChanges.map(item => [item.date, item.afterMinutes]),
    goals: goalImpacts.map(item => [item.goalId, item.afterExpectedCompletion, item.latestRiskAfter]),
    structural: nonDateChanges.map(item => [item.entityType, item.entityId, item.changeType, item.fields]),
    exceptions: effectiveExceptions.map(item => [item.date, item.rawKey, item.overrideLimit]),
  })
  const leaveUnscheduled = new Set(Array.isArray(event.metadata?.leaveUnscheduledIds) ? event.metadata?.leaveUnscheduledIds.filter((item): item is string => typeof item === 'string') : [])
  const unresolved = afterState.assignments.filter(item => event.affectedAssignmentIds.includes(item.id) && !item.scheduledDate && !leaveUnscheduled.has(item.id))
  const infeasibleReasons: string[] = []
  if (unresolved.length) infeasibleReasons.push(tr('pl.157', { length: unresolved.length }))
  if (newDangers.length) infeasibleReasons.push(tr('pl.158', { length: newDangers.length }))
  if (protectedMoveViolations.length) infeasibleReasons.push(tr('pl.159', { length: protectedMoveViolations.length }))
  return {
    id: uid('proposal'), eventId: event.id,
    title: effectiveExceptions.length ? tr('pl.160', { title: scenario.title }) : scenario.title,
    description: effectiveExceptions.length
      ? tr('pl.161', { description: scenario.description })
      : scenario.description,
    action: event.action,
    preference: scenario.strategy,
    generatedAt: new Date().toISOString(),
    stateBefore: portableState(baseline),
    stateAfter: portableState(afterState),
    issues,
    movements,
    dateChanges,
    goalImpacts,
    structuralChanges: nonDateChanges,
    exceptions: effectiveExceptions,
    excludedDates,
    metrics,
    distinctSignature: signature,
    infeasible: infeasibleReasons.length > 0,
    infeasibleReason: infeasibleReasons.join(' '),
  }
}


function directIssueType(key: string): ProposalIssue['type'] {
  if (key === 'capacity' || key === 'today-extra' || key === 'today-closed' || key === 'travel-day' || key === 'buffer-high-intensity' || key === 'buffer-long-task') return 'capacity'
  if (key.startsWith('group:')) return 'group-daily-max'
  if (key.startsWith('activity:')) return 'activity-daily-max'
  if (key === 'long') return 'long-task-max'
  if (key === 'high-intensity') return 'high-intensity-max'
  if (key === 'date-protection' || key === 'protected-buffer') return 'date-protection'
  if (key === 'past' || key === 'plan-range') return 'past-freeze'
  if (key === 'goal-latest') return 'goal-risk'
  return 'unscheduled'
}

function issueFromHardConstraintFact(fact: HardConstraintFact, title: string): ProposalIssue {
  const waivable = fact.key === 'capacity' || fact.key.startsWith('group:') || fact.key.startsWith('activity:') || fact.key === 'long' || fact.key === 'high-intensity'
  const goal = fact.key === 'goal-latest'
  return {
    id: uid('issue'), type: directIssueType(fact.key), title, detail: fact.message, date: fact.date,
    currentValue: String(Math.round(fact.current)), allowedValue: String(Math.round(fact.limit)),
    assignmentIds: [...fact.adjustableAssignmentIds], rawConstraintKey: fact.key,
    suggestedLimit: waivable ? fact.current : undefined,
    consequence: tr('pl.162'),
    resolution: waivable
      ? tr('pl.163')
      : goal
        ? tr('pl.164')
        : tr('pl.165'),
    conflictCategory: waivable ? 'waivable-rule' : 'structural-conflict',
    allowedResolutions: waivable
      ? ['accept-once', 'system-find-another-date', 'leave-unscheduled']
      : goal
        ? ['system-find-another-date', 'leave-unscheduled', 'change-goal', 'cancel-change']
        : ['system-find-another-date', 'leave-unscheduled', 'change-capacity', 'cancel-change'],
  }
}

/**
 * 对“用户已经明确指定结果”或“默认保持日期”的变化生成精确预览。
 * 此函数不重新选择日期，只检查准备态相对当前正式计划新增了哪些硬冲突。
 */
export function previewPreparedChange(
  baseline: AppState,
  preparedState: AppState,
  event: PlanChangeEvent,
  title = tr('pl.166'),
  acceptedExceptions: ConstraintException[] = [],
): SchedulingProposal {
  const beforeById = new Map(baseline.assignments.map(item => [item.id, item]))
  const afterById = new Map(preparedState.assignments.map(item => [item.id, item]))
  const groups = groupMap(preparedState)
  const changed = [...new Set([...beforeById.keys(), ...afterById.keys()])].flatMap(id => {
    const oldItem = beforeById.get(id)
    const newItem = afterById.get(id)
    if (!oldItem || !newItem || oldItem.scheduledDate === newItem.scheduledDate) return []
    return [{ oldItem, newItem }]
  })
  const movements: TaskMovement[] = changed.map(({ oldItem, newItem }) => ({
    assignmentId: newItem.id,
    fromDate: oldItem.scheduledDate,
    toDate: newItem.scheduledDate,
    reason: event.type === 'execution-difference'
      ? tr('pl.167')
      : event.type === 'bulk-move'
        ? tr('pl.168')
        : tr('pl.169'),
    beforeLoad: oldItem.scheduledDate ? planningDayLoad(baseline, oldItem.scheduledDate) : 0,
    afterLoad: newItem.scheduledDate ? planningDayLoad(preparedState, newItem.scheduledDate) : 0,
    goalImpact: goalNamesForAssignment(preparedState, newItem).length
      ? tr('pl.088', { v: goalNamesForAssignment(preparedState, newItem).join('、') })
      : tr('pl.089'),
    manualIntentImpact: oldItem.locked ? 'locked-blocked'
      : oldItem.intentStrength === 'manual' && oldItem.scheduledDate !== newItem.scheduledDate ? 'moved-manual'
        : oldItem.intentStrength === 'manual' ? 'preserved' : 'none',
    rejectedAlternatives: [],
  }))
  const changedDates = new Set<string>(event.affectedDates)
  for (const move of movements) {
    if (move.fromDate) changedDates.add(move.fromDate)
    if (move.toDate) changedDates.add(move.toDate)
  }
  const dateChanges: DateLoadChange[] = [...changedDates].sort().map(date => ({
    date,
    beforeMinutes: planningDayLoad(baseline, date),
    afterMinutes: planningDayLoad(preparedState, date),
    beforeCapacity: getCapacity(baseline, date),
    afterCapacity: getCapacity(preparedState, date),
    beforeTaskIds: baseline.assignments.filter(item => item.scheduledDate === date).map(item => item.id),
    afterTaskIds: preparedState.assignments.filter(item => item.scheduledDate === date).map(item => item.id),
  })).filter(item => item.beforeMinutes !== item.afterMinutes || item.beforeCapacity !== item.afterCapacity || stableSignature(item.beforeTaskIds) !== stableSignature(item.afterTaskIds))

  const issuesByKey = new Map<string, ProposalIssue>()
  const addIssue = (signature: string, issue: ProposalIssue) => {
    const existing = issuesByKey.get(signature)
    if (!existing) { issuesByKey.set(signature, issue); return }
    existing.assignmentIds = Array.from(new Set([...existing.assignmentIds, ...issue.assignmentIds]))
  }
  const today = todayISO()
  const mergedAcceptedExceptions = mergeConstraintExceptions(acceptedExceptions)
  const request: ReplanRequest = {
    mode: 'repair', fromDate: today,
    todayExtraMinutes: Number(event.metadata?.todayExtraMinutes ?? 0),
    allowTodayIncomingAssignments: todayIncomingAssignmentIds(mergedAcceptedExceptions),
    allowBufferUseDates: mergedAcceptedExceptions
      .filter(item => item.key === 'date-protection' && !item.affectedAssignmentIds?.length && item.rawKey !== 'source-date-protection')
      .map(item => item.date),
    allowProtectedDateAssignments: mergedAcceptedExceptions
      .filter(item => item.key === 'date-protection' && item.affectedAssignmentIds?.length && item.rawKey !== 'source-date-protection')
      .map(item => ({ date: item.date, assignmentIds: [...(item.affectedAssignmentIds ?? [])] })),
    limitOverrides: [
      ...grandfatheredLimitOverrides(baseline),
      ...mergedAcceptedExceptions.flatMap(item => item.overrideLimit == null ? [] : [{
        date: item.date,
        key: item.rawKey ?? item.key,
        limit: item.overrideLimit,
        affectedAssignmentIds: item.affectedAssignmentIds ? [...item.affectedAssignmentIds] : undefined,
      }]),
    ],
    event,
  }
  for (const { oldItem, newItem } of changed) {
    const assignmentIds = [newItem.id]
    const oldDateIsPast = Boolean(oldItem.scheduledDate && before(oldItem.scheduledDate, today))
    const newDateIsPast = Boolean(newItem.scheduledDate && before(newItem.scheduledDate, today))
    const explicitlyMovesPastUnfinishedOut = Boolean(
      oldDateIsPast
      && oldItem.status !== 'done'
      && !oldItem.locked
      && baseline.timer.assignmentId !== oldItem.id
      && (!newItem.scheduledDate || !newDateIsPast)
      && event.affectedAssignmentIds.includes(newItem.id)
      && (event.type === 'execution-difference' || event.type === 'bulk-move')
    )
    const availabilitySourceChange = event.type === 'availability-change' && oldItem.scheduledDate && event.affectedDates.includes(oldItem.scheduledDate)
    const acceptedSourceProtection = Boolean(oldItem.scheduledDate && mergedAcceptedExceptions.some(item =>
      item.rawKey === 'source-date-protection' && item.date === oldItem.scheduledDate
      && (!item.affectedAssignmentIds?.length || item.affectedAssignmentIds.includes(newItem.id))))
    if (oldItem.scheduledDate && oldItem.scheduledDate !== newItem.scheduledDate && isDateProtected(baseline, oldItem.scheduledDate)
      && !availabilitySourceChange && !explicitlyMovesPastUnfinishedOut && !acceptedSourceProtection) addIssue(`source-protected:${oldItem.scheduledDate}:${newItem.id}`, {
      id: uid('issue'), type: 'date-protection', title: tr('pl.170'),
      detail: tr('pl.171', { title: oldItem.title, scheduledDate: oldItem.scheduledDate }),
      date: oldItem.scheduledDate, assignmentIds, consequence: tr('pl.172'),
      resolution: tr('pl.173'), rawConstraintKey: 'source-date-protection',
      conflictCategory: 'protected-intent', allowedResolutions: ['accept-once', 'keep-original', 'cancel-change'],
    })
    if (oldItem.status === 'done') addIssue(`done:${newItem.id}`, {
      id: uid('issue'), type: 'task-lock', title: tr('pl.174'), detail: tr('pl.175', { title: oldItem.title }),
      assignmentIds, consequence: tr('pl.176'), resolution: tr('pl.177'),
      rawConstraintKey: 'completed-history', conflictCategory: 'absolute-blocker', allowedResolutions: ['keep-original', 'cancel-change'],
    })
    if (oldItem.locked) addIssue(`locked:${newItem.id}`, {
      id: uid('issue'), type: 'task-lock', title: tr('pl.178'), detail: tr('pl.179', { title: oldItem.title, v: newItem.scheduledDate ?? tr('pl.036') }),
      assignmentIds, consequence: tr('pl.180'), resolution: tr('pl.181'),
      rawConstraintKey: 'task-lock', conflictCategory: 'protected-intent', allowedResolutions: ['keep-original', 'unlock-and-move', 'cancel-change'],
    })
    if (baseline.timer.assignmentId === newItem.id) addIssue(`timer:${newItem.id}`, {
      id: uid('issue'), type: 'active-timer', title: tr('pl.182'), detail: tr('pl.183', { title: oldItem.title }),
      assignmentIds, consequence: tr('pl.184'), resolution: tr('pl.185'),
      rawConstraintKey: 'active-timer', conflictCategory: 'absolute-blocker', allowedResolutions: ['keep-original', 'cancel-change'],
    })
    // 过去日期冻结的是已经发生的执行事实，而不是把未完成任务永远困在过去。
    // 用户在复盘或待处理任务中明确选择顺延时，允许把过去未完成任务移到今天/未来，
    // 或暂时取消日期；但仍禁止把任务移入过去、改写已完成记录、锁定任务或计时任务。
    if (newDateIsPast || (oldDateIsPast && !explicitlyMovesPastUnfinishedOut)) addIssue(`past:${newItem.id}`, {
      id: uid('issue'), type: 'past-freeze', title: newDateIsPast ? tr('pl.186') : tr('pl.187'),
      detail: newDateIsPast
        ? tr('pl.188', { title: oldItem.title, scheduledDate: newItem.scheduledDate ?? '' })
        : tr('pl.189', { title: oldItem.title }),
      assignmentIds,
      consequence: newDateIsPast ? tr('pl.190') : tr('pl.191'),
      resolution: newDateIsPast ? tr('pl.192') : tr('pl.193'),
      rawConstraintKey: 'past', conflictCategory: 'absolute-blocker', allowedResolutions: ['keep-original', 'cancel-change'],
    })
    if (!newItem.scheduledDate) continue
    const group = groups.get(newItem.groupId)
    if (!group) continue
    const stats = statsMap(preparedState, new Set([newItem.id]))
    for (const violation of validatePlacement(preparedState, stats, newItem, group, newItem.scheduledDate, request, oldItem.scheduledDate)) {
      if (!violation.hard) continue
      const type = directIssueType(violation.key)
      const signature = `${newItem.scheduledDate}:${violation.key}`
      const todayIncoming = isTodayIncomingConstraint(violation.key)
      addIssue(signature, {
        id: uid('issue'), type, title: violation.label,
        detail: tr('pl.194', { scheduledDate: newItem.scheduledDate, v: Math.round(violation.current), v2: Math.round(violation.limit) }),
        date: newItem.scheduledDate, groupId: violation.key.startsWith('group:') ? newItem.groupId : undefined,
        currentValue: String(Math.round(violation.current)), allowedValue: String(Math.round(violation.limit)), assignmentIds,
        consequence: tr('pl.195'),
        resolution: tr('pl.196'),
        rawConstraintKey: violation.key,
        suggestedLimit: violation.current,
        conflictCategory: todayIncoming ? 'waivable-rule' : violation.key === 'date-protection' || violation.key === 'protected-buffer' ? 'protected-intent'
          : violation.key === 'capacity' || violation.key.startsWith('group:') || violation.key.startsWith('activity:') || violation.key === 'long' || violation.key === 'high-intensity' ? 'waivable-rule'
            : violation.key === 'past' || violation.key === 'plan-range' ? 'absolute-blocker' : 'structural-conflict',
        allowedResolutions: todayIncoming
          ? ['accept-once', 'system-find-another-date', 'keep-original', 'change-capacity']
          : violation.key === 'date-protection' || violation.key === 'protected-buffer'
          ? ['accept-once', 'system-find-another-date', 'keep-original']
          : violation.key === 'capacity' || violation.key.startsWith('group:') || violation.key.startsWith('activity:') || violation.key === 'long' || violation.key === 'high-intensity'
            ? ['accept-once', 'system-find-another-date', 'leave-unscheduled']
            : violation.key === 'past' || violation.key === 'plan-range'
              ? ['keep-original', 'cancel-change']
              : ['system-find-another-date', 'keep-original', 'change-capacity', 'cancel-change'],
      })
    }
  }

  // 预计时长、容量和规则变化可能没有移动日期，但仍可能让现有日期新增硬冲突。
  const fromDate = proposalPlanningStart(preparedState, event)
  const analysisPreparedState = cloneActiveState(preparedState)
  analysisPreparedState.acceptedConstraintExceptions = [
    ...grandfatheredAcceptedExceptions(baseline),
    ...mergedAcceptedExceptions.map(item => ({
      ...item, id: uid('preview-exception'), eventId: event.id, accepted: true as const, createdAt: new Date().toISOString(),
    })),
  ]
  const specificallyValidatedDates = new Set([...issuesByKey.values()].flatMap(item => item.date ? [item.date] : []))
  for (const danger of worsenedHardConstraintFacts(baseline, analysisPreparedState, fromDate)) {
    if (danger.date && specificallyValidatedDates.has(danger.date)) continue
    addIssue(`analysis:${danger.id}`, issueFromHardConstraintFact(danger, tr('pl.197')))
  }

  const issues = [...issuesByKey.values()]
  const issueDelta = hardConstraintIssueDelta(baseline, analysisPreparedState, fromDate)
  const effectiveAcceptedExceptions = mergeConstraintExceptions(mergedAcceptedExceptions.filter(item => exceptionUsedByResult(preparedState, item, movements)))
  const goalImpacts = proposalGoalImpacts(baseline, preparedState)
  const nonDateChanges = structuralChanges(baseline, preparedState)
  const metrics = proposalMetrics(baseline, preparedState, event, issues, movements, dateChanges, goalImpacts)
  const signature = stableSignature({
    direct: true,
    moves: movements.map(item => [item.assignmentId, item.toDate]),
    dates: dateChanges.map(item => [item.date, item.afterMinutes]),
    structural: nonDateChanges.map(item => [item.entityType, item.entityId, item.changeType, item.fields]),
    issues: issues.map(item => [item.type, item.date, item.assignmentIds]),
    exceptions: effectiveAcceptedExceptions.map(item => [item.date, item.rawKey ?? item.key, item.overrideLimit, item.affectedAssignmentIds]),
  })
  return {
    id: uid('proposal'), eventId: event.id, title,
    description: issues.length
      ? tr('pl.198', { length: issues.length })
      : tr('pl.199'),
    action: event.action, preference: 'preserve', generatedAt: new Date().toISOString(),
    stateBefore: portableState(baseline), stateAfter: portableState(preparedState),
    issues, movements, dateChanges, goalImpacts, structuralChanges: nonDateChanges,
    exceptions: effectiveAcceptedExceptions, excludedDates: [], metrics, issueDelta, distinctSignature: signature,
    infeasible: issues.length > 0,
    infeasibleReason: issues.length ? tr('pl.200', { length: issues.length }) : undefined,
  }
}

export interface GenerateProposalOptions {
  baseline?: AppState
  preferences?: SchedulingPreference[]
  signal?: AbortSignal
  todayExtraMinutes?: number
  allowProtectedDates?: string[]
  /** 用户逐项接受的一次性例外；只作用于本轮重新计算。 */
  acceptedExceptions?: ConstraintException[]
  /** 逐项决策重算时不再自动打包所有未接受例外。 */
  disableAutomaticExceptions?: boolean
  /** 生成更多方案时逐步扩大候选半径；0 为默认，1/2 为更宽但仍受同一硬约束。 */
  expansionLevel?: number
}

/**
 * 事件中的日期是“约束/目标发生在哪一天”，不等于调度只能从那一天开始。
 * 目标提前到 8 月 6 日时，需要利用今天起的全部未来容量，而不是到 8 月 6 日才开始排。
 */
function proposalPlanningStart(state: AppState, event: PlanChangeEvent): string {
  // 事件日期只是目标、行程或原安排的位置。候选窗口仍从今天的未来开始：
  // 这样 8/10–8/15 的旅行既可把任务提前到旅行前，也可顺延到旅行后；
  // “偏好某日”的新任务仍由手动意图评分优先保留原日，而不是禁止更早的合法替代日。
  const today = todayISO()
  const requested = typeof event.metadata?.fromDate === 'string' ? event.metadata.fromDate : today
  if (before(requested, state.settings.startDate)) return state.settings.startDate
  if (after(requested, state.settings.endDate)) return state.settings.endDate
  return requested
}

/**
 * v0.8 统一方案入口。事件说明“为什么变”，action 说明计算范围，preference 说明取舍。
 * 继续复用 v0.7 经验证的同一约束/候选核心，不再创建第二套重排算法。
 */
export function generateSchedulingProposals(input: AppState, event: PlanChangeEvent, options: GenerateProposalOptions = {}): SchedulingProposal[] {
  if (options.signal?.aborted) return []
  const baseline = options.baseline ?? input
  const mode: ReplanMode = event.action === 'optimize' || event.action === 'rebuild' ? 'full' : 'repair'
  const fromDate = proposalPlanningStart(input, event)
  const rawLoadConstraints = event.metadata?.loadConstraints
  const loadConstraints = rawLoadConstraints && typeof rawLoadConstraints === 'object'
    ? rawLoadConstraints as ReplanRequest['loadConstraints']
    : undefined
  const request: ReplanRequest = {
    mode,
    fromDate,
    freezeDays: input.settings.freezeDays,
    includeToday: event.metadata?.includeToday === true,
    todayExtraMinutes: options.todayExtraMinutes ?? Number(event.metadata?.todayExtraMinutes ?? 0),
    allowTodayIncomingAssignments: todayIncomingAssignmentIds(options.acceptedExceptions ?? []),
    // Earlier accepted date-protection exceptions are audit records, not standing permission for future changes.
    allowBufferUseDates: Array.from(new Set(options.allowProtectedDates ?? [])),
    allowProtectedDateAssignments: (options.acceptedExceptions ?? [])
      .filter(item => item.key === 'date-protection' && item.affectedAssignmentIds?.length)
      .map(item => ({ date: item.date, assignmentIds: [...(item.affectedAssignmentIds ?? [])] })),
    limitOverrides: [
      ...grandfatheredLimitOverrides(baseline),
      ...(options.acceptedExceptions ?? []).flatMap(item => item.overrideLimit == null ? [] : [{ date: item.date, key: item.rawKey ?? item.key, limit: item.overrideLimit, affectedAssignmentIds: item.affectedAssignmentIds ? [...item.affectedAssignmentIds] : undefined }]),
    ],
    localRadius: (() => {
      const level = Math.max(0, Math.min(2, Math.round(options.expansionLevel ?? 0)))
      const base = input.settings.localRepairRadius
      if (event.action === 'rebuild') return Math.max(14, base * (level + 1))
      if (level === 1) return Math.max(7, base * 2)
      if (level === 2) return Math.max(14, base * 3)
      return base
    })(),
    affectedAssignmentIds: event.affectedAssignmentIds,
    loadConstraints,
    event,
    explanationLevel: (options.expansionLevel ?? 0) >= 2 ? 'full' : 'summary',
  }
  const metadataPreferences = Array.isArray(event.metadata?.preferredPreferences) ? event.metadata?.preferredPreferences.filter((item): item is SchedulingPreference => ['preserve', 'balanced', 'goal', 'rest'].includes(String(item))) : undefined
  const preferred = options.preferences ?? (metadataPreferences?.length ? metadataPreferences : ['preserve', 'balanced', 'goal', 'rest'])
  const bundle = generateReplanBundle(input, request, preferred)
  const proposals: SchedulingProposal[] = []
  const signatures = new Set<string>()
  const append = (proposal: SchedulingProposal) => {
    if (signatures.has(proposal.distinctSignature)) return
    signatures.add(proposal.distinctSignature)
    proposals.push(proposal)
  }
  for (const preference of preferred) {
    if (options.signal?.aborted) break
    const scenario = bundle.scenarios.find(item => item.strategy === preference)
    if (!scenario) continue
    append(proposalFromScenario(baseline, input, event, bundle.issues, scenario, options.acceptedExceptions ?? []))
  }

  // 只有普通硬限制（容量、每日上限、保护日期）阻止合法安排时，才生成一个
  // 明确标记的一次性例外候选；锁定、过去和 Goal 最晚日期永远不会在这里放宽。
  const seedScenario = preferred.map(preference => bundle.scenarios.find(item => item.strategy === preference))
    .find(item => item && item.constraintConflicts.length > 0)
  if (seedScenario && !options.signal?.aborted && !options.disableAutomaticExceptions) {
    const generatedExceptions = exceptionsFromConflicts(seedScenario.constraintConflicts)
    const exceptions = mergeConstraintExceptions([...(options.acceptedExceptions ?? []), ...generatedExceptions])
    if (exceptions.length) {
      const overrideRequest: ReplanRequest = {
        ...request,
        strategy: seedScenario.strategy,
        allowTodayIncomingAssignments: todayIncomingAssignmentIds(exceptions),
        limitOverrides: [
          ...(request.limitOverrides ?? []),
          ...exceptions.filter(item => item.overrideLimit != null).map(item => ({ date: item.date, key: item.rawKey ?? item.key, limit: item.overrideLimit!, affectedAssignmentIds: item.affectedAssignmentIds ? [...item.affectedAssignmentIds] : undefined })),
        ],
        allowBufferUseDates: Array.from(new Set([
          ...(request.allowBufferUseDates ?? []),
          ...exceptions.filter(item => item.key === 'date-protection' && !item.affectedAssignmentIds?.length).map(item => item.date),
        ])),
        allowProtectedDateAssignments: [
          ...(request.allowProtectedDateAssignments ?? []),
          ...exceptions.filter(item => item.key === 'date-protection' && item.affectedAssignmentIds?.length).map(item => ({ date: item.date, assignmentIds: [...(item.affectedAssignmentIds ?? [])] })),
        ],
      }
      const exceptionBundle = generateReplanBundle(input, overrideRequest, [seedScenario.strategy])
      const exceptionScenario = exceptionBundle.scenarios.find(item => item.strategy === seedScenario.strategy)
      if (exceptionScenario) append(proposalFromScenario(baseline, input, event, exceptionBundle.issues, exceptionScenario, exceptions))
    }
  }
  return proposals
}


export interface ProposalMovementRevision {
  assignmentId: string
  /** undefined 表示保留为未安排；普通已有任务通常传入原日期。 */
  date?: string
  lock?: boolean
}

function movementsFromStates(beforeState: AppState, afterState: AppState, previous: SchedulingProposal): TaskMovement[] {
  const previousMap = new Map(previous.movements.map(item => [item.assignmentId, item]))
  const ids = new Set([...beforeState.assignments.map(item => item.id), ...afterState.assignments.map(item => item.id)])
  return [...ids].flatMap(assignmentId => {
    const beforeTask = beforeState.assignments.find(item => item.id === assignmentId)
    const afterTask = afterState.assignments.find(item => item.id === assignmentId)
    if (!afterTask || beforeTask?.scheduledDate === afterTask.scheduledDate) return []
    const prior = previousMap.get(assignmentId)
    const goals = goalNamesForAssignment(afterState, afterTask)
    const customChanged = !prior || prior.toDate !== afterTask.scheduledDate
    return [{
      assignmentId,
      fromDate: beforeTask?.scheduledDate,
      toDate: afterTask.scheduledDate,
      reason: customChanged ? tr('pl.201') : prior.reason,
      beforeLoad: beforeTask?.scheduledDate ? planningDayLoad(beforeState, beforeTask.scheduledDate) : 0,
      afterLoad: afterTask.scheduledDate ? planningDayLoad(afterState, afterTask.scheduledDate) : 0,
      goalImpact: goals.length ? tr('pl.088', { v: goals.join('、') }) : tr('pl.089'),
      manualIntentImpact: beforeTask?.locked ? 'locked-blocked'
        : beforeTask?.intentStrength === 'manual' && beforeTask.scheduledDate !== afterTask.scheduledDate ? 'moved-manual'
          : beforeTask?.intentStrength === 'manual' ? 'preserved' : 'none',
      rejectedAlternatives: customChanged ? [] : prior.rejectedAlternatives,
    } satisfies TaskMovement]
  })
}

function dateChangesFromStates(beforeState: AppState, afterState: AppState, movements: TaskMovement[]): DateLoadChange[] {
  const dates = new Set(movements.flatMap(item => [item.fromDate, item.toDate].filter((date): date is string => Boolean(date))))
  return [...dates].sort().map(date => ({
    date,
    beforeMinutes: planningDayLoad(beforeState, date),
    afterMinutes: planningDayLoad(afterState, date),
    beforeCapacity: getCapacity(beforeState, date),
    afterCapacity: getCapacity(afterState, date),
    beforeTaskIds: beforeState.assignments.filter(item => item.scheduledDate === date).map(item => item.id),
    afterTaskIds: afterState.assignments.filter(item => item.scheduledDate === date).map(item => item.id),
  })).filter(item => item.beforeMinutes !== item.afterMinutes || stableSignature(item.beforeTaskIds) !== stableSignature(item.afterTaskIds))
}

/**
 * 在方案预览内逐项“保留原日 / 自定义改期 / 锁定结果”后重建完整方案。
 * 这不是绕过调度器的直接移动：每次修改都会重新计算日期负载、目标影响、
 * 新硬冲突、稳定性和最终可应用状态。
 */
export function reviseSchedulingProposal(
  baseline: AppState,
  event: PlanChangeEvent,
  proposal: SchedulingProposal,
  revision: ProposalMovementRevision,
): SchedulingProposal {
  const afterState = hydratePortableState(proposal.stateAfter)
  const assignment = afterState.assignments.find(item => item.id === revision.assignmentId)
  const baselineAssignment = baseline.assignments.find(item => item.id === revision.assignmentId)
  if (!assignment || assignment.status === 'done' || baselineAssignment?.locked || afterState.timer.assignmentId === assignment.id) {
    return { ...proposal, infeasible: true, infeasibleReason: tr('pl.202') }
  }

  const previousDate = assignment.scheduledDate
  let placementProblems: PlacementCheckItem[] = []
  if (revision.date) {
    const validationState = cloneActiveState(afterState)
    const validationAssignment = validationState.assignments.find(item => item.id === assignment.id)!
    const validationGroup = validationState.taskGroups.find(item => item.id === validationAssignment.groupId)
    // “保留原日期”是保留既有占用，不应被当成向受保护日期新塞入任务。
    if (baselineAssignment?.scheduledDate === revision.date) validationAssignment.scheduledDate = revision.date
    if (!validationGroup) {
      placementProblems = [{ key: 'missing-group', label: tr('pl.077'), current: 1, limit: 0, hard: true }]
    } else {
      const todayStats = statsMap(validationState, new Set([assignment.id])).get(todayISO()) ?? blankStats()
      const automaticTodayRemaining = Math.max(0, getCapacity(validationState, todayISO()) - todayStats.actualMinutes - todayStats.inferredMinutes)
      const explicitOverrides = proposal.exceptions.flatMap(item => item.overrideLimit == null ? [] : [{
        date: item.date,
        key: item.rawKey ?? (item.key === 'group-daily-max' ? `group:${assignment.groupId}` : item.key === 'activity-daily-max' ? `activity:${taskActivity(validationGroup)}` : item.key === 'long-task-max' ? 'long' : item.key === 'high-intensity-max' ? 'high-intensity' : item.key),
        limit: item.overrideLimit,
        affectedAssignmentIds: item.affectedAssignmentIds ? [...item.affectedAssignmentIds] : undefined,
      }])
      const request: ReplanRequest = {
        mode: 'repair',
        fromDate: todayISO(),
        todayExtraMinutes: automaticTodayRemaining,
        allowTodayIncomingAssignments: todayIncomingAssignmentIds(proposal.exceptions),
        allowBufferUseDates: proposal.exceptions.filter(item => (item.key === 'date-protection' || item.rawKey === 'date-protection' || item.rawKey === 'protected-buffer') && !item.affectedAssignmentIds?.length).map(item => item.date),
        allowProtectedDateAssignments: proposal.exceptions.filter(item => (item.key === 'date-protection' || item.rawKey === 'date-protection' || item.rawKey === 'protected-buffer') && item.affectedAssignmentIds?.length).map(item => ({ date: item.date, assignmentIds: [...(item.affectedAssignmentIds ?? [])] })),
        limitOverrides: [...grandfatheredLimitOverrides(baseline), ...explicitOverrides],
      }
      placementProblems = validatePlacement(
        validationState,
        statsMap(validationState, new Set([assignment.id])),
        validationAssignment,
        validationGroup,
        revision.date,
        request,
        baselineAssignment?.scheduledDate,
      ).filter(item => item.hard)
    }
  }

  assignment.previousDate = previousDate
  assignment.scheduledDate = revision.date
  assignment.locked = Boolean(revision.lock)
  assignment.intentStrength = revision.lock ? 'locked' : 'manual'
  assignment.scheduleSource = 'manual'
  assignment.lastManualMoveAt = new Date().toISOString()
  assignment.updatedAt = assignment.lastManualMoveAt

  const movements = movementsFromStates(baseline, afterState, proposal)
  const dateChanges = dateChangesFromStates(baseline, afterState, movements)
  const goalImpacts = proposalGoalImpacts(baseline, afterState)
  const structural = structuralChanges(baseline, afterState)
  const issues = proposal.issues.filter(item => ![tr('pl.152'), tr('pl.153'), tr('pl.203'), tr('pl.084')].includes(item.title))

  if (placementProblems.length) issues.push({
    id: uid('issue'), type: 'capacity', title: tr('pl.203'),
    detail: placementProblems.map(item => `${item.label}（${Math.round(item.current)}/${Math.round(item.limit)}）`).join('；'),
    date: revision.date, assignmentIds: [assignment.id], consequence: tr('pl.204'),
    resolution: tr('pl.205'),
  })

  const analysisState = cloneActiveState(afterState)
  analysisState.acceptedConstraintExceptions = [
    ...grandfatheredAcceptedExceptions(baseline),
    ...proposal.exceptions.map(item => ({
      ...item, id: uid('preview-exception'), eventId: event.id, accepted: true as const, createdAt: new Date().toISOString(),
    })),
  ]
  const analysisFrom = proposalPlanningStart(afterState, event)
  const newDangers = worsenedHardConstraintFacts(baseline, analysisState, analysisFrom)
  for (const danger of newDangers) issues.push(issueFromHardConstraintFact(danger, tr('pl.203')))

  const leaveUnscheduled = new Set(Array.isArray(event.metadata?.leaveUnscheduledIds) ? event.metadata?.leaveUnscheduledIds.filter((item): item is string => typeof item === 'string') : [])
  const unresolved = afterState.assignments.filter(item => event.affectedAssignmentIds.includes(item.id) && !item.scheduledDate && !leaveUnscheduled.has(item.id))
  if (unresolved.length) issues.push({
    id: uid('issue'), type: 'unscheduled', title: tr('pl.084'), detail: tr('pl.206', { length: unresolved.length }),
    assignmentIds: unresolved.map(item => item.id), consequence: tr('pl.207'), resolution: tr('pl.208'),
  })
  const metrics = proposalMetrics(baseline, afterState, event, issues, movements, dateChanges, goalImpacts)
  const distinctSignature = stableSignature({
    moves: movements.map(item => [item.assignmentId, item.toDate]),
    dates: dateChanges.map(item => [item.date, item.afterMinutes]),
    goals: goalImpacts.map(item => [item.goalId, item.afterExpectedCompletion, item.latestRiskAfter]),
    structural: structural.map(item => [item.entityType, item.entityId, item.changeType, item.fields]),
    exceptions: proposal.exceptions.map(item => [item.date, item.rawKey, item.overrideLimit]),
  })
  const reasons = [placementProblems.length ? tr('pl.209') : '', newDangers.length ? tr('pl.210', { length: newDangers.length }) : '', unresolved.length ? tr('pl.211', { length: unresolved.length }) : ''].filter(Boolean)
  return {
    ...proposal,
    id: `${proposal.id}-custom-${stableSignature([revision.assignmentId, revision.date, revision.lock, distinctSignature])}`,
    title: proposal.title.includes(tr('pl.212')) ? proposal.title : tr('pl.213', { title: proposal.title }),
    description: tr('pl.214', { description: proposal.description }),
    generatedAt: new Date().toISOString(),
    stateAfter: portableState(afterState),
    issues,
    movements,
    dateChanges,
    goalImpacts,
    structuralChanges: structural,
    metrics,
    distinctSignature,
    infeasible: reasons.length > 0,
    infeasibleReason: reasons.join(' '),
  }
}

export function allDurationSuggestions(state: AppState): import('../types').DurationSuggestion[] {
  if (!state.settings.duration.enabled) return []
  return state.taskGroups.flatMap(group => {
    const completed = state.assignments
      .filter(item => item.groupId === group.id && item.status === 'done' && item.actualMinutes > 0)
      .sort((a, b) => (b.completedAt ?? b.updatedAt ?? '').localeCompare(a.completedAt ?? a.updatedAt ?? ''))
      .slice(0, state.settings.duration.windowSize)
    if (completed.length < state.settings.duration.minimumSamples) return []
    const sorted = completed.map(item => ({ item, value: item.actualMinutes })).sort((a, b) => a.value - b.value)
    let filtered = sorted
    if (sorted.length >= 4) {
      const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)].value
      const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)].value
      const iqr = q3 - q1
      filtered = sorted.filter(sample => sample.value >= q1 - 1.5 * iqr && sample.value <= q3 + 1.5 * iqr)
    }
    if (filtered.length < state.settings.duration.minimumSamples) return []
    const average = filtered.reduce((sum, sample) => sum + sample.value, 0) / filtered.length
    const deviationRatio = group.unitMinutes > 0 ? (average - group.unitMinutes) / group.unitMinutes : 0
    if (Math.abs(deviationRatio) < state.settings.duration.deviationThreshold) return []
    return [{
      groupId: group.id,
      currentEstimate: group.unitMinutes,
      suggestedEstimate: Math.max(5, Math.round(average / 5) * 5),
      recentAverage: Math.round(average * 10) / 10,
      sampleCount: filtered.length,
      deviationRatio,
      eligibleAssignmentIds: state.assignments.filter(item => item.groupId === group.id && item.status === 'todo' && !item.durationCustomized && !item.manuallyEstimated).map(item => item.id),
      samples: filtered.map(({ item }) => ({ assignmentId: item.id, actualMinutes: item.actualMinutes, estimatedMinutes: item.estimatedMinutes, completionDate: item.completedAt?.slice(0, 10) })),
    }]
  })
}
