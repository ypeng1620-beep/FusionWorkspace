/**
 * Permission Workflow — 审批、待确认请求与审计日志
 *
 * 为长期在线服务提供最小可用的权限工作流持久层。
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import type { PermissionDecision, ToolCall } from './permissionGate.js'

export type ApprovalScope = 'once' | 'session' | 'user'

export interface ApprovalRecord {
  id: string
  fingerprint: string
  toolName: string
  scope: ApprovalScope
  sessionId?: string
  userId?: string
  createdAt: number
  expiresAt?: number
  remainingUses?: number
  note?: string
}

export interface PendingApprovalRequest {
  id: string
  fingerprint: string
  toolCall: ToolCall
  sessionId?: string
  userId?: string
  createdAt: number
  riskLevel?: number
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

export interface PermissionAuditEntry {
  id: string
  createdAt: number
  toolName: string
  fingerprint: string
  approved: boolean
  reason: string
  riskLevel?: number
  mode: string
  sessionId?: string
  userId?: string
  approvalRequestId?: string
}

interface WorkflowState {
  approvals: ApprovalRecord[]
  pendingRequests: PendingApprovalRequest[]
  auditLog: PermissionAuditEntry[]
}

export interface PermissionWorkflowConfig {
  rootDir?: string
  maxAuditEntries?: number
  /** 待审批请求过期时间（毫秒，默认 15 分钟）。Webhook 通道可设更长。 */
  pendingRequestExpiryMs?: number
}

export class PermissionWorkflowStore {
  private statePath: string
  private maxAuditEntries: number
  private pendingRequestExpiryMs: number
  private state: WorkflowState

  constructor(config: PermissionWorkflowConfig = {}) {
    const rootDir = resolve(config.rootDir ?? join(process.cwd(), '.fusion-runtime', 'permissions'))
    if (!existsSync(rootDir)) {
      mkdirSync(rootDir, { recursive: true })
    }

    this.statePath = join(rootDir, 'workflow-state.json')
    this.maxAuditEntries = config.maxAuditEntries ?? 500
    this.pendingRequestExpiryMs = config.pendingRequestExpiryMs ?? 15 * 60 * 1000
    this.state = this.loadState()
  }

  getMatchingApproval(call: ToolCall, sessionId?: string, userId?: string): ApprovalRecord | null {
    const fingerprint = createToolFingerprint(call)
    const now = Date.now()

    this.pruneExpired(now)

    const approval = this.state.approvals.find(record => {
      if (record.fingerprint !== fingerprint) return false
      if (record.expiresAt && record.expiresAt < now) return false
      if (record.scope === 'session' && record.sessionId && record.sessionId !== sessionId) return false
      if (record.scope === 'user' && record.userId && record.userId !== userId) return false
      return true
    }) ?? null

    if (!approval) return null

    if (approval.remainingUses !== undefined) {
      approval.remainingUses -= 1
      if (approval.remainingUses <= 0) {
        this.state.approvals = this.state.approvals.filter(record => record.id !== approval.id)
      }
      this.persist()
    }

    return approval
  }

  registerApproval(
    call: ToolCall,
    options: {
      scope?: ApprovalScope
      sessionId?: string
      userId?: string
      ttlMs?: number
      note?: string
      remainingUses?: number
    } = {},
  ): ApprovalRecord {
    const now = Date.now()
    const record: ApprovalRecord = {
      id: randomUUID(),
      fingerprint: createToolFingerprint(call),
      toolName: call.name,
      scope: options.scope ?? 'once',
      sessionId: options.sessionId,
      userId: options.userId,
      createdAt: now,
      expiresAt: options.ttlMs ? now + options.ttlMs : undefined,
      remainingUses: options.remainingUses ?? ((options.scope ?? 'once') === 'once' ? 1 : undefined),
      note: options.note,
    }

    this.state.approvals.push(record)
    this.persist()
    return record
  }

  createPendingRequest(
    call: ToolCall,
    options: {
      sessionId?: string
      userId?: string
      riskLevel?: number
      reason: string
    },
  ): PendingApprovalRequest {
    const existing = this.state.pendingRequests.find(request =>
      request.status === 'pending'
      && request.fingerprint === createToolFingerprint(call)
      && request.sessionId === options.sessionId
      && request.userId === options.userId,
    )

    if (existing) {
      return existing
    }

    const request: PendingApprovalRequest = {
      id: randomUUID(),
      fingerprint: createToolFingerprint(call),
      toolCall: call,
      sessionId: options.sessionId,
      userId: options.userId,
      createdAt: Date.now(),
      riskLevel: options.riskLevel,
      reason: options.reason,
      status: 'pending',
    }

    this.state.pendingRequests.push(request)
    this.persist()
    return request
  }

  resolvePendingRequest(id: string, approved: boolean): PendingApprovalRequest | null {
    const request = this.state.pendingRequests.find(item => item.id === id) ?? null
    if (!request) return null

    request.status = approved ? 'approved' : 'rejected'
    this.persist()
    return request
  }

  logDecision(entry: Omit<PermissionAuditEntry, 'id' | 'createdAt'>): PermissionAuditEntry {
    const auditEntry: PermissionAuditEntry = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...entry,
    }

    this.state.auditLog.push(auditEntry)
    if (this.state.auditLog.length > this.maxAuditEntries) {
      this.state.auditLog = this.state.auditLog.slice(-this.maxAuditEntries)
    }
    this.persist()
    return auditEntry
  }

  getPendingRequests(): PendingApprovalRequest[] {
    this.pruneExpired(Date.now())
    return this.state.pendingRequests.filter(request => request.status === 'pending')
  }

  getAuditLog(): PermissionAuditEntry[] {
    return [...this.state.auditLog]
  }

  private loadState(): WorkflowState {
    if (!existsSync(this.statePath)) {
      return { approvals: [], pendingRequests: [], auditLog: [] }
    }

    try {
      return JSON.parse(readFileSync(this.statePath, 'utf-8')) as WorkflowState
    } catch {
      return { approvals: [], pendingRequests: [], auditLog: [] }
    }
  }

  private pruneExpired(now: number): void {
    const beforeApprovals = this.state.approvals.length
    const beforePending = this.state.pendingRequests.length

    this.state.approvals = this.state.approvals.filter(record => !record.expiresAt || record.expiresAt >= now)
    this.state.pendingRequests = this.state.pendingRequests.map(request => {
      if (request.status !== 'pending') return request
      if (now - request.createdAt > this.pendingRequestExpiryMs) {
        return { ...request, status: 'expired' }
      }
      return request
    })

    if (beforeApprovals !== this.state.approvals.length || beforePending !== this.state.pendingRequests.length) {
      this.persist()
    }
  }

  private persist(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8')
  }
}

export function createToolFingerprint(call: ToolCall): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      )
    }
    return value
  }

  return JSON.stringify({
    name: call.name,
    cwd: call.cwd ?? '',
    params: normalize(call.params),
  })
}
