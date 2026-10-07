import { displayPlanName, getActiveLanguage, tr } from './i18n'
import type { AppState, Assignment, TaskGroup } from '../types'
import { dateRange, dayTypeLabel, fmtDate, fmtWeekday, getCapacity, getDayConfig, minutesText, shiftDate, todayISO } from './date'
import { aggregateDaily } from './stats'
import { allGoalProgress } from './goals'
import { allDurationSuggestions } from './planner'
import { isInferredTimeEntry, timeEntryDate } from './execution'

export interface ExportRange {
  start: string
  end: string
}

export type TaskTableImageColumn = 'date' | 'task' | 'subject' | 'group' | 'estimated' | 'actual' | 'progress' | 'status'

export const taskTableImageColumnOptions: Array<{ key: TaskTableImageColumn; label: string }> = [
  { key: 'date', get label() { return tr('ex.001') } },
  { key: 'task', get label() { return tr('ex.002') } },
  { key: 'subject', get label() { return tr('ex.003') } },
  { key: 'group', get label() { return tr('ex.004') } },
  { key: 'estimated', get label() { return tr('ex.005') } },
  { key: 'actual', get label() { return tr('ex.006') } },
  { key: 'progress', get label() { return tr('ex.007') } },
  { key: 'status', get label() { return tr('ex.008') } },
]

export const defaultTaskTableImageColumns: TaskTableImageColumn[] = ['date', 'task', 'subject', 'estimated', 'status']

export interface StatisticsReportSections {
  overview: boolean
  daily: boolean
  completion: boolean
  focus: boolean
  subjects: boolean
  accuracy: boolean
  insights: boolean
  heatmap: boolean
  goals: boolean
  quality: boolean
  details: boolean
  ledger: boolean
}

export const defaultStatisticsReportSections: StatisticsReportSections = {
  overview: true,
  daily: true,
  completion: true,
  focus: true,
  subjects: true,
  accuracy: true,
  insights: true,
  heatmap: true,
  goals: true,
  quality: true,
  details: true,
  ledger: true,
}

const taskStatusLabel: Record<Assignment['status'], string> = {
  get todo() { return tr('ex.009') },
  get partial() { return tr('ex.010') },
  get done() { return tr('ex.011') },
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows: unknown[][]) {
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

function activeGroupMap(state: AppState) {
  return new Map(state.taskGroups.filter(group => !group.hidden).map(group => [group.id, group]))
}

const subjectSvgColors: Record<string, string> = {
  语文: '#8b5cf6', 数学: '#2563eb', 英语: '#f59e0b', 物理: '#0891b2',
  化学: '#16a34a', 生物: '#db2777', 其他: '#64748b'
}

function xml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]!))
}

function shortText(value: unknown, maxLength: number) {
  const text = String(value ?? '')
  return Array.from(text).length > maxLength ? `${Array.from(text).slice(0, maxLength).join('')}…` : text
}

export function monthExportRange(month: string): ExportRange {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  const now = new Date()
  const year = Number(match?.[1] ?? now.getFullYear())
  const monthNumber = Number(match?.[2] ?? now.getMonth() + 1)
  const safeMonth = Math.max(1, Math.min(12, monthNumber))
  const lastDay = new Date(Date.UTC(year, safeMonth, 0)).getUTCDate()
  const prefix = `${String(year).padStart(4, '0')}-${String(safeMonth).padStart(2, '0')}`
  return { start: `${prefix}-01`, end: `${prefix}-${String(lastDay).padStart(2, '0')}` }
}

/**
 * Build the same month view users see in the app as a standalone SVG.
 * It is deliberately dependency-free so PNG export stays local and works
 * offline on both desktop and mobile browsers.
 */
export function buildCalendarSvg(state: AppState, month: string, options: { showAllTasks?: boolean } = {}) {
  const range = monthExportRange(month)
  const groups = activeGroupMap(state)
  const assignments = assignmentsInRange(state, range)
  const byDate = new Map<string, Assignment[]>()
  for (const assignment of assignments) {
    const date = assignment.scheduledDate!
    byDate.set(date, [...(byDate.get(date) ?? []), assignment])
  }
  const year = Number(range.start.slice(0, 4))
  const monthNumber = Number(range.start.slice(5, 7))
  const daysInMonth = Number(range.end.slice(8, 10))
  const leadingBlanks = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay()
  const rowCount = Math.ceil((leadingBlanks + daysInMonth) / 7)
  const width = 1600
  const margin = 32
  const headerHeight = 112
  const weekdayHeight = 42
  const showAllTasks = options.showAllTasks ?? true
  const rowHeights = Array.from({ length: rowCount }, (_, row) => {
    if (!showAllTasks) return 176
    const maxTasks = Math.max(0, ...Array.from({ length: 7 }, (_, column) => {
      const dayNumber = row * 7 + column - leadingBlanks + 1
      if (dayNumber < 1 || dayNumber > daysInMonth) return 0
      const date = `${range.start.slice(0, 8)}${String(dayNumber).padStart(2, '0')}`
      return byDate.get(date)?.length ?? 0
    }))
    return Math.max(176, 88 + maxTasks * 25 + 32)
  })
  const rowOffsets = rowHeights.reduce<number[]>((offsets, height, index) => {
    offsets.push((offsets[index - 1] ?? 0) + height)
    return offsets
  }, [])
  const gridWidth = width - margin * 2
  const cellWidth = gridWidth / 7
  const height = margin + headerHeight + weekdayHeight + (rowOffsets[rowOffsets.length - 1] ?? 0) + margin
  const weekdayLabels = [tr('ex.012'), tr('ex.013'), tr('ex.014'), tr('ex.015'), tr('ex.016'), tr('ex.017'), tr('ex.018')]
  const cells: string[] = []

  for (let index = 0; index < rowCount * 7; index += 1) {
    const dayNumber = index - leadingBlanks + 1
    const row = Math.floor(index / 7)
    const column = index % 7
    const x = margin + column * cellWidth
    const y = margin + headerHeight + weekdayHeight + (rowOffsets[row - 1] ?? 0)
    const cellHeight = rowHeights[row]
    const inMonth = dayNumber >= 1 && dayNumber <= daysInMonth
    const date = inMonth ? `${range.start.slice(0, 8)}${String(dayNumber).padStart(2, '0')}` : ''
    const tasks = date ? byDate.get(date) ?? [] : []
    const config = date && date >= state.settings.startDate && date <= state.settings.endDate ? getDayConfig(state, date) : undefined
    const capacity = config ? getCapacity(state, date) : 0
    const load = tasks.reduce((sum, task) => sum + Math.max(0, task.estimatedMinutes), 0)
    const ratio = capacity > 0 ? load / capacity : 0
    const fill = !inMonth ? '#f8fafc' : config?.type === 'travel' ? '#f7f7f7' : config?.isBufferDay ? '#fffaf0' : '#ffffff'
    const border = ratio > 1 ? '#ef4444' : ratio > .8 ? '#f59e0b' : '#dfe6ef'
    cells.push(`<rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" fill="${fill}" stroke="${border}" stroke-width="${ratio > .8 ? 2 : 1}"/>`)
    if (!inMonth) continue
    cells.push(`<text x="${x + 15}" y="${y + 28}" font-size="20" font-weight="750" fill="#172033">${dayNumber}</text>`)
    const typeLabel = config?.isBufferDay ? tr('ex.019', { v: minutesText(config.availableMinutes ?? capacity) }) : config ? dayTypeLabel[config.type] : tr('ex.020')
    cells.push(`<text x="${x + cellWidth - 15}" y="${y + 26}" text-anchor="end" font-size="11" fill="#718096">${xml(typeLabel)}</text>`)
    if (capacity > 0) {
      const barWidth = Math.max(0, cellWidth - 30)
      const visibleWidth = Math.min(barWidth, barWidth * ratio)
      const barColor = ratio > 1 ? '#ef4444' : ratio > .8 ? '#f59e0b' : '#2563eb'
      cells.push(`<rect x="${x + 15}" y="${y + 42}" width="${barWidth}" height="5" rx="2.5" fill="#edf1f5"/><rect x="${x + 15}" y="${y + 42}" width="${visibleWidth}" height="5" rx="2.5" fill="${barColor}"/>`)
      cells.push(`<text x="${x + 15}" y="${y + 65}" font-size="11" fill="#718096">${tr('ex.021')} ${xml(minutesText(load))} / ${xml(minutesText(capacity))}</text>`)
    } else {
      cells.push(`<text x="${x + 15}" y="${y + 65}" font-size="11" fill="#9aa6b6">${tr('ex.022')}</text>`)
    }
    const visibleTasks = showAllTasks ? tasks : tasks.slice(0, 6)
    visibleTasks.forEach((task, taskIndex) => {
      const group = groups.get(task.groupId)
      const taskY = y + 88 + taskIndex * 25
      const color = subjectSvgColors[group?.subject ?? '其他'] ?? subjectSvgColors.其他
      const opacity = task.status === 'done' ? '.52' : '1'
      cells.push(`<circle cx="${x + 18}" cy="${taskY - 4}" r="4" fill="${color}" opacity="${opacity}"/><text x="${x + 29}" y="${taskY}" font-size="12" fill="#26344b" opacity="${opacity}">${xml(shortText(task.title, 25))}</text><text x="${x + cellWidth - 15}" y="${taskY}" text-anchor="end" font-size="10" fill="#8491a4" opacity="${opacity}">${task.estimatedMinutes}${tr('ex.023')}</text>`)
    })
    if (!showAllTasks && tasks.length > visibleTasks.length) cells.push(`<text x="${x + 15}" y="${y + cellHeight - 14}" font-size="10" fill="#2563eb">+${tasks.length - visibleTasks.length} ${tr('ex.024')}</text>`)
  }

  const weekdays = weekdayLabels.map((label, index) => {
    const x = margin + index * cellWidth + cellWidth / 2
    return `<text x="${x}" y="${margin + headerHeight + 27}" text-anchor="middle" font-size="13" font-weight="700" fill="#68758a">${label}</text>`
  }).join('')
  const legend = Object.entries(subjectSvgColors).map(([subject, color], index) => {
    const x = margin + index * 105
    return `<circle cx="${x}" cy="${margin + 91}" r="5" fill="${color}"/><text x="${x + 10}" y="${margin + 95}" font-size="11" fill="#68758a">${xml(subject)}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(tr('ex.025', { year, month: monthNumber }))}"><rect width="100%" height="100%" fill="#ffffff"/><text x="${margin}" y="${margin + 34}" font-size="30" font-weight="800" fill="#172033">${xml(tr('ex.025', { year, month: monthNumber }))}</text><text x="${margin}" y="${margin + 62}" font-size="13" fill="#68758a">${xml(displayPlanName(state.settings.planName))} ${tr('ex.027')}</text>${legend}<rect x="${margin}" y="${margin + headerHeight}" width="${gridWidth}" height="${weekdayHeight}" fill="#f8fafc" stroke="#dfe6ef"/>${weekdays}${cells}</svg>`
}

/** Build a compact, shareable task-list image for an arbitrary date range. */
export function buildTaskTableSvg(state: AppState, range: ExportRange, columns: TaskTableImageColumn[] = defaultTaskTableImageColumns) {
  const allowed = new Set(taskTableImageColumnOptions.map(option => option.key))
  const selectedColumns = Array.from(new Set(columns.filter(column => allowed.has(column))))
  const safeColumns = selectedColumns.length ? selectedColumns : [...defaultTaskTableImageColumns]
  const assignments = assignmentsInRange(state, range)
  const groups = activeGroupMap(state)
  const width = 1440
  const margin = 40
  const contentWidth = width - margin * 2
  const titleHeight = 126
  const headerHeight = 48
  const rowHeight = 40
  const emptyHeight = assignments.length ? 0 : 116
  const footerHeight = 54
  const tableHeight = headerHeight + assignments.length * rowHeight + emptyHeight
  const height = margin + titleHeight + tableHeight + footerHeight + margin
  const baseWidths: Record<TaskTableImageColumn, number> = {
    date: 150,
    task: 430,
    subject: 130,
    group: 250,
    estimated: 130,
    actual: 130,
    progress: 110,
    status: 120,
  }
  const baseTotal = safeColumns.reduce((sum, column) => sum + baseWidths[column], 0)
  const columnWidths = safeColumns.map(column => contentWidth * baseWidths[column] / baseTotal)
  const completed = assignments.filter(item => item.status === 'done').length
  const partial = assignments.filter(item => item.status === 'partial').length
  const tableTop = margin + titleHeight
  const rowValue = (assignment: Assignment, column: TaskTableImageColumn, availableWidth: number) => {
    const group = groups.get(assignment.groupId)
    const maxCharacters = Math.max(4, Math.floor((availableWidth - 24) / 15))
    if (column === 'date') return assignment.scheduledDate ?? ''
    if (column === 'task') return shortText(assignment.title, maxCharacters)
    if (column === 'subject') return group?.subject ?? '其他'
    if (column === 'group') return shortText(group?.title ?? '', maxCharacters)
    if (column === 'estimated') return tr('ex.028', { estimatedMinutes: assignment.estimatedMinutes })
    if (column === 'actual') return tr('ex.029', { v: realMinutesInRange(assignment, range) })
    if (column === 'progress') return `${Math.round(assignment.progress)}%`
    return taskStatusLabel[assignment.status]
  }
  const headerCells: string[] = []
  const bodyCells: string[] = []
  let offset = margin
  safeColumns.forEach((column, index) => {
    const columnWidth = columnWidths[index]
    const label = taskTableImageColumnOptions.find(option => option.key === column)?.label ?? column
    headerCells.push(`<text x="${offset + 14}" y="${tableTop + 30}" font-size="13" font-weight="750" fill="#526176">${xml(label)}</text>`)
    if (index > 0) headerCells.push(`<line x1="${offset}" y1="${tableTop}" x2="${offset}" y2="${tableTop + tableHeight}" stroke="#e6ebf2"/>`)
    offset += columnWidth
  })
  assignments.forEach((assignment, rowIndex) => {
    const y = tableTop + headerHeight + rowIndex * rowHeight
    const rowFill = rowIndex % 2 ? '#fbfcfe' : '#ffffff'
    bodyCells.push(`<rect x="${margin}" y="${y}" width="${contentWidth}" height="${rowHeight}" fill="${rowFill}"/><line x1="${margin}" y1="${y + rowHeight}" x2="${margin + contentWidth}" y2="${y + rowHeight}" stroke="#e6ebf2"/>`)
    let cellX = margin
    safeColumns.forEach((column, columnIndex) => {
      const columnWidth = columnWidths[columnIndex]
      const color = column === 'status'
        ? assignment.status === 'done' ? '#16815c' : assignment.status === 'partial' ? '#a96709' : '#64748b'
        : '#26344b'
      const weight = column === 'task' || column === 'status' ? 650 : 450
      bodyCells.push(`<text x="${cellX + 14}" y="${y + 26}" font-size="13" font-weight="${weight}" fill="${color}">${xml(rowValue(assignment, column, columnWidth))}</text>`)
      cellX += columnWidth
    })
  })
  const emptyState = assignments.length ? '' : `<text x="${width / 2}" y="${tableTop + headerHeight + 66}" text-anchor="middle" font-size="16" fill="#7a879a">${tr('ex.030')}</text>`
  const footerY = tableTop + tableHeight + 34
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(range.start)} ${tr('ex.031')} ${xml(range.end)} ${tr('ex.032')}"><rect width="100%" height="100%" fill="#f5f7fb"/><rect x="${margin}" y="${margin}" width="${contentWidth}" height="${height - margin * 2}" rx="22" fill="#ffffff" stroke="#dfe6ef"/><text x="${margin + 24}" y="${margin + 40}" font-size="28" font-weight="800" fill="#172033">${tr('ex.032')}</text><text x="${margin + 24}" y="${margin + 70}" font-size="13" fill="#68758a">${xml(displayPlanName(state.settings.planName))} · ${xml(range.start)} ${tr('ex.031')} ${xml(range.end)}</text><text x="${margin + contentWidth - 24}" y="${margin + 40}" text-anchor="end" font-size="15" font-weight="750" fill="#2563eb">${tr('ex.033')} ${assignments.length} ${tr('ex.034')}</text><text x="${margin + contentWidth - 24}" y="${margin + 69}" text-anchor="end" font-size="12" fill="#68758a">${tr('ex.011')} ${completed} ${tr('ex.035')} ${partial} ${tr('ex.036')} ${Math.max(0, assignments.length - completed - partial)}</text><rect x="${margin}" y="${tableTop}" width="${contentWidth}" height="${headerHeight}" fill="#f1f5fa"/>${headerCells.join('')}${bodyCells.join('')}${emptyState}<text x="${margin + 24}" y="${footerY}" font-size="11" fill="#8a97aa">${tr('ex.037')} ${xml(new Date().toLocaleString('zh-CN'))} ${tr('ex.038')}</text></svg>`
}

function downloadBlobFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadSvgAsPng(filename: string, svg: string) {
  return new Promise<boolean>((resolve, reject) => {
    const match = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg)
    const width = Number(match?.[1] ?? 1600)
    const height = Number(match?.[2] ?? 1200)
    const maximumCanvasSide = 16384
    const maximumCanvasPixels = 64_000_000
    const scale = Math.min(2, maximumCanvasSide / width, maximumCanvasSide / height, Math.sqrt(maximumCanvasPixels / (width * height)))
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(width * scale))
        canvas.height = Math.max(1, Math.floor(height * scale))
        const context = canvas.getContext('2d')
        if (!context) throw new Error(tr('ex.039'))
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(blob => {
          URL.revokeObjectURL(url)
          if (!blob) {
            reject(new Error(tr('ex.040')))
            return
          }
          downloadBlobFile(filename, blob)
          resolve(true)
        }, 'image/png')
      } catch (error) {
        URL.revokeObjectURL(url)
        reject(error)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(tr('ex.040')))
    }
    image.src = url
  })
}

function assignmentsInRange(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  return state.assignments
    .filter(item => item.scheduledDate && item.scheduledDate >= range.start && item.scheduledDate <= range.end && groups.has(item.groupId))
    .sort((a, b) => (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '') || a.title.localeCompare(b.title))
}

export function buildCalendarCsv(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  const byDate = new Map<string, Assignment[]>()
  for (const assignment of assignmentsInRange(state, range)) {
    const date = assignment.scheduledDate!
    byDate.set(date, [...(byDate.get(date) ?? []), assignment])
  }
  const rows: unknown[][] = [[
    tr('ex.001'), tr('ex.041'), tr('ex.042'), tr('ex.043'), tr('ex.044'), tr('ex.045'),
    tr('ex.003'), tr('ex.004'), tr('ex.002'), tr('ex.005'), tr('ex.007'), tr('ex.008'), tr('ex.046'), tr('ex.047'),
  ]]
  for (const date of dateRange(range.start, range.end)) {
    const assignments = byDate.get(date) ?? []
    const plannedMinutes = assignments.reduce((sum, item) => sum + item.estimatedMinutes, 0)
    const config = getDayConfig(state, date)
    if (!assignments.length) {
      rows.push([date, fmtWeekday(date), dayTypeLabel[config.type], getCapacity(state, date), 0, 0, '', '', '', '', '', '', '', config.note ?? ''])
      continue
    }
    for (const assignment of assignments) {
      const group = groups.get(assignment.groupId)
      rows.push([
        date,
        fmtWeekday(date),
        dayTypeLabel[config.type],
        getCapacity(state, date),
        plannedMinutes,
        assignments.length,
        group?.subject ?? '其他',
        group?.title ?? '',
        assignment.title,
        assignment.estimatedMinutes,
        `${Math.round(assignment.progress)}%`,
        taskStatusLabel[assignment.status],
        assignment.locked ? tr('ex.048') : tr('ex.049'),
        assignment.notes ?? group?.notes ?? '',
      ])
    }
  }
  return toCsv(rows)
}

function icsEscape(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function icsDate(value: string) {
  return value.replace(/-/g, '')
}

function foldIcsLine(line: string) {
  const parts: string[] = []
  let remaining = line
  while (remaining.length > 74) {
    parts.push(remaining.slice(0, 74))
    remaining = ` ${remaining.slice(74)}`
  }
  parts.push(remaining)
  return parts.join('\r\n')
}

export function buildCalendarIcs(state: AppState, range: ExportRange, generatedAt = new Date()) {
  const groups = activeGroupMap(state)
  const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Study Planner//Calendar Export//ZH-CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(displayPlanName(state.settings.planName))}`,
  ]
  for (const assignment of assignmentsInRange(state, range)) {
    const group = groups.get(assignment.groupId)
    const date = assignment.scheduledDate!
    const description = [
      tr('ex.051', { v: group?.title ?? tr('ex.050') }),
      tr('ex.052', { v: group?.subject ?? '其他' }),
      tr('ex.053', { estimatedMinutes: assignment.estimatedMinutes }),
      tr('ex.054', { v: taskStatusLabel[assignment.status] }),
      assignment.notes || group?.notes ? tr('ex.055', { v: assignment.notes ?? group?.notes ?? '' }) : '',
    ].filter(Boolean).join('\n')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(assignment.id)}@study-planner`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(date)}`,
      `DTEND;VALUE=DATE:${icsDate(shiftDate(date, 1))}`,
      `SUMMARY:${icsEscape(assignment.title)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      `CATEGORIES:${icsEscape(group?.subject ?? '其他')}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`
}

export function buildStatisticsCsv(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  const rows = aggregateDaily(state.assignments, groups, state.settings.countWordsTime, range.start, range.end, state.dailyPlanBaselines)
  return toCsv([
    [tr('ex.001'), tr('ex.041'), tr('ex.056'), tr('ex.057'), tr('ex.058'), tr('ex.059'), tr('ex.060'), tr('ex.061'), tr('ex.062'), tr('ex.063'), tr('ex.064'), tr('ex.065'), tr('ex.066'), tr('ex.067'), tr('ex.068'), tr('ex.069'), tr('ex.070')],
    ...rows.map(row => [
      row.date,
      fmtWeekday(row.date),
      row.planned,
      row.actual,
      row.inferred,
      row.extraActual,
      row.timerActual,
      row.manualActual,
      row.plannedTasks,
      row.doneTasks,
      row.partialTasks,
      `${Math.round(row.taskCompletion * 10) / 10}%`,
      `${Math.round(row.workloadCompletion * 10) / 10}%`,
      row.lateTasks,
      row.estimatedStatusTasks,
      row.focusSessions,
      row.movingAverage,
    ]),
  ])
}

function entryDate(value?: string) {
  const date = value?.slice(0, 10)
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
}

function sourceLabel(source?: string) {
  return source === 'timer' ? tr('ex.071') : source === 'finish' ? tr('ex.072') : source === 'inferred' ? tr('ex.073') : source === 'manual' ? tr('ex.074') : tr('ex.075')
}

export function buildTimeLedgerCsv(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  const rows: unknown[][] = [[tr('ex.076'), tr('ex.002'), tr('ex.004'), tr('ex.003'), tr('ex.077'), tr('ex.078'), tr('ex.079'), tr('ex.080'), tr('ex.081')]]
  for (const assignment of state.assignments) {
    const group = groups.get(assignment.groupId)
    if (!group) continue
    let recorded = 0
    for (const entry of assignment.timeEntries ?? []) {
      const date = timeEntryDate(entry)
      const minutes = Math.max(0, Number(entry.minutes) || 0)
      if (!isInferredTimeEntry(entry)) recorded += minutes
      if (!date || date < range.start || date > range.end || minutes <= 0) continue
      rows.push([date, assignment.title, group.title, group.subject, minutes, sourceLabel(entry.source), entry.originalCreatedAt ?? entry.createdAt, entry.updatedAt ?? '', entry.id])
    }
    const residual = Math.max(0, assignment.actualMinutes - recorded)
    const residualDate = entryDate(assignment.completedAt) ?? assignment.scheduledDate
    if (residual > 0 && residualDate && residualDate >= range.start && residualDate <= range.end) {
      rows.push([residualDate, assignment.title, group.title, group.subject, residual, sourceLabel(), assignment.completedAt ?? '', '', 'legacy-residual'])
    }
  }
  rows.splice(1, rows.length - 1, ...rows.slice(1).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))))
  return toCsv(rows)
}

function html(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
}

interface ExportSubjectSummary {
  subject: string
  planned: number
  actual: number
  total: number
  done: number
  completedEquivalent: number
  accuracy?: number
  sampleSize: number
  groups: Array<{
    id: string
    title: string
    planned: number
    actual: number
    total: number
    done: number
    accuracy?: number
    sampleSize: number
  }>
}

function progressForExport(assignment?: Assignment) {
  if (!assignment) return 0
  if (assignment.status === 'done') return 1
  if (assignment.status === 'partial') return Math.max(0, Math.min(1, assignment.progress / 100))
  return 0
}

function assignmentTimeEvidence(assignment: Assignment) {
  const realEntries = (assignment.timeEntries ?? []).filter(entry => !isInferredTimeEntry(entry) && Math.max(0, Number(entry.minutes) || 0) > 0)
  const inferredEntries = (assignment.timeEntries ?? []).filter(entry => isInferredTimeEntry(entry) && Math.max(0, Number(entry.minutes) || 0) > 0)
  const realMinutes = realEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.minutes) || 0), 0)
  const inferredMinutes = inferredEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.minutes) || 0), 0)
  if (assignment.status === 'done' && realMinutes <= 0 && inferredMinutes <= 0 && assignment.actualMinutes <= 0) return tr('ex.082')
  if (realMinutes <= 0 && inferredMinutes > 0) return tr('ex.083')
  if (realMinutes > 0 && inferredMinutes > 0) return tr('ex.084')
  if (realMinutes > 0 || assignment.actualMinutes > 0) return tr('ex.085')
  return tr('ex.086')
}

function realMinutesInRange(assignment: Assignment, range: ExportRange) {
  let recorded = 0
  let inRange = 0
  for (const entry of assignment.timeEntries ?? []) {
    const minutes = Math.max(0, Number(entry.minutes) || 0)
    if (isInferredTimeEntry(entry)) continue
    recorded += minutes
    const date = timeEntryDate(entry)
    if (date && date >= range.start && date <= range.end) inRange += minutes
  }
  const residual = Math.max(0, assignment.actualMinutes - recorded)
  const residualDate = entryDate(assignment.completedAt) ?? assignment.scheduledDate
  return inRange + (residual > 0 && residualDate && residualDate >= range.start && residualDate <= range.end ? residual : 0)
}

function isCountedForExport(group: TaskGroup | undefined, countWordsTime: boolean) {
  return Boolean(group && !group.hidden && (group.countInStats || countWordsTime))
}

function subjectSummaryForExport(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  const assignmentById = new Map(state.assignments.map(assignment => [assignment.id, assignment]))
  const capturedDates = new Set(state.dailyPlanBaselines.filter(item => item.date >= range.start && item.date <= range.end).map(item => item.date))
  const bySubject = new Map<string, ExportSubjectSummary>()
  const ensure = (subject: string) => {
    const current = bySubject.get(subject)
    if (current) return current
    const created: ExportSubjectSummary = { subject, planned: 0, actual: 0, total: 0, done: 0, completedEquivalent: 0, sampleSize: 0, groups: [] }
    bySubject.set(subject, created)
    return created
  }
  const ensureGroup = (summary: ExportSubjectSummary, group: TaskGroup) => {
    const current = summary.groups.find(item => item.id === group.id)
    if (current) return current
    const created = { id: group.id, title: group.title, planned: 0, actual: 0, total: 0, done: 0, sampleSize: 0 }
    summary.groups.push(created)
    return created
  }

  // 任务数和完成数沿用统计页口径：展示当前科目下的全部任务，
  // 但计划分钟和实际分钟仍只统计被纳入统计的任务组。
  for (const assignment of state.assignments) {
    const group = groups.get(assignment.groupId)
    if (!group) continue
    const summary = ensure(group.subject)
    const groupSummary = ensureGroup(summary, group)
    summary.total += 1
    summary.done += assignment.status === 'done' ? 1 : 0
    summary.completedEquivalent += progressForExport(assignment)
    groupSummary.total += 1
    groupSummary.done += assignment.status === 'done' ? 1 : 0
  }

  const plannedItems: Array<{ assignment?: Assignment; groupId: string; date: string; minutes: number }> = []
  for (const baseline of state.dailyPlanBaselines) {
    if (!capturedDates.has(baseline.date)) continue
    for (const item of baseline.assignments) plannedItems.push({ assignment: assignmentById.get(item.assignmentId), groupId: item.groupId, date: baseline.date, minutes: item.estimatedMinutes })
  }
  for (const assignment of state.assignments) {
    if (!assignment.scheduledDate || assignment.scheduledDate < range.start || assignment.scheduledDate > range.end || capturedDates.has(assignment.scheduledDate)) continue
    plannedItems.push({ assignment, groupId: assignment.groupId, date: assignment.scheduledDate, minutes: assignment.estimatedMinutes })
  }
  for (const item of plannedItems) {
    const group = groups.get(item.groupId)
    if (!isCountedForExport(group, state.settings.countWordsTime)) continue
    const summary = ensure(group!.subject)
    const groupSummary = ensureGroup(summary, group!)
    summary.planned += Math.max(0, item.minutes)
    groupSummary.planned += Math.max(0, item.minutes)
  }
  for (const assignment of state.assignments) {
    const group = groups.get(assignment.groupId)
    if (!isCountedForExport(group, state.settings.countWordsTime)) continue
    let recorded = 0
    for (const entry of assignment.timeEntries ?? []) {
      const date = timeEntryDate(entry)
      const minutes = Math.max(0, Number(entry.minutes) || 0)
      if (isInferredTimeEntry(entry)) continue
      recorded += minutes
      if (date && date >= range.start && date <= range.end) {
        ensure(group!.subject).actual += minutes
        ensureGroup(ensure(group!.subject), group!).actual += minutes
      }
    }
    const residual = Math.max(0, assignment.actualMinutes - recorded)
    const residualDate = entryDate(assignment.completedAt) ?? assignment.scheduledDate
    if (residual > 0 && residualDate && residualDate >= range.start && residualDate <= range.end) {
      ensure(group!.subject).actual += residual
      ensureGroup(ensure(group!.subject), group!).actual += residual
    }
  }

  for (const summary of bySubject.values()) {
    const subjectItems = state.assignments.filter(assignment => groups.get(assignment.groupId)?.subject === summary.subject)
    const completed = subjectItems.filter(assignment => {
      const group = groups.get(assignment.groupId)
      return Boolean(group && isCountedForExport(group, state.settings.countWordsTime) && assignment.status === 'done' && assignment.actualMinutes > 0)
    })
    const estimated = completed.reduce((sum, assignment) => sum + Math.max(0, assignment.estimatedMinutes), 0)
    const actual = completed.reduce((sum, assignment) => sum + Math.max(0, assignment.actualMinutes), 0)
    summary.sampleSize = completed.length
    summary.accuracy = completed.length >= 3 && estimated > 0 ? (actual - estimated) / estimated * 100 : undefined
    for (const groupSummary of summary.groups) {
      const groupItems = subjectItems.filter(assignment => assignment.groupId === groupSummary.id)
      const groupCompleted = groupItems.filter(assignment => assignment.status === 'done' && assignment.actualMinutes > 0)
      const groupEstimated = groupCompleted.reduce((sum, assignment) => sum + Math.max(0, assignment.estimatedMinutes), 0)
      const groupActual = groupCompleted.reduce((sum, assignment) => sum + Math.max(0, assignment.actualMinutes), 0)
      groupSummary.sampleSize = groupCompleted.length
      groupSummary.accuracy = groupCompleted.length >= 3 && groupEstimated > 0 ? (groupActual - groupEstimated) / groupEstimated * 100 : undefined
    }
    summary.groups.sort((a, b) => b.actual - a.actual || b.planned - a.planned || a.title.localeCompare(b.title))
  }
  return [...bySubject.values()].filter(item => item.total > 0 || item.planned > 0 || item.actual > 0).sort((a, b) => b.actual - a.actual || b.planned - a.planned || a.subject.localeCompare(b.subject))
}

function dailyChartSvg(rows: ReturnType<typeof aggregateDaily>) {
  const width = 1000
  const height = 310
  const left = 58
  const right = 20
  const top = 28
  const bottom = 54
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const max = Math.max(60, ...rows.flatMap(row => [row.planned, row.actual, row.movingAverage]))
  const slot = chartWidth / Math.max(rows.length, 1)
  const barWidth = Math.max(2, Math.min(18, slot * .58))
  const y = (value: number) => top + chartHeight - (value / max) * chartHeight
  const bars = rows.map((row, index) => {
    const x = left + index * slot + (slot - barWidth) / 2
    const actualY = y(row.actual)
    return `<rect x="${x.toFixed(1)}" y="${actualY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, top + chartHeight - actualY).toFixed(1)}" rx="3" fill="#2563eb"/><line x1="${(x - 2).toFixed(1)}" x2="${(x + barWidth + 2).toFixed(1)}" y1="${y(row.planned).toFixed(1)}" y2="${y(row.planned).toFixed(1)}" stroke="#94a3b8" stroke-width="2"/>`
  }).join('')
  const movingPoints = rows.map((row, index) => `${(left + index * slot + slot / 2).toFixed(1)},${y(row.movingAverage).toFixed(1)}`).join(' ')
  const labels = rows.map((row, index) => {
    const step = Math.max(1, Math.ceil(rows.length / 10))
    if (index % step !== 0 && index !== rows.length - 1) return ''
    return `<text x="${(left + index * slot + slot / 2).toFixed(1)}" y="${height - 24}" text-anchor="middle" font-size="10" fill="#718096">${xml(row.shortLabel)}</text>`
  }).join('')
  const guides = [0, .5, 1].map(ratio => {
    const value = Math.round(max * ratio)
    const yy = y(value)
    return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="#e7edf4"/><text x="${left - 9}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#8a97aa">${value}${tr('ex.023')}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${tr('ex.087')}">${guides}${bars}<polyline points="${movingPoints}" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${labels}<g transform="translate(${left},10)"><rect width="10" height="10" rx="2" fill="#2563eb"/><text x="16" y="9" font-size="10" fill="#68758a">${tr('ex.088')}</text><line x1="66" x2="78" y1="5" y2="5" stroke="#94a3b8" stroke-width="2"/><text x="84" y="9" font-size="10" fill="#68758a">${tr('ex.021')}</text><line x1="137" x2="149" y1="5" y2="5" stroke="#8b5cf6" stroke-width="2.5"/><text x="155" y="9" font-size="10" fill="#68758a">${tr('ex.089')}</text></g></svg>`
}

function subjectChartSvg(rows: ExportSubjectSummary[]) {
  const width = 1000
  const rowHeight = 38
  const height = Math.max(120, rows.length * rowHeight + 42)
  const left = 90
  const right = 90
  const chartWidth = width - left - right
  const max = Math.max(60, ...rows.flatMap(row => [row.planned, row.actual]))
  const bars = rows.map((row, index) => {
    const y = 27 + index * rowHeight
    const color = subjectSvgColors[row.subject] ?? subjectSvgColors.其他
    const plannedWidth = chartWidth * row.planned / max
    const actualWidth = chartWidth * row.actual / max
    return `<text x="${left - 12}" y="${y + 14}" text-anchor="end" font-size="12" fill="#26344b">${xml(row.subject)}</text><rect x="${left}" y="${y}" width="${plannedWidth.toFixed(1)}" height="10" rx="5" fill="#dbe3ee"/><rect x="${left}" y="${y + 14}" width="${actualWidth.toFixed(1)}" height="10" rx="5" fill="${color}"/><text x="${width - right + 10}" y="${y + 23}" font-size="10" fill="#68758a">${xml(minutesText(row.actual))}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${tr('ex.090')}">${bars}<g transform="translate(${left},${height - 16})"><rect width="10" height="10" rx="3" fill="#dbe3ee"/><text x="16" y="9" font-size="10" fill="#68758a">${tr('ex.021')}</text><rect x="62" width="10" height="10" rx="3" fill="#2563eb"/><text x="78" y="9" font-size="10" fill="#68758a">${tr('ex.088')}</text></g></svg>`
}

function buildLegacyStatisticsReportHtml(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  const daily = aggregateDaily(state.assignments, groups, state.settings.countWordsTime, range.start, range.end, state.dailyPlanBaselines)
  const subjects = subjectSummaryForExport(state, range)
  const assignments = assignmentsInRange(state, range)
  const planned = daily.reduce((sum, row) => sum + row.planned, 0)
  const actual = daily.reduce((sum, row) => sum + row.actual, 0)
  const extra = daily.reduce((sum, row) => sum + row.extraActual, 0)
  const focusSessions = daily.reduce((sum, row) => sum + row.focusSessions, 0)
  const activeDays = daily.filter(row => row.actual > 0).length
  const average = activeDays ? Math.round(actual / activeDays) : 0
  const taskCount = daily.reduce((sum, row) => sum + row.plannedTasks, 0)
  const completion = taskCount ? Math.round(daily.reduce((sum, row) => sum + row.completedEquivalent, 0) / taskCount * 100) : 0
  const generatedAt = new Date().toLocaleString('zh-CN')
  const dailyRows = daily.map(row => `<tr><td>${html(row.date)}</td><td>${html(fmtWeekday(row.date))}</td><td>${row.planned}</td><td>${row.actual}</td><td>${row.extraActual}</td><td>${Math.round(row.taskCompletion)}%</td><td>${row.lateTasks}</td><td>${row.focusSessions}</td></tr>`).join('')
  const subjectRows = subjects.map(row => `<tr><td>${html(row.subject)}</td><td>${row.planned}</td><td>${row.actual}</td><td>${row.total}</td><td>${row.done}</td><td>${row.total ? Math.round(row.completedEquivalent / row.total * 100) : 0}%</td></tr>`).join('')
  const taskRows = assignments.map(item => {
    const group = groups.get(item.groupId)
    return `<tr><td>${html(item.scheduledDate)}</td><td>${html(item.title)}</td><td>${html(group?.subject ?? '其他')}</td><td>${item.estimatedMinutes}</td><td>${item.actualMinutes}</td><td>${html(taskStatusLabel[item.status])}</td></tr>`
  }).join('')
  return `<!doctype html><html lang="${getActiveLanguage() === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(displayPlanName(state.settings.planName))} ${tr('ex.094')}</title><style>
  :root{font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#172033;background:#fff}*{box-sizing:border-box}body{margin:0 auto;max-width:1080px;padding:34px}header{border-bottom:2px solid #2563eb;padding-bottom:18px;margin-bottom:24px}h1{font-size:28px;margin:0 0 8px;letter-spacing:-.03em}h2{font-size:18px;margin:28px 0 11px}h3{font-size:14px;margin:0 0 8px}p{color:#667085;margin:4px 0;line-height:1.6}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.summary div{border:1px solid #dfe5ee;border-radius:13px;padding:14px;background:#fbfcfe}.summary span{display:block;color:#667085;font-size:11px}.summary strong{display:block;font-size:21px;margin-top:6px}.chart{border:1px solid #e1e8f1;border-radius:14px;padding:12px 14px;background:#fff}.chart svg{width:100%;height:auto;display:block}.two-column{display:grid;grid-template-columns:1fr 1fr;gap:14px}.table-wrap{overflow:hidden;border:1px solid #e1e8f1;border-radius:12px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border-bottom:1px solid #e6ebf1;padding:8px 7px;text-align:left}th{background:#f5f8fc;color:#526176;font-weight:700}tbody tr:last-child td{border-bottom:0}.privacy{margin-top:24px;padding:12px;border-radius:10px;background:#f4f7fb;font-size:10px}.muted{color:#7a8799;font-size:11px}@media print{body{padding:0;max-width:none}thead{display:table-header-group}.summary div,.chart,.two-column>section{break-inside:avoid}h2{break-after:avoid}}@media(max-width:700px){body{padding:20px}.summary{grid-template-columns:1fr 1fr}.two-column{grid-template-columns:1fr}.table-wrap{overflow:auto}table{min-width:620px}}
  </style></head><body><header><h1>${html(displayPlanName(state.settings.planName))} ${tr('ex.094')}</h1><p>${html(range.start)} ${tr('ex.031')} ${html(range.end)} ${tr('ex.095')} ${html(generatedAt)}</p><p class="muted">${tr('ex.096')}</p></header><section class="summary"><div><span>${tr('ex.097')}</span><strong>${minutesText(actual)}</strong></div><div><span>${tr('ex.098')}</span><strong>${minutesText(planned)}</strong></div><div><span>${tr('ex.099')}</span><strong>${activeDays} ${tr('ex.100')} ${minutesText(average)}</strong></div><div><span>${tr('ex.101')}</span><strong>${completion}% · ${focusSessions} ${tr('ex.102')}</strong></div></section><h2>${tr('ex.103')}</h2><div class="chart">${dailyChartSvg(daily)}</div><section class="two-column"><section><h2>${tr('ex.104')}</h2><div class="chart">${subjects.length ? subjectChartSvg(subjects) : tr('ex.091')}</div></section><section><h2>${tr('ex.105')}</h2><div class="chart"><p>${tr('ex.106')}${minutesText(actual)}${tr('ex.107')} ${minutesText(extra)}。</p><p>${tr('ex.108')}</p><p>${tr('ex.109')}</p></div></section></section><h2>${tr('ex.110')}</h2><div class="table-wrap"><table><thead><tr><th>${tr('ex.001')}</th><th>${tr('ex.041')}</th><th>${tr('ex.098')}</th><th>${tr('ex.088')}</th><th>${tr('ex.020')}</th><th>${tr('ex.111')}</th><th>${tr('ex.112')}</th><th>${tr('ex.069')}</th></tr></thead><tbody>${dailyRows}</tbody></table></div><h2>${tr('ex.113')}</h2><div class="table-wrap"><table><thead><tr><th>${tr('ex.003')}</th><th>${tr('ex.114')}</th><th>${tr('ex.006')}</th><th>${tr('ex.045')}</th><th>${tr('ex.011')}</th><th>${tr('ex.115')}</th></tr></thead><tbody>${subjectRows || tr('ex.092')}</tbody></table></div><h2>${tr('ex.116')}</h2><div class="table-wrap"><table><thead><tr><th>${tr('ex.001')}</th><th>${tr('ex.002')}</th><th>${tr('ex.003')}</th><th>${tr('ex.117')}</th><th>${tr('ex.118')}</th><th>${tr('ex.008')}</th></tr></thead><tbody>${taskRows || tr('ex.093')}</tbody></table></div><p class="privacy">${tr('ex.119')}</p></body></html>`
}

function completionChartSvg(rows: ReturnType<typeof aggregateDaily>) {
  const width = 1000
  const height = 300
  const left = 58
  const right = 20
  const top = 30
  const bottom = 48
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const slot = chartWidth / Math.max(rows.length - 1, 1)
  const x = (index: number) => left + (rows.length <= 1 ? chartWidth / 2 : index * slot)
  const y = (value: number) => top + chartHeight - Math.max(0, Math.min(100, value)) / 100 * chartHeight
  const line = (key: 'taskCompletion' | 'workloadCompletion') => rows.map((row, index) => `${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(' ')
  const guides = [0, 50, 100].map(value => `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="#e7edf4"/><text x="${left - 9}" y="${y(value) + 4}" text-anchor="end" font-size="10" fill="#8a97aa">${value}%</text>`).join('')
  const labels = rows.map((row, index) => {
    const step = Math.max(1, Math.ceil(rows.length / 10))
    if (index % step !== 0 && index !== rows.length - 1) return ''
    return `<text x="${x(index)}" y="${height - 18}" text-anchor="middle" font-size="10" fill="#718096">${xml(row.shortLabel)}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${tr('ex.120')}">${guides}<polyline points="${line('taskCompletion')}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${line('workloadCompletion')}" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${labels}<g transform="translate(${left},10)"><line x1="0" x2="14" y1="5" y2="5" stroke="#2563eb" stroke-width="2.5"/><text x="20" y="9" font-size="10" fill="#68758a">${tr('ex.121')}</text><line x1="105" x2="119" y1="5" y2="5" stroke="#16a34a" stroke-width="2.5"/><text x="125" y="9" font-size="10" fill="#68758a">${tr('ex.066')}</text></g></svg>`
}

function focusChartSvg(rows: ReturnType<typeof aggregateDaily>) {
  const width = 1000
  const height = 300
  const left = 58
  const right = 42
  const top = 30
  const bottom = 48
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const max = Math.max(30, ...rows.flatMap(row => [row.timerActual, row.focusSessions]))
  const slot = chartWidth / Math.max(rows.length, 1)
  const barWidth = Math.max(2, Math.min(18, slot * .55))
  const y = (value: number) => top + chartHeight - value / max * chartHeight
  const bars = rows.map((row, index) => {
    const x = left + index * slot + (slot - barWidth) / 2
    const topY = y(row.timerActual)
    return `<rect x="${x.toFixed(1)}" y="${topY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, top + chartHeight - topY).toFixed(1)}" rx="3" fill="#8b5cf6"/>`
  }).join('')
  const points = rows.map((row, index) => `${(left + index * slot + slot / 2).toFixed(1)},${y(row.focusSessions).toFixed(1)}`).join(' ')
  const labels = rows.map((row, index) => {
    const step = Math.max(1, Math.ceil(rows.length / 10))
    if (index % step !== 0 && index !== rows.length - 1) return ''
    return `<text x="${(left + index * slot + slot / 2).toFixed(1)}" y="${height - 18}" text-anchor="middle" font-size="10" fill="#718096">${xml(row.shortLabel)}</text>`
  }).join('')
  const guides = [0, .5, 1].map(ratio => {
    const value = Math.round(max * ratio)
    const yy = y(value)
    return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="#e7edf4"/><text x="${left - 9}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#8a97aa">${value}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${tr('ex.122')}">${guides}${bars}<polyline points="${points}" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${labels}<g transform="translate(${left},10)"><rect width="10" height="10" rx="2" fill="#8b5cf6"/><text x="16" y="9" font-size="10" fill="#68758a">${tr('ex.123')}</text><line x1="88" x2="102" y1="5" y2="5" stroke="#f59e0b" stroke-width="2.5"/><text x="108" y="9" font-size="10" fill="#68758a">${tr('ex.124')}</text></g></svg>`
}

function heatmapSvg(rows: ReturnType<typeof aggregateDaily>) {
  const cell = 14
  const gap = 3
  const left = 32
  const top = 26
  const offset = rows.length ? (new Date(`${rows[0].date}T00:00:00Z`).getUTCDay() + 6) % 7 : 0
  const weekCount = Math.max(1, Math.ceil((offset + rows.length) / 7))
  const width = left + weekCount * (cell + gap) + 18
  const height = top + 7 * (cell + gap) + 16
  const max = Math.max(1, ...rows.map(row => row.actual))
  const color = (value: number) => value <= 0 ? '#eef2f6' : value / max < .25 ? '#cfe0ff' : value / max < .5 ? '#9fc1ff' : value / max < .75 ? '#5f92f2' : '#2563eb'
  const cells = rows.map((row, index) => {
    const position = offset + index
    const column = Math.floor(position / 7)
    const weekday = position % 7
    const x = left + column * (cell + gap)
    const y = top + weekday * (cell + gap)
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="5" fill="${color(row.actual)}"><title>${xml(row.label)} · ${xml(minutesText(row.actual))}</title></rect>`
  }).join('')
  const weekdays = [tr('ex.125'), tr('ex.126'), tr('ex.127'), tr('ex.128')].map((label, index) => `<text x="${left - 8}" y="${top + [0, 2, 4, 6][index] * (cell + gap) + 10}" text-anchor="end" font-size="9" fill="#718096">${label}</text>`).join('')
  const months = rows.map((row, index) => {
    if (index > 0 && !row.date.endsWith('-01')) return ''
    const position = offset + index
    const column = Math.floor(position / 7)
    return `<text x="${left + column * (cell + gap)}" y="${top - 8}" font-size="9" fill="#718096">${tr('ex.129', { month: Number(row.date.slice(5, 7)) })}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${tr('ex.130')}">${weekdays}${months}${cells}</svg>`
}

interface ExportLedgerRow {
  date: string
  title: string
  group: string
  subject: string
  minutes: number
  source: string
  createdAt: string
}

function ledgerRowsForExport(state: AppState, range: ExportRange): ExportLedgerRow[] {
  const groups = activeGroupMap(state)
  const rows: ExportLedgerRow[] = []
  for (const assignment of state.assignments) {
    const group = groups.get(assignment.groupId)
    if (!group) continue
    let recorded = 0
    for (const entry of assignment.timeEntries ?? []) {
      const date = timeEntryDate(entry)
      const minutes = Math.max(0, Number(entry.minutes) || 0)
      if (!isInferredTimeEntry(entry)) recorded += minutes
      if (!date || date < range.start || date > range.end || minutes <= 0) continue
      rows.push({ date, title: assignment.title, group: group.title, subject: group.subject, minutes, source: sourceLabel(entry.source), createdAt: entry.originalCreatedAt ?? entry.createdAt })
    }
    const residual = Math.max(0, assignment.actualMinutes - recorded)
    const residualDate = entryDate(assignment.completedAt) ?? assignment.scheduledDate
    if (residual > 0 && residualDate && residualDate >= range.start && residualDate <= range.end) {
      rows.push({ date: residualDate, title: assignment.title, group: group.title, subject: group.subject, minutes: residual, source: sourceLabel(), createdAt: assignment.completedAt ?? residualDate })
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title) || a.createdAt.localeCompare(b.createdAt))
}

function accuracyLabel(value?: number) {
  if (value === undefined) return tr('ex.131')
  if (value > 0) return tr('ex.132', { v: Math.round(value) })
  if (value < 0) return tr('ex.133', { v: Math.abs(Math.round(value)) })
  return tr('ex.134')
}

function reportSection(enabled: boolean, title: string, content: string) {
  return enabled ? `<section class="report-section"><h2>${html(title)}</h2>${content}</section>` : ''
}

export function buildStatisticsReportHtml(state: AppState, range: ExportRange, requestedSections: Partial<StatisticsReportSections> = {}) {
  const sections = { ...defaultStatisticsReportSections, ...requestedSections }
  const groups = activeGroupMap(state)
  const daily = aggregateDaily(state.assignments, groups, state.settings.countWordsTime, range.start, range.end, state.dailyPlanBaselines)
  const subjects = subjectSummaryForExport(state, range)
  const assignments = assignmentsInRange(state, range)
  const goalRows = allGoalProgress(state)
  const durationSuggestions = allDurationSuggestions(state).filter(item => groups.has(item.groupId))
  const ledgerRows = ledgerRowsForExport(state, range)
  const planned = daily.reduce((sum, row) => sum + row.planned, 0)
  const actual = daily.reduce((sum, row) => sum + row.actual, 0)
  const extra = daily.reduce((sum, row) => sum + row.extraActual, 0)
  const inferred = daily.reduce((sum, row) => sum + row.inferred, 0)
  const timer = daily.reduce((sum, row) => sum + row.timerActual, 0)
  const manual = daily.reduce((sum, row) => sum + row.manualActual, 0)
  const legacy = daily.reduce((sum, row) => sum + row.legacyActual, 0)
  const taskCount = daily.reduce((sum, row) => sum + row.plannedTasks, 0)
  const completedEquivalent = daily.reduce((sum, row) => sum + row.completedEquivalent, 0)
  const taskCompletion = taskCount ? completedEquivalent / taskCount * 100 : 0
  const workloadCompletion = planned ? daily.reduce((sum, row) => sum + row.planned * row.workloadCompletion / 100, 0) / planned * 100 : 0
  const estimatedStatusTasks = daily.reduce((sum, row) => sum + row.estimatedStatusTasks, 0)
  const noRecordCompleted = assignments.filter(item => assignmentTimeEvidence(item) === tr('ex.082')).length
  const activeDays = daily.filter(row => row.actual > 0).length
  const average = activeDays ? Math.round(actual / activeDays) : 0
  const focusSessions = daily.reduce((sum, row) => sum + row.focusSessions, 0)
  const focusDurations = ledgerRows.filter(row => row.source === tr('ex.071')).map(row => row.minutes)
  const averageFocus = focusDurations.length ? Math.round(focusDurations.reduce((sum, value) => sum + value, 0) / focusDurations.length) : 0
  const longestFocus = focusDurations.length ? Math.max(...focusDurations) : 0
  const today = todayISO()
  const completedCounted = state.assignments.filter(item => {
    const group = groups.get(item.groupId)
    return isCountedForExport(group, state.settings.countWordsTime) && item.status === 'done' && item.completedAt && item.scheduledDate
  })
  const onTime = completedCounted.filter(item => entryDate(item.completedAt)! <= item.scheduledDate!).length
  const onTimeRate = completedCounted.length ? onTime / completedCounted.length * 100 : 0
  const currentLate = state.assignments.filter(item => {
    const group = groups.get(item.groupId)
    return Boolean(group && item.scheduledDate && item.scheduledDate < today && item.status !== 'done')
  }).length
  const changedTasks = state.assignments.filter(item => item.previousDate && groups.has(item.groupId)).length
  const activeTasks = state.assignments.filter(item => groups.has(item.groupId)).length
  const carryovers = state.assignments.filter(item => item.scheduleSource === 'carryover' && groups.has(item.groupId)).length
  const priorityRows = [5, 3, 2, 1, 0].map(priority => {
    const ids = new Set(state.taskGroups.filter(group => group.priority === priority && !group.hidden).map(group => group.id))
    const items = state.assignments.filter(item => ids.has(item.groupId))
    const completed = items.reduce((sum, item) => sum + progressForExport(item), 0)
    return { label: priority === 5 ? tr('ex.135') : priority === 3 ? tr('ex.136') : priority === 2 ? tr('ex.137') : priority === 1 ? tr('ex.138') : tr('ex.139'), total: items.length, completion: items.length ? completed / items.length * 100 : 0 }
  }).filter(row => row.total > 0)
  const dominantSubject = subjects.filter(item => actual > 0 && item.actual > 0).sort((a, b) => b.actual - a.actual)[0]
  const insightItems = [
    planned > 0 ? { tone: actual >= planned ? 'positive' : 'warning', title: actual >= planned ? tr('ex.140') : tr('ex.141'), detail: tr('ex.142', { v: minutesText(actual), v2: minutesText(planned), v3: Math.round(workloadCompletion) }) } : undefined,
    dominantSubject ? { tone: 'neutral', title: tr('ex.143', { subject: dominantSubject.subject }), detail: tr('ex.144', { v: minutesText(dominantSubject.actual), v2: Math.round(dominantSubject.actual / Math.max(actual, 1) * 100) }) } : undefined,
    currentLate > 0 ? { tone: 'warning', title: tr('ex.145', { currentLate }), detail: tr('ex.146') } : undefined,
    durationSuggestions.length ? { tone: 'neutral', title: tr('ex.147', { length: durationSuggestions.length }), detail: tr('ex.148') } : undefined,
  ].filter(Boolean) as Array<{ tone: string; title: string; detail: string }>
  const dailyRows = daily.map(row => `<tr><td>${html(row.date)}</td><td>${html(fmtWeekday(row.date))}</td><td>${row.planned}</td><td>${row.actual}</td><td>${row.inferred}</td><td>${row.extraActual}</td><td>${row.timerActual}</td><td>${row.manualActual}</td><td>${row.plannedTasks}</td><td>${row.doneTasks}</td><td>${row.partialTasks}</td><td>${Math.round(row.taskCompletion)}%</td><td>${Math.round(row.workloadCompletion)}%</td><td>${row.lateTasks}</td><td>${row.estimatedStatusTasks}</td><td>${row.focusSessions}</td></tr>`).join('')
  const subjectRows = subjects.map(row => `<tr><td>${html(row.subject)}</td><td>${row.planned}</td><td>${row.actual}</td><td>${row.total}</td><td>${row.done}</td><td>${Math.round(row.completedEquivalent / Math.max(row.total, 1) * 100)}%</td><td>${html(accuracyLabel(row.accuracy))}</td><td>${row.sampleSize || '—'}</td></tr>`).join('')
  const subjectGroupRows = subjects.flatMap(subject => subject.groups.filter(group => group.total > 0 || group.planned > 0 || group.actual > 0).map(group => `<tr><td>${html(subject.subject)}</td><td>${html(group.title)}</td><td>${group.planned}</td><td>${group.actual}</td><td>${group.done}/${group.total}</td><td>${html(accuracyLabel(group.accuracy))}</td></tr>`)).join('')
  const taskRows = assignments.map(item => {
    const group = groups.get(item.groupId)
    return `<tr><td>${html(item.scheduledDate)}</td><td>${html(item.title)}</td><td>${html(group?.subject ?? '其他')}</td><td>${item.estimatedMinutes}</td><td>${item.actualMinutes}</td><td>${Math.round(item.progress)}%</td><td>${html(taskStatusLabel[item.status])}</td><td>${html(assignmentTimeEvidence(item))}</td></tr>`
  }).join('')
  const tasksByDate = new Map<string, Assignment[]>()
  for (const assignment of assignments) {
    const date = assignment.scheduledDate!
    tasksByDate.set(date, [...(tasksByDate.get(date) ?? []), assignment])
  }
  const taskDates = dateRange(range.start, range.end).filter(date => (tasksByDate.get(date)?.length ?? 0) > 0)
  const dailyTaskCards = taskDates.map(date => {
    const dayAssignments = tasksByDate.get(date) ?? []
    const doneCount = dayAssignments.filter(item => item.status === 'done').length
    const taskItems = dayAssignments.length ? dayAssignments.map(item => {
      const group = groups.get(item.groupId)
      const stateClass = item.status === 'done' ? 'done' : item.status === 'partial' ? 'partial' : 'todo'
      const stateText = item.status === 'done' ? tr('ex.011') : item.status === 'partial' ? tr('ex.149', { v: Math.round(item.progress) }) : tr('ex.009')
      return `<li><span class="day-task-title"><i class="subject-dot" style="background:${subjectSvgColors[group?.subject ?? '其他'] ?? subjectSvgColors.其他}"></i><strong>${html(item.title)}</strong><small>${html(group?.subject ?? '其他')} · ${item.estimatedMinutes} ${tr('ex.077')}</small></span><span class="task-state ${stateClass}">${stateText}</span></li>`
    }).join('') : tr('ex.150')
    return `<article class="day-task-card"><header><div><strong>${html(fmtDate(date))}</strong><span>${html(fmtWeekday(date))}</span></div><em>${doneCount}/${dayAssignments.length} ${tr('ex.011')}</em></header><ul>${taskItems}</ul></article>`
  }).join('')
  const ledgerSummary = [
    [tr('ex.071'), timer],
    [tr('ex.074'), manual],
    [tr('ex.151'), inferred],
    [tr('ex.075'), legacy],
    [tr('ex.152'), extra],
  ].map(([label, value]) => `<div class="report-stat"><span>${label}</span><strong>${minutesText(Number(value))}</strong></div>`).join('')
  const goalTable = goalRows.map(row => {
    const goal = state.goals.find(item => item.id === row.goalId)
    if (!goal) return ''
    return `<tr><td>${html(goal.title)}</td><td>${row.completedCount}/${row.requiredCount}</td><td>${Math.round(row.progress * 100)}%</td><td>${html(row.expectedCompletion ? fmtDate(row.expectedCompletion) : row.completed ? tr('ex.011') : tr('ex.153'))}</td><td>${html(row.latestRisk ? tr('ex.154') : row.desiredRisk ? tr('ex.155') : tr('ex.156'))}</td><td>${minutesText(row.estimatedRemainingMinutes)}</td></tr>`
  }).join('')
  const versionRows = [...state.planVersions].reverse().map(version => `<tr><td>${html(new Date(version.timestamp).toLocaleString('zh-CN'))}</td><td>${html(version.reason)}</td><td>${version.summary.goalCount}</td><td>${version.summary.groupCount}</td><td>${version.summary.assignmentCount}</td><td>${version.summary.completedCount}</td><td>${version.summary.movedTaskCount}</td><td>${minutesText(version.summary.scheduledMinutes)}</td></tr>`).join('')
  const accuracyRows = subjects.filter(item => item.accuracy !== undefined).sort((a, b) => Math.abs(b.accuracy ?? 0) - Math.abs(a.accuracy ?? 0)).map(item => `<tr><td>${html(item.subject)}</td><td>${html(accuracyLabel(item.accuracy))}</td><td>${item.sampleSize}</td><td>${item.actual} ${tr('ex.077')}</td></tr>`).join('')
  const suggestionRows = durationSuggestions.map(suggestion => {
    const group = groups.get(suggestion.groupId)
    return `<tr><td>${html(group?.subject ?? '其他')}</td><td>${html(group?.title ?? suggestion.groupId)}</td><td>${suggestion.currentEstimate} ${tr('ex.077')}</td><td>${suggestion.suggestedEstimate} ${tr('ex.077')}</td><td>${suggestion.recentAverage} ${tr('ex.077')}</td><td>${suggestion.sampleCount}</td></tr>`
  }).join('')
  const insightHtml = insightItems.length ? `<div class="report-insights">${insightItems.map(item => `<article class="${item.tone}"><strong>${html(item.title)}</strong><span>${html(item.detail)}</span></article>`).join('')}</div>` : tr('ex.157')
  const ledgerDetailRows = ledgerRows.map(row => `<tr><td>${html(row.date)}</td><td>${html(row.title)}</td><td>${html(row.group)}</td><td>${html(row.subject)}</td><td>${row.minutes}</td><td>${html(row.source)}</td><td>${html(row.createdAt)}</td></tr>`).join('')
  const generatedAt = new Date().toLocaleString('zh-CN')
  const empty = (columns: number, message: string) => `<tr><td colspan="${columns}">${html(message)}</td></tr>`
  const overviewHtml = `<div class="report-stat-grid"><div class="report-stat"><span>${tr('ex.158')}</span><strong>${minutesText(actual)}</strong></div><div class="report-stat"><span>${tr('ex.098')}</span><strong>${minutesText(planned)}</strong></div><div class="report-stat"><span>${tr('ex.099')}</span><strong>${activeDays} ${tr('ex.100')} ${minutesText(average)}</strong></div><div class="report-stat"><span>${tr('ex.065')}</span><strong>${Math.round(taskCompletion)}%</strong></div><div class="report-stat"><span>${tr('ex.066')}</span><strong>${Math.round(workloadCompletion)}%</strong></div><div class="report-stat"><span>${tr('ex.159')}</span><strong>${minutesText(extra)}</strong></div><div class="report-stat"><span>${tr('ex.151')}</span><strong>${minutesText(inferred)}</strong></div><div class="report-stat"><span>${tr('ex.082')}</span><strong>${noRecordCompleted} ${tr('ex.034')}</strong></div><div class="report-stat"><span>${tr('ex.160')}</span><strong>${focusSessions} ${tr('ex.102')}</strong></div><div class="report-stat"><span>${tr('ex.161')}</span><strong>${minutesText(averageFocus)}</strong></div></div><div class="report-note"><strong>${tr('ex.162')}</strong>${html(range.start)} ${tr('ex.031')} ${html(range.end)}${tr('ex.163')}</div>`
  const dailyHtml = `<div class="chart">${dailyChartSvg(daily)}</div>`
  const completionHtml = `<div class="chart">${completionChartSvg(daily)}</div>`
  const focusHtml = `<div class="chart">${focusChartSvg(daily)}</div><div class="report-stat-grid report-stat-grid-four">${ledgerSummary}<div class="report-stat"><span>${tr('ex.164')}</span><strong>${minutesText(longestFocus)}</strong></div></div>`
  const subjectHtml = `<div class="chart">${subjects.length ? subjectChartSvg(subjects) : tr('ex.091')}</div><div class="table-wrap"><table><thead><tr><th>${tr('ex.003')}</th><th>${tr('ex.114')}</th><th>${tr('ex.006')}</th><th>${tr('ex.045')}</th><th>${tr('ex.011')}</th><th>${tr('ex.115')}</th><th>${tr('ex.167')}</th><th>${tr('ex.168')}</th></tr></thead><tbody>${subjectRows || empty(8, tr('ex.165'))}</tbody></table></div><h3 class="subheading">${tr('ex.169')}</h3><div class="table-wrap"><table><thead><tr><th>${tr('ex.003')}</th><th>${tr('ex.004')}</th><th>${tr('ex.114')}</th><th>${tr('ex.006')}</th><th>${tr('ex.170')}</th><th>${tr('ex.167')}</th></tr></thead><tbody>${subjectGroupRows || empty(6, tr('ex.166'))}</tbody></table></div>`
  const accuracyHtml = `<p class="muted">${tr('ex.173')} ${state.settings.duration.minimumSamples} ${tr('ex.174')}</p><div class="table-wrap"><table><thead><tr><th>${tr('ex.003')}</th><th>${tr('ex.175')}</th><th>${tr('ex.176')}</th><th>${tr('ex.177')}</th></tr></thead><tbody>${accuracyRows || empty(4, tr('ex.171'))}</tbody></table></div><h3 class="subheading">${tr('ex.178')}</h3><div class="table-wrap"><table><thead><tr><th>${tr('ex.003')}</th><th>${tr('ex.004')}</th><th>${tr('ex.179')}</th><th>${tr('ex.180')}</th><th>${tr('ex.181')}</th><th>${tr('ex.176')}</th></tr></thead><tbody>${suggestionRows || empty(6, tr('ex.172'))}</tbody></table></div>`
  const goalsHtml = `<div class="two-column"><div><h3>${tr('ex.184')}</h3><div class="table-wrap"><table><thead><tr><th>${tr('ex.185')}</th><th>${tr('ex.170')}</th><th>${tr('ex.007')}</th><th>${tr('ex.186')}</th><th>${tr('ex.187')}</th><th>${tr('ex.188')}</th></tr></thead><tbody>${goalTable || empty(6, tr('ex.182'))}</tbody></table></div></div><div><h3>${tr('ex.189')}</h3><div class="table-wrap"><table><thead><tr><th>${tr('ex.190')}</th><th>${tr('ex.191')}</th><th>${tr('ex.185')}</th><th>${tr('ex.004')}</th><th>${tr('ex.002')}</th><th>${tr('ex.170')}</th><th>${tr('ex.192')}</th><th>${tr('ex.193')}</th></tr></thead><tbody>${versionRows || empty(8, tr('ex.183'))}</tbody></table></div></div></div>`
  const qualityHtml = `<div class="report-stat-grid report-stat-grid-four"><div class="report-stat"><span>${tr('ex.195')}</span><strong>${Math.round(onTimeRate)}%</strong><small>${onTime}/${completedCounted.length} ${tr('ex.196')}</small></div><div class="report-stat"><span>${tr('ex.197')}</span><strong>${currentLate} ${tr('ex.034')}</strong></div><div class="report-stat"><span>${tr('ex.198')}</span><strong>${carryovers} ${tr('ex.034')}</strong></div><div class="report-stat"><span>${tr('ex.199')}</span><strong>${activeTasks ? Math.round(changedTasks / activeTasks * 100) : 0}%</strong><small>${changedTasks}/${activeTasks} ${tr('ex.200')}</small></div></div><h3 class="subheading">${tr('ex.201')}</h3><div class="table-wrap"><table><thead><tr><th>${tr('ex.202')}</th><th>${tr('ex.045')}</th><th>${tr('ex.203')}</th></tr></thead><tbody>${priorityRows.map(row => `<tr><td>${row.label}</td><td>${row.total}</td><td>${Math.round(row.completion)}%</td></tr>`).join('') || empty(3, tr('ex.194'))}</tbody></table></div><p class="report-note">${tr('ex.204')}</p>`
  const emptyTaskDays = Math.max(0, daily.length - taskDates.length)
  const detailsHtml = `<h3>${tr('ex.208')}</h3><p class="muted">${tr('ex.209')} ${emptyTaskDays} ${tr('ex.210')}</p><div class="day-task-grid">${dailyTaskCards || tr('ex.205')}</div><h3 class="subheading">${tr('ex.211')}</h3><div class="table-wrap"><table class="wide-table"><thead><tr><th>${tr('ex.001')}</th><th>${tr('ex.041')}</th><th>${tr('ex.098')}</th><th>${tr('ex.212')}</th><th>${tr('ex.213')}</th><th>${tr('ex.214')}</th><th>${tr('ex.071')}</th><th>${tr('ex.215')}</th><th>${tr('ex.045')}</th><th>${tr('ex.170')}</th><th>${tr('ex.010')}</th><th>${tr('ex.111')}</th><th>${tr('ex.216')}</th><th>${tr('ex.112')}</th><th>${tr('ex.217')}</th><th>${tr('ex.069')}</th></tr></thead><tbody>${dailyRows || empty(16, tr('ex.206'))}</tbody></table></div><h3 class="subheading">${tr('ex.116')}</h3><div class="table-wrap"><table><thead><tr><th>${tr('ex.001')}</th><th>${tr('ex.002')}</th><th>${tr('ex.003')}</th><th>${tr('ex.117')}</th><th>${tr('ex.118')}</th><th>${tr('ex.007')}</th><th>${tr('ex.008')}</th><th>${tr('ex.218')}</th></tr></thead><tbody>${taskRows || empty(8, tr('ex.207'))}</tbody></table></div>`
  const ledgerHtml = `<p class="muted">${tr('ex.220')} ${ledgerRows.length} ${tr('ex.221')}</p><div class="table-wrap"><table><thead><tr><th>${tr('ex.076')}</th><th>${tr('ex.002')}</th><th>${tr('ex.004')}</th><th>${tr('ex.003')}</th><th>${tr('ex.077')}</th><th>${tr('ex.078')}</th><th>${tr('ex.079')}</th></tr></thead><tbody>${ledgerDetailRows || empty(7, tr('ex.219'))}</tbody></table></div>`
  const selectedCount = Object.values(sections).filter(Boolean).length
  const body = selectedCount === 0 ? tr('ex.222') : [
    reportSection(sections.overview, tr('ex.223'), overviewHtml),
    reportSection(sections.daily, tr('ex.224'), dailyHtml),
    reportSection(sections.completion, tr('ex.225'), completionHtml),
    reportSection(sections.focus, tr('ex.226'), focusHtml),
    reportSection(sections.subjects, tr('ex.227'), subjectHtml),
    reportSection(sections.accuracy, tr('ex.228'), accuracyHtml),
    reportSection(sections.insights, tr('ex.229'), insightHtml),
    reportSection(sections.heatmap, tr('ex.230'), `<div class="chart heatmap-chart">${heatmapSvg(daily)}</div>`),
    reportSection(sections.goals, tr('ex.231'), goalsHtml),
    reportSection(sections.quality, tr('ex.232'), qualityHtml),
    reportSection(sections.details, tr('ex.233'), detailsHtml),
    reportSection(sections.ledger, tr('ex.234'), ledgerHtml),
  ].join('')
  const reportStyles = `
    :root{font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#172033;background:#fff}
    *{box-sizing:border-box}
    body{margin:0 auto;max-width:1120px;padding:34px}
    header{border-bottom:2px solid #2563eb;padding-bottom:18px;margin-bottom:24px}
    h1{font-size:28px;margin:0 0 8px;letter-spacing:-.03em}
    h2{font-size:18px;margin:30px 0 12px}
    h3{font-size:14px;margin:0 0 9px}
    .subheading{margin-top:22px}
    p{color:#667085;margin:4px 0;line-height:1.6}
    .muted{color:#7a8799;font-size:11px}
    .report-section{break-inside:auto}
    .report-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}
    .report-stat-grid-four{grid-template-columns:repeat(5,minmax(0,1fr))}
    .report-stat{border:1px solid #dfe5ee;border-radius:12px;padding:13px;background:#fbfcfe;min-height:76px}
    .report-stat span{display:block;color:#667085;font-size:11px}
    .report-stat strong{display:block;font-size:19px;margin-top:6px}
    .report-stat small{display:block;color:#7a8799;font-size:10px;margin-top:4px}
    .report-note{margin:12px 0;padding:10px 12px;border-radius:9px;background:#f4f7fb;color:#526176;font-size:11px;line-height:1.65}
    .chart{border:1px solid #e1e8f1;border-radius:14px;padding:12px 14px;background:#fff}
    .chart svg{width:100%;height:auto;display:block}
    .heatmap-chart{overflow:hidden}
    .heatmap-chart svg{min-width:0;max-width:100%}
    .two-column{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .table-wrap{overflow:hidden;border:1px solid #e1e8f1;border-radius:12px}
    table{width:100%;border-collapse:collapse;font-size:11px}
    th,td{border-bottom:1px solid #e6ebf1;padding:8px 7px;text-align:left;vertical-align:top}
    th{background:#f5f8fc;color:#526176;font-weight:700;white-space:nowrap}
    tbody tr:last-child td{border-bottom:0}
    .wide-table{min-width:980px}
    .day-task-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .day-task-card{border:1px solid #e1e8f1;border-radius:12px;padding:12px;background:#fbfcfe;break-inside:avoid}
    .day-task-card header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border:0;padding:0;margin:0 0 8px}
    .day-task-card header div{display:flex;align-items:baseline;gap:8px}
    .day-task-card header strong{font-size:13px}
    .day-task-card header span,.day-task-card header em{color:#718096;font-size:10px;font-style:normal}
    .day-task-card ul{list-style:none;margin:0;padding:0}
    .day-task-card li{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:7px 0;border-top:1px solid #e6ebf1}
    .day-task-title{display:grid;grid-template-columns:8px 1fr;column-gap:7px;min-width:0}
    .day-task-title strong{font-size:11px;line-height:1.45;overflow-wrap:anywhere}
    .day-task-title small{grid-column:2;color:#7a8799;font-size:10px;margin-top:2px}
    .subject-dot{width:8px;height:8px;border-radius:50%;margin-top:4px}
    .task-state{flex:none;font-size:10px;font-weight:700}
    .task-state.done{color:#15803d}
    .task-state.partial{color:#b45309}
    .task-state.todo{color:#64748b}
    .day-task-empty{color:#8a97aa;font-size:11px}
    .report-insights{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .report-insights article{display:flex;flex-direction:column;gap:6px;border:1px solid #dfe5ee;border-left:4px solid #94a3b8;border-radius:10px;padding:12px;background:#fbfcfe}
    .report-insights article.positive{border-left-color:#16a34a}
    .report-insights article.warning{border-left-color:#f59e0b}
    .report-insights strong{font-size:13px}
    .report-insights span{color:#667085;font-size:11px;line-height:1.55}
    .privacy{margin-top:24px;padding:12px;border-radius:10px;background:#f4f7fb;font-size:10px;color:#667085}
    @media print{body{padding:0;max-width:none}.report-stat,.chart,.report-insights article,.two-column>div{break-inside:avoid}.day-task-grid{grid-template-columns:1fr 1fr}.day-task-card{break-inside:avoid}.report-section{break-before:auto}thead{display:table-header-group}.table-wrap{overflow:visible}.wide-table{min-width:0;font-size:8px}h2{break-after:avoid}}
    @media(max-width:760px){body{padding:20px}.report-stat-grid,.report-stat-grid-four{grid-template-columns:1fr 1fr}.two-column,.report-insights,.day-task-grid{grid-template-columns:1fr}.table-wrap{overflow:auto}table{min-width:650px}}
  `
  return `<!doctype html><html lang="${getActiveLanguage() === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(displayPlanName(state.settings.planName))} ${tr('ex.094')}</title><style>${reportStyles}</style></head><body><header><h1>${html(displayPlanName(state.settings.planName))} ${tr('ex.094')}</h1><p>${html(range.start)} ${tr('ex.031')} ${html(range.end)} ${tr('ex.095')} ${html(generatedAt)}</p><p class="muted">${tr('ex.235')}</p></header>${body}<p class="privacy">${tr('ex.119')}</p></body></html>`
}

export function buildPrintableReportHtml(state: AppState, range: ExportRange, sections?: Partial<StatisticsReportSections>) {
  return buildStatisticsReportHtml(state, range, sections)
}

function buildCalendarTaskDetailsHtml(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  const assignments = assignmentsInRange(state, range)
  const rows = assignments.map(assignment => {
    const group = groups.get(assignment.groupId)
    return `<tr><td>${html(assignment.scheduledDate)}</td><td>${html(group?.subject ?? '其他')}</td><td>${html(assignment.title)}</td><td>${assignment.estimatedMinutes} ${tr('ex.077')}</td><td>${html(taskStatusLabel[assignment.status])}</td></tr>`
  }).join('')
  return `<section class="calendar-details"><h2>${tr('ex.237')}</h2><p class="muted">${tr('ex.238')}</p><div class="table-wrap"><table><thead><tr><th>${tr('ex.001')}</th><th>${tr('ex.003')}</th><th>${tr('ex.002')}</th><th>${tr('ex.117')}</th><th>${tr('ex.008')}</th></tr></thead><tbody>${rows || tr('ex.236')}</tbody></table></div></section>`
}

export function buildCalendarPrintHtml(state: AppState, month: string) {
  const range = monthExportRange(month)
  const generatedAt = new Date().toLocaleString('zh-CN')
  return `<!doctype html><html lang="${getActiveLanguage() === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(displayPlanName(state.settings.planName))} ${html(month)} ${tr('ex.239')}</title><style>:root{font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#172033}*{box-sizing:border-box}body{margin:0;padding:22px}header{display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:2px solid #2563eb;padding-bottom:14px;margin-bottom:16px}h1{font-size:24px;margin:0 0 5px}h2{font-size:18px;margin:28px 0 9px}.muted{margin:0 0 10px;color:#667085;font-size:11px}.calendar-svg{display:block;width:100%;height:auto}.table-wrap{overflow:hidden;border:1px solid #e1e8f1;border-radius:12px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border-bottom:1px solid #e6ebf1;padding:8px 7px;text-align:left}th{background:#f5f8fc;color:#526176;font-weight:700}tbody tr:last-child td{border-bottom:0}.calendar-details{break-before:page}@media print{body{padding:0}@page{size:landscape;margin:10mm}thead{display:table-header-group}}@media(max-width:700px){body{padding:12px}header{display:block}header p{margin-top:6px}}</style></head><body><header><div><h1>${html(displayPlanName(state.settings.planName))} · ${html(range.start.slice(0, 7))} ${tr('ex.239')}</h1><p>${tr('ex.240')}</p></div><p>${tr('ex.037')} ${html(generatedAt)}</p></header>${buildCalendarSvg(state, month, { showAllTasks: false })}${buildCalendarTaskDetailsHtml(state, range)}</body></html>`
}

export function exportRangeSummary(state: AppState, range: ExportRange) {
  const groups = activeGroupMap(state)
  const daily = aggregateDaily(state.assignments, groups, state.settings.countWordsTime, range.start, range.end, state.dailyPlanBaselines)
  const assignments = assignmentsInRange(state, range)
  return {
    days: dateRange(range.start, range.end).length,
    assignments: assignments.length,
    plannedMinutes: daily.reduce((sum, row) => sum + row.planned, 0),
    actualMinutes: daily.reduce((sum, row) => sum + row.actual, 0),
    timeEntries: state.assignments.reduce((sum, assignment) => sum + (assignment.timeEntries ?? []).filter(entry => {
      const date = timeEntryDate(entry)
      return Boolean(date && date >= range.start && date <= range.end)
    }).length, 0),
  }
}

export function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function safeExportName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-') || 'study-planner'
}
