import type { FlameBreakerAuditEntry, FlameBreakerDecision } from '../reliability/flameBreaker.js'
import { AntibodyRepository, type AntibodyRule } from './antibodyRepository.js'

export type AntibodyPolicyAction = 'ignored' | 'duplicate' | 'proposed'

export interface AntibodyPolicyConfig {
  repository: AntibodyRepository
  reviewAfterMs?: number
  expiresAfterMs?: number
}

export interface AntibodyPolicyObservation {
  decision: FlameBreakerDecision
  transition: FlameBreakerAuditEntry
}

export interface AntibodyPolicyResult extends AntibodyPolicyObservation {
  action: AntibodyPolicyAction
  rule?: AntibodyRule
  reason: string
  canAffectExecution: false
}

export class AntibodyPolicy {
  private readonly repository: AntibodyRepository
  private readonly reviewAfterMs: number
  private readonly expiresAfterMs: number

  constructor(config: AntibodyPolicyConfig) {
    this.repository = config.repository
    this.reviewAfterMs = config.reviewAfterMs ?? 24 * 60 * 60 * 1000
    this.expiresAfterMs = config.expiresAfterMs ?? 7 * 24 * 60 * 60 * 1000
  }

  observeReliabilityTransition(observation: AntibodyPolicyObservation): AntibodyPolicyResult {
    const { decision, transition } = observation
    if (transition.to !== 'open' || decision.recommendation.action !== 'fallback') {
      return {
        ...observation,
        action: 'ignored',
        reason: 'transition_not_failure_fallback',
        canAffectExecution: false,
      }
    }

    const pattern = buildPattern(transition)
    const recommendation = `fallback:${decision.recommendation.reason}`
    const duplicate = this.repository.listRules().find(rule =>
      rule.pattern === pattern &&
      rule.recommendation === recommendation &&
      rule.status !== 'expired' &&
      rule.status !== 'rejected'
    )

    if (duplicate) {
      return {
        ...observation,
        action: 'duplicate',
        rule: duplicate,
        reason: 'matching_non_terminal_rule_exists',
        canAffectExecution: false,
      }
    }

    const rule = this.repository.proposeRule({
      pattern,
      recommendation,
      sourceFailure: transition.originalError ?? decision.recommendation.originalError ?? transition.reason,
      operationKey: transition.operationKey,
      subsystem: transition.subsystem,
      reviewAfterMs: this.reviewAfterMs,
      expiresAfterMs: this.expiresAfterMs,
    })

    return {
      ...observation,
      action: 'proposed',
      rule,
      reason: 'failure_fallback_observed',
      canAffectExecution: false,
    }
  }
}

function buildPattern(transition: FlameBreakerAuditEntry): string {
  return `${transition.subsystem}:${transition.operationKey}:${transition.reason}`
}
