/**
 * Approval EventBus — 异步审批事件总线
 *
 * 为微信/飞书等 webhook 通道提供非阻塞的审批协议。
 * 与现有 Promise 模式（ApprovalService.waitForDecision）并存。
 */

import type { ToolCall } from '../permissions/permissionGate.js'
import type { ChannelType } from '../gateway/gateway.js'

// =============================================================================
// 事件类型
// =============================================================================

/** 审批请求事件（core → adapter） */
export interface ApprovalNeededEvent {
  requestId: string
  sessionId: string
  conversationId?: string
  userId?: string
  channel: ChannelType
  toolName: string
  toolCall: ToolCall
  riskLevel: number
  message: string
  timestamp: number
}

/** 审批结果事件（adapter → core） */
export interface ApprovalResolvedEvent {
  requestId: string
  approved: boolean
  sessionId: string
  userId?: string
  note?: string
  timestamp: number
}

/** 审批超时事件（core → adapter） */
export interface ApprovalExpiredEvent {
  requestId: string
  sessionId: string
  toolName: string
  timestamp: number
}

// =============================================================================
// 事件总线接口
// =============================================================================

type ApprovalNeededHandler = (event: ApprovalNeededEvent) => void
type ApprovalResolvedHandler = (event: ApprovalResolvedEvent) => void
type ApprovalExpiredHandler = (event: ApprovalExpiredEvent) => void

export interface ApprovalEventBus {
  onApprovalNeeded(handler: ApprovalNeededHandler): void
  onApprovalResolved(handler: ApprovalResolvedHandler): void
  onApprovalExpired(handler: ApprovalExpiredHandler): void
  emitApprovalNeeded(event: ApprovalNeededEvent): void
  emitApprovalResolved(event: ApprovalResolvedEvent): void
  emitApprovalExpired(event: ApprovalExpiredEvent): void
}

// =============================================================================
// 默认实现（基于 EventEmitter 的轻量封装）
// =============================================================================

export class DefaultApprovalEventBus implements ApprovalEventBus {
  private onNeededHandlers: ApprovalNeededHandler[] = []
  private onResolvedHandlers: ApprovalResolvedHandler[] = []
  private onExpiredHandlers: ApprovalExpiredHandler[] = []

  onApprovalNeeded(handler: ApprovalNeededHandler): void {
    this.onNeededHandlers.push(handler)
  }

  onApprovalResolved(handler: ApprovalResolvedHandler): void {
    this.onResolvedHandlers.push(handler)
  }

  onApprovalExpired(handler: ApprovalExpiredHandler): void {
    this.onExpiredHandlers.push(handler)
  }

  emitApprovalNeeded(event: ApprovalNeededEvent): void {
    for (const handler of this.onNeededHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('[ApprovalEventBus] Error in onApprovalNeeded handler:', error)
      }
    }
  }

  emitApprovalResolved(event: ApprovalResolvedEvent): void {
    for (const handler of this.onResolvedHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('[ApprovalEventBus] Error in onApprovalResolved handler:', error)
      }
    }
  }

  emitApprovalExpired(event: ApprovalExpiredEvent): void {
    for (const handler of this.onExpiredHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('[ApprovalEventBus] Error in onApprovalExpired handler:', error)
      }
    }
  }
}

// =============================================================================
// 审批等待器（event 模式下 TAOR loop 使用）
// =============================================================================

/** 等待中的审批请求 */
export interface PendingApproval {
  requestId: string
  resolve: (approved: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * 审批等待管理器
 * 在 event 模式下，TAOR loop 通过此管理器等待审批结果
 */
export class ApprovalWaitManager {
  private pending: Map<string, PendingApproval> = new Map()
  private eventBus: ApprovalEventBus

  constructor(eventBus: ApprovalEventBus) {
    this.eventBus = eventBus
    this.eventBus.onApprovalResolved((event) => {
      this.resolve(event.requestId, event.approved)
    })
  }

  /**
   * 注册一个等待中的审批请求
   */
  register(requestId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(false)
      }, timeoutMs)

      this.pending.set(requestId, { requestId, resolve, timeout })
    })
  }

  /**
   * 解析一个审批请求
   */
  resolve(requestId: string, approved: boolean): boolean {
    const waiter = this.pending.get(requestId)
    if (!waiter) return false

    clearTimeout(waiter.timeout)
    this.pending.delete(requestId)
    waiter.resolve(approved)
    return true
  }

  /**
   * 取消一个审批请求
   */
  cancel(requestId: string): void {
    const waiter = this.pending.get(requestId)
    if (waiter) {
      clearTimeout(waiter.timeout)
      this.pending.delete(requestId)
    }
  }

  /** 获取待审批数量 */
  get pendingCount(): number {
    return this.pending.size
  }
}
