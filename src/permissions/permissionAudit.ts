/**
 * Permission Audit — 审计回放系统
 *
 * 长期服务必须能回放"为什么当时允许了这个工具调用"。
 *
 * 功能：
 * - 记录每次权限决策的完整上下文
 * - 支持按时间/用户/工具/渠道查询
 * - 支持决策回放（重现当时的判断逻辑）
 * - 支持审计导出（JSON/CSV）
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import type { PermissionMode } from './permissionGate.js'
import type { ChannelId } from './permissionPolicyEngine.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 审计条目 */
export interface AuditEntry {
  id: string
  timestamp: number
  /** 决策结果 */
  decision: 'approved' | 'denied' | 'required_confirmation' | 'expired'
  /** 工具信息 */
  toolName: string
  toolParams: Record<string, unknown>
  toolCategory: string
  /** 风险评估 */
  riskLevel: number
  riskFactors: string[]
  /** 身份上下文 */
  userId?: string
  sessionId?: string
  channel: ChannelId
  groupId?: string
  /** 权限上下文 */
  mode: PermissionMode
  policyApplied: string
  /** 审批信息 */
  approvalRequestId?: string
  approvedBy?: string
  approvalNote?: string
  /** 执行结果 */
  executionSuccess?: boolean
  executionError?: string
}

/** 查询过滤器 */
export interface AuditQuery {
  /** 时间范围 */
  fromTimestamp?: number
  toTimestamp?: number
  /** 用户 ID */
  userId?: string
  /** 会话 ID */
  sessionId?: string
  /** 渠道 */
  channel?: ChannelId
  /** 工具名 */
  toolName?: string
  /** 决策结果 */
  decision?: AuditEntry['decision']
  /** 风险等级范围 */
  minRiskLevel?: number
  maxRiskLevel?: number
  /** 限制条数 */
  limit?: number
}

/** 审计统计 */
export interface AuditStats {
  totalEntries: number
  byDecision: Record<AuditEntry['decision'], number>
  byChannel: Record<string, number>
  byTool: Record<string, number>
  avgRiskLevel: number
  highRiskCount: number
  confirmationRate: number
  denialRate: number
}

// =============================================================================
// 审计存储
// =============================================================================

export class PermissionAuditStore {
  private entries: AuditEntry[] = []
  private persistDir: string
  private maxEntries: number

  constructor(persistDir: string, maxEntries: number = 5000) {
    this.persistDir = resolve(persistDir)
    this.maxEntries = maxEntries
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 记录审计条目 */
  async record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    const newEntry: AuditEntry = {
      ...entry,
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    }
    this.entries.push(newEntry)

    // 限制条目数
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }

    await this.persist()
    return newEntry
  }

  /** 更新执行结果 */
  async updateExecutionResult(auditId: string, success: boolean, error?: string): Promise<void> {
    const entry = this.entries.find(e => e.id === auditId)
    if (entry) {
      entry.executionSuccess = success
      entry.executionError = error
      await this.persist()
    }
  }

  /** 更新审批信息 */
  async updateApprovalInfo(auditId: string, approvedBy: string, note?: string): Promise<void> {
    const entry = this.entries.find(e => e.id === auditId)
    if (entry) {
      entry.approvedBy = approvedBy
      entry.approvalNote = note
      await this.persist()
    }
  }

  /** 查询审计记录 */
  query(filter: AuditQuery = {}): AuditEntry[] {
    let results = [...this.entries]

    if (filter.fromTimestamp) {
      results = results.filter(e => e.timestamp >= filter.fromTimestamp!)
    }
    if (filter.toTimestamp) {
      results = results.filter(e => e.timestamp <= filter.toTimestamp!)
    }
    if (filter.userId) {
      results = results.filter(e => e.userId === filter.userId)
    }
    if (filter.sessionId) {
      results = results.filter(e => e.sessionId === filter.sessionId)
    }
    if (filter.channel) {
      results = results.filter(e => e.channel === filter.channel)
    }
    if (filter.toolName) {
      results = results.filter(e => e.toolName === filter.toolName)
    }
    if (filter.decision) {
      results = results.filter(e => e.decision === filter.decision)
    }
    if (filter.minRiskLevel !== undefined) {
      results = results.filter(e => e.riskLevel >= filter.minRiskLevel!)
    }
    if (filter.maxRiskLevel !== undefined) {
      results = results.filter(e => e.riskLevel <= filter.maxRiskLevel!)
    }

    // 按时间倒序
    results.sort((a, b) => b.timestamp - a.timestamp)

    const limit = filter.limit ?? 100
    return results.slice(0, limit)
  }

  /** 获取单条记录（用于回放） */
  getEntry(id: string): AuditEntry | null {
    return this.entries.find(e => e.id === id) ?? null
  }

  /** 生成决策回放文本 */
  replayDecision(auditId: string): string | null {
    const entry = this.getEntry(auditId)
    if (!entry) return null

    const lines = [
      `=== Permission Decision Replay ===`,
      ``,
      `ID: ${entry.id}`,
      `Time: ${new Date(entry.timestamp).toISOString()}`,
      `Decision: ${entry.decision}`,
      ``,
      `Tool: ${entry.toolName}`,
      `Category: ${entry.toolCategory}`,
      `Risk Level: ${entry.riskLevel}/10`,
      `Risk Factors: ${entry.riskFactors.join(', ') || 'none'}`,
      ``,
      `Identity:`,
      `  User: ${entry.userId ?? 'anonymous'}`,
      `  Channel: ${entry.channel}`,
      `  Session: ${entry.sessionId ?? 'N/A'}`,
      `  Group: ${entry.groupId ?? 'N/A'}`,
      ``,
      `Policy:`,
      `  Mode: ${entry.mode}`,
      `  Applied Policy: ${entry.policyApplied}`,
      ``,
      `Approval:`,
      `  Request ID: ${entry.approvalRequestId ?? 'N/A'}`,
      `  Approved By: ${entry.approvedBy ?? 'N/A'}`,
      `  Note: ${entry.approvalNote ?? 'N/A'}`,
      ``,
      `Execution:`,
      `  Success: ${entry.executionSuccess ?? 'N/A'}`,
      `  Error: ${entry.executionError ?? 'N/A'}`,
      ``,
      `=== End Replay ===`,
    ]

    return lines.join('\n')
  }

  /** 生成统计报告 */
  getStats(): AuditStats {
    const byDecision: Record<AuditEntry['decision'], number> = {
      approved: 0,
      denied: 0,
      required_confirmation: 0,
      expired: 0,
    }
    const byChannel: Record<string, number> = {}
    const byTool: Record<string, number> = {}
    let totalRisk = 0
    let highRiskCount = 0

    for (const entry of this.entries) {
      byDecision[entry.decision]++
      byChannel[entry.channel] = (byChannel[entry.channel] ?? 0) + 1
      byTool[entry.toolName] = (byTool[entry.toolName] ?? 0) + 1
      totalRisk += entry.riskLevel
      if (entry.riskLevel >= 7) highRiskCount++
    }

    const total = this.entries.length
    return {
      totalEntries: total,
      byDecision,
      byChannel,
      byTool,
      avgRiskLevel: total > 0 ? totalRisk / total : 0,
      highRiskCount,
      confirmationRate: total > 0 ? byDecision.required_confirmation / total : 0,
      denialRate: total > 0 ? byDecision.denied / total : 0,
    }
  }

  /** 导出为 JSON */
  async exportJSON(filter?: AuditQuery): Promise<string> {
    const entries = filter ? this.query(filter) : this.entries
    return JSON.stringify(entries, null, 2)
  }

  /** 导出为 CSV */
  exportCSV(filter?: AuditQuery): string {
    const entries = filter ? this.query(filter) : this.entries
    if (entries.length === 0) return ''

    const headers = ['id', 'timestamp', 'decision', 'toolName', 'riskLevel', 'channel', 'userId', 'mode', 'policyApplied']
    const rows = entries.map(e =>
      headers.map(h => {
        const val = (e as any)[h]
        return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val
      }).join(',')
    )

    return [headers.join(','), ...rows].join('\n')
  }

  /** 清理过期条目 */
  async cleanup(maxAgeDays: number = 90): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.timestamp > cutoff)
    const removed = before - this.entries.length
    if (removed > 0) await this.persist()
    return removed
  }

  get size(): number {
    return this.entries.length
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'audit-log.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      this.entries = JSON.parse(raw) as AuditEntry[]
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'audit-log.json')
    await writeFile(filePath, JSON.stringify(this.entries, null, 2), 'utf-8')
  }
}
