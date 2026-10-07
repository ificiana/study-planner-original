import type { PlanAdjustmentPolicy, PlanChangeEvent, SchedulingPreference } from '../types'
import { translate, type Language } from './i18n'

const allPreferences: SchedulingPreference[] = ['preserve', 'balanced', 'goal', 'rest']

function alternatives(primary: SchedulingPreference, preferred?: unknown, ordered: SchedulingPreference[] = []): SchedulingPreference[] {
  const metadata = Array.isArray(preferred)
    ? preferred.filter((item): item is SchedulingPreference => allPreferences.includes(item as SchedulingPreference))
    : []
  return Array.from(new Set([...ordered, ...metadata, ...allPreferences])).filter(item => item !== primary)
}

/**
 * 场景协调策略：先判断用户意图是否已经完整，再决定是精确校验、推荐预览还是探索式优化。
 * 底层仍只保留一套调度引擎；这里负责避免所有业务变化都被粗暴送进“四方案重排”。
 */
export function adjustmentPolicyForEvent(event: PlanChangeEvent, language: Language = 'zh'): PlanAdjustmentPolicy {
  const t = (key: string) => translate(language, key)
  const metadata = event.metadata ?? {}
  const preferred = metadata.preferredPreferences
  const direct = (label: string, explanation: string, primary: SchedulingPreference = 'preserve'): PlanAdjustmentPolicy => ({
    mode: 'validate-and-commit', primaryPreference: primary,
    alternativePreferences: alternatives(primary, preferred), allowKeepPrepared: true,
    directPreviewLabel: label, explanation, defaultScope: 'requested-change-only',
  })
  const recommended = (label: string, explanation: string, primary: SchedulingPreference = 'preserve'): PlanAdjustmentPolicy => ({
    mode: 'recommended-preview', primaryPreference: primary,
    alternativePreferences: alternatives(primary, preferred), allowKeepPrepared: false,
    directPreviewLabel: label, explanation, defaultScope: 'directly-affected-items',
  })
  const optional = (label: string, explanation: string, primary: SchedulingPreference = 'preserve', ordered: SchedulingPreference[] = []): PlanAdjustmentPolicy => ({
    mode: 'optional-optimization', primaryPreference: primary,
    alternativePreferences: alternatives(primary, preferred, ordered), allowKeepPrepared: true,
    directPreviewLabel: label, explanation, defaultScope: 'requested-change-only',
  })
  const exploratory = (label: string, explanation: string, primary: SchedulingPreference, ordered: SchedulingPreference[] = []): PlanAdjustmentPolicy => ({
    mode: 'exploratory-optimization', primaryPreference: primary,
    alternativePreferences: alternatives(primary, preferred, ordered), allowKeepPrepared: false,
    directPreviewLabel: label, explanation, defaultScope: 'broader-future-plan',
  })

  if (metadata.explicitLocalOperation === true || event.type === 'assignment-deletion' || event.type === 'group-deletion') {
    const localLabel = typeof metadata.requestedChangeLabel === 'string' ? metadata.requestedChangeLabel : t('adjustment.localOnly.label')
    return optional(localLabel, t('adjustment.localOnly.explanation'))
  }
  if (event.type === 'execution-difference' && metadata.requestedCarryDates) {
    return direct(t('adjustment.executionDifferenceCarry.label'), t('adjustment.executionDifferenceCarry.explanation'))
  }
  if (event.type === 'bulk-move') {
    return direct(t('adjustment.bulkMove.label'), t('adjustment.bulkMove.explanation'))
  }
  if (event.type === 'rule-change' && metadata.currentEstimate != null) {
    return direct(t('adjustment.ruleChangeEstimate.label'), t('adjustment.ruleChangeEstimate.explanation'))
  }
  if (event.type === 'goal-relaxation' || event.type === 'goal-deletion') {
    return optional(t('adjustment.goalRelaxation.label'), t('adjustment.goalRelaxation.explanation'), 'preserve', ['rest', 'balanced', 'goal'])
  }
  if (event.type === 'availability-change' && metadata.pureRelaxation === true) {
    return optional(t('adjustment.availabilityRelaxation.label'), t('adjustment.availabilityRelaxation.explanation'), 'preserve', ['rest', 'balanced', 'goal'])
  }
  if (event.type === 'load-preference-change') {
    const primary = (metadata.preferredPreference as SchedulingPreference | undefined) ?? 'rest'
    return exploratory(t('adjustment.loadPreferenceChange.label'), t('adjustment.loadPreferenceChange.explanation'), primary, primary === 'rest' ? ['balanced', 'preserve', 'goal'] : ['rest', 'preserve', 'goal'])
  }
  if (event.type === 'future-replanning') {
    const primary = (metadata.preferredPreference as SchedulingPreference | undefined) ?? 'balanced'
    return exploratory(t('adjustment.futureReplanning.label'), t('adjustment.futureReplanning.explanation'), primary)
  }
  if (event.type === 'new-task-insertion' || event.type === 'task-group-size-increase') {
    return recommended(t('adjustment.newTaskInsertion.label'), t('adjustment.newTaskInsertion.explanation'))
  }
  if (event.type === 'goal-tightening') {
    return recommended(t('adjustment.goalTightening.label'), t('adjustment.goalTightening.explanation'), 'goal')
  }
  if (event.type === 'availability-change') {
    return recommended(t('adjustment.availabilityChange.label'), t('adjustment.availabilityChange.explanation'))
  }
  if (event.type === 'rule-change') {
    return recommended(t('adjustment.ruleChange.label'), t('adjustment.ruleChange.explanation'))
  }
  if (event.type === 'execution-difference') {
    return recommended(t('adjustment.executionDifference.label'), t('adjustment.executionDifference.explanation'))
  }
  return recommended(t('adjustment.default.label'), t('adjustment.default.explanation'))
}

export function eventWithPreferences(event: PlanChangeEvent, preferences: SchedulingPreference[]): PlanChangeEvent {
  return { ...event, metadata: { ...(event.metadata ?? {}), preferredPreferences: preferences } }
}
