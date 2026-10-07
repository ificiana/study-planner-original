import {
  ArrowUpRight, BarChart3, BookOpen, CalendarDays, CheckCircle2, Github, Inbox,
  ListChecks, RefreshCw, Target, Timer,
} from 'lucide-react'
import todayImage from '../../docs/images/02-today-execution.png'
import calendarImage from '../../docs/images/03-calendar-month-view.png'
import loadImage from '../../docs/images/06-daily-workload-before-after.png'
import reviewImage from '../../docs/images/16-review-summary-and-unfinished-tasks.png'
import { GITHUB_REPO_URL } from '../lib/constants'
import { useT } from '../lib/i18n'
import { PwaInstallGuideSection } from './PwaInstallGuide'

type GuidePageId = 'today' | 'calendar' | 'tasks' | 'intake' | 'goals' | 'stats' | 'export' | 'settings'

export function GuidePage({ onNavigate, onStartTutorial }: { onNavigate: (page: GuidePageId) => void; onStartTutorial?: () => void }) {
  const t = useT()

  const chapters = [
    { id: 'install-app', label: t('guidePage.chapterInstall') },
    { id: 'first-plan', label: t('guidePage.chapterFirstPlan') },
    { id: 'daily-use', label: t('guidePage.chapterDailyUse') },
    { id: 'changes', label: t('guidePage.chapterChanges') },
    { id: 'concepts', label: t('guidePage.chapterConcepts') },
  ]

  return <div className="guide-page">
    <section className="guide-hero">
      <div className="guide-hero-copy">
        <span className="guide-eyebrow"><BookOpen size={15}/>{t('guidePage.heroEyebrow')}</span>
        <h2>{t('guidePage.heroTitle')}</h2>
        <p>{t('guidePage.heroText')}</p>
        <div className="guide-hero-actions">
          <button type="button" className="primary-button" onClick={() => onNavigate('intake')}><Inbox size={16}/>{t('guidePage.startIntake')}</button>
          {onStartTutorial && <button type="button" className="secondary-button" onClick={onStartTutorial}><RefreshCw size={16}/>{t('guidePage.openTutorial')}</button>}
          <a className="secondary-button" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer"><Github size={16}/>{t('guidePage.viewRepo')}<ArrowUpRight size={14}/></a>
        </div>
        {onStartTutorial && <p className="muted-text">{t('guidePage.tutorialNote')}</p>}
      </div>
      <figure className="guide-hero-figure">
        <img src={todayImage} alt={t('guidePage.todayImageAlt')} />
        <figcaption><span>{t('guidePage.todayFigureLabel')}</span><strong>{t('guidePage.todayFigureCaption')}</strong></figcaption>
      </figure>
    </section>

    <nav className="guide-chapters" aria-label={t('guidePage.chaptersAriaLabel')}>
      {chapters.map(chapter => <a key={chapter.id} href={`#${chapter.id}`}>{chapter.label}</a>)}
    </nav>

    <PwaInstallGuideSection />

    <section className="guide-section" id="first-plan">
      <GuideHeading eyebrow={t('guidePage.firstPlanEyebrow')} title={t('guidePage.firstPlanTitle')} text={t('guidePage.firstPlanText')} />
      <div className="guide-story guide-story-image-right">
        <div className="guide-story-copy">
          <GuideSteps steps={[
            [t('guidePage.step1Title'), t('guidePage.step1Text')],
            [t('guidePage.step2Title'), t('guidePage.step2Text')],
            [t('guidePage.step3Title'), t('guidePage.step3Text')],
          ]} />
          <button type="button" className="guide-card-action" onClick={() => onNavigate('intake')}>{t('guidePage.openIntake')}<ArrowUpRight size={14}/></button>
        </div>
        <GuideFigure src={calendarImage} alt={t('guidePage.calendarImageAlt')} label={t('guidePage.calendarFigureLabel')} caption={t('guidePage.calendarFigureCaption')} />
      </div>
    </section>

    <section className="guide-section" id="daily-use">
      <GuideHeading eyebrow={t('guidePage.dailyUseEyebrow')} title={t('guidePage.dailyUseTitle')} text={t('guidePage.dailyUseText')} />
      <div className="guide-flow-grid">
        <GuideFlowCard icon={Timer} title={t('guidePage.flowStartTitle')} text={t('guidePage.flowStartText')} />
        <GuideFlowCard icon={CheckCircle2} title={t('guidePage.flowRecordTitle')} text={t('guidePage.flowRecordText')} />
        <GuideFlowCard icon={ListChecks} title={t('guidePage.flowReviewTitle')} text={t('guidePage.flowReviewText')} />
        <GuideFlowCard icon={BarChart3} title={t('guidePage.flowStatsTitle')} text={t('guidePage.flowStatsText')} />
      </div>
      <div className="guide-story guide-story-two-images">
        <GuideFigure src={todayImage} alt={t('guidePage.todayImageAlt')} label={t('guidePage.todayFigureLabel2')} caption={t('guidePage.todayFigureCaption2')} />
        <GuideFigure src={reviewImage} alt={t('guidePage.reviewImageAlt')} label={t('guidePage.reviewFigureLabel')} caption={t('guidePage.reviewFigureCaption')} />
      </div>
    </section>

    <section className="guide-section" id="changes">
      <GuideHeading eyebrow={t('guidePage.changesEyebrow')} title={t('guidePage.changesTitle')} text={t('guidePage.changesText')} />
      <div className="guide-story guide-story-image-left">
        <GuideFigure src={loadImage} alt={t('guidePage.loadImageAlt')} label={t('guidePage.loadFigureLabel')} caption={t('guidePage.loadFigureCaption')} />
        <div className="guide-story-copy">
          <GuideSteps steps={[
            [t('guidePage.changesStep1Title'), t('guidePage.changesStep1Text')],
            [t('guidePage.changesStep2Title'), t('guidePage.changesStep2Text')],
            [t('guidePage.changesStep3Title'), t('guidePage.changesStep3Text')],
          ]} />
          <button type="button" className="guide-card-action" onClick={() => onNavigate('stats')}>{t('guidePage.viewStats')}<ArrowUpRight size={14}/></button>
        </div>
      </div>
    </section>

    <section className="guide-section guide-concepts-section" id="concepts">
      <GuideHeading eyebrow={t('guidePage.conceptsEyebrow')} title={t('guidePage.conceptsTitle')} text={t('guidePage.conceptsText')} />
      <div className="guide-concept-grid">
        <article><span className="guide-concept-label">{t('guidePage.conceptPlanLabel')}</span><strong>{t('guidePage.conceptPlanStrong')}</strong><p>{t('guidePage.conceptPlanText')}</p></article>
        <article><span className="guide-concept-label guide-concept-label-blue">{t('guidePage.conceptActualLabel')}</span><strong>{t('guidePage.conceptActualStrong')}</strong><p>{t('guidePage.conceptActualText')}</p></article>
        <article><span className="guide-concept-label guide-concept-label-amber">{t('guidePage.conceptLoadLabel')}</span><strong>{t('guidePage.conceptLoadStrong')}</strong><p>{t('guidePage.conceptLoadText')}</p></article>
      </div>
    </section>

    <section className="guide-section guide-entry-section">
      <GuideHeading eyebrow={t('guidePage.entryEyebrow')} title={t('guidePage.entryTitle')} text={t('guidePage.entryText')} />
      <div className="guide-entry-list">
        <GuideEntry icon={CheckCircle2} title={t('guidePage.entryTodayTitle')} detail={t('guidePage.entryTodayDetail')} action={t('guidePage.entryTodayAction')} onAction={() => onNavigate('today')} />
        <GuideEntry icon={Inbox} title={t('guidePage.entryIntakeTitle')} detail={t('guidePage.entryIntakeDetail')} action={t('guidePage.entryIntakeAction')} onAction={() => onNavigate('intake')} />
        <GuideEntry icon={CalendarDays} title={t('guidePage.entryCalendarTitle')} detail={t('guidePage.entryCalendarDetail')} action={t('guidePage.entryCalendarAction')} onAction={() => onNavigate('calendar')} />
        <GuideEntry icon={Target} title={t('guidePage.entryGoalsTitle')} detail={t('guidePage.entryGoalsDetail')} action={t('guidePage.entryGoalsAction')} onAction={() => onNavigate('goals')} />
        <GuideEntry icon={BarChart3} title={t('guidePage.entryExportTitle')} detail={t('guidePage.entryExportDetail')} action={t('guidePage.entryExportAction')} onAction={() => onNavigate('export')} />
      </div>
    </section>

    <section className="guide-principles">
      <div><span className="guide-eyebrow">{t('guidePage.principlesEyebrow')}</span><h3>{t('guidePage.principlesTitle')}</h3><p>{t('guidePage.principlesText')}</p></div>
      <a className="guide-repo-link" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer"><Github size={18}/><span><strong>{t('guidePage.repoLinkTitle')}</strong><small>{t('guidePage.repoLinkText')}</small></span><ArrowUpRight size={17}/></a>
    </section>
  </div>
}

function GuideHeading({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <div className="guide-section-heading"><div><span className="guide-eyebrow">{eyebrow}</span><h3>{title}</h3><p>{text}</p></div></div>
}

function GuideSteps({ steps }: { steps: Array<[string, string]> }) {
  return <ol className="guide-steps">{steps.map(([title, text]) => <li key={title}><span/><div><strong>{title}</strong><p>{text}</p></div></li>)}</ol>
}

function GuideFigure({ src, alt, label, caption }: { src: string; alt: string; label: string; caption: string }) {
  return <figure className="guide-figure"><div className="guide-figure-frame"><img loading="lazy" src={src} alt={alt}/></div><figcaption><span>{label}</span><strong>{caption}</strong></figcaption></figure>
}

function GuideFlowCard({ icon: Icon, title, text }: { icon: typeof Target; title: string; text: string }) {
  return <article className="guide-flow-card"><div className="guide-flow-icon"><Icon size={18}/></div><strong>{title}</strong><p>{text}</p></article>
}

function GuideEntry({ icon: Icon, title, detail, action, onAction }: { icon: typeof Target; title: string; detail: string; action: string; onAction: () => void }) {
  return <article className="guide-entry"><div className="guide-entry-icon"><Icon size={17}/></div><div><strong>{title}</strong><p>{detail}</p></div><button type="button" className="text-button" onClick={onAction}>{action}<ArrowUpRight size={14}/></button></article>
}
