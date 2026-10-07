import { useEffect, useMemo, useState } from 'react'
import { BarChart3, CalendarDays, CheckCircle2, Clock3, Database, Download, FileImage, FileSpreadsheet, FileText, Printer, ShieldCheck } from 'lucide-react'
import { useApp } from '../AppContext'
import { useT } from '../lib/i18n'
import { clampDate, minutesText, shiftDate, todayISO } from '../lib/date'
import {
  buildCalendarCsv,
  buildCalendarIcs,
  buildCalendarPrintHtml,
  buildCalendarSvg,
  buildTaskTableSvg,
  buildStatisticsReportHtml,
  buildStatisticsCsv,
  buildTimeLedgerCsv,
  downloadSvgAsPng,
  downloadTextFile,
  exportRangeSummary,
  monthExportRange,
  safeExportName,
  defaultStatisticsReportSections,
  defaultTaskTableImageColumns,
  taskTableImageColumnOptions,
  type StatisticsReportSections,
  type TaskTableImageColumn,
  type ExportRange,
} from '../lib/exports'

type ExportPageId = 'settings' | 'stats'
type RangePreset = 'recent' | '30d' | '90d' | 'future' | 'all'

function useReportSectionOptions(): Array<{ key: keyof StatisticsReportSections; title: string; description: string }> {
  const t = useT()
  return [
    { key: 'overview', title: t('exportPage.section.overview.title'), description: t('exportPage.section.overview.desc') },
    { key: 'daily', title: t('exportPage.section.daily.title'), description: t('exportPage.section.daily.desc') },
    { key: 'completion', title: t('exportPage.section.completion.title'), description: t('exportPage.section.completion.desc') },
    { key: 'focus', title: t('exportPage.section.focus.title'), description: t('exportPage.section.focus.desc') },
    { key: 'subjects', title: t('exportPage.section.subjects.title'), description: t('exportPage.section.subjects.desc') },
    { key: 'accuracy', title: t('exportPage.section.accuracy.title'), description: t('exportPage.section.accuracy.desc') },
    { key: 'insights', title: t('exportPage.section.insights.title'), description: t('exportPage.section.insights.desc') },
    { key: 'heatmap', title: t('exportPage.section.heatmap.title'), description: t('exportPage.section.heatmap.desc') },
    { key: 'goals', title: t('exportPage.section.goals.title'), description: t('exportPage.section.goals.desc') },
    { key: 'quality', title: t('exportPage.section.quality.title'), description: t('exportPage.section.quality.desc') },
    { key: 'details', title: t('exportPage.section.details.title'), description: t('exportPage.section.details.desc') },
    { key: 'ledger', title: t('exportPage.section.ledger.title'), description: t('exportPage.section.ledger.desc') },
  ]
}

const coreReportSections: StatisticsReportSections = {
  ...defaultStatisticsReportSections,
  focus: false,
  accuracy: false,
  insights: false,
  heatmap: false,
  goals: false,
  quality: false,
  ledger: false,
}

export function ExportPage({ onNavigate }: { onNavigate: (page: ExportPageId) => void }) {
  const t = useT()
  const reportSectionOptions = useReportSectionOptions()
  const { state } = useApp()
  const today = todayISO()
  const initialEnd = clampDate(today, state.settings.startDate, state.settings.endDate)
  const initialStart = clampDate(shiftDate(initialEnd, -6), state.settings.startDate, state.settings.endDate)
  const [start, setStart] = useState(initialStart)
  const [end, setEnd] = useState(initialEnd)
  const [calendarMonth, setCalendarMonth] = useState(initialEnd.slice(0, 7))
  const [reportSections, setReportSections] = useState<StatisticsReportSections>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('study-planner:export-report-sections') ?? '') as Partial<StatisticsReportSections>
      return { ...defaultStatisticsReportSections, ...saved }
    } catch {
      return { ...defaultStatisticsReportSections }
    }
  })
  const [taskImageColumns, setTaskImageColumns] = useState<TaskTableImageColumn[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('study-planner:export-task-columns') ?? '') as TaskTableImageColumn[]
      const allowed = new Set(taskTableImageColumnOptions.map(option => option.key))
      const validSaved = Array.isArray(saved) ? saved.filter(column => allowed.has(column)) : []
      return validSaved.length ? validSaved : [...defaultTaskTableImageColumns]
    } catch {
      return [...defaultTaskTableImageColumns]
    }
  })
  const [notice, setNotice] = useState('')
  const valid = Boolean(start && end && start <= end)
  const range: ExportRange = { start, end }
  const calendarRange = monthExportRange(calendarMonth)
  const summary = useMemo(() => valid ? exportRangeSummary(state, range) : undefined, [state, start, end, valid])
  const filenameBase = `${safeExportName(state.settings.planName)}-${start}-${end}`
  const calendarFilenameBase = `${safeExportName(state.settings.planName)}-${calendarMonth}-calendar`

  useEffect(() => { window.localStorage.setItem('study-planner:export-report-sections', JSON.stringify(reportSections)) }, [reportSections])
  useEffect(() => { window.localStorage.setItem('study-planner:export-task-columns', JSON.stringify(taskImageColumns)) }, [taskImageColumns])

  const runExport = (label: string, filename: string, content: string, mime: string) => {
    downloadTextFile(filename, content, mime)
    setNotice(t('exportPage.downloadStarted', { label }))
  }

  const setPreset = (preset: RangePreset) => {
    if (preset === 'all') {
      setStart(state.settings.startDate)
      setEnd(state.settings.endDate)
    } else if (preset === 'future') {
      setStart(clampDate(today, state.settings.startDate, state.settings.endDate))
      setEnd(state.settings.endDate)
    } else {
      const days = preset === 'recent' ? 6 : preset === '30d' ? 29 : 89
      const recentEnd = clampDate(today, state.settings.startDate, state.settings.endDate)
      setEnd(recentEnd)
      setStart(clampDate(shiftDate(recentEnd, -days), state.settings.startDate, state.settings.endDate))
    }
    setNotice('')
  }

  const openPrintWindow = (html: string, label: string) => {
    const reportWindow = window.open('', '_blank')
    if (!reportWindow) {
      setNotice(t('exportPage.printWindowBlocked'))
      return
    }
    reportWindow.opener = null
    reportWindow.document.open()
    reportWindow.document.write(html)
    reportWindow.document.close()
    reportWindow.focus()
    window.setTimeout(() => reportWindow.print(), 250)
    setNotice(t('exportPage.printWindowOpened', { label }))
  }

  const openStatisticsReport = () => {
    if (!valid) return
    openPrintWindow(buildStatisticsReportHtml(state, range, reportSections), t('exportPage.statisticsReportLabel'))
  }

  const openCalendarReport = () => {
    openPrintWindow(buildCalendarPrintHtml(state, calendarMonth), t('exportPage.calendarPdfLabel'))
  }

  const downloadCalendarImage = () => {
    setNotice(t('exportPage.generatingCalendarPng'))
    void downloadSvgAsPng(`${calendarFilenameBase}.png`, buildCalendarSvg(state, calendarMonth))
      .then(() => setNotice(t('exportPage.calendarPngStarted')))
      .catch(error => setNotice(error instanceof Error ? error.message : t('exportPage.calendarImageFailed')))
  }

  const toggleTaskImageColumn = (column: TaskTableImageColumn) => {
    setTaskImageColumns(current => {
      if (current.includes(column)) return current.length === 1 ? current : current.filter(item => item !== column)
      return taskTableImageColumnOptions.filter(option => current.includes(option.key) || option.key === column).map(option => option.key)
    })
    setNotice('')
  }

  const downloadTaskTableImage = () => {
    if (!valid) return
    setNotice(t('exportPage.generatingTaskImage'))
    void downloadSvgAsPng(`${filenameBase}-tasks.png`, buildTaskTableSvg(state, range, taskImageColumns))
      .then(() => setNotice(t('exportPage.taskImageStarted')))
      .catch(error => setNotice(error instanceof Error ? error.message : t('exportPage.taskImageFailed')))
  }

  return <div className="export-page">
    <section className="export-hero">
      <div>
        <span className="export-kicker"><Download size={16}/>{t('exportPage.exportCenter')}</span>
        <h2>{t('exportPage.exportStudyData')}</h2>
        <p>{t('exportPage.heroDescription')}</p>
        <div className="export-hero-links"><button type="button" className="text-button" onClick={() => onNavigate('stats')}><BarChart3 size={15}/>{t('exportPage.viewStatsFirst')}</button></div>
      </div>
      <div className="export-hero-mark" aria-hidden="true"><FileSpreadsheet size={44}/></div>
    </section>

    <section className="export-range-panel">
      <div className="export-range-copy"><h3>{t('exportPage.exportDateRange')}</h3><p>{t('exportPage.dateRangeDescription')}</p></div>
      <div className="export-presets" aria-label={t('exportPage.dateRangePresetsAria')}>
        <button type="button" onClick={() => setPreset('recent')}>{t('exportPage.last7Days')}</button>
        <button type="button" onClick={() => setPreset('30d')}>{t('exportPage.last30Days')}</button>
        <button type="button" onClick={() => setPreset('90d')}>{t('exportPage.last90Days')}</button>
        <button type="button" onClick={() => setPreset('future')}>{t('exportPage.fromToday')}</button>
        <button type="button" onClick={() => setPreset('all')}>{t('exportPage.wholePlan')}</button>
      </div>
      <div className="export-date-fields">
        <label><span>{t('exportPage.startDate')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={start} onChange={event => { setStart(event.target.value); setNotice('') }}/></label>
        <span className="export-date-arrow">{t('exportPage.to')}</span>
        <label><span>{t('exportPage.endDate')}</span><input type="date" min={state.settings.startDate} max={state.settings.endDate} value={end} onChange={event => { setEnd(event.target.value); setNotice('') }}/></label>
      </div>
      {!valid && <p className="form-error" role="alert">{t('exportPage.endBeforeStartError')}</p>}
      {summary && <div className="export-range-summary" aria-label={t('exportPage.rangeSummaryAria')}>
        <span><strong>{summary.days}</strong> {t('exportPage.days')}</span>
        <span><strong>{summary.assignments}</strong> {t('exportPage.scheduledTasks')}</span>
        <span><strong>{minutesText(summary.plannedMinutes)}</strong> {t('exportPage.originalPlan')}</span>
        <span><strong>{minutesText(summary.actualMinutes)}</strong> {t('exportPage.actualOccurred')}</span>
      </div>}
    </section>

    <section className="export-task-image" aria-labelledby="export-task-image-title">
      <div className="export-task-image-header">
        <div className="export-task-image-title">
          <span aria-hidden="true"><FileImage size={22}/></span>
          <div><h3 id="export-task-image-title">{t('exportPage.taskImageTitle')}</h3><p>{t('exportPage.taskImageDescription')}</p></div>
        </div>
        <div className="export-task-image-actions"><span>{t('exportPage.columnsSelected', { count: taskImageColumns.length })}</span><button type="button" className="text-button" onClick={() => setTaskImageColumns([...defaultTaskTableImageColumns])}>{t('exportPage.restoreDefault')}</button></div>
      </div>
      <div className="export-column-grid" aria-label={t('exportPage.chooseColumnsAria')}>
        {taskTableImageColumnOptions.map(option => <label key={option.key} className="export-column-choice"><input type="checkbox" checked={taskImageColumns.includes(option.key)} onChange={() => toggleTaskImageColumn(option.key)}/><span>{option.label}</span></label>)}
      </div>
      <div className="export-task-image-footer">
        <span>{summary ? t('exportPage.tasksWillBeIncluded', { count: summary.assignments }) : t('exportPage.selectValidRangeFirst')}</span>
        <button type="button" className="primary-button" disabled={!valid || !summary?.assignments} onClick={downloadTaskTableImage}><FileImage size={16}/>{t('exportPage.downloadImagePng')}</button>
      </div>
    </section>

    <section className="export-section-picker" aria-labelledby="export-report-sections-title">
      <div className="export-section-picker-header">
        <div><h3 id="export-report-sections-title">{t('exportPage.pdfReportContent')}</h3><p>{t('exportPage.pdfReportDescription')}</p></div>
        <div className="export-section-picker-actions"><span>{t('exportPage.modulesSelected', { selected: Object.values(reportSections).filter(Boolean).length, total: reportSectionOptions.length })}</span><button type="button" className="text-button" onClick={() => setReportSections({ ...defaultStatisticsReportSections })}>{t('exportPage.selectAll')}</button><button type="button" className="text-button" onClick={() => setReportSections({ ...coreReportSections })}>{t('exportPage.coreOnly')}</button></div>
      </div>
      <div className="export-section-grid">
        {reportSectionOptions.map(option => <label key={option.key} className="export-section-choice"><input type="checkbox" checked={reportSections[option.key]} onChange={() => setReportSections(current => ({ ...current, [option.key]: !current[option.key] }))}/><span><strong>{option.title}</strong><small>{option.description}</small></span></label>)}
      </div>
    </section>

    <section className="export-options" aria-label={t('exportPage.availableFormatsAria')}>
      <article className="export-card export-card-stats export-card-featured">
        <div className="export-card-icon"><BarChart3 size={22}/></div>
        <div className="export-card-copy"><h3>{t('exportPage.studyStatsReport')}</h3><p>{t('exportPage.studyStatsReportDescription')}</p></div>
        <div className="export-card-actions">
          <button type="button" className="primary-button" disabled={!valid} onClick={openStatisticsReport}><Printer size={16}/>{t('exportPage.statsReportPdf')}</button>
          <button type="button" className="secondary-button" disabled={!valid} onClick={() => runExport(t('exportPage.statsCsvLabel'), `${filenameBase}-statistics.csv`, buildStatisticsCsv(state, range), 'text/csv')}><FileSpreadsheet size={16}/>{t('exportPage.statsCsv')}</button>
          <button type="button" className="text-button" disabled={!valid} onClick={() => runExport(t('exportPage.statsHtmlLabel'), `${filenameBase}-statistics.html`, buildStatisticsReportHtml(state, range, reportSections), 'text/html')}><FileText size={16}/>HTML</button>
        </div>
      </article>

      <article className="export-card export-card-calendar export-card-featured">
        <div className="export-card-icon"><CalendarDays size={22}/></div>
        <div className="export-card-copy"><h3>{t('exportPage.calendarImageAndPdf')}</h3><p>{t('exportPage.calendarImageAndPdfDescription')}</p></div>
        <div className="export-month-choice"><label><span>{t('exportPage.calendarMonth')}</span><input type="month" min={state.settings.startDate.slice(0, 7)} max={state.settings.endDate.slice(0, 7)} value={calendarMonth} onChange={event => setCalendarMonth(event.target.value)}/></label><small>{t('exportPage.rangeToRange', { start: calendarRange.start, end: calendarRange.end })}</small></div>
        <div className="export-card-actions">
          <button type="button" className="primary-button" onClick={openCalendarReport}><Printer size={16}/>{t('exportPage.calendarPdf')}</button>
          <button type="button" className="secondary-button" onClick={downloadCalendarImage}><Download size={16}/>{t('exportPage.calendarPng')}</button>
          <button type="button" className="text-button" onClick={() => runExport(t('exportPage.calendarCsvLabel'), `${calendarFilenameBase}.csv`, buildCalendarCsv(state, calendarRange), 'text/csv')}><FileSpreadsheet size={16}/>CSV</button>
        </div>
      </article>

      <article className="export-card export-card-ledger">
        <div className="export-card-icon"><Clock3 size={22}/></div>
        <div className="export-card-copy"><h3>{t('exportPage.actualTimeLedger')}</h3><p>{t('exportPage.actualTimeLedgerDescription')}</p></div>
        <div className="export-card-actions">
          <button type="button" className="secondary-button" disabled={!valid} onClick={() => runExport(t('exportPage.timeLedgerCsvLabel'), `${filenameBase}-time-ledger.csv`, buildTimeLedgerCsv(state, range), 'text/csv')}><Download size={16}/>{t('exportPage.downloadLedgerCsv')}</button>
        </div>
      </article>

      <article className="export-card export-card-calendar">
        <div className="export-card-icon"><CalendarDays size={22}/></div>
        <div className="export-card-copy"><h3>{t('exportPage.systemCalendar')}</h3><p>{t('exportPage.systemCalendarDescription')}</p></div>
        <div className="export-card-actions">
          <button type="button" className="secondary-button" disabled={!valid} onClick={() => runExport(t('exportPage.calendarIcsLabel'), `${filenameBase}-calendar.ics`, buildCalendarIcs(state, range), 'text/calendar')}><CalendarDays size={16}/>{t('exportPage.downloadIcs')}</button>
        </div>
      </article>
    </section>

    {notice && <div className="export-notice" role="status"><CheckCircle2 size={17}/><span>{notice}</span></div>}

    <section className="export-privacy">
      <ShieldCheck size={22}/>
      <div><h3>{t('exportPage.privacyTitle')}</h3><p>{t('exportPage.privacyDescription')}</p></div>
      <button type="button" className="secondary-button" onClick={() => onNavigate('settings')}><Database size={16}/>{t('exportPage.goToBackupSettings')}</button>
    </section>
  </div>
}
