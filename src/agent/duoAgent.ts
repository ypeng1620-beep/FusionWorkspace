/**
 * DuoAgent — Dual-agent collaboration coordinator.
 *
 * Coordinates a local agent (read/write/execute) with an external review
 * agent (read-only). The review agent receives a redacted context payload
 * and returns structured suggestions filtered against Phoenix boundary
 * contracts before the local agent acts on them.
 */

import type { LlmProvider } from '../llm/llmProvider.js'
import type { PhoenixCore } from '../orchestrator/phoenixCore.js'
import type { PhoenixAuditStore } from '../orchestrator/phoenixAudit.js'
import {
  ExternalReviewer,
  buildReviewContext,
  type ReviewContext,
  type ReviewResult,
  type ReviewSuggestion,
  type ReviewAuditEntry,
} from './externalReviewer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DuoAgentConfig {
  /** Local agent's LLM provider (read/write/execute). */
  localProvider: LlmProvider
  /** External reviewer's LLM provider (read-only). */
  reviewProvider: LlmProvider
  /** Phoenix governance core for boundary enforcement. */
  phoenixCore?: PhoenixCore
  /** Phoenix audit store for review trail persistence. */
  auditStore?: PhoenixAuditStore
  /** Whether to auto-apply suggestions that pass boundary checks. */
  autoApply?: boolean
  /** Max review iterations per task. */
  maxReviewIterations?: number
}

export interface DuoAgentSession {
  id: string
  task: string
  architectureSummary: string
  reviewHistory: ReviewResult[]
  auditTrail: ReviewAuditEntry[]
  startedAt: number
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export class DuoAgent {
  private localProvider: LlmProvider
  private reviewer: ExternalReviewer
  private phoenixCore?: PhoenixCore
  private auditStore?: PhoenixAuditStore
  private autoApply: boolean
  private maxReviewIterations: number
  private sessions: Map<string, DuoAgentSession> = new Map()

  constructor(config: DuoAgentConfig) {
    this.localProvider = config.localProvider
    this.phoenixCore = config.phoenixCore
    this.auditStore = config.auditStore
    this.autoApply = config.autoApply ?? false
    this.maxReviewIterations = config.maxReviewIterations ?? 3

    this.reviewer = new ExternalReviewer({
      provider: config.reviewProvider,
      phoenixCore: config.phoenixCore,
    })
  }

  /**
   * Start a new DuoAgent session.
   */
  startSession(task: string, architectureSummary: string): DuoAgentSession {
    const session: DuoAgentSession = {
      id: `duo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      task,
      architectureSummary,
      reviewHistory: [],
      auditTrail: [],
      startedAt: Date.now(),
    }
    this.sessions.set(session.id, session)
    return session
  }

  /**
   * Request an external review for a session.
   *
   * Returns filtered suggestions — only those that pass Phoenix boundary
   * checks. Rejected suggestions are recorded in the audit trail.
   */
  async requestReview(
    sessionId: string,
    changedFiles: Array<{ path: string; summary: string }>,
    testFailures: string[] = [],
  ): Promise<{
    result: ReviewResult
    allowed: ReviewSuggestion[]
    rejected: Array<{ suggestion: ReviewSuggestion; reason: string }>
  }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`DuoAgent session not found: ${sessionId}`)
    }

    const context = buildReviewContext({
      task: session.task,
      architectureSummary: session.architectureSummary,
      changedFiles,
      testFailures,
      boundaryContractVersion: '1.0.0',
    })

    const result = await this.reviewer.review(context)
    session.reviewHistory.push(result)

    const { allowed, rejected } = this.reviewer.filterSuggestions(result.suggestions)
    // Only push newly generated audit entries (avoid duplicates across iterations)
    const knownIds = new Set(session.auditTrail.map(e => e.suggestionId + e.action + e.timestamp))
    for (const entry of this.reviewer.getAuditTrail()) {
      const key = entry.suggestionId + entry.action + entry.timestamp
      if (!knownIds.has(key)) {
        session.auditTrail.push(entry)
        knownIds.add(key)
      }
    }

    // Persist audit trail if store is available
    if (this.auditStore) {
      for (const entry of this.reviewer.getAuditTrail()) {
        this.auditStore.record({
          stage: 'governance',
          level: entry.action === 'rejected' ? 'warn' : 'info',
          decision: `duo_agent_${entry.action}`,
          sessionId,
          metadata: {
            reviewId: entry.reviewId,
            suggestionId: entry.suggestionId,
            action: entry.action,
            reason: entry.reason,
          },
        })
      }
    }

    return { result, allowed, rejected }
  }

  /**
   * Apply accepted suggestions (mark them in the audit trail).
   * The local agent is responsible for the actual implementation.
   */
  acceptSuggestion(sessionId: string, suggestionId: string, reason: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const entry: ReviewAuditEntry = {
      reviewId: sessionId,
      suggestionId,
      action: 'accepted',
      reason,
      timestamp: Date.now(),
    }
    session.auditTrail.push(entry)
    this.reviewer.recordAudit(entry)
  }

  /**
   * Defer a suggestion for later review.
   */
  deferSuggestion(sessionId: string, suggestionId: string, reason: string): void {
    const entry: ReviewAuditEntry = {
      reviewId: sessionId,
      suggestionId,
      action: 'deferred',
      reason,
      timestamp: Date.now(),
    }
    this.sessions.get(sessionId)?.auditTrail.push(entry)
    this.reviewer.recordAudit(entry)
  }

  /**
   * Run the full DuoAgent cycle: review → filter → apply.
   *
   * Iterates up to maxReviewIterations, stopping when the reviewer
   * returns 'approve' or no new suggestions are produced.
   */
  async *runCycle(
    sessionId: string,
    changedFiles: Array<{ path: string; summary: string }>,
    testFailures: string[] = [],
  ): AsyncGenerator<{
    iteration: number
    result: ReviewResult
    allowed: ReviewSuggestion[]
    rejected: Array<{ suggestion: ReviewSuggestion; reason: string }>
  }> {
    for (let i = 0; i < this.maxReviewIterations; i++) {
      const { result, allowed, rejected } = await this.requestReview(
        sessionId,
        changedFiles,
        testFailures,
      )

      yield { iteration: i + 1, result, allowed, rejected }

      if (result.overallAssessment === 'approve') break
      if (allowed.length === 0 && rejected.length === 0) break

      // Auto-accept allowed suggestions
      if (this.autoApply) {
        for (const s of allowed) {
          this.acceptSuggestion(sessionId, s.id, 'auto-applied by DuoAgent cycle')
        }
      }
    }
  }

  /** Get session info. */
  getSession(sessionId: string): DuoAgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Get all active sessions. */
  getSessions(): DuoAgentSession[] {
    return [...this.sessions.values()]
  }

  /** Get the reviewer's full audit trail. */
  getAuditTrail(): readonly ReviewAuditEntry[] {
    return this.reviewer.getAuditTrail()
  }

  /** Close a session. */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
