export type AntibodyRuleStatus = 'proposed' | 'approved' | 'active' | 'rejected' | 'expired'

export interface AntibodyRuleProposal {
  pattern: string
  recommendation: string
  sourceFailure: string
  operationKey: string
  subsystem: string
  reviewAfterMs?: number
  expiresAfterMs?: number
}

export interface AntibodyRule extends AntibodyRuleProposal {
  id: string
  status: AntibodyRuleStatus
  version: string
  createdAt: number
  updatedAt: number
  reviewAfter?: number
  expiresAt?: number
  conflictsWith?: string[]
}

export interface AntibodyEvaluation {
  matchedActiveRules: AntibodyRule[]
  canAffectExecution: false
}

export interface AntibodyRepositoryConfig {
  now?: () => number
  version?: string
}

export class AntibodyRepository {
  private readonly now: () => number
  private readonly version: string
  private rules: AntibodyRule[] = []

  constructor(config: AntibodyRepositoryConfig = {}) {
    this.now = config.now ?? (() => Date.now())
    this.version = config.version ?? 'antibody-rule-0.1.0'
  }

  proposeRule(proposal: AntibodyRuleProposal): AntibodyRule {
    const timestamp = this.now()
    const rule: AntibodyRule = {
      ...proposal,
      id: `${timestamp}-${this.rules.length + 1}`,
      status: 'proposed',
      version: this.version,
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewAfter: proposal.reviewAfterMs === undefined ? undefined : timestamp + proposal.reviewAfterMs,
      expiresAt: proposal.expiresAfterMs === undefined ? undefined : timestamp + proposal.expiresAfterMs,
    }
    this.rules.push(rule)
    return { ...rule }
  }

  approveRule(id: string): AntibodyRule {
    return this.updateStatus(id, 'approved')
  }

  activateRule(id: string): AntibodyRule {
    const rule = this.getMutableRule(id)
    if (!rule) {
      throw new Error(`Antibody rule not found: ${id}`)
    }

    const conflict = this.rules.find(existing =>
      existing.id !== id &&
      existing.status === 'active' &&
      existing.pattern === rule.pattern &&
      existing.recommendation !== rule.recommendation
    )

    if (conflict) {
      rule.status = 'rejected'
      rule.conflictsWith = [conflict.id]
      rule.updatedAt = this.now()
      return { ...rule }
    }

    if (rule.status !== 'approved' && rule.status !== 'active') {
      throw new Error(`Antibody rule must be approved before activation: ${id}`)
    }

    rule.status = 'active'
    rule.updatedAt = this.now()
    return { ...rule }
  }

  rejectRule(id: string): AntibodyRule {
    return this.updateStatus(id, 'rejected')
  }

  expireDueRules(): number {
    const now = this.now()
    let count = 0
    for (const rule of this.rules) {
      if ((rule.status === 'active' || rule.status === 'approved' || rule.status === 'proposed') && rule.expiresAt !== undefined && rule.expiresAt <= now) {
        rule.status = 'expired'
        rule.updatedAt = now
        count += 1
      }
    }
    return count
  }

  evaluate(input: { pattern: string }): AntibodyEvaluation {
    this.expireDueRules()
    return {
      matchedActiveRules: this.rules
        .filter(rule => rule.status === 'active' && rule.pattern === input.pattern)
        .map(rule => ({ ...rule })),
      canAffectExecution: false,
    }
  }

  getStats(): Record<string, unknown> {
    const byStatus = this.rules.reduce<Record<string, number>>((acc, rule) => {
      acc[rule.status] = (acc[rule.status] ?? 0) + 1
      return acc
    }, {})

    return {
      status: 'observe_only',
      totalRules: this.rules.length,
      byStatus,
      proposedCount: byStatus.proposed ?? 0,
      activeCount: byStatus.active ?? 0,
      recent: this.rules.slice(-5).reverse().map(rule => ({ ...rule })),
    }
  }

  listRules(): AntibodyRule[] {
    return this.rules.map(rule => ({ ...rule }))
  }

  private updateStatus(id: string, status: AntibodyRuleStatus): AntibodyRule {
    const rule = this.getMutableRule(id)
    if (!rule) {
      throw new Error(`Antibody rule not found: ${id}`)
    }
    rule.status = status
    rule.updatedAt = this.now()
    return { ...rule }
  }

  private getMutableRule(id: string): AntibodyRule | undefined {
    return this.rules.find(rule => rule.id === id)
  }
}
