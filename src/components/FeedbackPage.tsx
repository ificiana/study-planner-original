import { useEffect, useState } from 'react'
import { AlertTriangle, Bell, CheckCircle2, ImagePlus, Inbox, MessageCircle, RefreshCw, Sparkles, Upload, X } from 'lucide-react'
import {
  appendFeedbackReply,
  FEEDBACK_UNREAD_EVENT,
  getFeedbackSessionContext,
  getUnreadFeedbackReplyCount,
  listFeedback,
  markAdminFollowupsRead,
  markFeedbackRepliesRead,
  replyToFeedback,
  submitFeedback,
  updateFeedbackStatus,
  validateFeedbackScreenshots,
  type FeedbackAttachment,
  type FeedbackRecord,
  type FeedbackReply,
  type FeedbackStatus,
  type FeedbackType,
} from '../lib/feedback'
import { useT } from '../lib/i18n'
import '../feedback.css'

function useFeedbackOptions() {
  const t = useT()
  return [
    { type: 'bug' as FeedbackType, title: t('feedbackPage.typeBug'), description: t('feedbackPage.typeBugDesc'), icon: AlertTriangle },
    { type: 'suggestion' as FeedbackType, title: t('feedbackPage.typeSuggestion'), description: t('feedbackPage.typeSuggestionDesc'), icon: Sparkles },
    { type: 'experience' as FeedbackType, title: t('feedbackPage.typeExperience'), description: t('feedbackPage.typeExperienceDesc'), icon: CheckCircle2 },
    { type: 'other' as FeedbackType, title: t('feedbackPage.typeOther'), description: t('feedbackPage.typeOtherDesc'), icon: Inbox },
  ]
}

function usePlaceholders(): Record<FeedbackType, string> {
  const t = useT()
  return {
    bug: t('feedbackPage.placeholderBug'),
    suggestion: t('feedbackPage.placeholderSuggestion'),
    experience: t('feedbackPage.placeholderExperience'),
    other: t('feedbackPage.placeholderOther'),
  }
}

function useTypeLabels(): Record<FeedbackType, string> {
  const t = useT()
  return {
    bug: t('feedbackPage.typeBug'), suggestion: t('feedbackPage.typeSuggestion'), experience: t('feedbackPage.typeExperience'), other: t('feedbackPage.typeOther'),
  }
}

function useStatusLabels(): Record<FeedbackStatus, string> {
  const t = useT()
  return {
    new: t('feedbackPage.statusNew'), reviewing: t('feedbackPage.statusReviewing'), planned: t('feedbackPage.statusPlanned'), resolved: t('feedbackPage.statusResolved'), closed: t('feedbackPage.statusClosed'),
  }
}

function useDepthLabels(): Record<string, string> {
  const t = useT()
  return {
    new: t('feedbackPage.depthNew'), casual: t('feedbackPage.depthCasual'), returning: t('feedbackPage.depthReturning'), engaged: t('feedbackPage.depthEngaged'), power: t('feedbackPage.depthPower'),
  }
}

function displayTime(value: string) {
  try { return new Date(value).toLocaleString('zh-CN', { hour12: false }) } catch { return value }
}

function useDetailValue() {
  const t = useT()
  return (value: string | number | boolean | null | undefined, options?: { time?: boolean; suffix?: string }) => {
    if (value === null || value === undefined || value === '') return t('feedbackPage.valueEmpty')
    if (typeof value === 'boolean') return value ? t('feedbackPage.valueYes') : t('feedbackPage.valueNo')
    if (options?.time && typeof value === 'string') return displayTime(value)
    return `${value}${options?.suffix ?? ''}`
  }
}

function AttachmentGrid({ attachments }: { attachments: FeedbackAttachment[] }) {
  if (!attachments.length) return null
  return <div className="feedback-attachment-grid">
    {attachments.map(attachment => attachment.signed_url
      ? <a href={attachment.signed_url} target="_blank" rel="noreferrer" key={attachment.id} className="feedback-attachment">
          <img src={attachment.signed_url} alt={attachment.file_name}/>
          <span>{attachment.file_name}</span>
        </a>
      : <div className="feedback-attachment unavailable" key={attachment.id}><span>{attachment.file_name}</span></div>)}
  </div>
}

function SelectedReplyFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const t = useT()
  if (!files.length) return null
  return <div className="feedback-selected-files feedback-reply-files">
    {files.map((file, index) => <div key={`${file.name}-${file.size}-${index}`}>
      <span>{file.name}</span>
      <button type="button" aria-label={t('feedbackPage.removeFile', { name: file.name })} onClick={() => onRemove(index)}><X size={15}/></button>
    </div>)}
  </div>
}

function AdminDetails({ record }: { record: FeedbackRecord }) {
  const t = useT()
  const typeLabels = useTypeLabels()
  const statusLabels = useStatusLabels()
  const depthLabels = useDepthLabels()
  const detailValue = useDetailValue()
  const groups: Array<{ title: string; items: Array<[string, string]> }> = [
    {
      title: t('feedbackPage.detailIdentityTitle'),
      items: [
        [t('feedbackPage.detailFeedbackId'), detailValue(record.id)],
        [t('feedbackPage.detailUserId'), detailValue(record.user_id)],
        [t('feedbackPage.detailVisitorId'), detailValue(record.visitor_id)],
        [t('feedbackPage.detailAccountMode'), record.account_mode === 'account' ? t('feedbackPage.accountModeAccount') : record.account_mode === 'guest' ? t('feedbackPage.accountModeGuest') : t('feedbackPage.valueEmpty')],
        [t('feedbackPage.detailFeedbackType'), typeLabels[record.feedback_type]],
        [t('feedbackPage.detailStatus'), statusLabels[record.status]],
        [t('feedbackPage.detailSubmittedAt'), detailValue(record.created_at, { time: true })],
      ],
    },
    {
      title: t('feedbackPage.detailSourceTitle'),
      items: [
        [t('feedbackPage.detailAppVersion'), detailValue(record.app_version)],
        [t('feedbackPage.detailPagePath'), detailValue(record.page_path)],
        [t('feedbackPage.detailUserAgent'), detailValue(record.user_agent)],
        [t('feedbackPage.detailUtmSource'), detailValue(record.utm_source)],
        [t('feedbackPage.detailUtmCampaign'), detailValue(record.utm_campaign)],
        [t('feedbackPage.detailFirstReferrer'), detailValue(record.first_referrer)],
        [t('feedbackPage.detailBrowserLanguage'), detailValue(record.browser_language)],
        [t('feedbackPage.detailClientTimezone'), detailValue(record.client_timezone)],
        [t('feedbackPage.detailIsPwa'), detailValue(record.is_pwa)],
      ],
    },
    {
      title: t('feedbackPage.detailUsageTitle'),
      items: [
        [t('feedbackPage.detailFirstSeen'), detailValue(record.first_seen_at, { time: true })],
        [t('feedbackPage.detailLastSeen'), detailValue(record.last_seen_at, { time: true })],
        [t('feedbackPage.detailTenureDays'), detailValue(record.tenure_days, { suffix: t('feedbackPage.detailDaysSuffix') })],
        [t('feedbackPage.detailTotalSessions'), detailValue(record.total_sessions)],
        [t('feedbackPage.detailTotalEvents'), detailValue(record.total_events)],
        [t('feedbackPage.detailTotalActiveDays'), detailValue(record.total_active_days, { suffix: t('feedbackPage.detailDaysSuffix') })],
        [t('feedbackPage.detailSessions30d'), detailValue(record.sessions_30d)],
        [t('feedbackPage.detailEvents30d'), detailValue(record.events_30d)],
        [t('feedbackPage.detailActiveDays30d'), detailValue(record.active_days_30d, { suffix: t('feedbackPage.detailDaysSuffix') })],
        [t('feedbackPage.detailUniquePages30d'), detailValue(record.unique_pages_30d)],
      ],
    },
    {
      title: t('feedbackPage.detailPlannerTitle'),
      items: [
        [t('feedbackPage.detailAssignmentCount'), detailValue(record.assignment_count)],
        [t('feedbackPage.detailCompletedAssignmentCount'), detailValue(record.completed_assignment_count)],
        [t('feedbackPage.detailTaskGroupCount'), detailValue(record.task_group_count)],
        [t('feedbackPage.detailGoalCount'), detailValue(record.goal_count)],
        [t('feedbackPage.detailIntakeBatchCount'), detailValue(record.intake_batch_count)],
        [t('feedbackPage.detailReplanCount'), detailValue(record.replan_count)],
      ],
    },
    {
      title: t('feedbackPage.detailSnapshotTitle'),
      items: [
        [t('feedbackPage.detailDepthScore'), record.depth_score === null || record.depth_score === undefined ? t('feedbackPage.valueEmpty') : `${record.depth_score} / 100`],
        [t('feedbackPage.detailDepthLevel'), record.depth_level ? `${depthLabels[record.depth_level] ?? record.depth_level}（${record.depth_level}）` : t('feedbackPage.valueEmpty')],
        [t('feedbackPage.detailDepthCalculatedAt'), detailValue(record.depth_calculated_at, { time: true })],
      ],
    },
  ]

  return <details className="feedback-admin-details">
    <summary>{t('feedbackPage.viewDetails')}</summary>
    <div className="feedback-detail-groups">
      {groups.map(group => <section className="feedback-detail-group" key={group.title}>
        <h4>{group.title}</h4>
        <dl className="feedback-detail-grid">
          {group.items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      </section>)}
      <p className="feedback-detail-security">{t('feedbackPage.securityNote')}</p>
    </div>
  </details>
}

function useReplyLabel() {
  const t = useT()
  return (reply: FeedbackReply, scope: 'mine' | 'admin') => {
    if (reply.author_type === 'admin') return t('feedbackPage.replyLabelAdmin')
    if (scope === 'mine') return t('feedbackPage.replyLabelSelf')
    return reply.author_type === 'guest' ? t('feedbackPage.replyLabelGuest') : t('feedbackPage.replyLabelUser')
  }
}

function replyIsNew(reply: FeedbackReply, scope: 'mine' | 'admin') {
  if (reply.read_at) return false
  return scope === 'mine' ? reply.author_type === 'admin' : reply.author_type !== 'admin'
}

function FeedbackList({ scope, refreshKey, onUnreadCountChange }: { scope: 'mine' | 'admin'; refreshKey: number; onUnreadCountChange?: (count: number) => void }) {
  const t = useT()
  const typeLabels = useTypeLabels()
  const statusLabels = useStatusLabels()
  const depthLabels = useDepthLabels()
  const replyLabel = useReplyLabel()
  const [records, setRecords] = useState<FeedbackRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [replyingId, setReplyingId] = useState<string>()
  const [replyText, setReplyText] = useState('')
  const [replyFiles, setReplyFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const next = await listFeedback(scope)
      setRecords(next)
      if (scope === 'mine') {
        const remaining = await markFeedbackRepliesRead(next)
        onUnreadCountChange?.(remaining)
      } else {
        await markAdminFollowupsRead(next)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('feedbackPage.loadFailed'))
    } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [scope, refreshKey])

  const beginReply = (feedbackId: string) => {
    setReplyingId(feedbackId)
    setReplyText('')
    setReplyFiles([])
    setError('')
    setNotice('')
  }

  const cancelReply = () => {
    setReplyingId(undefined)
    setReplyText('')
    setReplyFiles([])
  }

  const chooseReplyFiles = (record: FeedbackRecord, files: FileList | null) => {
    const next = Array.from(files ?? [])
    const validation = validateFeedbackScreenshots(next)
    if (validation) { setError(validation); return }
    if (scope === 'mine' && !record.user_id && next.length) {
      setError(t('feedbackPage.guestAttachTextOnly'))
      return
    }
    setReplyFiles(next)
    setError('')
  }

  const sendReply = async (record: FeedbackRecord) => {
    if (!replyText.trim() || saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = scope === 'admin'
        ? await replyToFeedback(record.id, replyText, replyFiles)
        : await appendFeedbackReply(record, replyText, replyFiles)
      const failed = result.failedCount > 0 ? t('feedbackPage.replyFailedImagesSuffix', { count: result.failedCount }) : ''
      setNotice(`${scope === 'admin' ? t('feedbackPage.replySentAdmin') : t('feedbackPage.replySentMine')}${failed}。`)
      cancelReply()
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('feedbackPage.replySendFailed'))
    } finally { setSaving(false) }
  }

  const changeStatus = async (feedbackId: string, status: FeedbackStatus) => {
    setSaving(true)
    setError('')
    try { await updateFeedbackStatus(feedbackId, status); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('feedbackPage.statusUpdateFailed')) }
    finally { setSaving(false) }
  }

  if (loading) return <div className="feedback-empty"><RefreshCw size={18}/><span>{t('feedbackPage.loading')}</span></div>
  if (records.length === 0) return <>{error && <div className="feedback-status error" role="alert">{error}</div>}<div className="feedback-empty"><Inbox size={20}/><span>{scope === 'admin' ? t('feedbackPage.emptyAdmin') : t('feedbackPage.emptyMine')}</span></div></>

  return <>
    {error && <div className="feedback-status error" role="alert">{error}</div>}
    {notice && <div className="feedback-status success" role="status"><CheckCircle2 size={18}/><span>{notice}</span></div>}
    <div className="feedback-history-list">
      {records.map(record => {
        const unreadReplies = record.replies.filter(reply => replyIsNew(reply, scope)).length
        const canAttachToReply = scope === 'admin' || Boolean(record.user_id)
        return <article className={`feedback-history-card ${unreadReplies ? 'has-new-reply' : ''}`} key={record.id}>
          <div className="feedback-history-head">
            <div className="feedback-history-meta">
              <span className="feedback-type-badge">{typeLabels[record.feedback_type]}</span>
              <span className={`feedback-state-badge state-${record.status}`}>{statusLabels[record.status]}</span>
              {unreadReplies > 0 && <span className="feedback-new-reply-badge">{scope === 'mine' ? t('feedbackPage.newReplyMine') : t('feedbackPage.newReplyAdmin')} · {unreadReplies}</span>}
              {scope === 'admin' && <span className="feedback-admin-identity">{record.user_id ? t('feedbackPage.identityLoggedIn') : t('feedbackPage.identityGuest')}</span>}
              {scope === 'admin' && record.depth_level && <span className="feedback-admin-depth">{depthLabels[record.depth_level] ?? record.depth_level} · {record.depth_score ?? 0}{t('feedbackPage.depthScoreSuffix')}</span>}
            </div>
            <time>{displayTime(record.created_at)}</time>
          </div>
          <p className="feedback-history-content">{record.content}</p>
          <AttachmentGrid attachments={record.attachments}/>

          {scope === 'admin' && <AdminDetails record={record}/>}

          {record.replies.length > 0 && <div className="feedback-replies feedback-conversation">
            <div className="feedback-conversation-title"><strong><MessageCircle size={15}/>{t('feedbackPage.conversationTitle')}</strong><span>{t('feedbackPage.conversationCount', { count: record.replies.length })}</span></div>
            {record.replies.map(reply => {
              const developer = reply.author_type === 'admin'
              return <div className={`feedback-reply ${developer ? 'feedback-reply-developer' : 'feedback-reply-participant'}`} key={reply.id}>
                <div className="feedback-reply-head">
                  <strong>{replyLabel(reply, scope)}</strong>
                  <div>{replyIsNew(reply, scope) && <em>{scope === 'mine' ? t('feedbackPage.newReplyMine') : t('feedbackPage.newReplyAdmin')}</em>}<time>{displayTime(reply.created_at)}</time></div>
                </div>
                <p>{reply.content}</p>
                <AttachmentGrid attachments={reply.attachments}/>
              </div>
            })}
          </div>}

          <div className={scope === 'admin' ? 'feedback-admin-actions' : 'feedback-user-actions'}>
            {scope === 'admin' && <label>{t('feedbackPage.statusLabel')}
              <select value={record.status} disabled={saving} onChange={event => void changeStatus(record.id, event.target.value as FeedbackStatus)}>
                {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>}

            {replyingId === record.id
              ? <div className="feedback-reply-editor">
                  <div className="feedback-reply-editor-heading">
                    <strong>{scope === 'admin' ? t('feedbackPage.replyToUser') : t('feedbackPage.appendNote')}</strong>
                    <small>{t('feedbackPage.charCount', { count: replyText.length })}</small>
                  </div>
                  <textarea value={replyText} maxLength={4000} rows={4} placeholder={scope === 'admin' ? t('feedbackPage.replyPlaceholderAdmin') : t('feedbackPage.replyPlaceholderMine')} onChange={event => setReplyText(event.target.value)}/>
                  {canAttachToReply
                    ? <label className="feedback-reply-upload">
                        <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event => chooseReplyFiles(record, event.target.files)}/>
                        <ImagePlus size={16}/><span>{t('feedbackPage.addImage')}</span><small>{t('feedbackPage.attachLimit')}</small>
                      </label>
                    : <p className="feedback-reply-guest-note">{t('feedbackPage.guestAttachNote')}</p>}
                  <SelectedReplyFiles files={replyFiles} onRemove={index => setReplyFiles(current => current.filter((_, currentIndex) => currentIndex !== index))}/>
                  {(scope === 'mine' && (record.status === 'resolved' || record.status === 'closed')) && <p className="feedback-reopen-note">{t('feedbackPage.reopenNote')}</p>}
                  <div><button className="ghost-button" type="button" disabled={saving} onClick={cancelReply}>{t('common.cancel')}</button><button className="primary-button" type="button" disabled={saving || !replyText.trim()} onClick={() => void sendReply(record)}>{saving ? t('feedbackPage.sending') : scope === 'admin' ? t('feedbackPage.sendReplyAdmin') : t('feedbackPage.sendReplyMine')}</button></div>
                </div>
              : <button className="ghost-button feedback-open-reply" type="button" onClick={() => beginReply(record.id)}><MessageCircle size={15}/>{scope === 'admin' ? t('feedbackPage.replyToUser') : record.replies.length ? t('feedbackPage.continueReply') : t('feedbackPage.appendNote')}</button>}
          </div>
        </article>
      })}
    </div>
  </>
}

export function FeedbackPage() {
  const t = useT()
  const feedbackOptions = useFeedbackOptions()
  const placeholders = usePlaceholders()
  const [view, setView] = useState<'submit' | 'mine' | 'admin'>('submit')
  const [type, setType] = useState<FeedbackType>('bug')
  const [content, setContent] = useState('')
  const [screenshots, setScreenshots] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string }>()
  const [sessionReady, setSessionReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    void getFeedbackSessionContext({ refresh: true }).then(context => {
      setSignedIn(Boolean(context.session))
      setIsAdmin(context.isAdmin)
      setSessionReady(true)
    }).catch(() => setSessionReady(true))
  }, [])

  useEffect(() => {
    let disposed = false
    const refreshUnread = () => {
      void getUnreadFeedbackReplyCount().then(count => { if (!disposed) setUnreadCount(count) }).catch(() => undefined)
    }
    const onUnreadChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ count?: number }>).detail
      if (typeof detail?.count === 'number') setUnreadCount(detail.count)
      else refreshUnread()
    }
    refreshUnread()
    window.addEventListener(FEEDBACK_UNREAD_EVENT, onUnreadChanged)
    return () => { disposed = true; window.removeEventListener(FEEDBACK_UNREAD_EVENT, onUnreadChanged) }
  }, [])

  const chooseScreenshots = (files: FileList | null) => {
    const next = Array.from(files ?? [])
    const error = validateFeedbackScreenshots(next)
    if (error) { setStatus({ kind: 'error', message: error }); return }
    if (next.length > 0 && !signedIn) { setStatus({ kind: 'error', message: t('feedbackPage.loginRequiredToUpload') }); return }
    setScreenshots(next)
    setStatus(undefined)
  }

  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault()
    const trimmed = content.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setStatus(undefined)
    try {
      const result = await submitFeedback({ type, content: trimmed, screenshots })
      setContent('')
      setScreenshots([])
      setRefreshKey(value => value + 1)
      const extra = result.failedCount > 0 ? t('feedbackPage.submitFailedGeneric', { count: result.failedCount }) : t('feedbackPage.submitSuccess')
      setStatus({ kind: 'success', message: extra })
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : t('feedbackPage.submitFailed') })
    } finally { setSubmitting(false) }
  }

  return <div className="feedback-page">
    <section className="feedback-hero">
      <div>
        <span className="feedback-eyebrow">{t('feedbackPage.heroEyebrow')}</span>
        <h2>{t('feedbackPage.heroTitle')}</h2>
        <p>{t('feedbackPage.heroText')}</p>
      </div>
    </section>

    {unreadCount > 0 && <div className="feedback-unread-banner" role="status">
      <Bell size={19}/>
      <div><strong>{t('feedbackPage.unreadTitle')}</strong><span>{t('feedbackPage.unreadText', { count: unreadCount })}</span></div>
      <button className="primary-button" type="button" onClick={() => setView('mine')}>{t('feedbackPage.viewReplies')}</button>
    </div>}

    <div className="feedback-tabs" role="tablist" aria-label={t('feedbackPage.tabsAriaLabel')}>
      <button type="button" className={view === 'submit' ? 'active' : ''} onClick={() => setView('submit')}>{t('feedbackPage.tabSubmit')}</button>
      <button type="button" className={view === 'mine' ? 'active' : ''} onClick={() => setView('mine')}>{t('feedbackPage.tabMine')}{unreadCount > 0 && <em>{unreadCount > 99 ? '99+' : unreadCount}</em>}</button>
      {isAdmin && <button type="button" className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>{t('feedbackPage.tabAdmin')}</button>}
    </div>

    {view === 'submit' && <form className="feedback-form" onSubmit={submit}>
      <fieldset className="feedback-type-fieldset">
        <legend>{t('feedbackPage.typeFieldsetLegend')}</legend>
        <div className="feedback-type-grid">
          {feedbackOptions.map(option => {
            const Icon = option.icon
            const selected = type === option.type
            return <label className={`feedback-type-option ${selected ? 'selected' : ''}`} key={option.type}>
              <input type="radio" name="feedback-type" value={option.type} checked={selected} onChange={() => { setType(option.type); setStatus(undefined) }}/>
              <span className="feedback-type-icon"><Icon size={20}/></span>
              <span className="feedback-type-copy"><strong>{option.title}</strong><small>{option.description}</small></span>
              <span className="feedback-radio-dot" aria-hidden="true"/>
            </label>
          })}
        </div>
      </fieldset>

      <label className="feedback-content-field">
        <span className="feedback-field-heading"><strong>{t('feedbackPage.contentLabel')}</strong><small>{t('feedbackPage.charCount', { count: content.length })}</small></span>
        <textarea value={content} onChange={event => { setContent(event.target.value); if (status) setStatus(undefined) }} placeholder={placeholders[type]} maxLength={4000} rows={9} required/>
      </label>

      <div className="feedback-screenshot-field">
        <div className="feedback-field-heading"><strong>{t('feedbackPage.screenshotLabel')} <span>{t('feedbackPage.optional')}</span></strong><small>{t('feedbackPage.attachLimit')}</small></div>
        <label className={`feedback-upload ${!signedIn && sessionReady ? 'disabled' : ''}`}>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={!signedIn && sessionReady} onChange={event => chooseScreenshots(event.target.files)}/>
          <Upload size={18}/><span>{signedIn ? t('feedbackPage.chooseScreenshot') : t('feedbackPage.loginToUpload')}</span>
        </label>
        {screenshots.length > 0 && <div className="feedback-selected-files">
          {screenshots.map((file, index) => <div key={`${file.name}-${file.size}-${index}`}><span>{file.name}</span><button type="button" aria-label={t('feedbackPage.removeFile', { name: file.name })} onClick={() => setScreenshots(current => current.filter((_, currentIndex) => currentIndex !== index))}><X size={15}/></button></div>)}
        </div>}
      </div>

      {status && <div className={`feedback-status ${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.kind === 'success' && <CheckCircle2 size={18}/>}<span>{status.message}</span></div>}

      <div className="feedback-submit-row">
        <p>{t('feedbackPage.privacyNote')}</p>
        <button className="primary-button" type="submit" disabled={submitting || !content.trim()}><CheckCircle2 size={16}/>{submitting ? t('feedbackPage.submitting') : t('feedbackPage.submit')}</button>
      </div>
    </form>}

    {view === 'mine' && <section className="feedback-panel">
      <div className="feedback-panel-head"><div><h3>{t('feedbackPage.myFeedbackTitle')}</h3><p>{signedIn ? t('feedbackPage.myFeedbackTextSignedIn') : t('feedbackPage.myFeedbackTextGuest')}</p></div>{sessionReady && <button className="ghost-button" type="button" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={15}/>{t('feedbackPage.refresh')}</button>}</div>
      {!sessionReady ? <div className="feedback-empty"><RefreshCw size={18}/><span>{t('feedbackPage.preparingRecords')}</span></div> : <FeedbackList scope="mine" refreshKey={refreshKey} onUnreadCountChange={setUnreadCount}/>}
    </section>}

    {view === 'admin' && isAdmin && <section className="feedback-panel feedback-admin-panel">
      <div className="feedback-panel-head"><div><h3>{t('feedbackPage.adminTitle')}</h3><p>{t('feedbackPage.adminText')}</p></div><button className="ghost-button" type="button" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={15}/>{t('feedbackPage.refresh')}</button></div>
      <FeedbackList scope="admin" refreshKey={refreshKey}/>
    </section>}
  </div>
}
