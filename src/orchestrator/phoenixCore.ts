export type PhoenixGovernanceMode = 'observe_only' | 'enforce'
export type PhoenixGovernanceAction = 'allow' | 'flag' | 'block'

export interface PhoenixCoreConfig {
  mode?: PhoenixGovernanceMode
  version?: string
}

export interface PhoenixGovernanceInput {
  prompt: string
  sessionId?: string
  userId?: string
  channel?: string
}

export interface PhoenixGovernanceDecision {
  mode: PhoenixGovernanceMode
  version: string
  recommendedAction: PhoenixGovernanceAction
  effectiveAction: PhoenixGovernanceAction
  reasons: string[]
  sessionId?: string
  userId?: string
  channel?: string
  canApprovePermission: false
  canExecuteTool: false
}

export interface PhoenixMemoryRecallInput {
  prompt: string
  configuredLimit: number
  minLimit?: number
  maxLimit?: number
  sessionId?: string
  userId?: string
  channel?: string
}

export interface PhoenixMemoryRecallDecision {
  version: string
  configuredLimit: number
  recommendedLimit: number
  effectiveLimit: number
  reasons: string[]
  sessionId?: string
  userId?: string
  channel?: string
  canWriteMemory: false
  canDeleteMemory: false
}

export interface PhoenixSkillLookupInput {
  prompt: string
  availableSkillCount?: number
  sessionId?: string
  userId?: string
  channel?: string
}

export interface PhoenixSkillLookupDecision {
  version: string
  shouldLookup: boolean
  query: string
  maxResults: number
  availableSkillCount?: number
  reasons: string[]
  sessionId?: string
  userId?: string
  channel?: string
  canExecuteSkill: false
}

export type PhoenixFallbackPath =
  | 'retry_with_reduced_context'
  | 'retry_later'
  | 'surface_original_error'

export interface PhoenixFallbackPathInput {
  subsystem: string
  operationKey: string
  error: unknown
  destructive?: boolean
  sessionId?: string
  userId?: string
  channel?: string
}

export interface PhoenixFallbackPathDecision {
  version: string
  subsystem: string
  operationKey: string
  recommendedPath: PhoenixFallbackPath
  reasons: string[]
  originalError: string
  sessionId?: string
  userId?: string
  channel?: string
  canRetryAutomatically: false
  canBypassPermission: false
  hideOriginalError: false
  canExecuteTool: false
}

const BLOCK_PATTERNS = [
  { pattern: /\brm\s+-rf\s+\/\b/i, reason: 'destructive_root_delete_requested' },
  { pattern: /\bdelete\s+everything\b/i, reason: 'broad_destructive_delete_requested' },
  { pattern: /\bbypass\s+permissions?\b/i, reason: 'permission_bypass_requested' },
  { pattern: /\bignore\s+all\s+permission\s+checks?\b/i, reason: 'permission_bypass_requested' },
]

const FLAG_PATTERNS = [
  { pattern: /\bsecret\b/i, reason: 'secret_handling_requested' },
  { pattern: /\bapi\s*key\b/i, reason: 'api_key_handling_requested' },
  { pattern: /\bcredential\b/i, reason: 'credential_handling_requested' },
]

export class PhoenixCore {
  private readonly mode: PhoenixGovernanceMode
  private readonly version: string

  constructor(config: PhoenixCoreConfig = {}) {
    this.mode = config.mode ?? 'observe_only'
    this.version = config.version ?? 'phoenix-core-0.1.0'
  }

  evaluateGovernance(input: PhoenixGovernanceInput): PhoenixGovernanceDecision {
    const reasons: string[] = []

    for (const rule of BLOCK_PATTERNS) {
      if (rule.pattern.test(input.prompt)) {
        reasons.push(rule.reason)
      }
    }

    for (const rule of FLAG_PATTERNS) {
      if (rule.pattern.test(input.prompt)) {
        reasons.push(rule.reason)
      }
    }

    const recommendedAction = reasons.some(reason => reason.includes('bypass') || reason.includes('destructive'))
      ? 'block'
      : reasons.length > 0
        ? 'flag'
        : 'allow'

    return {
      mode: this.mode,
      version: this.version,
      recommendedAction,
      effectiveAction: this.mode === 'enforce' ? recommendedAction : 'allow',
      reasons,
      sessionId: input.sessionId,
      userId: input.userId,
      channel: input.channel,
      canApprovePermission: false,
      canExecuteTool: false,
    }
  }

  recommendMemoryRecall(input: PhoenixMemoryRecallInput): PhoenixMemoryRecallDecision {
    const minLimit = input.minLimit ?? 1
    const maxLimit = input.maxLimit ?? 8
    const reasons: string[] = []
    let recommendedLimit = input.configuredLimit

    if (/\b(deep|research|architecture|investigate)\b/i.test(input.prompt) || /深入|研究|架构|排查/.test(input.prompt)) {
      recommendedLimit = Math.max(recommendedLimit, 5)
      reasons.push('deep_context_request')
    } else if (input.prompt.length < 80) {
      recommendedLimit = Math.min(recommendedLimit, 2)
      reasons.push('short_prompt_low_context_need')
    } else {
      reasons.push('default_context_need')
    }

    const effectiveLimit = Math.max(minLimit, Math.min(maxLimit, recommendedLimit))

    return {
      version: this.version,
      configuredLimit: input.configuredLimit,
      recommendedLimit,
      effectiveLimit,
      reasons,
      sessionId: input.sessionId,
      userId: input.userId,
      channel: input.channel,
      canWriteMemory: false,
      canDeleteMemory: false,
    }
  }

  recommendSkillLookup(input: PhoenixSkillLookupInput): PhoenixSkillLookupDecision {
    const reasons: string[] = []
    let query = ''

    if (/\b(code\s*review|review\b[\s\S]{0,40}\bcode|code\b[\s\S]{0,40}\breview|security\s+review)\b/i.test(input.prompt) || /代码审查|安全审查/.test(input.prompt)) {
      query = 'code review security'
      reasons.push('code_review_skill_signal')
    } else if (/\b(stock|portfolio|valuation)\b/i.test(input.prompt) || /股票|选股|估值/.test(input.prompt)) {
      query = 'stock analysis'
      reasons.push('finance_skill_signal')
    } else if (/\b(write|draft|article|content)\b/i.test(input.prompt) || /写作|文章|内容/.test(input.prompt)) {
      query = 'writing content'
      reasons.push('writing_skill_signal')
    }

    return {
      version: this.version,
      shouldLookup: query.length > 0,
      query,
      maxResults: 3,
      availableSkillCount: input.availableSkillCount,
      reasons: query.length > 0 ? reasons : ['no_skill_signal'],
      sessionId: input.sessionId,
      userId: input.userId,
      channel: input.channel,
      canExecuteSkill: false,
    }
  }

  recommendFallbackPath(input: PhoenixFallbackPathInput): PhoenixFallbackPathDecision {
    const originalError = stringifyError(input.error)
    const lowerError = originalError.toLowerCase()
    const reasons: string[] = []
    let recommendedPath: PhoenixFallbackPath = 'surface_original_error'

    if (input.subsystem === 'llm' && /context|deadline|timeout/.test(lowerError)) {
      recommendedPath = 'retry_with_reduced_context'
      reasons.push('llm_context_or_timeout_failure')
    } else if (/rate\s*limit|too many requests|429/.test(lowerError)) {
      recommendedPath = 'retry_later'
      reasons.push('rate_limit_failure')
    } else {
      reasons.push('unknown_failure_surface_error')
    }

    if (input.destructive) {
      reasons.push('destructive_operation_requires_manual_review')
    }

    return {
      version: this.version,
      subsystem: input.subsystem,
      operationKey: input.operationKey,
      recommendedPath,
      reasons,
      originalError,
      sessionId: input.sessionId,
      userId: input.userId,
      channel: input.channel,
      canRetryAutomatically: false,
      canBypassPermission: false,
      hideOriginalError: false,
      canExecuteTool: false,
    }
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
