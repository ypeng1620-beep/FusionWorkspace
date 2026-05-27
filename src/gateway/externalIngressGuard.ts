import type { ChannelType } from './gateway.js'

export type ExternalIngressDecisionReason =
  | 'accepted'
  | 'channel_mismatch'
  | 'missing_signature'
  | 'invalid_signature'
  | 'duplicate'
  | 'rate_limited'

export interface ExternalIngressRateLimitConfig {
  maxMessages: number
  windowMs: number
}

export interface ExternalIngressGuardConfig {
  channel: ChannelType
  requireSignature?: boolean
  secret?: string
  dedupWindowMs?: number
  rateLimit?: ExternalIngressRateLimitConfig
}

export interface ExternalIngressInput {
  channel: ChannelType
  messageId: string
  externalUserId: string
  content: string
  timestamp: number
  signature?: string
  metadata?: Record<string, unknown>
}

export interface ExternalIngressDecision {
  allowed: boolean
  reason: ExternalIngressDecisionReason
  idempotencyKey: string
  retryAfterMs?: number
  metadata?: Record<string, unknown>
}

export class ExternalIngressGuard {
  private seen = new Map<string, number>()
  private rateBuckets = new Map<string, number[]>()
  private config: Required<Omit<ExternalIngressGuardConfig, 'secret' | 'rateLimit'>> & {
    secret?: string
    rateLimit?: ExternalIngressRateLimitConfig
  }

  constructor(config: ExternalIngressGuardConfig) {
    this.config = {
      channel: config.channel,
      requireSignature: config.requireSignature ?? false,
      secret: config.secret,
      dedupWindowMs: config.dedupWindowMs ?? 5_000,
      rateLimit: config.rateLimit,
    }
  }

  inspect(input: ExternalIngressInput): ExternalIngressDecision {
    const idempotencyKey = `${input.channel}:${input.messageId}`

    if (input.channel !== this.config.channel) {
      return { allowed: false, reason: 'channel_mismatch', idempotencyKey }
    }

    const signatureDecision = this.checkSignature(input, idempotencyKey)
    if (signatureDecision) {
      return signatureDecision
    }

    if (this.isDuplicate(idempotencyKey, input.timestamp)) {
      return { allowed: false, reason: 'duplicate', idempotencyKey }
    }

    const rateLimitDecision = this.checkRateLimit(input, idempotencyKey)
    if (rateLimitDecision) {
      return rateLimitDecision
    }

    this.seen.set(idempotencyKey, input.timestamp)
    this.cleanupSeen(input.timestamp)

    return {
      allowed: true,
      reason: 'accepted',
      idempotencyKey,
      metadata: {
        channel: input.channel,
        externalUserId: input.externalUserId,
      },
    }
  }

  getStats(): Record<string, unknown> {
    return {
      channel: this.config.channel,
      dedupCacheSize: this.seen.size,
      rateLimitSubjects: this.rateBuckets.size,
      signatureRequired: this.config.requireSignature,
    }
  }

  getConfigSnapshot(): ExternalIngressGuardConfig {
    return {
      channel: this.config.channel,
      requireSignature: this.config.requireSignature,
      secret: this.config.secret,
      dedupWindowMs: this.config.dedupWindowMs,
      rateLimit: this.config.rateLimit,
    }
  }

  private checkSignature(input: ExternalIngressInput, idempotencyKey: string): ExternalIngressDecision | null {
    if (!this.config.requireSignature) {
      return null
    }

    if (!input.signature) {
      return { allowed: false, reason: 'missing_signature', idempotencyKey }
    }

    const expected = `${this.config.secret ?? ''}:${input.messageId}`
    if (input.signature !== expected) {
      return { allowed: false, reason: 'invalid_signature', idempotencyKey }
    }

    return null
  }

  private isDuplicate(idempotencyKey: string, now: number): boolean {
    const seenAt = this.seen.get(idempotencyKey)
    return seenAt !== undefined && now - seenAt < this.config.dedupWindowMs
  }

  private cleanupSeen(now: number): void {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt >= this.config.dedupWindowMs) {
        this.seen.delete(key)
      }
    }
  }

  private checkRateLimit(input: ExternalIngressInput, idempotencyKey: string): ExternalIngressDecision | null {
    const rateLimit = this.config.rateLimit
    if (!rateLimit) {
      return null
    }

    const bucketKey = `${input.channel}:${input.externalUserId}`
    const existing = this.rateBuckets.get(bucketKey) ?? []
    const recent = existing.filter(timestamp => input.timestamp - timestamp < rateLimit.windowMs)

    if (recent.length >= rateLimit.maxMessages) {
      const oldest = recent[0] ?? input.timestamp
      return {
        allowed: false,
        reason: 'rate_limited',
        idempotencyKey,
        retryAfterMs: Math.max(0, rateLimit.windowMs - (input.timestamp - oldest)),
      }
    }

    recent.push(input.timestamp)
    this.rateBuckets.set(bucketKey, recent)
    return null
  }
}
