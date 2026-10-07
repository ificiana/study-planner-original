import { tr } from './i18n'
import { addDays, eachDayOfInterval, format, isAfter, isBefore, parseISO } from 'date-fns'
import type { AppState, DayConfig, DayType } from '../types'

let nowProvider = () => new Date()

/** Injectable clock for deterministic date and timezone tests. */
export const setNowProvider = (provider: () => Date) => { nowProvider = provider }
export const resetNowProvider = () => { nowProvider = () => new Date() }
export const withNowProvider = <T>(provider: () => Date, callback: () => T): T => {
  const previous = nowProvider
  nowProvider = provider
  try { return callback() } finally { nowProvider = previous }
}
export const nowDate = () => new Date(nowProvider().getTime())
export const todayISO = () => format(nowDate(), 'yyyy-MM-dd')

/**
 * Create a stable timestamp for a calendar date.
 *
 * Actual-time aggregation reads the date portion of timestamps. Using UTC
 * noon keeps that date stable across local time zones and around midnight.
 */
export const timestampForDate = (date: string) => `${date}T12:00:00.000Z`
export const fmtDate = (date: string, pattern = tr('dt.001')) => format(parseISO(date), pattern)
export const fmtWeekday = (date: string) => [tr('dt.002'),tr('dt.003'),tr('dt.004'),tr('dt.005'),tr('dt.006'),tr('dt.007'),tr('dt.008')][parseISO(date).getDay()]
export const dateRange = (start: string, end: string) => eachDayOfInterval({ start: parseISO(start), end: parseISO(end) }).map(d => format(d, 'yyyy-MM-dd'))
export const shiftDate = (date: string, amount: number) => format(addDays(parseISO(date), amount), 'yyyy-MM-dd')
export const clampDate = (date: string, start: string, end: string) => isBefore(parseISO(date), parseISO(start)) ? start : isAfter(parseISO(date), parseISO(end)) ? end : date

export const dayTypeLabel: Record<DayType, string> = {
  get regular() { return tr('dt.009') },
  get study() { return tr('dt.010') },
  get travel() { return tr('dt.011') },
  get custom() { return tr('dt.012') }
}

export function getDayConfig(state: AppState, date: string): DayConfig {
  return state.dayConfigs[date] ?? { date, type: 'regular' }
}

export function getBaseCapacity(state: AppState, date: string): number {
  const config = getDayConfig(state, date)
  if (config.type === 'study') return state.settings.studyMinutes
  if (config.type === 'travel') return state.settings.travelMinutes
  if (config.type === 'custom') return config.customMinutes ?? state.settings.regularMinutes
  return state.settings.regularMinutes
}

export function constraintsForDate(state: AppState, date: string) {
  return state.calendarConstraints.filter(item => item.startDate <= date && item.endDate >= date)
}

export function getCapacity(state: AppState, date: string): number {
  const config = getDayConfig(state, date)
  let capacity = typeof config.availableMinutes === 'number' ? Math.max(0, Math.round(config.availableMinutes)) : getBaseCapacity(state, date)
  for (const constraint of constraintsForDate(state, date)) {
    if (constraint.kind === 'unavailable') capacity = 0
    else if (constraint.kind === 'reduced-capacity' || constraint.kind === 'special-capacity' || constraint.kind === 'protected-buffer') {
      if (typeof constraint.capacityMinutes === 'number') capacity = Math.max(0, Math.round(constraint.capacityMinutes))
    }
  }
  return capacity
}

export function isDateProtected(state: AppState, date: string): boolean {
  const config = getDayConfig(state, date)
  return Boolean(config.bufferProtected || constraintsForDate(state, date).some(item => item.protected))
}

export function minutesText(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes))
  const h = Math.floor(rounded / 60)
  const m = rounded % 60
  if (!h) return tr('dt.013', { m })
  if (!m) return tr('dt.014', { h })
  return tr('dt.015', { h, m })
}
