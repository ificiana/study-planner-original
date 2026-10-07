import type { Session } from '@supabase/supabase-js'
import { visitorId } from './analytics'
import { getSession, supabase } from './supabase'
import { translate, tr, type Language } from './i18n'

export type FeedbackType = 'bug' | 'suggestion' | 'experience' | 'other'
export type FeedbackStatus = 'new' | 'reviewing' | 'planned' | 'resolved' | 'closed'
export type FeedbackReplyAuthor = 'admin' | 'user' | 'guest'

export interface FeedbackAttachment {
  id: string
  feedback_id: string
  reply_id: string | null
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  created_at: string
  signed_url?: string
}

export interface FeedbackReply {
  id: string
  feedback_id: string
  content: string
  created_at: string
  author_type: FeedbackReplyAuthor
  read_at: string | null
  attachments: FeedbackAttachment[]
}

export interface FeedbackRecord {
  id: string
  user_id: string | null
  feedback_type: FeedbackType
  content: string
  status: FeedbackStatus
  created_at: string
  replies: FeedbackReply[]
  attachments: FeedbackAttachment[]
  app_version?: string | null
  page_path?: string | null
  user_agent?: string | null
  visitor_id?: string | null
  account_mode?: string | null
  utm_source?: string | null
  utm_campaign?: string | null
  first_referrer?: string | null
  browser_language?: string | null
  client_timezone?: string | null
  is_pwa?: boolean | null
  first_seen_at?: string | null
  last_seen_at?: string | null
  tenure_days?: number | null
  total_sessions?: number | null
  total_events?: number | null
  total_active_days?: number | null
  sessions_30d?: number | null
  events_30d?: number | null
  active_days_30d?: number | null
  unique_pages_30d?: number | null
  assignment_count?: number | null
  completed_assignment_count?: number | null
  task_group_count?: number | null
  goal_count?: number | null
  intake_batch_count?: number | null
  replan_count?: number | null
  depth_score?: number | null
  depth_level?: string | null
  depth_calculated_at?: string | null
}

export interface FeedbackSessionContext {
  session: Session | null
  isAdmin: boolean
}

export const FEEDBACK_UNREAD_EVENT = 'study-planner:feedback-unread-changed'

const SCREENSHOT_BUCKET = 'feedback-screenshots'
const GUEST_SECRET_KEY = 'study-planner:feedback-guest-secret'
const MAX_SCREENSHOTS = 3
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
const ALLOWED_SCREENSHOT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const ADMIN_DETAIL_COLUMNS = [
  'id', 'feedback_type', 'content', 'user_id', 'created_at',
  'app_version', 'page_path', 'user_agent', 'status', 'visitor_id', 'account_mode',
  'utm_source', 'utm_campaign', 'first_referrer', 'browser_language', 'client_timezone', 'is_pwa',
  'first_seen_at', 'last_seen_at', 'tenure_days',
  'total_sessions', 'total_events', 'total_active_days',
  'sessions_30d', 'events_30d', 'active_days_30d', 'unique_pages_30d',
  'assignment_count', 'completed_assignment_count', 'task_group_count', 'goal_count', 'intake_batch_count', 'replan_count',
  'depth_score', 'depth_level', 'depth_calculated_at',
].join(',')
let memoryGuestSecret = ''

function sessionIsFeedbackAdmin(session: Session | null): boolean {
  return Boolean((session?.user as any)?.app_metadata?.feedback_admin === true)
}

export async function getFeedbackSessionContext(options?: { refresh?: boolean }): Promise<FeedbackSessionContext> {
  let session = await getSession()
  if (session && options?.refresh && supabase) {
    const refreshed = await supabase.auth.refreshSession()
    if (!refreshed.error && refreshed.data.session) session = refreshed.data.session
  }
  return { session, isAdmin: sessionIsFeedbackAdmin(session) }
}

export function validateFeedbackScreenshots(files: File[], language: Language = 'zh'): string | undefined {
  if (files.length > MAX_SCREENSHOTS) return translate(language, 'feedback.screenshot.tooMany', { max: MAX_SCREENSHOTS })
  for (const file of files) {
    if (!ALLOWED_SCREENSHOT_TYPES.has(file.type)) return translate(language, 'feedback.screenshot.typeError')
    if (file.size <= 0 || file.size > MAX_SCREENSHOT_BYTES) return translate(language, 'feedback.screenshot.sizeError')
  }
  return undefined
}

function screenshotExtension(file: File) {
  if (file.type === 'image/png') return 'png'
  if (file.type === 'image/webp') return 'webp'
  return 'jpg'
}

function randomToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function guestFeedbackSecret(): string {
  if (memoryGuestSecret) return memoryGuestSecret
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(GUEST_SECRET_KEY)
      if (stored && stored.length >= 32) {
        memoryGuestSecret = stored
        return stored
      }
    } catch {
      // localStorage 不可用时退回到当前页面生命周期内的内存密钥。
    }
  }

  const generated = `${randomToken()}.${randomToken()}`
  memoryGuestSecret = generated
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(GUEST_SECRET_KEY, generated) } catch { /* ignore */ }
  }
  return generated
}

export function broadcastFeedbackUnreadCount(count?: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(FEEDBACK_UNREAD_EVENT, { detail: typeof count === 'number' ? { count } : {} }))
}

async function uploadFeedbackScreenshots(session: Session, feedbackId: string, screenshots: File[], replyId?: string, language: Language = 'zh') {
  if (!supabase) return { uploadedCount: 0, failedCount: screenshots.length }
  let uploadedCount = 0
  let failedCount = 0

  for (const file of screenshots) {
    const folder = replyId ? `${session.user.id}/${feedbackId}/replies/${replyId}` : `${session.user.id}/${feedbackId}`
    const storagePath = `${folder}/${randomToken()}.${screenshotExtension(file)}`
    const upload = await supabase.storage.from(SCREENSHOT_BUCKET).upload(storagePath, file, {
      cacheControl: '3600',
      contentType: file.type,
      upsert: false,
    })
    if (upload.error) {
      failedCount += 1
      continue
    }
    const metadata = await supabase.from('feedback_attachments').insert({
      feedback_id: feedbackId,
      reply_id: replyId ?? null,
      storage_path: storagePath,
      file_name: file.name.slice(0, 255) || translate(language, 'feedback.screenshotFileName', { ext: screenshotExtension(file) }),
      mime_type: file.type,
      size_bytes: file.size,
    })
    if (metadata.error) {
      failedCount += 1
      // 元数据失败时删除已上传对象，避免私有桶留下无法关联的孤儿文件。
      await supabase.storage.from(SCREENSHOT_BUCKET).remove([storagePath]).catch(() => undefined)
    } else uploadedCount += 1
  }

  return { uploadedCount, failedCount }
}

export async function submitFeedback(input: { type: FeedbackType; content: string; screenshots?: File[] }, language: Language = 'zh') {
  if (!supabase) throw new Error(translate(language, 'feedback.serviceUnavailable'))
  const content = input.content.trim()
  const screenshots = input.screenshots ?? []
  if (!content) throw new Error(translate(language, 'feedback.contentRequired'))
  if (content.length > 4000) throw new Error(translate(language, 'feedback.contentTooLong'))
  const screenshotError = validateFeedbackScreenshots(screenshots, language)
  if (screenshotError) throw new Error(screenshotError)

  const session = await getSession()
  if (screenshots.length > 0 && !session) throw new Error(translate(language, 'feedback.loginRequiredForScreenshots'))

  const stableVisitorId = typeof window === 'undefined' ? null : visitorId()

  if (!session) {
    if (!stableVisitorId) throw new Error(translate(language, 'feedback.submitFailedRefresh'))
    const result = await supabase.rpc('submit_guest_feedback', {
      p_feedback_type: input.type,
      p_content: content,
      p_visitor_id: stableVisitorId,
      p_guest_secret: guestFeedbackSecret(),
    })
    if (result.error || !result.data) throw new Error(translate(language, 'feedback.submitFailedRetry'))
    return { id: String(result.data), uploadedCount: 0, failedCount: 0 }
  }

  const basePayload = {
    feedback_type: input.type,
    content,
    user_id: session.user.id,
    visitor_id: stableVisitorId,
  }

  const inserted = await supabase.from('feedback_submissions').insert(basePayload).select('id').single()
  if (inserted.error || !inserted.data?.id) throw new Error(translate(language, 'feedback.submitFailedRetry'))
  const feedbackId = String(inserted.data.id)
  const uploads = await uploadFeedbackScreenshots(session, feedbackId, screenshots, undefined, language)
  broadcastFeedbackUnreadCount()
  return { id: feedbackId, ...uploads }
}

async function signedAttachment(attachment: FeedbackAttachment): Promise<FeedbackAttachment> {
  if (!supabase) return attachment
  const signed = await supabase.storage.from(SCREENSHOT_BUCKET).createSignedUrl(attachment.storage_path, 60 * 30)
  return signed.error || !signed.data?.signedUrl ? attachment : { ...attachment, signed_url: signed.data.signedUrl }
}

function normalizeGuestReply(row: any): FeedbackReply {
  return {
    id: String(row.id),
    feedback_id: String(row.feedback_id),
    content: String(row.content ?? ''),
    created_at: String(row.created_at),
    author_type: (row.author_type === 'user' || row.author_type === 'guest' ? row.author_type : 'admin') as FeedbackReplyAuthor,
    read_at: row.read_at ? String(row.read_at) : null,
    attachments: [],
  }
}

async function listGuestReplyAttachments(stableVisitorId: string, guestSecret: string, language: Language = 'zh'): Promise<FeedbackAttachment[]> {
  try {
    const response = await fetch('/api/feedback-guest-attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: stableVisitorId, guestSecret }),
    })
    if (!response.ok) return []
    const payload = await response.json() as { attachments?: any[] }
    if (!Array.isArray(payload.attachments)) return []
    return payload.attachments.flatMap((row: any): FeedbackAttachment[] => {
      if (!row?.id || !row?.feedback_id || !row?.reply_id || typeof row?.signed_url !== 'string') return []
      return [{
        id: String(row.id),
        feedback_id: String(row.feedback_id),
        reply_id: String(row.reply_id),
        // 服务端刻意不返回 Storage 路径；游客只拿到 30 分钟签名地址。
        storage_path: '',
        file_name: String(row.file_name ?? translate(language, 'feedback.replyImageFallbackName')),
        mime_type: String(row.mime_type ?? 'image/jpeg'),
        size_bytes: Number(row.size_bytes ?? 0),
        created_at: String(row.created_at ?? ''),
        signed_url: row.signed_url,
      }]
    })
  } catch {
    // 图片签名失败不应阻断游客查看文字会话。
    return []
  }
}

async function listGuestFeedbackForBrowser(language: Language = 'zh'): Promise<FeedbackRecord[]> {
  if (!supabase || typeof window === 'undefined') return []
  const stableVisitorId = visitorId()
  const secret = guestFeedbackSecret()
  const result = await supabase.rpc('list_guest_feedback', {
    p_visitor_id: stableVisitorId,
    p_guest_secret: secret,
  })
  if (result.error) throw new Error(translate(language, 'feedback.guestHistoryFailed'))
  if (!Array.isArray(result.data)) return []

  const records = result.data.map((row: any): FeedbackRecord => ({
    id: String(row.id),
    user_id: row.user_id ? String(row.user_id) : null,
    feedback_type: row.feedback_type as FeedbackType,
    content: String(row.content ?? ''),
    status: row.status as FeedbackStatus,
    created_at: String(row.created_at),
    replies: Array.isArray(row.replies) ? row.replies.map(normalizeGuestReply) : [],
    attachments: [],
  }))
  if (!records.length) return []

  const attachments = await listGuestReplyAttachments(stableVisitorId, secret, language)
  return records.map(record => ({
    ...record,
    replies: record.replies.map(reply => ({
      ...reply,
      attachments: attachments.filter(attachment => attachment.reply_id === reply.id),
    })),
  }))
}

function newestFirst(records: FeedbackRecord[]): FeedbackRecord[] {
  const seen = new Set<string>()
  return records
    .filter(record => {
      if (seen.has(record.id)) return false
      seen.add(record.id)
      return true
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export async function listFeedback(scope: 'mine' | 'admin', language: Language = 'zh'): Promise<FeedbackRecord[]> {
  if (!supabase) throw new Error(translate(language, 'feedback.serviceUnavailable'))
  const { session, isAdmin } = await getFeedbackSessionContext({ refresh: true })
  if (scope === 'admin' && (!session || !isAdmin)) throw new Error(translate(language, 'feedback.noPermission'))

  const guestRows = scope === 'mine' ? await listGuestFeedbackForBrowser(language) : []
  if (!session) return guestRows

  let rows: Array<Omit<FeedbackRecord, 'replies' | 'attachments'>> = []
  if (scope === 'admin') {
    const submissions = await supabase
      .from('feedback_submissions')
      .select(ADMIN_DETAIL_COLUMNS)
      .order('created_at', { ascending: false })
    if (submissions.error) throw new Error(translate(language, 'feedback.detailLoadFailed'))
    rows = (submissions.data ?? []) as unknown as Array<Omit<FeedbackRecord, 'replies' | 'attachments'>>
  } else {
    const submissions = await supabase
      .from('feedback_submissions')
      .select('id,user_id,feedback_type,content,status,created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
    if (submissions.error) throw new Error(translate(language, 'feedback.recordLoadFailed'))
    rows = (submissions.data ?? []) as Array<Omit<FeedbackRecord, 'replies' | 'attachments'>>
  }

  if (rows.length === 0) return newestFirst(guestRows)

  const ids = rows.map(row => row.id)
  const [repliesResult, attachmentsResult] = await Promise.all([
    supabase.from('feedback_replies').select('id,feedback_id,content,created_at,author_type,read_at').in('feedback_id', ids).order('created_at', { ascending: true }),
    supabase.from('feedback_attachments').select('id,feedback_id,reply_id,storage_path,file_name,mime_type,size_bytes,created_at').in('feedback_id', ids).order('created_at', { ascending: true }),
  ])
  if (repliesResult.error) throw new Error(translate(language, 'feedback.threadLoadFailed'))
  if (attachmentsResult.error) throw new Error(translate(language, 'feedback.screenshotLoadFailed'))

  const replies = (repliesResult.data ?? []).map((reply: any): FeedbackReply => ({
    id: String(reply.id),
    feedback_id: String(reply.feedback_id),
    content: String(reply.content ?? ''),
    created_at: String(reply.created_at),
    author_type: (reply.author_type === 'user' || reply.author_type === 'guest' ? reply.author_type : 'admin') as FeedbackReplyAuthor,
    read_at: reply.read_at ? String(reply.read_at) : null,
    attachments: [],
  }))
  const attachments = await Promise.all(((attachmentsResult.data ?? []) as unknown as FeedbackAttachment[]).map(signedAttachment))
  const accountRows = rows.map(row => ({
    ...row,
    replies: replies
      .filter(reply => reply.feedback_id === row.id)
      .map(reply => ({ ...reply, attachments: attachments.filter(attachment => attachment.reply_id === reply.id) })),
    attachments: attachments.filter(attachment => attachment.feedback_id === row.id && !attachment.reply_id),
  }))

  return scope === 'mine' ? newestFirst([...accountRows, ...guestRows]) : accountRows
}

export async function replyToFeedback(feedbackId: string, content: string, screenshots: File[] = [], language: Language = 'zh') {
  if (!supabase) throw new Error(translate(language, 'feedback.serviceUnavailable'))
  const trimmed = content.trim()
  if (!trimmed) throw new Error(translate(language, 'feedback.replyContentRequired'))
  if (trimmed.length > 4000) throw new Error(translate(language, 'feedback.replyTooLong'))
  const screenshotError = validateFeedbackScreenshots(screenshots, language)
  if (screenshotError) throw new Error(screenshotError)
  const { session, isAdmin } = await getFeedbackSessionContext({ refresh: true })
  if (!session || !isAdmin) throw new Error(translate(language, 'feedback.noPermission'))

  const inserted = await supabase
    .from('feedback_replies')
    .insert({ feedback_id: feedbackId, content: trimmed, author_type: 'admin' })
    .select('id')
    .single()
  if (inserted.error || !inserted.data?.id) throw new Error(translate(language, 'feedback.replySendFailed'))
  const uploads = await uploadFeedbackScreenshots(session, feedbackId, screenshots, String(inserted.data.id), language)
  const statusUpdate = await supabase.from('feedback_submissions').update({ status: 'reviewing' }).eq('id', feedbackId).eq('status', 'new')
  if (statusUpdate.error) console.warn(tr('fb.001'), statusUpdate.error)
  broadcastFeedbackUnreadCount()
  return uploads
}

export async function appendFeedbackReply(record: FeedbackRecord, content: string, screenshots: File[] = [], language: Language = 'zh') {
  if (!supabase) throw new Error(translate(language, 'feedback.serviceUnavailable'))
  const trimmed = content.trim()
  if (!trimmed) throw new Error(translate(language, 'feedback.followupContentRequired'))
  if (trimmed.length > 4000) throw new Error(translate(language, 'feedback.followupTooLong'))
  const screenshotError = validateFeedbackScreenshots(screenshots, language)
  if (screenshotError) throw new Error(screenshotError)

  const session = await getSession()
  if (!record.user_id) {
    if (screenshots.length > 0) throw new Error(translate(language, 'feedback.guestFollowupNoImages'))
    if (typeof window === 'undefined') throw new Error(translate(language, 'feedback.envCannotVerifyGuest'))
    const result = await supabase.rpc('reply_to_guest_feedback', {
      p_feedback_id: record.id,
      p_visitor_id: visitorId(),
      p_guest_secret: guestFeedbackSecret(),
      p_content: trimmed,
    })
    if (result.error || !result.data) throw new Error(translate(language, 'feedback.followupFailed'))
    broadcastFeedbackUnreadCount()
    return { uploadedCount: 0, failedCount: 0 }
  }

  if (!session || session.user.id !== record.user_id) throw new Error(translate(language, 'feedback.wrongAccountForReply'))
  const inserted = await supabase
    .from('feedback_replies')
    .insert({ feedback_id: record.id, content: trimmed, author_type: 'user' })
    .select('id')
    .single()
  if (inserted.error || !inserted.data?.id) throw new Error(translate(language, 'feedback.followupFailed'))
  const uploads = await uploadFeedbackScreenshots(session, record.id, screenshots, String(inserted.data.id), language)

  if (record.status === 'resolved' || record.status === 'closed') {
    const reopened = await supabase.from('feedback_submissions').update({ status: 'reviewing' }).eq('id', record.id)
    if (reopened.error) console.warn(tr('fb.002'), reopened.error)
  }
  broadcastFeedbackUnreadCount()
  return uploads
}

function unreadAdminReplies(records: FeedbackRecord[]) {
  return records.reduce((sum, record) => sum + record.replies.filter(reply => reply.author_type === 'admin' && !reply.read_at).length, 0)
}

export async function getUnreadFeedbackReplyCount(): Promise<number> {
  if (!supabase) return 0
  let total = 0
  try {
    total += unreadAdminReplies(await listGuestFeedbackForBrowser())
  } catch {
    // 游客历史不可用不应影响已登录账号的通知检查。
  }

  const session = await getSession()
  if (!session) return total
  const submissions = await supabase.from('feedback_submissions').select('id').eq('user_id', session.user.id)
  if (submissions.error) return total
  const ids = (submissions.data ?? []).map((row: any) => String(row.id))
  if (!ids.length) return total
  const replies = await supabase
    .from('feedback_replies')
    .select('id')
    .in('feedback_id', ids)
    .eq('author_type', 'admin')
    .is('read_at', null)
  if (!replies.error) total += replies.data?.length ?? 0
  return total
}

export async function markFeedbackRepliesRead(records: FeedbackRecord[]): Promise<number> {
  if (!supabase) return 0
  const session = await getSession()
  const accountReplyIds = records.flatMap(record =>
    record.user_id && session?.user.id === record.user_id
      ? record.replies.filter(reply => reply.author_type === 'admin' && !reply.read_at).map(reply => reply.id)
      : [],
  )
  if (accountReplyIds.length) {
    const marked = await supabase.from('feedback_replies').update({ read_at: new Date().toISOString() }).in('id', accountReplyIds)
    if (marked.error) console.warn(tr('fb.003'), marked.error)
  }

  const hasUnreadGuestReply = records.some(record => !record.user_id && record.replies.some(reply => reply.author_type === 'admin' && !reply.read_at))
  if (hasUnreadGuestReply && typeof window !== 'undefined') {
    const markedGuest = await supabase.rpc('mark_guest_feedback_replies_read', {
      p_visitor_id: visitorId(),
      p_guest_secret: guestFeedbackSecret(),
    })
    if (markedGuest.error) console.warn(tr('fb.004'), markedGuest.error)
  }

  const remaining = await getUnreadFeedbackReplyCount()
  broadcastFeedbackUnreadCount(remaining)
  return remaining
}

export async function markAdminFollowupsRead(records: FeedbackRecord[]) {
  if (!supabase) return
  const { isAdmin } = await getFeedbackSessionContext({ refresh: false })
  if (!isAdmin) return
  const ids = records.flatMap(record => record.replies.filter(reply => (reply.author_type === 'user' || reply.author_type === 'guest') && !reply.read_at).map(reply => reply.id))
  if (!ids.length) return
  const marked = await supabase.from('feedback_replies').update({ read_at: new Date().toISOString() }).in('id', ids)
  if (marked.error) console.warn(tr('fb.005'), marked.error)
}

export async function updateFeedbackStatus(feedbackId: string, status: FeedbackStatus, language: Language = 'zh') {
  if (!supabase) throw new Error(translate(language, 'feedback.serviceUnavailable'))
  const { isAdmin } = await getFeedbackSessionContext({ refresh: true })
  if (!isAdmin) throw new Error(translate(language, 'feedback.noPermission'))
  const result = await supabase.from('feedback_submissions').update({ status }).eq('id', feedbackId)
  if (result.error) throw new Error(translate(language, 'feedback.statusUpdateFailed'))
}
