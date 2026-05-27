/**
 * Approval Service — 内部异步审批协调器
 */

import type { PendingApprovalRequest, PermissionWorkflowStore } from './permissionWorkflow.js'

interface ApprovalWaiter {
  resolve: (approved: boolean) => void
  timeout: NodeJS.Timeout
}

export class ApprovalService {
  private workflow: PermissionWorkflowStore
  private waiters: Map<string, ApprovalWaiter> = new Map()

  constructor(workflow: PermissionWorkflowStore) {
    this.workflow = workflow
  }

  async waitForDecision(requestId: string, timeoutMs: number = 5 * 60 * 1000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(requestId)
        this.workflow.resolvePendingRequest(requestId, false)
        resolve(false)
      }, timeoutMs)

      this.waiters.set(requestId, { resolve, timeout })
    })
  }

  resolve(requestId: string, approved: boolean): boolean {
    const request = this.workflow.resolvePendingRequest(requestId, approved)
    if (!request) return false

    const waiter = this.waiters.get(requestId)
    if (waiter) {
      clearTimeout(waiter.timeout)
      this.waiters.delete(requestId)
      waiter.resolve(approved)
    }

    return true
  }

  getPendingRequests(): PendingApprovalRequest[] {
    return this.workflow.getPendingRequests()
  }
}
