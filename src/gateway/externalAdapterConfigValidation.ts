import { ExternalIngressGuard } from './externalIngressGuard.js'
import type { ExternalChannelConfig } from './externalChannel.js'

export type ExternalAdapterConfigValidationStatus = 'ok' | 'degraded' | 'unavailable'

export interface ExternalAdapterConfigValidationOptions {
  strict?: boolean
}

export interface ExternalAdapterConfigValidationResult {
  status: ExternalAdapterConfigValidationStatus
  errors: string[]
  warnings: string[]
}

interface GuardConfigShape {
  requireSignature?: boolean
  secret?: string
  rateLimit?: {
    maxMessages?: number
    windowMs?: number
  }
}

export function validateExternalAdapterConfig(
  config: ExternalChannelConfig,
  options: ExternalAdapterConfigValidationOptions = {},
): ExternalAdapterConfigValidationResult {
  const issues = collectIssues(config)
  const strict = options.strict ?? false
  const errors = strict ? issues.map(issue => issue.strictMessage) : []
  const warnings = strict ? [] : issues.map(issue => issue.warningMessage)

  return {
    status: errors.length > 0 ? 'unavailable' : warnings.length > 0 ? 'degraded' : 'ok',
    errors,
    warnings,
  }
}

export function assertExternalAdapterConfigReady(
  config: ExternalChannelConfig,
  options: ExternalAdapterConfigValidationOptions = {},
): void {
  const result = validateExternalAdapterConfig(config, {
    ...options,
    strict: true,
  })
  if (result.status !== 'ok') {
    throw new Error(`External adapter config is not production-ready: ${result.errors.join('; ')}`)
  }
}

function collectIssues(config: ExternalChannelConfig): Array<{ strictMessage: string; warningMessage: string }> {
  const issues: Array<{ strictMessage: string; warningMessage: string }> = []
  const guard = getGuardShape(config.ingressGuard)

  if (!config.ingressGuard) {
    issues.push({
      strictMessage: 'ingressGuard is required',
      warningMessage: 'ingressGuard should be set',
    })
  }

  if (guard?.requireSignature !== true) {
    issues.push({
      strictMessage: 'ingressGuard.requireSignature must be true',
      warningMessage: 'ingressGuard.requireSignature should be true',
    })
  }

  if (!guard?.secret) {
    issues.push({
      strictMessage: 'ingressGuard.secret is required',
      warningMessage: 'ingressGuard.secret should be set',
    })
  }

  if (!guard?.rateLimit) {
    issues.push({
      strictMessage: 'ingressGuard.rateLimit is required',
      warningMessage: 'ingressGuard.rateLimit should be set',
    })
  } else {
    if (!guard.rateLimit.maxMessages || guard.rateLimit.maxMessages <= 0) {
      issues.push({
        strictMessage: 'ingressGuard.rateLimit.maxMessages must be > 0',
        warningMessage: 'ingressGuard.rateLimit.maxMessages should be > 0',
      })
    }
    if (!guard.rateLimit.windowMs || guard.rateLimit.windowMs <= 0) {
      issues.push({
        strictMessage: 'ingressGuard.rateLimit.windowMs must be > 0',
        warningMessage: 'ingressGuard.rateLimit.windowMs should be > 0',
      })
    }
  }

  if (!config.ingressAuditLogPath) {
    issues.push({
      strictMessage: 'ingressAuditLogPath is required',
      warningMessage: 'ingressAuditLogPath should be set',
    })
  }

  return issues
}

function getGuardShape(guard: ExternalChannelConfig['ingressGuard']): GuardConfigShape | undefined {
  if (!guard) {
    return undefined
  }
  if (guard instanceof ExternalIngressGuard) {
    return guard.getConfigSnapshot()
  }
  return guard
}
