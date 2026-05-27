export type EmlSignalType = 'generic' | 'user_preference' | 'project_fact' | 'failure_signal'

export interface EmlScoreInput {
  novelty: number
  importance: number
  volatility: number
  redundancy: number
  retrievalFrequency: number
  ageMs: number
  signalType?: EmlSignalType
}

export type EmlScoreAction = 'ignore' | 'short_term' | 'promote' | 'distill_candidate' | 'archive'

export interface EmlScoreDecision {
  score: number
  action: EmlScoreAction
  reasons: string[]
  thresholdVersion: string
  requiresArchiveCopy: boolean
}

export interface EmlThresholds {
  version: string
  ignoreBelow: number
  promoteAt: number
  distillAt: number
  archiveAgeMs: number
}

export interface EmlScorerConfig {
  thresholds?: Partial<EmlThresholds>
}

const DEFAULT_THRESHOLDS: EmlThresholds = {
  version: 'eml-thresholds-0.1.0',
  ignoreBelow: 0.25,
  promoteAt: 0.7,
  distillAt: 0.82,
  archiveAgeMs: 120 * 24 * 60 * 60 * 1000,
}

const SIGNAL_BONUS: Record<EmlSignalType, number> = {
  generic: 0,
  user_preference: 0.12,
  project_fact: 0.1,
  failure_signal: 0.14,
}

export class EmlScorer {
  private readonly thresholds: EmlThresholds

  constructor(config: EmlScorerConfig = {}) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...config.thresholds,
    }
  }

  score(input: EmlScoreInput): EmlScoreDecision {
    const normalized = normalize(input)
    const reasons: string[] = []

    if (normalized.novelty >= 0.7) reasons.push('high_novelty')
    if (normalized.importance >= 0.7) reasons.push('high_importance')
    if (normalized.redundancy >= 0.7) reasons.push('high_redundancy')
    if (normalized.retrievalFrequency >= 0.7) reasons.push('frequently_retrieved')
    if (normalized.volatility >= 0.7) reasons.push('high_volatility')
    if (normalized.ageMs >= this.thresholds.archiveAgeMs) reasons.push('stale_memory')

    const signalType = normalized.signalType ?? 'generic'
    if (signalType !== 'generic') {
      reasons.push(signalType)
    }

    const rawScore =
      normalized.novelty * 0.28 +
      normalized.importance * 0.34 +
      (1 - normalized.redundancy) * 0.16 +
      normalized.retrievalFrequency * 0.12 +
      (1 - normalized.volatility) * 0.1 +
      SIGNAL_BONUS[signalType]

    const score = round(clamp01(rawScore))
    const isArchiveCandidate =
      normalized.ageMs >= this.thresholds.archiveAgeMs &&
      normalized.volatility >= 0.7 &&
      normalized.redundancy >= 0.7 &&
      normalized.retrievalFrequency <= 0.1

    let action: EmlScoreAction
    if (isArchiveCandidate) {
      action = 'archive'
      reasons.push('no_hard_delete')
    } else if (score < this.thresholds.ignoreBelow || (normalized.redundancy >= 0.9 && normalized.importance < 0.5)) {
      action = 'ignore'
    } else if (signalType === 'failure_signal' && score >= this.thresholds.distillAt) {
      action = 'distill_candidate'
    } else if (score >= this.thresholds.promoteAt) {
      action = 'promote'
    } else {
      action = 'short_term'
    }

    if (reasons.length === 0) {
      reasons.push('balanced_signal')
    }

    return {
      score,
      action,
      reasons: unique(reasons),
      thresholdVersion: this.thresholds.version,
      requiresArchiveCopy: action === 'archive',
    }
  }
}

function normalize(input: EmlScoreInput): Required<EmlScoreInput> {
  return {
    novelty: clamp01(input.novelty),
    importance: clamp01(input.importance),
    volatility: clamp01(input.volatility),
    redundancy: clamp01(input.redundancy),
    retrievalFrequency: clamp01(input.retrievalFrequency),
    ageMs: Math.max(0, input.ageMs),
    signalType: input.signalType ?? 'generic',
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
