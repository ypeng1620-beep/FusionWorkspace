import type {
  PhoenixFallbackPathDecision,
  PhoenixGovernanceDecision,
  PhoenixMemoryRecallDecision,
  PhoenixSkillLookupDecision,
} from './phoenixCore.js'
import type { EmlScoreDecision } from '../memory/emlScoring.js'
import type { FlameBreakerAuditEntry, FlameBreakerDecision } from '../reliability/flameBreaker.js'
import type { AntibodyPolicyResult } from '../antibody/antibodyPolicy.js'
import type { AntibodyEvaluation } from '../antibody/antibodyRepository.js'
import type { SkillTriggerMatch } from '../skills/skillManager.js'
import { assertPhoenixBoundaryDecision } from './phoenixBoundaries.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHmac, timingSafeEqual, randomBytes } from 'crypto'

export type PhoenixAuditStage =
  | 'intent_route'
  | 'memory_score'
  | 'reliability_decision'
  | 'antibody_lookup'
  | 'skill_lookup'
  | 'governance'

export type PhoenixAuditLevel = 'info' | 'warn' | 'error'

export interface PhoenixAuditEntry {
  id: string
  timestamp: number
  stage: PhoenixAuditStage
  level: PhoenixAuditLevel
  decision: string
  version: string
  sessionId?: string
  userId?: string
  inputSummary?: string
  metadata?: Record<string, unknown>
}

export interface PhoenixAuditStoreConfig {
  maxEntries?: number
  version?: string
  /** HMAC key for audit chain integrity. If set, entries are chained with SHA-256 HMACs. */
  hmacKey?: string
}

export interface PhoenixAuditReplaySnapshot {
  schemaVersion: 'phoenix-audit-snapshot-1'
  snapshotId: string
  exportedAt: number
  reason?: string
  policyVersions: Record<string, string>
  entries: PhoenixAuditEntry[]
}

export interface PhoenixAuditSnapshotStoreConfig {
  directory: string
  maxSnapshots?: number
  now?: () => number
}

export interface PhoenixAuditSnapshotSaveInput {
  snapshotId: string
  reason?: string
}

export interface PhoenixAuditSnapshotFile {
  path: string
  snapshot: PhoenixAuditReplaySnapshot
}

export interface PhoenixAuditSnapshotListItem {
  snapshotId: string
  exportedAt: number
  reason?: string
  entries: number
  path: string
  policyVersions: Record<string, string>
}

export class PhoenixAuditStore {
  private entries: PhoenixAuditEntry[] = []
  private maxEntries: number
  private version: string
  private hmacKey: Buffer | null = null
  private chainHash: string | null = null

  constructor(config: PhoenixAuditStoreConfig = {}) {
    this.maxEntries = config.maxEntries ?? 200
    this.version = config.version ?? 'phoenix-governance-0.1.0'
    if (config.hmacKey) {
      this.hmacKey = Buffer.from(config.hmacKey, 'utf-8')
    }
  }

  record(entry: Omit<PhoenixAuditEntry, 'id' | 'timestamp' | 'version'>): PhoenixAuditEntry {
    validateAuditBoundary(entry)

    const stored: PhoenixAuditEntry = {
      ...entry,
      id: `${Date.now()}-${this.entries.length + 1}`,
      timestamp: Date.now(),
      version: this.version,
    }

    // Append HMAC chain hash to metadata if integrity is enabled
    if (this.hmacKey) {
      const payload = JSON.stringify({
        id: stored.id,
        ts: stored.timestamp,
        stage: stored.stage,
        decision: stored.decision,
        prev: this.chainHash,
      })
      const hash = createHmac('sha256', this.hmacKey).update(payload).digest('hex')
      stored.metadata = { ...(stored.metadata ?? {}), _chainHash: hash }
      this.chainHash = hash
    }

    this.entries.push(stored)
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }

    return stored
  }

  recordIntentRoute(input: {
    prompt: string
    sessionId?: string
    userId?: string
    channel?: string
  }): PhoenixAuditEntry {
    return this.record({
      stage: 'intent_route',
      level: 'info',
      decision: 'observe_only',
      sessionId: input.sessionId,
      userId: input.userId,
      inputSummary: summarize(input.prompt),
      metadata: {
        channel: input.channel,
        promptLength: input.prompt.length,
      },
    })
  }

  recordMemoryScorePlaceholder(input: {
    sessionId?: string
    userId?: string
    memoryEnabled: boolean
    recallInjected: boolean
  }): PhoenixAuditEntry {
    return this.record({
      stage: 'memory_score',
      level: 'info',
      decision: 'placeholder_only',
      sessionId: input.sessionId,
      userId: input.userId,
      metadata: {
        memoryEnabled: input.memoryEnabled,
        recallInjected: input.recallInjected,
      },
    })
  }

  recordMemoryScoreDecision(input: {
    decision: EmlScoreDecision
    sessionId?: string
    userId?: string
    source?: string
    policyReason?: string
    policyCategory?: string
    shouldStore?: boolean
  }): PhoenixAuditEntry {
    return this.record({
      stage: 'memory_score',
      level: input.decision.action === 'archive' ? 'warn' : 'info',
      decision: input.decision.action,
      sessionId: input.sessionId,
      userId: input.userId,
      metadata: {
        source: input.source,
        score: input.decision.score,
        reasons: input.decision.reasons,
        thresholdVersion: input.decision.thresholdVersion,
        requiresArchiveCopy: input.decision.requiresArchiveCopy,
        policyReason: input.policyReason,
        policyCategory: input.policyCategory,
        shouldStore: input.shouldStore,
      },
    })
  }

  recordMemoryRecallDecision(decision: PhoenixMemoryRecallDecision): PhoenixAuditEntry {
    assertPhoenixBoundaryDecision(decision as unknown as Record<string, unknown>)

    return this.record({
      stage: 'memory_score',
      level: decision.effectiveLimit > decision.configuredLimit ? 'warn' : 'info',
      decision: 'recall_depth',
      sessionId: decision.sessionId,
      userId: decision.userId,
      metadata: {
        version: decision.version,
        channel: decision.channel,
        configuredLimit: decision.configuredLimit,
        recommendedLimit: decision.recommendedLimit,
        effectiveLimit: decision.effectiveLimit,
        reasons: decision.reasons,
        canWriteMemory: decision.canWriteMemory,
        canDeleteMemory: decision.canDeleteMemory,
      },
    })
  }

  recordReliabilityPlaceholder(input: {
    sessionId?: string
    userId?: string
    maxSteps: number
    maxToolCalls: number
  }): PhoenixAuditEntry {
    return this.record({
      stage: 'reliability_decision',
      level: 'info',
      decision: 'placeholder_only',
      sessionId: input.sessionId,
      userId: input.userId,
      metadata: {
        maxSteps: input.maxSteps,
        maxToolCalls: input.maxToolCalls,
      },
    })
  }

  recordReliabilityDecision(input: {
    decision: FlameBreakerDecision
    transition?: FlameBreakerAuditEntry
    sessionId?: string
    userId?: string
  }): PhoenixAuditEntry {
    assertPhoenixBoundaryDecision(input.decision.recommendation as unknown as Record<string, unknown>)

    return this.record({
      stage: 'reliability_decision',
      level: input.decision.recommendation.action === 'fallback' ? 'warn' : 'info',
      decision: input.decision.recommendation.action,
      sessionId: input.sessionId,
      userId: input.userId,
      metadata: {
        subsystem: input.decision.subsystem,
        operationKey: input.decision.operationKey,
        state: input.decision.state,
        reason: input.decision.recommendation.reason,
        originalError: input.decision.recommendation.originalError,
        canRetryAutomatically: input.decision.recommendation.canRetryAutomatically,
        canBypassPermission: input.decision.recommendation.canBypassPermission,
        hideOriginalError: input.decision.recommendation.hideOriginalError,
        transitionFrom: input.transition?.from,
        transitionTo: input.transition?.to,
        transitionReason: input.transition?.reason,
      },
    })
  }

  recordFallbackPathDecision(decision: PhoenixFallbackPathDecision): PhoenixAuditEntry {
    assertPhoenixBoundaryDecision(decision as unknown as Record<string, unknown>)

    return this.record({
      stage: 'reliability_decision',
      level: 'warn',
      decision: 'fallback_path',
      sessionId: decision.sessionId,
      userId: decision.userId,
      metadata: {
        version: decision.version,
        channel: decision.channel,
        subsystem: decision.subsystem,
        operationKey: decision.operationKey,
        recommendedPath: decision.recommendedPath,
        reasons: decision.reasons,
        originalError: decision.originalError,
        canRetryAutomatically: decision.canRetryAutomatically,
        canBypassPermission: decision.canBypassPermission,
        hideOriginalError: decision.hideOriginalError,
        canExecuteTool: decision.canExecuteTool,
      },
    })
  }

  recordAntibodyPolicyResult(input: {
    result: AntibodyPolicyResult
    sessionId?: string
    userId?: string
  }): PhoenixAuditEntry {
    assertPhoenixBoundaryDecision(input.result as unknown as Record<string, unknown>)

    return this.record({
      stage: 'antibody_lookup',
      level: input.result.action === 'proposed' ? 'warn' : 'info',
      decision: input.result.action,
      sessionId: input.sessionId,
      userId: input.userId,
      metadata: {
        reason: input.result.reason,
        subsystem: input.result.transition.subsystem,
        operationKey: input.result.transition.operationKey,
        transitionReason: input.result.transition.reason,
        pattern: input.result.rule?.pattern,
        ruleId: input.result.rule?.id,
        ruleStatus: input.result.rule?.status,
        canAffectExecution: input.result.canAffectExecution,
      },
    })
  }

  recordAntibodyLookupDecision(input: {
    pattern: string
    evaluation: AntibodyEvaluation
    sessionId?: string
    userId?: string
  }): PhoenixAuditEntry {
    assertPhoenixBoundaryDecision(input.evaluation as unknown as Record<string, unknown>)

    const matchedActiveRules = input.evaluation.matchedActiveRules.length
    return this.record({
      stage: 'antibody_lookup',
      level: matchedActiveRules > 0 ? 'warn' : 'info',
      decision: matchedActiveRules > 0 ? 'matched_active_rules' : 'no_match',
      sessionId: input.sessionId,
      userId: input.userId,
      metadata: {
        pattern: input.pattern,
        matchedActiveRules,
        canAffectExecution: input.evaluation.canAffectExecution,
        matchedRuleIds: input.evaluation.matchedActiveRules.map(rule => rule.id),
        matchedRuleStatuses: input.evaluation.matchedActiveRules.map(rule => rule.status),
        recommendations: input.evaluation.matchedActiveRules.map(rule => rule.recommendation),
      },
    })
  }

  recordSkillLookupDecision(input: {
    decision: PhoenixSkillLookupDecision
    matches?: SkillTriggerMatch[]
  }): PhoenixAuditEntry {
    assertPhoenixBoundaryDecision(input.decision as unknown as Record<string, unknown>)

    const matches = input.matches ?? []
    return this.record({
      stage: 'skill_lookup',
      level: input.decision.shouldLookup ? 'info' : 'info',
      decision: input.decision.shouldLookup ? 'lookup_recommended' : 'lookup_skipped',
      sessionId: input.decision.sessionId,
      userId: input.decision.userId,
      metadata: {
        version: input.decision.version,
        channel: input.decision.channel,
        query: input.decision.query,
        maxResults: input.decision.maxResults,
        availableSkillCount: input.decision.availableSkillCount,
        reasons: input.decision.reasons,
        matchedSkills: matches.length,
        matchedSkillNames: matches.map(match => match.skill.metadata.name),
        matchedBy: matches.map(match => match.matchedBy),
        canExecuteSkill: input.decision.canExecuteSkill,
      },
    })
  }

  recordGovernanceDecision(decision: PhoenixGovernanceDecision): PhoenixAuditEntry {
    assertPhoenixBoundaryDecision(decision as unknown as Record<string, unknown>)

    return this.record({
      stage: 'governance',
      level: decision.effectiveAction === 'block' ? 'warn' : 'info',
      decision: decision.effectiveAction,
      sessionId: decision.sessionId,
      userId: decision.userId,
      metadata: {
        mode: decision.mode,
        version: decision.version,
        channel: decision.channel,
        recommendedAction: decision.recommendedAction,
        reasons: decision.reasons,
        canApprovePermission: decision.canApprovePermission,
        canExecuteTool: decision.canExecuteTool,
      },
    })
  }

  getRecent(limit = 20): PhoenixAuditEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  /**
   * Verify the HMAC audit chain integrity. Returns the index of the first
   * tampered entry, or -1 if the chain is intact. Always returns -1 when
   * HMAC is not configured.
   */
  verifyChain(): number {
    if (!this.hmacKey) return -1

    let prevHash: string | null = null
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!
      const expectHash = (entry.metadata as Record<string, unknown> | undefined)?.['_chainHash'] as string | undefined
      if (!expectHash) return i

      const payload = JSON.stringify({
        id: entry.id,
        ts: entry.timestamp,
        stage: entry.stage,
        decision: entry.decision,
        prev: prevHash,
      })
      const computed = createHmac('sha256', this.hmacKey!).update(payload).digest('hex')

      if (!timingSafeEqual(Buffer.from(computed), Buffer.from(expectHash))) return i
      prevHash = expectHash
    }
    return -1
  }

  /** Check whether HMAC integrity verification is enabled. */
  hasIntegrityVerification(): boolean {
    return this.hmacKey !== null
  }

  exportReplaySnapshot(input: {
    snapshotId: string
    reason?: string
  }): PhoenixAuditReplaySnapshot {
    return {
      schemaVersion: 'phoenix-audit-snapshot-1',
      snapshotId: input.snapshotId,
      exportedAt: Date.now(),
      reason: input.reason,
      policyVersions: this.getPolicyVersions(),
      entries: this.entries.map(entry => ({ ...entry, metadata: entry.metadata ? { ...entry.metadata } : undefined })),
    }
  }

  static fromReplaySnapshot(snapshot: PhoenixAuditReplaySnapshot): PhoenixAuditStore {
    if (snapshot.schemaVersion !== 'phoenix-audit-snapshot-1') {
      throw new Error(`Unsupported Phoenix audit snapshot schema: ${snapshot.schemaVersion}`)
    }

    const store = new PhoenixAuditStore({
      maxEntries: Math.max(snapshot.entries.length, 1),
      version: snapshot.policyVersions.audit,
    })
    store.entries = snapshot.entries.map(entry => {
      validateAuditBoundary(entry)
      return { ...entry, metadata: entry.metadata ? { ...entry.metadata } : undefined }
    })
    return store
  }

  getStats(): Record<string, unknown> {
    const byStage = this.entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.stage] = (acc[entry.stage] ?? 0) + 1
      return acc
    }, {})

    return {
      status: 'observe_only',
      version: this.version,
      policyVersions: this.getPolicyVersions(),
      totalEntries: this.entries.length,
      byStage,
      memoryScore: this.getMemoryScoreStats(),
      recent: this.getRecent(5),
    }
  }

  private getPolicyVersions(): Record<string, string> {
    const versions: Record<string, string> = {
      audit: this.version,
    }

    for (const entry of this.entries) {
      if (typeof entry.metadata?.thresholdVersion === 'string') {
        versions.emlThresholds = entry.metadata.thresholdVersion
      }
      if (typeof entry.metadata?.version === 'string') {
        if (entry.stage === 'governance') {
          versions.phoenixCore = entry.metadata.version
        } else if (entry.stage === 'memory_score' && entry.decision === 'recall_depth') {
          versions.memoryRecall = entry.metadata.version
        } else if (entry.stage === 'skill_lookup') {
          versions.skillLookup = entry.metadata.version
        } else if (entry.stage === 'reliability_decision' && entry.decision === 'fallback_path') {
          versions.fallbackPath = entry.metadata.version
        }
      }
    }

    return versions
  }

  private getMemoryScoreStats(): Record<string, unknown> {
    const realDecisions = this.entries
      .filter(entry => entry.stage === 'memory_score' && entry.decision !== 'placeholder_only')

    const byAction = realDecisions.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.decision] = (acc[entry.decision] ?? 0) + 1
      return acc
    }, {})

    const recent = realDecisions.slice(-5).reverse().map(entry => ({
      action: entry.decision,
      score: typeof entry.metadata?.score === 'number' ? entry.metadata.score : undefined,
      policyReason: typeof entry.metadata?.policyReason === 'string' ? entry.metadata.policyReason : undefined,
      policyCategory: typeof entry.metadata?.policyCategory === 'string' ? entry.metadata.policyCategory : undefined,
      shouldStore: typeof entry.metadata?.shouldStore === 'boolean' ? entry.metadata.shouldStore : undefined,
      thresholdVersion: typeof entry.metadata?.thresholdVersion === 'string' ? entry.metadata.thresholdVersion : undefined,
      requiresArchiveCopy: typeof entry.metadata?.requiresArchiveCopy === 'boolean' ? entry.metadata.requiresArchiveCopy : undefined,
      timestamp: entry.timestamp,
    }))

    const latestThreshold = recent.find(entry => entry.thresholdVersion)?.thresholdVersion

    return {
      totalDecisions: realDecisions.length,
      byAction,
      thresholdVersion: latestThreshold,
      recent,
    }
  }
}

export class PhoenixAuditSnapshotStore {
  private readonly directory: string
  private readonly maxSnapshots: number
  private readonly now: () => number

  constructor(config: PhoenixAuditSnapshotStoreConfig) {
    this.directory = config.directory
    this.maxSnapshots = Math.max(config.maxSnapshots ?? 20, 1)
    this.now = config.now ?? Date.now
  }

  save(audit: PhoenixAuditStore, input: PhoenixAuditSnapshotSaveInput): PhoenixAuditSnapshotFile {
    this.ensureDirectory()
    const snapshot = {
      ...audit.exportReplaySnapshot(input),
      exportedAt: this.now(),
    }
    const path = this.pathForSnapshot(snapshot)
    const tempPath = `${path}.tmp`

    writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    renameSync(tempPath, path)
    this.rotate()

    return { path, snapshot }
  }

  list(): PhoenixAuditSnapshotListItem[] {
    this.ensureDirectory()
    return this.readSnapshotFiles()
      .map(({ path, snapshot }) => ({
        snapshotId: snapshot.snapshotId,
        exportedAt: snapshot.exportedAt,
        reason: snapshot.reason,
        entries: snapshot.entries.length,
        path,
        policyVersions: snapshot.policyVersions,
      }))
      .sort((a, b) => b.exportedAt - a.exportedAt || b.snapshotId.localeCompare(a.snapshotId))
  }

  getMaxSnapshots(): number {
    return this.maxSnapshots
  }

  restore(snapshotId: string): PhoenixAuditStore {
    const file = this.readSnapshotFiles().find(item => item.snapshot.snapshotId === snapshotId)
    if (!file) {
      throw new Error(`Phoenix audit snapshot not found: ${snapshotId}`)
    }
    return PhoenixAuditStore.fromReplaySnapshot(file.snapshot)
  }

  restoreLatest(): { snapshotId: string; audit: PhoenixAuditStore } | null {
    const latest = this.list()[0]
    if (!latest) {
      return null
    }
    return {
      snapshotId: latest.snapshotId,
      audit: this.restore(latest.snapshotId),
    }
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) {
      mkdirSync(this.directory, { recursive: true })
    }
  }

  private rotate(): void {
    const files = this.readSnapshotFiles()
      .sort((a, b) => b.snapshot.exportedAt - a.snapshot.exportedAt || b.snapshot.snapshotId.localeCompare(a.snapshot.snapshotId))

    for (const file of files.slice(this.maxSnapshots)) {
      rmSync(file.path, { force: true })
    }
  }

  private readSnapshotFiles(): PhoenixAuditSnapshotFile[] {
    this.ensureDirectory()
    const files = readdirSync(this.directory)
      .filter(file => file.endsWith('.json'))
      .map(file => join(this.directory, file))

    return files.map(path => {
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as PhoenixAuditReplaySnapshot
      PhoenixAuditStore.fromReplaySnapshot(snapshot)
      return { path, snapshot }
    })
  }

  private pathForSnapshot(snapshot: PhoenixAuditReplaySnapshot): string {
    return join(this.directory, `${snapshot.exportedAt}-${sanitizeSnapshotId(snapshot.snapshotId)}.json`)
  }
}

function summarize(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function sanitizeSnapshotId(snapshotId: string): string {
  const sanitized = snapshotId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return sanitized.length > 0 ? sanitized : 'snapshot'
}

function validateAuditBoundary(entry: Pick<PhoenixAuditEntry, 'metadata'> & object): void {
  assertPhoenixBoundaryDecision(entry as Record<string, unknown>)
  if (entry.metadata) {
    assertPhoenixBoundaryDecision(entry.metadata)
  }
}
