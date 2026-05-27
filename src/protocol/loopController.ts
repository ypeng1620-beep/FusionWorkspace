/**
 * Loop Controller — TAOR 循环暂停/恢复/取消接口
 *
 * 为 event 模式下的审批流程提供循环生命周期管理。
 * 当前仅定义接口，完整实现需要与 TAOR loop 深度集成。
 */

import type { ToolCall } from '../permissions/permissionGate.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 暂停时的循环状态 */
export interface LoopPausedState {
  /** 循环 ID */
  loopId: string
  /** 会话 ID */
  sessionId: string
  /** 当前步骤数 */
  stepCount: number
  /** 待确认的工具调用 */
  pendingConfirmation: {
    requestId: string
    toolCall: ToolCall
    riskLevel: number
  }
  /** 暂停时间戳 */
  pausedAt: number
}

/** 循环控制接口 */
export interface LoopController {
  /** 暂停循环 */
  pause(loopId: string, state: LoopPausedState): void
  /** 暂停并等待恢复 */
  waitForResume(loopId: string, state: LoopPausedState, timeoutMs?: number): Promise<boolean>
  /** 恢复循环（传入审批结果） */
  resume(loopId: string, approvalResult: boolean): void
  /** 取消循环 */
  cancel(loopId: string): void
  /** 获取暂停状态 */
  getState(loopId: string): LoopPausedState | null
  /** 获取所有暂停的循环 */
  getAllPaused(): LoopPausedState[]
}

// =============================================================================
// 默认实现（内存存储）
// =============================================================================

export class DefaultLoopController implements LoopController {
  private pausedStates: Map<string, LoopPausedState> = new Map()
  private resolvers: Map<string, { resolve: (approved: boolean) => void; timeout?: NodeJS.Timeout }> = new Map()

  pause(loopId: string, state: LoopPausedState): void {
    this.pausedStates.set(loopId, state)
  }

  waitForResume(loopId: string, state: LoopPausedState, timeoutMs: number = 5 * 60 * 1000): Promise<boolean> {
    this.pause(loopId, state)

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.resolvers.delete(loopId)
        this.pausedStates.delete(loopId)
        resolve(false)
      }, timeoutMs)

      this.resolvers.set(loopId, { resolve, timeout })
    })
  }

  resume(loopId: string, approvalResult: boolean): void {
    const waiter = this.resolvers.get(loopId)
    if (waiter) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout)
      }
      waiter.resolve(approvalResult)
      this.resolvers.delete(loopId)
    }
    this.pausedStates.delete(loopId)
  }

  cancel(loopId: string): void {
    const waiter = this.resolvers.get(loopId)
    if (waiter) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout)
      }
      waiter.resolve(false)
      this.resolvers.delete(loopId)
    }
    this.pausedStates.delete(loopId)
  }

  getState(loopId: string): LoopPausedState | null {
    return this.pausedStates.get(loopId) ?? null
  }

  getAllPaused(): LoopPausedState[] {
    return Array.from(this.pausedStates.values())
  }

}
