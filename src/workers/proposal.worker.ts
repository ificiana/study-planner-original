/// <reference lib="webworker" />
import type { AppState, PlanChangeEvent } from '../types'
import { generateSchedulingProposals } from '../lib/planner'
import { translate, type Language } from '../lib/i18n'

type ProposalWorkerRequest = {
  preparedState: AppState
  baseline: AppState
  event: PlanChangeEvent
  language?: Language
}

type ProposalWorkerResponse =
  | { ok: true; proposals: ReturnType<typeof generateSchedulingProposals> }
  | { ok: false; message: string }

self.onmessage = (message: MessageEvent<ProposalWorkerRequest>) => {
  const language: Language = message.data.language ?? 'zh'
  try {
    const { preparedState, baseline, event } = message.data
    const proposals = generateSchedulingProposals(preparedState, event, { baseline })
    self.postMessage({ ok: true, proposals } satisfies ProposalWorkerResponse)
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : translate(language, 'worker.proposalFailed') } satisfies ProposalWorkerResponse)
  }
}
