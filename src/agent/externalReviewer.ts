/**
 * External Reviewer — calls an external LLM (Gemini, OpenRouter, etc.) to
 * review code changes and architecture decisions.
 *
 * The reviewer is read-only — it receives a redacted context payload and
 * returns structured suggestions. Suggestions are filtered against Phoenix
 * boundary contracts before being presented to the local agent.
 */

import type { LlmProvider } from '../llm/llmProvider.js'
import type { PhoenixCore } from '../orchestrator/phoenixCore.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewContext {
  /** High-level task description */
  task: string
  /** Architecture summary (file structure, key interfaces) */
  architectureSummary: string
  /** Recently changed files with diff summaries */
  changedFiles: Array<{ path: string; summary: string }>
  /** Test failures (if any) */
  testFailures: string[]
  /** Current Phoenix boundary contract version */
  boundaryContractVersion: string
}

export interface ReviewSuggestion {
  id: string
  category: 'security' | 'architecture' | 'performance' | 'correctness' | 'style'
  severity: 'critical' | 'warning' | 'info'
  summary: string
  detail: string
  /** File or component this suggestion applies to */
  target?: string
}

export interface ReviewResult {
  suggestions: ReviewSuggestion[]
  overallAssessment: 'approve' | 'approve_with_suggestions' | 'request_changes'
  summary: string
  reviewerModel: string
  timestamp: number
}

export interface ReviewAuditEntry {
  reviewId: string
  suggestionId: string
  action: 'accepted' | 'rejected' | 'deferred'
  reason: string
  timestamp: number
}

export interface ExternalReviewerOptions {
  provider: LlmProvider
  phoenixCore?: PhoenixCore
  /** Max suggestions to return per review */
  maxSuggestions?: number
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/** Build a redacted review payload safe for external LLM consumption. */
export function buildReviewContext(params: {
  task: string
  architectureSummary: string
  changedFiles: Array<{ path: string; summary: string }>
  testFailures?: string[]
  boundaryContractVersion?: string
}): ReviewContext {
  return {
    task: redactSensitive(params.task),
    architectureSummary: redactSensitive(params.architectureSummary),
    changedFiles: params.changedFiles.map((f) => ({
      path: redactPath(f.path),
      summary: redactSensitive(f.summary),
    })),
    testFailures: (params.testFailures ?? []).map(redactSensitive),
    boundaryContractVersion: params.boundaryContractVersion ?? '1.0.0',
  }
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

export class ExternalReviewer {
  private provider: LlmProvider
  private phoenixCore?: PhoenixCore
  private maxSuggestions: number
  private auditTrail: ReviewAuditEntry[] = []

  constructor(options: ExternalReviewerOptions) {
    this.provider = options.provider
    this.phoenixCore = options.phoenixCore
    this.maxSuggestions = options.maxSuggestions ?? 10
  }

  /**
   * Send a review request to the external LLM.
   */
  async review(context: ReviewContext): Promise<ReviewResult> {
    const prompt = buildReviewPrompt(context)

    const result = await this.provider.chat(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
      { temperature: 0.3 },
    )

    return this.parseReviewResult(result.text, this.provider.model)
  }

  /**
   * Filter suggestions against Phoenix boundary contracts.
   * Suggestions that would violate boundaries are rejected.
   */
  filterSuggestions(suggestions: ReviewSuggestion[]): {
    allowed: ReviewSuggestion[]
    rejected: Array<{ suggestion: ReviewSuggestion; reason: string }>
  } {
    if (!this.phoenixCore) {
      return { allowed: suggestions, rejected: [] }
    }

    const allowed: ReviewSuggestion[] = []
    const rejected: Array<{ suggestion: ReviewSuggestion; reason: string }> = []

    for (const suggestion of suggestions) {
      const decision = this.phoenixCore.evaluateGovernance({
        prompt: `${suggestion.summary}\n${suggestion.detail}`,
      })

      if (decision.recommendedAction === 'block') {
        const reason = decision.reasons.length > 0 ? decision.reasons.join('; ') : 'boundary violation'
        rejected.push({ suggestion, reason })
        this.auditTrail.push({
          reviewId: suggestion.id,
          suggestionId: suggestion.id,
          action: 'rejected',
          reason: `Phoenix boundary violation: ${reason}`,
          timestamp: Date.now(),
        })
      } else {
        allowed.push(suggestion)
      }
    }

    return { allowed, rejected }
  }

  /**
   * Record an audit entry for a suggestion disposition.
   */
  recordAudit(entry: ReviewAuditEntry): void {
    this.auditTrail.push(entry)
  }

  /** Get the full audit trail. */
  getAuditTrail(): readonly ReviewAuditEntry[] {
    return this.auditTrail
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private parseReviewResult(text: string, model: string): ReviewResult {
    const suggestions: ReviewSuggestion[] = []
    let overallAssessment: ReviewResult['overallAssessment'] = 'approve_with_suggestions'
    let summary = text

    // Try to extract structured suggestions from the LLM response
    const lines = text.split('\n')
    let currentSuggestion: Partial<ReviewSuggestion> | null = null

    for (const line of lines) {
      const trimmed = line.trim()

      // Detect overall assessment
      if (trimmed.match(/^overall\s*(assessment|verdict)?\s*:\s*/i)) {
        const value = trimmed.split(':')[1]?.trim().toLowerCase() ?? ''
        if (value.includes('approve_with_suggestions') || value.includes('approve with')) {
          overallAssessment = 'approve_with_suggestions'
        } else if (value.includes('request_changes') || value.includes('request changes')) {
          overallAssessment = 'request_changes'
        } else if (value.includes('approve')) {
          overallAssessment = 'approve'
        }
        continue
      }

      // Detect suggestion blocks
      const sugMatch = trimmed.match(/^###?\s*(?:suggestion\s*)?(\d+)?\s*[-:]?\s*(.+)/i)
      if (sugMatch) {
        if (currentSuggestion && currentSuggestion.summary) {
          suggestions.push({
            id: currentSuggestion.id ?? `sug-${Date.now()}-${suggestions.length}`,
            category: currentSuggestion.category ?? 'style',
            severity: currentSuggestion.severity ?? 'info',
            summary: currentSuggestion.summary,
            detail: currentSuggestion.detail ?? currentSuggestion.summary,
            target: currentSuggestion.target,
          })
        }
        currentSuggestion = {
          id: `sug-${Date.now()}-${suggestions.length}`,
          summary: sugMatch[2],
          detail: '',
        }
        continue
      }

      // Detect severity in current suggestion
      if (currentSuggestion) {
        const sevMatch = trimmed.match(/^\*\*severity\*\*\s*:\s*(.+)/i)
        if (sevMatch) {
          const sev = sevMatch[1].trim().toLowerCase()
          if (sev.includes('critical')) currentSuggestion.severity = 'critical'
          else if (sev.includes('warning')) currentSuggestion.severity = 'warning'
          else currentSuggestion.severity = 'info'
          continue
        }
        const catMatch = trimmed.match(/^\*\*category\*\*\s*:\s*(.+)/i)
        if (catMatch) {
          const cat = catMatch[1].trim().toLowerCase()
          if (cat.includes('security')) currentSuggestion.category = 'security'
          else if (cat.includes('architecture') || cat.includes('arch')) currentSuggestion.category = 'architecture'
          else if (cat.includes('performance') || cat.includes('perf')) currentSuggestion.category = 'performance'
          else if (cat.includes('correctness') || cat.includes('correct')) currentSuggestion.category = 'correctness'
          else currentSuggestion.category = 'style'
          continue
        }
        // Accumulate detail
        currentSuggestion.detail = (currentSuggestion.detail ?? '') + trimmed + '\n'
      }
    }

    // Flush last suggestion
    if (currentSuggestion && currentSuggestion.summary) {
      suggestions.push({
        id: currentSuggestion.id ?? `sug-${Date.now()}-${suggestions.length}`,
        category: currentSuggestion.category ?? 'style',
        severity: currentSuggestion.severity ?? 'info',
        summary: currentSuggestion.summary,
        detail: (currentSuggestion.detail ?? currentSuggestion.summary).trim(),
        target: currentSuggestion.target,
      })
    }

    // If no structured suggestions found, use the full text as summary
    if (suggestions.length === 0) {
      summary = text
    } else {
      summary = `${suggestions.length} suggestion(s), overall: ${overallAssessment}`
    }

    return {
      suggestions: suggestions.slice(0, this.maxSuggestions),
      overallAssessment,
      summary,
      reviewerModel: model,
      timestamp: Date.now(),
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReviewPrompt(context: ReviewContext): string {
  return [
    'You are a code review assistant. Review the following context and provide structured suggestions.',
    '',
    '## Format',
    'Return suggestions in this format:',
    '',
    'Overall Assessment: [approve | approve_with_suggestions | request_changes]',
    '',
    '### Suggestion 1: [summary]',
    '**Severity:** [critical | warning | info]',
    '**Category:** [security | architecture | performance | correctness | style]',
    '[detail]',
    '',
    '## Context',
    `Task: ${context.task}`,
    '',
    '### Architecture Summary',
    context.architectureSummary,
    '',
    '### Changed Files',
    ...context.changedFiles.map((f) => `- ${f.path}: ${f.summary}`),
    '',
    context.testFailures.length > 0
      ? ['### Test Failures', ...context.testFailures.map((f) => `- ${f}`)].join('\n')
      : 'No test failures.',
    '',
    `Boundary Contract Version: ${context.boundaryContractVersion}`,
    '',
    '## Constraints',
    '- Do NOT suggest changes that bypass permission gates',
    '- Do NOT suggest removing safety checks (FlameBreaker, Phoenix boundaries)',
    '- Do NOT suggest exposing internal APIs or secrets',
    '- Focus on correctness, security, and maintainability',
    '- Keep suggestions actionable and specific',
  ].join('\n')
}

function redactSensitive(text: string): string {
  return text
    .replace(/api[_-]?key[=:]\s*\S+/gi, '[REDACTED_API_KEY]')
    .replace(/secret[=:]\s*\S+/gi, '[REDACTED_SECRET]')
    .replace(/token[=:]\s*\S+/gi, '[REDACTED_TOKEN]')
    .replace(/(?:sk|pk|api)[-_][a-zA-Z0-9]{20,}/g, '[REDACTED_KEY]')
}

function redactPath(path: string): string {
  return path.replace(/[\\/]home[\\/]\w+/, '/home/[user]')
    .replace(/[\\/]Users[\\/]\w+/, '/Users/[user]')
    .replace(/[\\/]\.ssh[\\/]/, '/.ssh/')
    .replace(/[\\/]\.env/, '/.env')
}
