/**
 * Runtime Monitor — 统一运行时状态与指标聚合
 */

import type { Gateway } from '../gateway/gateway.js'
import type { MemoryManager } from '../memory/memoryManager.js'
import type { PermissionWorkflowStore } from '../permissions/permissionWorkflow.js'
import type { PermissionPolicyEngine } from '../permissions/permissionPolicyEngine.js'
import type { SkillManager } from '../skills/skillManager.js'
import type { ToolRegistry } from '../tools/toolExecutor.js'
import type { ApprovalService } from '../permissions/approvalService.js'
import type { PhoenixAuditSnapshotStore, PhoenixAuditStore } from '../orchestrator/phoenixAudit.js'
import type { FlameBreaker } from '../reliability/flameBreaker.js'
import type { AntibodyRepository } from '../antibody/antibodyRepository.js'
import { getPhoenixBoundaryContract } from '../orchestrator/phoenixBoundaries.js'

export interface RuntimeEvent {
  id: string
  timestamp: number
  level: 'info' | 'warn' | 'error'
  source: 'runtime' | 'gateway' | 'session' | 'taor' | 'permission' | 'memory' | 'skills' | 'adapter' | 'phoenix'
  message: string
  metadata?: Record<string, unknown>
}

export interface RuntimeTurnSummary {
  sessionId: string
  channel?: string
  userId?: string
  startedAt: number
  completedAt: number
  durationMs: number
  stopReason?: string | null
  stepCount: number
  toolCallCount: number
  totalTokens?: { input: number; output: number }
}

export interface RuntimeStatus {
  status: 'starting' | 'running' | 'degraded' | 'stopped'
  uptimeMs: number
  startedAt: number
  lifecycle?: Record<string, unknown>
  activeSessions: number
  totalTurns: number
  recentTurns: RuntimeTurnSummary[]
  recentEvents: RuntimeEvent[]
  subsystems: {
    gateway: Record<string, unknown>
    memory: Record<string, unknown>
    skills: Record<string, unknown>
    permissions: Record<string, unknown>
    tools: Record<string, unknown>
    phoenix: Record<string, unknown>
    /** 适配器子系统状态（按实例 ID 分组） */
    adapters: Record<string, unknown>
  }
}

export class RuntimeMonitor {
  private startedAt = Date.now()
  private status: RuntimeStatus['status'] = 'starting'
  private events: RuntimeEvent[] = []
  private turns: RuntimeTurnSummary[] = []
  private activeSessions = new Set<string>()
  private maxEvents: number
  private maxTurns: number

  constructor(config: { maxEvents?: number; maxTurns?: number } = {}) {
    this.maxEvents = config.maxEvents ?? 100
    this.maxTurns = config.maxTurns ?? 30
  }

  markRunning(): void {
    this.status = 'running'
    this.recordEvent('info', 'runtime', 'Runtime marked as running')
  }

  markStopped(): void {
    this.status = 'stopped'
    this.recordEvent('info', 'runtime', 'Runtime stopped')
  }

  markDegraded(message: string, metadata?: Record<string, unknown>): void {
    this.status = 'degraded'
    this.recordEvent('warn', 'runtime', message, metadata)
  }

  sessionConnected(sessionId: string, channel?: string): void {
    this.activeSessions.add(sessionId)
    this.recordEvent('info', 'session', `Session connected: ${sessionId}`, { channel })
  }

  sessionDisconnected(sessionId: string, reason?: string): void {
    this.activeSessions.delete(sessionId)
    this.recordEvent('info', 'session', `Session disconnected: ${sessionId}`, { reason })
  }

  recordTurn(turn: RuntimeTurnSummary): void {
    this.turns.push(turn)
    if (this.turns.length > this.maxTurns) {
      this.turns = this.turns.slice(-this.maxTurns)
    }
  }

  recordEvent(
    level: RuntimeEvent['level'],
    source: RuntimeEvent['source'],
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.events.push({
      id: `${Date.now()}-${this.events.length + 1}`,
      timestamp: Date.now(),
      level,
      source,
      message,
      metadata,
    })

    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents)
    }
  }

  getStatus(deps: {
    gateway?: Gateway
    memoryManager?: MemoryManager
    skillManager?: SkillManager
    permissionWorkflow?: PermissionWorkflowStore
    permissionPolicyEngine?: PermissionPolicyEngine
    permissionPolicyFixtureLoaded?: boolean
    approvalService?: ApprovalService
    toolRegistry?: ToolRegistry
    phoenixAudit?: PhoenixAuditStore
    phoenixSnapshotStore?: PhoenixAuditSnapshotStore
    flameBreaker?: FlameBreaker
    antibodyRepository?: AntibodyRepository
    lifecycle?: Record<string, unknown>
  }): RuntimeStatus {
    const phoenixStatus = deps.phoenixAudit
      ? deps.phoenixAudit.getStats()
      : { status: 'unavailable' }

    return {
      status: this.status,
      uptimeMs: Date.now() - this.startedAt,
      startedAt: this.startedAt,
      lifecycle: deps.lifecycle,
      activeSessions: this.activeSessions.size,
      totalTurns: this.turns.length,
      recentTurns: [...this.turns].reverse(),
      recentEvents: [...this.events].reverse(),
      subsystems: {
        gateway: (deps.gateway?.getStats() as unknown as Record<string, unknown>) ?? { status: 'unavailable' },
        memory: deps.memoryManager
          ? {
              backend: deps.memoryManager.getBackend(),
              cacheSize: deps.memoryManager.getCacheSize(),
              cacheCapacity: deps.memoryManager.getCacheCapacity(),
              totalMemories: deps.memoryManager.getTotalMemoryCount(),
              totalSummaries: deps.memoryManager.getTotalSummaryCount(),
            }
          : { status: 'disabled' },
        skills: deps.skillManager
          ? {
              totalSkills: deps.skillManager.getAllSkills().length,
              lifecycle: deps.skillManager.getLifecycleReport(),
            }
          : { status: 'unavailable' },
        permissions: deps.permissionWorkflow
          ? {
              pendingRequests: deps.permissionWorkflow.getPendingRequests().length,
              auditEntries: deps.permissionWorkflow.getAuditLog().length,
              waitingResolvers: deps.approvalService?.getPendingRequests().length ?? deps.permissionWorkflow.getPendingRequests().length,
              policyEngine: deps.permissionPolicyEngine
                ? {
                    ...deps.permissionPolicyEngine.getStats(),
                    fixtureLoaded: deps.permissionPolicyFixtureLoaded ?? false,
                  }
                : { status: 'unavailable' },
            }
          : { status: 'unavailable' },
        tools: deps.toolRegistry
          ? {
              totalTools: deps.toolRegistry.listTools().length,
              mode: deps.toolRegistry.getMode(),
            }
          : { status: 'unavailable' },
        phoenix: {
          ...phoenixStatus,
          boundary: getPhoenixBoundaryContract(),
          snapshots: deps.phoenixSnapshotStore
            ? {
                totalSnapshots: deps.phoenixSnapshotStore.list().length,
                maxSnapshots: deps.phoenixSnapshotStore.getMaxSnapshots(),
                recent: deps.phoenixSnapshotStore.list().slice(0, 5),
              }
            : { status: 'unavailable' },
          reliability: deps.flameBreaker
            ? deps.flameBreaker.getStats()
            : { status: 'unavailable' },
          antibody: deps.antibodyRepository
            ? deps.antibodyRepository.getStats()
            : { status: 'unavailable' },
        },
        adapters: deps.gateway
          ? (deps.gateway as any).getChannelStats?.() ?? { status: 'unavailable' }
          : { status: 'unavailable' },
      },
    }
  }
}
