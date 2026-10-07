import { useEffect, useMemo, useState } from 'react'
import type {
  AppState,
  Assignment,
  ConflictResolutionAction,
  ConflictResolutionDecision,
  ConstraintException,
  ConstraintExceptionResolutionDecision,
  Goal,
  PlanAdjustmentPolicy,
  PlanChangeEvent,
  ProposalIssue,
  SchedulingProposal,
} from '../types'
import { Modal } from './Modal'
import { useT } from '../lib/i18n'
import { fmtDate, minutesText } from '../lib/date'
import { reviseSchedulingProposal, type ProposalMovementRevision } from '../lib/planner'
import { categoryLabel, conflictProfile, isBlockingDecisionIssue, isTodayIncomingIssue, preferredAutoResolution, resolutionLabel } from '../lib/conflicts'

const preferenceKeys: Record<string, string> = {
  preserve: 'prop.pref.preserve', balanced: 'prop.pref.balanced', goal: 'prop.pref.goal', rest: 'prop.pref.rest'
}

function recommendedProposal(proposals: SchedulingProposal[], event?: PlanChangeEvent) {
  if (event?.metadata?.explicitLocalOperation === true || event?.metadata?.operationScope === 'requested-change-only') {
    const requestedLabel = typeof event.metadata?.requestedChangeLabel === 'string' ? event.metadata.requestedChangeLabel : undefined
    return proposals.find(item => requestedLabel ? item.title === requestedLabel : item.preference === 'preserve') ?? proposals[0]
  }
  return proposals.find(item => !item.infeasible) ?? proposals[0]
}

function initialVisibleCount(proposals: SchedulingProposal[]) {
  if (proposals.length <= 1) return proposals.length
  return proposals[0]?.infeasible ? Math.min(2, proposals.length) : 1
}

function exceptionId(item: ConstraintException, index: number) {
  return `${index}:${item.date}:${item.rawKey ?? item.key}:${item.overrideLimit ?? 'protected'}`
}

function localActionLabel(event: PlanChangeEvent) {
  const requested = typeof event.metadata?.requestedChangeLabel === 'string' ? event.metadata.requestedChangeLabel.trim() : ''
  return requested ? requested.replace(/^(仅|Only )/, '') : event.title
}

export function ProposalDialog({
  open,
  baseline,
  preparedState,
  event,
  proposals,
  policy,
  calculationRevision = 0,
  decisionSummary,
  moreExhausted,
  onClose,
  onApply,
  onKeep,
  onGenerateMore,
  onResolveConflicts,
  onRequestExternalChange,
  tutorialMode = false,
  onTutorialBlocked,
}: {
  open: boolean
  baseline: AppState
  preparedState: AppState
  event: PlanChangeEvent
  proposals: SchedulingProposal[]
  policy: PlanAdjustmentPolicy
  calculationRevision?: number
  decisionSummary?: string
  moreExhausted?: boolean
  onClose: () => void
  onApply: (proposal: SchedulingProposal) => void
  onKeep: () => void
  onGenerateMore?: () => void
  onResolveConflicts: (proposal: SchedulingProposal, decisions: ConflictResolutionDecision[], exceptionDecisions: ConstraintExceptionResolutionDecision[]) => void
  onRequestExternalChange?: (action: 'change-goal' | 'change-capacity') => void
  tutorialMode?: boolean
  onTutorialBlocked?: (message?: string) => void
}) {
  const t = useT()
  const initial = recommendedProposal(proposals, event)
  const explicitLocalOperation = event.metadata?.explicitLocalOperation === true || event.metadata?.operationScope === 'requested-change-only'
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount(proposals))
  const [selectedId, setSelectedId] = useState(initial?.id ?? '')
  const [drafts, setDrafts] = useState<Record<string, SchedulingProposal>>({})
  const [issueDecisions, setIssueDecisions] = useState<Record<string, ConflictResolutionAction>>({})
  const [exceptionDecisions, setExceptionDecisions] = useState<Record<string, 'accept-once' | 'system-find-another-date'>>({})

  useEffect(() => {
    const next = recommendedProposal(proposals, event)
    setVisibleCount(initialVisibleCount(proposals))
    setSelectedId(next?.id ?? '')
    setDrafts({})
    setIssueDecisions({})
    setExceptionDecisions({})
  }, [event.id, calculationRevision])

  const selectedBase = useMemo(() => proposals.find(item => item.id === selectedId) ?? recommendedProposal(proposals, event), [proposals, selectedId, event])
  const tutorialProposal = tutorialMode ? recommendedProposal(proposals, event) : undefined
  const displayedProposals = tutorialMode ? proposals : proposals.slice(0, visibleCount)
  const selected = selectedBase ? drafts[selectedBase.id] ?? selectedBase : undefined
  const singleLocalProposal = explicitLocalOperation && proposals.length === 1 && Boolean(selected)
  const recommendedId = recommendedProposal(proposals, event)?.id
  const assignmentMap = useMemo(() => new Map<string, Assignment>([...baseline.assignments, ...preparedState.assignments].map(item => [item.id, item])), [baseline, preparedState])
  const goalMap = useMemo(() => new Map<string, Goal>([...baseline.goals, ...preparedState.goals].map(item => [item.id, item])), [baseline, preparedState])
  // 重新计算后的方案只显示“相对上一个基准”的增量变化；这里补上与正式计划的累计差异，
  // 避免用户在多次冲突处理后误以为新方案只改动了一两天。
  const cumulativeVsBaseline = useMemo(() => {
    if (!selected) return undefined
    const afterById = new Map(selected.stateAfter.assignments.map(item => [item.id, item]))
    const beforeById = new Map(baseline.assignments.map(item => [item.id, item]))
    let moved = 0
    let scheduledNew = 0
    let unscheduled = 0
    for (const [id, after] of afterById) {
      if (after.status === 'done') continue
      const before = beforeById.get(id)
      if (!before) {
        if (after.scheduledDate) scheduledNew += 1
        else unscheduled += 1
        continue
      }
      if (after.scheduledDate !== before.scheduledDate) moved += 1
    }
    return { moved, scheduledNew, unscheduled }
  }, [selected, baseline])
  const directConflict = proposals.find(item => item.infeasible && item.title === policy.directPreviewLabel)
  const decisionIssues = selected?.infeasible ? selected.issues : []
  const blockingDecisionIssues = decisionIssues.filter(isBlockingDecisionIssue)
  const requiredExceptionEntries = selected?.exceptions.map((item, index) => ({ id: exceptionId(item, index), item })) ?? []
  const unresolvedIssues = blockingDecisionIssues.filter(issue => !issueDecisions[issue.id])
  const unresolvedExceptions = requiredExceptionEntries.filter(entry => !exceptionDecisions[entry.id])
  const unresolvedCount = unresolvedIssues.length + unresolvedExceptions.length
  const resolvedExceptionDecisions: ConstraintExceptionResolutionDecision[] = requiredExceptionEntries.flatMap(entry => {
    const action = exceptionDecisions[entry.id]
    return action ? [{ exception: entry.item, action }] : []
  })
  const rejectedExistingExceptions = resolvedExceptionDecisions.filter(entry => entry.action === 'system-find-another-date')
  const decisions = decisionIssues.flatMap(issue => issueDecisions[issue.id] ? [{ issueId: issue.id, action: issueDecisions[issue.id] }] : [])
  const externalDecision = decisions.find(item => item.action === 'change-goal' || item.action === 'change-capacity')?.action as 'change-goal' | 'change-capacity' | undefined
  const requiresRecalculation = Boolean(selected && ((selected.infeasible && blockingDecisionIssues.length > 0) || rejectedExistingExceptions.length > 0))
  const requestedActionLabel = localActionLabel(event)

  const resetDecisions = () => {
    setIssueDecisions({})
    setExceptionDecisions({})
  }
  const selectProposal = (proposalId: string) => {
    setSelectedId(proposalId)
    resetDecisions()
  }
  const showMore = () => {
    if (visibleCount < proposals.length) setVisibleCount(proposals.length)
    else onGenerateMore?.()
  }
  const keepLabel = event.metadata?.containsReviewRecord
    ? t('prop.keep.reviewOnly')
    : event.type === 'bulk-move'
      ? t('prop.keep.noBulk')
      : event.type === 'availability-change' && event.metadata?.pureRelaxation !== true
        ? t('prop.keep.saveAvailability')
        : event.type === 'new-task-insertion' || event.type === 'task-group-size-increase'
          ? t('prop.keep.createUnscheduled')
          : undefined

  const focusDecisionPanel = () => {
    document.getElementById('proposal-conflict-decisions')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handlePrimary = () => {
    if (!selected) {
      document.getElementById('proposal-no-solution')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (unresolvedCount > 0) {
      focusDecisionPanel()
      return
    }
    if (externalDecision) {
      onRequestExternalChange?.(externalDecision)
      return
    }
    if (requiresRecalculation) {
      onResolveConflicts(selected, decisions, resolvedExceptionDecisions)
      return
    }
    onApply(selected)
  }

  const primaryLabel = !selected
    ? t('prop.primary.viewOptions')
    : unresolvedCount > 0
      ? t('prop.primary.resolveN', { n: unresolvedCount })
      : externalDecision === 'change-goal'
        ? t('prop.primary.backToGoal')
        : externalDecision === 'change-capacity'
          ? t('prop.primary.backToCapacity')
          : requiresRecalculation
            ? t('prop.primary.recalculate')
            : explicitLocalOperation
              ? requestedActionLabel
            : selected.movements.length || selected.structuralChanges.length
              ? t('prop.primary.applyChanges')
              : t('prop.primary.confirmSave')

  const footer = <div className="proposal-footer-actions">
    <button className="proposal-cancel-action" onClick={onClose}>{t('common.cancel')}</button>
    {keepLabel && <button className={`secondary-button proposal-keep-action ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('prop.tut.applyRecommended')) : onKeep()}>{keepLabel}</button>}
    <button className="primary-button" data-tutorial-target="proposal-primary" data-tutorial-action="proposal-primary" onClick={handlePrimary}>{primaryLabel}</button>
  </div>

  return <Modal open={open} title={t('prop.title')} onClose={onClose} footer={footer} wide mobileFullscreen className="proposal-modal">
    <div className="proposal-dialog-shell">
    <section className={`proposal-event ${explicitLocalOperation ? 'proposal-event-local' : ''}`}>
      <div className="proposal-event-heading"><span className="proposal-event-kicker">{explicitLocalOperation ? t('prop.event.thisOperation') : t('prop.event.whatHappened')}</span><strong>{event.title}</strong></div>
      <p>{event.description}</p>
      {!explicitLocalOperation && <div className="proposal-policy-note"><strong>{t('prop.event.policy')}</strong><span>{policy.explanation}</span></div>}
      {explicitLocalOperation && <div className="proposal-local-principle"><strong>{t('prop.event.localOnly')}</strong><span>{t('prop.event.localOnlyDesc')}</span></div>}
      {decisionSummary && <div className="proposal-decision-summary"><strong>{t('prop.event.recalculated')}</strong><span>{decisionSummary}</span></div>}
    </section>

    {directConflict && <section className="proposal-direct-conflict">
      <div><strong>{t('prop.direct.found', { n: directConflict.issues.length })}</strong><span>{t('prop.direct.desc')}</span></div>
      <button type="button" className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('prop.tut.continueRecommended')) : selectProposal(directConflict.id)}>{t('prop.direct.view')}</button>
    </section>}

    {!proposals.length && <section id="proposal-no-solution" className="empty-state proposal-no-solution"><h3>{t('prop.none.title')}</h3><p>{t('prop.none.desc')}</p><div className="proposal-no-solution-actions">{onGenerateMore && <button type="button" className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('prop.tut.noWiden')) : onGenerateMore()}>{t('prop.none.widen')}</button>}<button type="button" className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('prop.tut.noCapacity')) : onRequestExternalChange?.('change-capacity')}>{t('prop.none.adjustCapacity')}</button><button type="button" className={`secondary-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} onClick={() => tutorialMode ? onTutorialBlocked?.(t('prop.tut.noGoal')) : onRequestExternalChange?.('change-goal')}>{t('prop.none.adjustGoal')}</button></div></section>}

    {!singleLocalProposal && <section className="proposal-options-heading">
      <div><strong>{tutorialMode ? t('prop.opts.tutorial') : proposals.length > 1 ? t('prop.opts.choose') : t('prop.opts.confirm')}</strong><span>{t('prop.opts.desc')}</span></div>
      {proposals.length > 1 && <small>{t('prop.opts.generated', { n: proposals.length })}{tutorialMode ? ` · ${t('prop.opts.tutorialFixed')}` : ''}</small>}
    </section>}
    {!singleLocalProposal && <div className="proposal-choice-list">
      {displayedProposals.map(proposal => {
        const display = drafts[proposal.id] ?? proposal
        const selectedChoice = selectedBase?.id === proposal.id
        const tutorialBlockedChoice = tutorialMode && proposal.id !== recommendedId
        return <button key={proposal.id} aria-disabled={tutorialBlockedChoice || undefined} className={`proposal-choice ${selectedChoice ? 'selected' : ''} ${proposal.infeasible ? 'proposal-choice-infeasible' : ''} ${tutorialBlockedChoice ? 'tutorial-disabled-control' : ''}`} onClick={() => tutorialBlockedChoice ? onTutorialBlocked?.(t('prop.tut.fixedRecommended')) : selectProposal(proposal.id)}>
          <div className="proposal-choice-title"><div><strong>{display.title}</strong><small>{preferenceKeys[display.preference] ? t(preferenceKeys[display.preference]) : display.preference} · {t('prop.choice.impact', { level: t(display.metrics.impactLevel === 'small' ? 'prop.impact.small' : display.metrics.impactLevel === 'medium' ? 'prop.impact.medium' : 'prop.impact.large') })}</small></div><span>{proposal.id === recommendedId ? t('prop.choice.recommended') : selectedChoice ? t('prop.choice.selected') : t('prop.choice.available')}</span></div>
          <div className="proposal-choice-metrics"><span>{t('prop.choice.moved', { n: display.metrics.movedTaskCount })}</span><span>{t('prop.choice.daysChanged', { n: display.metrics.affectedDateCount })}</span><span>{t('prop.choice.issues', { n: display.metrics.issueCount })}</span>{display.exceptions.length > 0 && <em>{t('prop.choice.exceptions', { n: display.exceptions.length })}</em>}</div>
          {cumulativeVsBaseline && (cumulativeVsBaseline.moved > 0 || cumulativeVsBaseline.scheduledNew > 0 || cumulativeVsBaseline.unscheduled > 0) && <div className="proposal-choice-cumulative">{t('prop.choice.cumulative', cumulativeVsBaseline)}</div>}
          {display.issueDelta && explicitLocalOperation && <div className="proposal-existing-issue-summary"><span>{t('prop.delta.existing', { n: display.issueDelta.preExistingCount })}</span><span>{t('prop.delta.resolved', { n: display.issueDelta.resolvedPreExistingCount })}</span><span>{t('prop.delta.newOrWorse', { n: display.issueDelta.newOrWorsenedCount })}</span></div>}
          <p>{display.infeasible ? display.infeasibleReason : display.description}</p>
        </button>
      })}
    </div>}

    {singleLocalProposal && selected && <LocalOperationResult proposal={selected} actionLabel={requestedActionLabel}/>} 

    {!singleLocalProposal && (visibleCount < proposals.length || onGenerateMore) && <button className={`secondary-button proposal-more ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} disabled={!tutorialMode && Boolean(moreExhausted && visibleCount >= proposals.length)} onClick={() => tutorialMode ? onTutorialBlocked?.(t('prop.tut.noMorePlans')) : showMore()}>{tutorialMode ? t('prop.more.tutorial') : visibleCount < proposals.length ? t('prop.more.compare', { n: proposals.length - visibleCount }) : moreExhausted ? t('prop.more.exhausted') : t('prop.more.generate')}</button>}
    {singleLocalProposal && onGenerateMore && <div className="proposal-local-alternatives"><div><strong>{t('prop.alt.title')}</strong><span>{t('prop.alt.desc')}</span></div><button type="button" className={`text-button ${tutorialMode ? 'tutorial-disabled-control' : ''}`} aria-disabled={tutorialMode || undefined} disabled={!tutorialMode && moreExhausted} onClick={() => tutorialMode ? onTutorialBlocked?.(t('prop.tut.noWidenAdjust')) : onGenerateMore()}>{tutorialMode ? t('prop.alt.tutorial') : moreExhausted ? t('prop.alt.none') : t('prop.alt.view')}</button></div>}

    {selected && selectedBase && <>
      <ProposalDetails proposal={selected} event={event} baseline={baseline} assignmentMap={assignmentMap} goalMap={goalMap} compactLocal={singleLocalProposal} tutorialMode={tutorialMode} onRevise={revision => {
        const revised = reviseSchedulingProposal(baseline, event, selected, revision)
        setDrafts(current => ({ ...current, [selectedBase.id]: revised }))
        resetDecisions()
      }}/>
      {(selected.infeasible || selected.exceptions.length > 0) && <ConflictDecisionPanel
        proposal={selected}
        assignmentMap={assignmentMap}
        issueDecisions={issueDecisions}
        exceptionDecisions={exceptionDecisions}
        onIssueDecision={(issueId, action) => setIssueDecisions(current => ({ ...current, [issueId]: action }))}
        onExceptionDecision={(id, action) => setExceptionDecisions(current => ({ ...current, [id]: action }))}
      />}
    </>}
    </div>
  </Modal>
}

function LocalOperationResult({ proposal, actionLabel }: { proposal: SchedulingProposal; actionLabel: string }) {
  const t = useT()
  const removedAssignments = proposal.structuralChanges.filter(change => change.entityType === 'assignment' && change.changeType === 'removed').length
  const directCount = removedAssignments || proposal.metrics.newTaskCount || proposal.structuralChanges.length
  const directLabel = removedAssignments ? t('prop.local.removeTask') : proposal.metrics.newTaskCount ? t('prop.local.addTask') : t('prop.local.direct')
  const directSection = proposal.structuralChanges.length ? 'structural' : proposal.metrics.newTaskCount ? 'new' : 'calculation'
  const newOrWorsened = proposal.issueDelta?.newOrWorsenedCount ?? proposal.metrics.issueCount
  const existing = proposal.issueDelta?.preExistingCount ?? 0

  return <section className="proposal-local-result">
    <header><div><span>{t('prop.local.result')}</span><strong>{actionLabel}</strong></div><em>{proposal.infeasible ? t('prop.local.needFix') : t('prop.local.canSave')}</em></header>
    <div className="proposal-local-result-grid">
      <button type="button" disabled={!directCount} onClick={() => openSection(proposal.id, directSection)}><strong>{directCount}</strong><span>{directLabel}</span></button>
      <button type="button" disabled={!proposal.movements.length} onClick={() => openSection(proposal.id, 'moves')}><strong>{proposal.movements.length}</strong><span>{t('prop.local.movedOthers')}</span></button>
      <button type="button" disabled={!proposal.metrics.affectedDateCount} onClick={() => openSection(proposal.id, 'dates')}><strong>{proposal.metrics.affectedDateCount}</strong><span>{t('prop.local.affectedDates')}</span></button>
      <button type="button" disabled={!newOrWorsened} className={newOrWorsened ? 'danger' : 'success'} onClick={() => openSection(proposal.id, 'issues')}><strong>{newOrWorsened}</strong><span>{t('prop.local.newOrWorse')}</span></button>
    </div>
    {proposal.issueDelta && <p>{t('prop.local.summary', { existing })}{proposal.issueDelta.resolvedPreExistingCount ? t('prop.local.summaryResolved', { n: proposal.issueDelta.resolvedPreExistingCount }) : ''}{proposal.issueDelta.improvedPreExistingCount ? t('prop.local.summaryImproved', { n: proposal.issueDelta.improvedPreExistingCount }) : ''}{t('prop.local.summaryEnd')}</p>}
  </section>
}

function ConflictDecisionPanel({ proposal, assignmentMap, issueDecisions, exceptionDecisions, onIssueDecision, onExceptionDecision }: {
  proposal: SchedulingProposal
  assignmentMap: Map<string, Assignment>
  issueDecisions: Record<string, ConflictResolutionAction>
  exceptionDecisions: Record<string, 'accept-once' | 'system-find-another-date'>
  onIssueDecision: (issueId: string, action: ConflictResolutionAction) => void
  onExceptionDecision: (id: string, action: 'accept-once' | 'system-find-another-date') => void
}) {
  const t = useT()
  const issues = proposal.infeasible ? proposal.issues.filter(isBlockingDecisionIssue) : []
  const unscheduledNotes = proposal.infeasible ? proposal.issues.filter(issue => !isBlockingDecisionIssue(issue)) : []
  const exceptionEntries = proposal.exceptions.map((item, index) => ({ id: exceptionId(item, index), item }))
  const autoResolvable = issues.some(issue => Boolean(preferredAutoResolution(issue)))
  const autoResolveAll = () => {
    for (const issue of issues) {
      const action = preferredAutoResolution(issue)
      if (action) onIssueDecision(issue.id, action)
    }
    for (const entry of exceptionEntries) {
      if (!exceptionDecisions[entry.id]) onExceptionDecision(entry.id, 'accept-once')
    }
  }
  const categoryCounts = new Map<string, number>()
  for (const issue of issues) {
    const label = categoryLabel(conflictProfile(issue).category)
    categoryCounts.set(label, (categoryCounts.get(label) ?? 0) + 1)
  }
  if (exceptionEntries.length) categoryCounts.set(t('prop.cd.oneTimeException'), exceptionEntries.length)
  const unresolved = issues.filter(issue => !issueDecisions[issue.id]).length + exceptionEntries.filter(entry => !exceptionDecisions[entry.id]).length

  return <section id="proposal-conflict-decisions" className="conflict-decision-panel">
    <div className="conflict-decision-heading">
      <div><span>{t('prop.cd.needYou')}</span><h3>{unresolved ? t('prop.cd.remaining', { n: unresolved }) : t('prop.cd.allDecided')}</h3><p>{t('prop.cd.intro')}</p>
        {unscheduledNotes.length > 0 && <p className="conflict-unscheduled-note">{t('prop.cd.unscheduledNote', { n: unscheduledNotes.length })}</p>}
      </div>
      <div className="conflict-category-chips">{[...categoryCounts].map(([label, count]) => <span key={label}>{label} {count}</span>)}</div>
    </div>
    {autoResolvable && <div className="conflict-auto-resolve">
      <button type="button" className="secondary-button" onClick={autoResolveAll}>{t('prop.cd.waiveAll')}</button>
      <span>{t('prop.cd.waiveAllDesc')}</span>
    </div>}

    {issues.map(issue => {
      const profile = conflictProfile(issue)
      const selected = issueDecisions[issue.id]
      return <article className={`conflict-decision-card conflict-${profile.category}`} key={issue.id}>
        <div className="conflict-decision-card-head"><div><span>{profile.label}</span><strong>{issue.title}</strong></div>{selected && <em>{t('prop.cd.selected', { label: resolutionLabel(selected, issue) })}</em>}</div>
        <p>{issue.detail}</p>
        {(issue.currentValue != null || issue.allowedValue != null) && <div className="conflict-values"><span><small>{t('prop.cd.afterAdjust')}</small>{issue.currentValue ?? '—'}</span><span><small>{t('prop.cd.currentlyAllowed')}</small>{issue.allowedValue ?? '—'}</span></div>}
        {issue.assignmentIds.length > 0 && <details><summary>{t('prop.cd.involvedTasks', { n: issue.assignmentIds.length })}</summary><ul>{issue.assignmentIds.map(id => <li key={id}>{assignmentMap.get(id)?.title ?? id}</li>)}</ul></details>}
        <div className="conflict-impact"><span>{profile.description}</span><small>{t('prop.cd.consequence', { text: issue.consequence })}</small></div>
        <ConflictResolutionChoices
          issue={issue}
          actions={profile.allowedResolutions}
          selected={selected}
          onSelect={action => onIssueDecision(issue.id, action)}
        />
      </article>
    })}

    {exceptionEntries.map(({ id, item }) => {
      const selected = exceptionDecisions[id]
      return <article className="conflict-decision-card conflict-waivable-rule" key={id}>
        <div className="conflict-decision-card-head"><div><span>{t('prop.cd.oneTimeException')}</span><strong>{fmtDate(item.date)} · {item.label}</strong></div>{selected && <em>{t('prop.cd.selected', { label: selected === 'accept-once' ? t('prop.cd.acceptOnce') : t('prop.cd.rejectException') })}</em>}</div>
        <p>{t('prop.cd.exceptionScope')}</p>
        {item.affectedAssignmentIds?.length ? <details><summary>{t('prop.cd.exceptionTasks', { n: item.affectedAssignmentIds.length })}</summary><ul>{item.affectedAssignmentIds.map(idValue => <li key={idValue}>{assignmentMap.get(idValue)?.title ?? idValue}</li>)}</ul></details> : null}
        <div className="conflict-resolution-grid two"><button type="button" className={selected === 'accept-once' ? 'selected' : ''} onClick={() => onExceptionDecision(id, 'accept-once')}><strong>{t('prop.cd.acceptOnce')}</strong><small>{t('prop.cd.acceptOnceDesc')}</small></button><button type="button" className={selected === 'system-find-another-date' ? 'selected' : ''} onClick={() => onExceptionDecision(id, 'system-find-another-date')}><strong>{t('prop.cd.rejectRecalc')}</strong><small>{t('prop.cd.rejectRecalcDesc')}</small></button></div>
      </article>
    })}
  </section>
}

function ConflictResolutionChoices({ issue, actions, selected, onSelect }: {
  issue?: ProposalIssue
  actions: ConflictResolutionAction[]
  selected?: ConflictResolutionAction
  onSelect: (action: ConflictResolutionAction) => void
}) {
  const t = useT()
  const direct = actions.filter(action => ['accept-once', 'system-find-another-date', 'keep-original', 'leave-unscheduled', 'unlock-and-move'].includes(action))
  const condition = actions.filter(action => action === 'change-goal' || action === 'change-capacity')
  const withdraw = actions.filter(action => action === 'cancel-change')
  const render = (items: ConflictResolutionAction[]) => <div className="conflict-resolution-grid">{items.map(action => <button
    type="button"
    className={selected === action ? 'selected' : ''}
    key={action}
    onClick={() => onSelect(action)}
  ><strong>{resolutionLabel(action, issue)}</strong><small>{resolutionDescription(action, t, issue)}</small></button>)}</div>

  return <div className="conflict-resolution-sections">
    {direct.length > 0 && <section><header><strong>{isTodayIncomingIssue(issue) ? t('prop.rc.todayTitle') : t('prop.rc.directTitle')}</strong><span>{isTodayIncomingIssue(issue) ? t('prop.rc.todayDesc') : t('prop.rc.directDesc')}</span></header>{render(direct)}</section>}
    {condition.length > 0 && <section><header><strong>{t('prop.rc.conditionTitle')}</strong><span>{isTodayIncomingIssue(issue) ? t('prop.rc.conditionToday') : t('prop.rc.conditionOther')}</span></header>{render(condition)}</section>}
    {withdraw.length > 0 && <section className="conflict-resolution-withdraw"><header><strong>{t('prop.rc.withdrawTitle')}</strong><span>{t('prop.rc.withdrawDesc')}</span></header>{render(withdraw)}</section>}
  </div>
}

function resolutionDescription(action: ConflictResolutionAction, t: ReturnType<typeof useT>, issue?: ProposalIssue) {
  if (isTodayIncomingIssue(issue)) {
    const todayDescriptions: Partial<Record<ConflictResolutionAction, string>> = {
      'accept-once': t('prop.rd.today.acceptOnce'),
      'system-find-another-date': t('prop.rd.today.findAnother'),
      'keep-original': t('prop.rd.today.keepOriginal'),
      'change-capacity': t('prop.rd.today.changeCapacity'),
    }
    return todayDescriptions[action] ?? action
  }
  const descriptions: Record<ConflictResolutionAction, string> = {
    'accept-once': t('prop.rd.acceptOnce'),
    'system-find-another-date': t('prop.rd.findAnother'),
    'keep-original': t('prop.rd.keepOriginal'),
    'leave-unscheduled': t('prop.rd.leaveUnscheduled'),
    'unlock-and-move': t('prop.rd.unlockAndMove'),
    'change-goal': t('prop.rd.changeGoal'),
    'change-capacity': t('prop.rd.changeCapacity'),
    'cancel-change': t('prop.rd.cancelChange'),
  }
  return descriptions[action]
}

function openSection(proposalId: string, section: string) {
  const element = document.getElementById(`proposal-${proposalId}-${section}`) as HTMLDetailsElement | null
  if (!element) return
  element.open = true
  element.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function ProposalDetails({ proposal, event, baseline, assignmentMap, goalMap, compactLocal = false, tutorialMode = false, onRevise }: { proposal: SchedulingProposal; event: PlanChangeEvent; baseline: AppState; assignmentMap: Map<string, Assignment>; goalMap: Map<string, Goal>; compactLocal?: boolean; tutorialMode?: boolean; onRevise: (revision: ProposalMovementRevision) => void }) {
  const t = useT()
  const newTaskIds = event.type === 'new-task-insertion' || event.type === 'task-group-size-increase' ? event.affectedAssignmentIds : []
  const manualMoves = proposal.movements.filter(item => item.manualIntentImpact === 'moved-manual')
  const explicitLocalOperation = event.metadata?.explicitLocalOperation === true || event.metadata?.operationScope === 'requested-change-only'
  const completedPreserved = tutorialMode ? baseline.assignments.filter(before => before.status === 'done' && proposal.stateAfter.assignments.some(after => after.id === before.id && after.status === before.status && after.scheduledDate === before.scheduledDate)).length : 0
  const lockedPreserved = tutorialMode ? baseline.assignments.filter(before => before.locked && proposal.stateAfter.assignments.some(after => after.id === before.id && after.locked && after.scheduledDate === before.scheduledDate)).length : 0
  const goalRiskImproved = tutorialMode && proposal.goalImpacts.some(item => (item.latestRiskBefore && !item.latestRiskAfter) || (item.desiredRiskBefore && !item.desiredRiskAfter) || Boolean(item.beforeExpectedCompletion && item.afterExpectedCompletion && item.afterExpectedCompletion < item.beforeExpectedCompletion))
  return <div className={`proposal-details ${compactLocal ? 'proposal-details-compact-local' : ''}`}>
    {tutorialMode && event.metadata?.requestedOutcome === 'fix-current' && <section className="tutorial-proposal-protection"><div><strong>{t('prop.pd.donePreserved')}</strong><span>{t('prop.pd.donePreservedDesc', { n: completedPreserved })}</span></div><div><strong>{t('prop.pd.lockedPreserved')}</strong><span>{t('prop.pd.lockedPreservedDesc', { n: lockedPreserved })}</span></div><div className={goalRiskImproved ? 'success' : 'warning'}><strong>{goalRiskImproved ? t('prop.pd.riskEased') : t('prop.pd.riskRemains')}</strong><span>{goalRiskImproved ? t('prop.pd.riskEasedDesc') : t('prop.pd.riskRemainsDesc')}</span></div></section>}
    {!compactLocal && explicitLocalOperation && proposal.issueDelta && <section className="proposal-scope-summary"><div><span>{t('prop.pd.scope')}</span><strong>{t('prop.pd.scopeOnlyUser')}</strong><p>{t('prop.pd.scopeDesc', { n: proposal.movements.length })}</p></div><div className="proposal-scope-stats"><span><small>{t('prop.pd.statExisting')}</small><strong>{proposal.issueDelta.preExistingCount}</strong></span><span><small>{t('prop.pd.statResolved')}</small><strong>{proposal.issueDelta.resolvedPreExistingCount}</strong></span><span><small>{t('prop.pd.statImproved')}</small><strong>{proposal.issueDelta.improvedPreExistingCount}</strong></span><span className={proposal.issueDelta.newOrWorsenedCount ? 'danger' : 'success'}><small>{t('prop.pd.statNewOrWorse')}</small><strong>{proposal.issueDelta.newOrWorsenedCount}</strong></span></div></section>}
    {proposal.infeasible && <div className="proposal-warning"><strong>{t('prop.pd.needFix')}</strong><p>{proposal.infeasibleReason}</p><small>{t('prop.pd.needFixDesc')}</small></div>}
    {!compactLocal && <section className="proposal-human-summary"><span>{t('prop.pd.result')}</span><h3>{proposal.infeasible ? t('prop.pd.found', { n: proposal.issues.length }) : proposal.goalImpacts.some(item => item.latestRiskAfter) ? t('prop.pd.executableRisk') : t('prop.pd.passed')}</h3><p>{proposal.metrics.manualTaskMoveCount ? t('prop.pd.touchesManual') : t('prop.pd.manualProtected')} {t('prop.pd.expandHint')}</p></section>}
    {!compactLocal && <div className="proposal-summary-grid">
      <ExpandableMetric label={t('prop.pd.mIssues')} value={proposal.metrics.issueCount} tone={proposal.metrics.issueCount ? 'danger' : 'success'} onClick={() => openSection(proposal.id, 'issues')}/>
      <ExpandableMetric label={t('prop.pd.mMoved')} value={proposal.metrics.movedTaskCount} onClick={() => openSection(proposal.id, 'moves')}/>
      <ExpandableMetric label={t('prop.pd.mDates')} value={proposal.metrics.affectedDateCount} onClick={() => openSection(proposal.id, 'dates')}/>
      <ExpandableMetric label={t('prop.pd.mNew')} value={proposal.metrics.newTaskCount} onClick={() => openSection(proposal.id, 'new')}/>
      <ExpandableMetric label={t('prop.pd.mManual')} value={proposal.metrics.manualTaskMoveCount} tone={proposal.metrics.manualTaskMoveCount ? 'warning' : 'success'} onClick={() => openSection(proposal.id, 'manual')}/>
      <ExpandableMetric label={t('prop.pd.mStructural')} value={proposal.structuralChanges.length} onClick={() => openSection(proposal.id, 'structural')}/>
      <ExpandableMetric label={t('prop.pd.mExceptions')} value={proposal.exceptions.length} tone={proposal.exceptions.length ? 'warning' : undefined} onClick={() => openSection(proposal.id, 'exceptions')}/>
      <ExpandableMetric label={t('prop.pd.mStability')} value={`${proposal.metrics.stabilityScore}%`} onClick={() => openSection(proposal.id, 'calculation')}/>
    </div>}

    {(!compactLocal || proposal.issues.length > 0) && <details id={`proposal-${proposal.id}-issues`}><summary>{t('prop.pd.issuesDetail', { n: proposal.issues.length })}</summary><div className="proposal-cards">{proposal.issues.map(issue => <article className="proposal-card proposal-issue-card" key={issue.id}><div className="proposal-issue-heading"><strong>{issue.title}</strong><span>{conflictProfile(issue).label}</span></div><p>{issue.detail}</p>{issue.assignmentIds.length > 0 && <details><summary>{t('prop.cd.involvedTasks', { n: issue.assignmentIds.length })}</summary><ul>{issue.assignmentIds.map(id => <li key={id}>{assignmentMap.get(id)?.title ?? id}</li>)}</ul></details>}{(issue.currentValue != null || issue.allowedValue != null) && <div className="before-after"><span><small>{t('prop.cd.afterAdjust')}</small>{issue.currentValue ?? '—'}</span><span><small>{t('prop.pd.allowed')}</small>{issue.allowedValue ?? '—'}</span></div>}<small>{t('prop.cd.consequence', { text: issue.consequence })}</small><p>{t('prop.pd.suggested', { text: issue.resolution })}</p></article>)}{proposal.issues.length === 0 && <p className="muted-text">{t('prop.pd.noNewConflicts')}</p>}</div></details>}

    {(!compactLocal || proposal.movements.length > 0) && <details id={`proposal-${proposal.id}-moves`}><summary>{t('prop.pd.taskChanges', { n: proposal.movements.length })}</summary><div className="proposal-cards">
      {proposal.movements.length === 0 && <p className="muted-text">{t('prop.pd.noMoves')}</p>}
      {proposal.movements.map(move => {
        const afterTask = proposal.stateAfter.assignments.find(item => item.id === move.assignmentId)
        const baselineTask = baseline.assignments.find(item => item.id === move.assignmentId)
        return <article key={move.assignmentId} className="proposal-card proposal-movement-card"><strong>{assignmentMap.get(move.assignmentId)?.title ?? move.assignmentId}</strong><div className="before-after"><span><small>{t('prop.pd.before')}</small>{move.fromDate ? fmtDate(move.fromDate) : t('prop.pd.unscheduled')} · {t('prop.pd.dayLoad', { load: minutesText(move.beforeLoad) })}</span><span><small>{t('prop.pd.after')}</small>{move.toDate ? fmtDate(move.toDate) : t('prop.pd.unscheduled')} · {t('prop.pd.dayLoad', { load: minutesText(move.afterLoad) })}</span></div><p>{move.reason}</p><small>{move.goalImpact} · {t('prop.pd.manualIntent', { label: move.manualIntentImpact === 'preserved' ? t('prop.pd.miPreserved') : move.manualIntentImpact === 'moved-manual' ? t('prop.pd.miMoved') : move.manualIntentImpact === 'locked-blocked' ? t('prop.pd.miBlocked') : t('prop.pd.miNone') })}</small>
          {!proposal.infeasible && <div className={`proposal-movement-editor ${tutorialMode ? 'tutorial-disabled-control' : ''}`}><div><strong>{t('prop.pd.fineTune')}</strong><small>{tutorialMode ? t('prop.pd.fineTuneTutorial') : t('prop.pd.fineTuneDesc')}</small></div><div className="proposal-movement-actions">{baselineTask?.scheduledDate && <button type="button" className="secondary-button" disabled={tutorialMode || move.toDate === baselineTask.scheduledDate} onClick={() => onRevise({ assignmentId: move.assignmentId, date: baselineTask.scheduledDate, lock: false })}>{t('prop.pd.keepOriginalDate')}</button>}<input aria-label={t('prop.pd.customDate')} type="date" min={baseline.settings.startDate} max={baseline.settings.endDate} value={move.toDate ?? ''} disabled={tutorialMode} onChange={eventValue => onRevise({ assignmentId: move.assignmentId, date: eventValue.target.value || undefined, lock: Boolean(afterTask?.locked) })}/><label><input type="checkbox" checked={Boolean(afterTask?.locked)} disabled={tutorialMode} onChange={eventValue => onRevise({ assignmentId: move.assignmentId, date: move.toDate, lock: eventValue.target.checked })}/><span>{t('prop.pd.lockResult')}</span></label></div></div>}
          {move.rejectedAlternatives.length > 0 && <details><summary>{t('prop.pd.whyNotOther')}</summary>{move.rejectedAlternatives.map(item => <div className="rejected-date" key={item.date}><strong>{fmtDate(item.date)}</strong><ul>{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>)}</details>}</article>
      })}
    </div></details>}

    {(!compactLocal || proposal.dateChanges.length > 0) && <details id={`proposal-${proposal.id}-dates`}><summary>{t('prop.pd.dateLoad', { n: proposal.dateChanges.length })}</summary><div className="proposal-cards">{proposal.dateChanges.map(change => {
      const delta = change.afterMinutes - change.beforeMinutes
      const capacityDelta = (change.afterCapacity ?? 0) - (change.beforeCapacity ?? 0)
      const capacityChanged = change.beforeCapacity != null && change.afterCapacity != null && capacityDelta !== 0
      const beforeTaskIds = new Set(change.beforeTaskIds)
      const afterTaskIds = new Set(change.afterTaskIds)
      const removedCount = change.beforeTaskIds.filter(id => !afterTaskIds.has(id)).length
      const addedCount = change.afterTaskIds.filter(id => !beforeTaskIds.has(id)).length
      return <article className="proposal-card proposal-date-card" key={change.date}><strong>{fmtDate(change.date)}</strong><div className="before-after"><span><small>{t('prop.pd.before')}</small>{t('prop.pd.load', { load: minutesText(change.beforeMinutes) })} · {t('prop.pd.items', { n: change.beforeTaskIds.length })}{change.beforeCapacity != null && <em>{t('prop.pd.capacity', { value: minutesText(change.beforeCapacity) })}</em>}</span><span><small>{t('prop.pd.after')}</small>{t('prop.pd.load', { load: minutesText(change.afterMinutes) })} · {t('prop.pd.items', { n: change.afterTaskIds.length })}{change.afterCapacity != null && <em>{t('prop.pd.capacity', { value: minutesText(change.afterCapacity) })}</em>}</span></div><p className={`load-delta ${delta > 0 ? 'load-delta-up' : delta < 0 ? 'load-delta-down' : 'load-delta-flat'}`}>{delta > 0 ? t('prop.pd.loadUp') : delta < 0 ? t('prop.pd.loadDown') : t('prop.pd.loadFlat')} {minutesText(Math.abs(delta))}</p>{capacityChanged && <p className={`capacity-delta ${capacityDelta > 0 ? 'capacity-delta-up' : 'capacity-delta-down'}`}>{capacityDelta > 0 ? t('prop.pd.capUp') : t('prop.pd.capDown')} {minutesText(Math.abs(capacityDelta))}</p>}{(removedCount > 0 || addedCount > 0) && <div className="proposal-change-legend"><span className="proposal-change-removed">{t('prop.pd.legendRemoved', { n: removedCount })}</span><span className="proposal-change-added">{t('prop.pd.legendAdded', { n: addedCount })}</span></div>}<div className="proposal-date-task-lists"><div><small>{t('prop.pd.tasksBefore')}</small><ul>{change.beforeTaskIds.map(id => <li className={!afterTaskIds.has(id) ? 'proposal-task-removed' : ''} key={id}>{assignmentMap.get(id)?.title ?? id}</li>)}</ul></div><div><small>{t('prop.pd.tasksAfter')}</small><ul>{change.afterTaskIds.map(id => <li className={!beforeTaskIds.has(id) ? 'proposal-task-added' : ''} key={id}>{assignmentMap.get(id)?.title ?? id}</li>)}</ul></div></div></article>
    })}{proposal.dateChanges.length === 0 && <p className="muted-text">{t('prop.pd.noLoadChange')}</p>}</div></details>}

    {(!compactLocal || proposal.goalImpacts.length > 0) && <details><summary>{t('prop.pd.goalImpact', { n: proposal.goalImpacts.length })}</summary><div className="proposal-cards">{proposal.goalImpacts.map(impact => <article className="proposal-card" key={impact.goalId}><strong>{goalMap.get(impact.goalId)?.title ?? impact.goalId}</strong><div className="before-after"><span><small>{t('prop.pd.before')}</small>{Math.round(impact.beforeProgress * 100)}% · {impact.beforeExpectedCompletion ?? t('prop.pd.cannotEstimate')}</span><span><small>{t('prop.pd.after')}</small>{Math.round(impact.afterProgress * 100)}% · {impact.afterExpectedCompletion ?? t('prop.pd.cannotEstimate')}</span></div><p>{impact.summary}</p><small>{t('prop.pd.desiredRisk', { v: impact.desiredRiskAfter ? t('prop.pd.yes') : t('prop.pd.no') })} · {t('prop.pd.latestRisk', { v: impact.latestRiskAfter ? t('prop.pd.yes') : t('prop.pd.no') })}</small></article>)}{proposal.goalImpacts.length === 0 && <p className="muted-text">{t('prop.pd.noGoalChange')}</p>}</div></details>}

    {(!compactLocal || newTaskIds.length > 0) && <details id={`proposal-${proposal.id}-new`}><summary>{t('prop.pd.newTasks', { n: newTaskIds.length })}</summary><ul className="proposal-name-list">{newTaskIds.map(id => <li key={id}>{assignmentMap.get(id)?.title ?? id}</li>)}{newTaskIds.length === 0 && <li>{t('prop.pd.notNewEvent')}</li>}</ul></details>}
    {(!compactLocal || manualMoves.length > 0) && <details id={`proposal-${proposal.id}-manual`}><summary>{t('prop.pd.manualImpact', { n: manualMoves.length })}</summary>{manualMoves.length ? <ul className="proposal-name-list">{manualMoves.map(item => <li key={item.assignmentId}>{assignmentMap.get(item.assignmentId)?.title ?? item.assignmentId}: {item.fromDate ?? t('prop.pd.unscheduled')} → {item.toDate ?? t('prop.pd.unscheduled')}</li>)}</ul> : <p className="muted-text">{t('prop.pd.noManualMoves')}</p>}</details>}
    {(!compactLocal || proposal.structuralChanges.length > 0) && <details id={`proposal-${proposal.id}-structural`}><summary>{t('prop.pd.structural', { n: proposal.structuralChanges.length })}</summary><div className="proposal-cards">{proposal.structuralChanges.length ? proposal.structuralChanges.map(change => <article className="proposal-card structural-change-card" key={`${change.entityType}-${change.entityId}`}><div className="structural-change-head"><strong>{change.title}</strong><span>{change.changeType === 'added' ? t('prop.pd.ctAdded') : change.changeType === 'removed' ? t('prop.pd.ctRemoved') : t('prop.pd.ctModified')}</span></div>{change.fields.map(field => <div className="before-after structural-field" key={field.label}><span><small>{field.label} · {t('prop.pd.before')}</small>{field.before ?? '—'}</span><span><small>{field.label} · {t('prop.pd.after')}</small>{field.after ?? '—'}</span></div>)}</article>) : <p className="muted-text">{t('prop.pd.noStructural')}</p>}</div></details>}
    {(!compactLocal || proposal.exceptions.length > 0) && <details id={`proposal-${proposal.id}-exceptions`}><summary>{t('prop.pd.exceptions', { n: proposal.exceptions.length })}</summary>{proposal.exceptions.length ? proposal.exceptions.map((item, index) => <div className="exception-row" key={`${index}-${item.date}-${item.rawKey ?? item.key}`}><strong>{fmtDate(item.date)}</strong><span>{item.label}</span><em>{t('prop.pd.exceptionNote')}{item.affectedAssignmentIds?.length ? ` · ${t('prop.pd.exceptionTasks', { n: item.affectedAssignmentIds.length })}` : ''}</em></div>) : <p className="muted-text">{t('prop.pd.noExceptions')}</p>}</details>}
    <details id={`proposal-${proposal.id}-calculation`}><summary>{t('prop.pd.calcTitle', { n: proposal.metrics.stabilityScore })}</summary><p>{proposal.description}</p><p>{t('prop.pd.calcBody', { avgBefore: minutesText(proposal.metrics.beforeAverageLoad), avgAfter: minutesText(proposal.metrics.afterAverageLoad), maxBefore: minutesText(proposal.metrics.beforeMaxLoad), maxAfter: minutesText(proposal.metrics.afterMaxLoad), retention: Math.round(proposal.metrics.originalDateRetention * 100) })}</p></details>
  </div>
}

function ExpandableMetric({ label, value, tone, onClick }: { label: string; value: number | string; tone?: 'danger' | 'warning' | 'success'; onClick: () => void }) {
  const t = useT()
  return <button type="button" className={tone ? `metric-${tone}` : ''} onClick={onClick}><strong>{value}</strong><span>{label}</span><small>{t('prop.pd.expand')}</small></button>
}
