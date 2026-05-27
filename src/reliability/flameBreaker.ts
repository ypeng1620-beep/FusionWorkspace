export type FlameBreakerState = 'closed' | 'open' | 'half_open'
export type FlameBreakerAction = 'allow' | 'probe' | 'fallback'

export interface FlameBreakerConfig {
  failureThreshold?: number
  cooldownMs?: number
  halfOpenSuccessThreshold?: number
  now?: () => number
  onTransition?: (decision: FlameBreakerDecision, transition: FlameBreakerAuditEntry) => void
}

export interface FlameBreakerKey {
  subsystem: string
  operationKey: string
  destructive?: boolean
}

export interface FlameBreakerFailure extends FlameBreakerKey {
  error: unknown
}

export interface FallbackRecommendation {
  action: FlameBreakerAction
  reason: string
  originalError?: string
  canRetryAutomatically: boolean
  canBypassPermission: false
  hideOriginalError: false
}

export interface FlameBreakerDecision {
  state: FlameBreakerState
  subsystem: string
  operationKey: string
  recommendation: FallbackRecommendation
}

export interface FlameBreakerAuditEntry {
  timestamp: number
  subsystem: string
  operationKey: string
  from: FlameBreakerState
  to: FlameBreakerState
  reason: string
  originalError?: string
}

interface BreakerRecord {
  state: FlameBreakerState
  failures: number
  halfOpenSuccesses: number
  openedAt?: number
  lastError?: string
  destructive?: boolean
}

export class FlameBreaker {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly halfOpenSuccessThreshold: number
  private readonly now: () => number
  private readonly onTransition?: (decision: FlameBreakerDecision, transition: FlameBreakerAuditEntry) => void
  private readonly records = new Map<string, BreakerRecord>()
  private readonly auditLog: FlameBreakerAuditEntry[] = []

  constructor(config: FlameBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5
    this.cooldownMs = config.cooldownMs ?? 60_000
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 3
    this.now = config.now ?? (() => Date.now())
    this.onTransition = config.onTransition
  }

  evaluate(input: FlameBreakerKey): FlameBreakerDecision {
    const record = this.getRecord(input)
    this.refreshCooldown(input, record)
    return this.toDecision(input, record)
  }

  recordFailure(input: FlameBreakerFailure): FlameBreakerDecision {
    const record = this.getRecord(input)
    this.refreshCooldown(input, record)
    record.lastError = stringifyError(input.error)
    record.destructive = input.destructive ?? record.destructive

    if (record.state === 'half_open') {
      const transition = this.transition(input, record, 'open', 'half_open_probe_failed')
      record.failures = this.failureThreshold
      record.halfOpenSuccesses = 0
      record.openedAt = this.now()
      this.notifyTransition(input, record, transition)
      return this.toDecision(input, record)
    }

    record.failures += 1
    record.halfOpenSuccesses = 0
    if (record.state === 'closed' && record.failures >= this.failureThreshold) {
      const transition = this.transition(input, record, 'open', 'failure_threshold_exceeded')
      record.openedAt = this.now()
      this.notifyTransition(input, record, transition)
    }

    return this.toDecision(input, record)
  }

  recordSuccess(input: FlameBreakerKey): FlameBreakerDecision {
    const record = this.getRecord(input)
    this.refreshCooldown(input, record)

    if (record.state === 'half_open') {
      record.halfOpenSuccesses += 1
      if (record.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        const transition = this.transition(input, record, 'closed', 'half_open_success_threshold_met')
        record.failures = 0
        record.halfOpenSuccesses = 0
        record.openedAt = undefined
        record.lastError = undefined
        this.notifyTransition(input, record, transition)
      }
      return this.toDecision(input, record)
    }

    if (record.state === 'closed') {
      record.failures = 0
      record.lastError = undefined
    }

    return this.toDecision(input, record)
  }

  getAuditLog(): FlameBreakerAuditEntry[] {
    return [...this.auditLog]
  }

  getStats(): Record<string, unknown> {
    const records = [...this.records.values()]
    const stateCounts = records.reduce<Record<string, number>>((acc, record) => {
      acc[record.state] = (acc[record.state] ?? 0) + 1
      return acc
    }, {})

    return {
      status: 'observe_only',
      totalBreakers: records.length,
      stateCounts,
      auditEntries: this.auditLog.length,
      recentTransitions: this.auditLog.slice(-5).reverse(),
    }
  }

  private getRecord(input: FlameBreakerKey): BreakerRecord {
    const key = makeKey(input)
    const existing = this.records.get(key)
    if (existing) {
      return existing
    }

    const created: BreakerRecord = {
      state: 'closed',
      failures: 0,
      halfOpenSuccesses: 0,
      destructive: input.destructive,
    }
    this.records.set(key, created)
    return created
  }

  private refreshCooldown(input: FlameBreakerKey, record: BreakerRecord): void {
    if (record.state !== 'open' || record.openedAt === undefined) {
      return
    }

    if (this.now() - record.openedAt >= this.cooldownMs) {
      const transition = this.transition(input, record, 'half_open', 'cooldown_elapsed')
      record.halfOpenSuccesses = 0
      this.notifyTransition(input, record, transition)
    }
  }

  private transition(
    input: FlameBreakerKey,
    record: BreakerRecord,
    to: FlameBreakerState,
    reason: string,
  ): FlameBreakerAuditEntry | undefined {
    if (record.state === to) {
      return undefined
    }

    const from = record.state
    record.state = to
    const entry: FlameBreakerAuditEntry = {
      timestamp: this.now(),
      subsystem: input.subsystem,
      operationKey: input.operationKey,
      from,
      to,
      reason,
      originalError: record.lastError,
    }
    this.auditLog.push(entry)
    return entry
  }

  private notifyTransition(
    input: FlameBreakerKey,
    record: BreakerRecord,
    transition: FlameBreakerAuditEntry | undefined,
  ): void {
    if (!transition || !this.onTransition) {
      return
    }
    this.onTransition(this.toDecision(input, record), transition)
  }

  private toDecision(input: FlameBreakerKey, record: BreakerRecord): FlameBreakerDecision {
    const destructive = input.destructive ?? record.destructive ?? false
    const action: FlameBreakerAction = record.state === 'closed'
      ? 'allow'
      : record.state === 'half_open'
        ? 'probe'
        : 'fallback'

    return {
      state: record.state,
      subsystem: input.subsystem,
      operationKey: input.operationKey,
      recommendation: {
        action,
        reason: record.state === 'open'
          ? 'breaker_open'
          : record.state === 'half_open'
            ? 'half_open_probe'
            : 'breaker_closed',
        originalError: record.lastError,
        canRetryAutomatically: action === 'probe' && !destructive,
        canBypassPermission: false,
        hideOriginalError: false,
      },
    }
  }
}

function makeKey(input: FlameBreakerKey): string {
  return `${input.subsystem}:${input.operationKey}`
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
