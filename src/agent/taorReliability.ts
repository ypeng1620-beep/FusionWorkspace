/**
 * TAOR Reliability — 执行内核加固
 *
 * 让 TAOR 循环能长期跑、不怕中断、可恢复、可审计。
 *
 * 功能：
 * 1. Checkpoint — 中断恢复点（每 N 步保存状态快照）
 * 2. ToolTransactionLog — 工具调用事务日志（可回放/回退）
 * 3. RetryFallback — 失败重试和回退策略
 * 4. SessionIsolation — 多 session 并发隔离
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'

// =============================================================================
// Checkpoint — 中断恢复点
// =============================================================================

/** 检查点状态 */
export interface CheckpointState {
  /** 检查点 ID */
  id: string
  /** 会话 ID */
  sessionId: string
  /** 当前步骤数 */
  stepCount: number
  /** 消息历史摘要（不保存完整消息，节省空间） */
  messageSummary: string
  /** 最近 N 条消息 */
  recentMessages: Array<{
    role: string
    content: string
  }>
  /** 已执行的工具调用 */
  toolCalls: Array<{
    toolName: string
    params: Record<string, unknown>
    success: boolean
  }>
  /** 当前 prompt */
  currentPrompt: string
  /** Token 使用估算 */
  tokenUsage: { input: number; output: number }
  /** 创建时间 */
  createdAt: number
  /** 状态 */
  status: 'active' | 'completed' | 'failed' | 'interrupted'
}

/** 检查点管理器 */
export class CheckpointManager {
  private checkpoints: Map<string, CheckpointState> = new Map()
  private persistDir: string
  private checkpointInterval: number

  constructor(persistDir: string, checkpointInterval: number = 5) {
    this.persistDir = resolve(persistDir)
    this.checkpointInterval = checkpointInterval
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 是否需要创建检查点 */
  shouldCheckpoint(stepCount: number): boolean {
    return stepCount > 0 && stepCount % this.checkpointInterval === 0
  }

  /** 创建检查点 */
  async createCheckpoint(state: Omit<CheckpointState, 'id' | 'createdAt' | 'status'>): Promise<CheckpointState> {
    const checkpoint: CheckpointState = {
      ...state,
      id: `cp-${state.sessionId}-${Date.now()}`,
      createdAt: Date.now(),
      status: 'active',
    }

    this.checkpoints.set(checkpoint.id, checkpoint)

    // 清理旧检查点（保留最近 10 个 per session）
    const sessionCheckpoints = Array.from(this.checkpoints.values())
      .filter(c => c.sessionId === state.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)

    if (sessionCheckpoints.length > 10) {
      for (const old of sessionCheckpoints.slice(10)) {
        this.checkpoints.delete(old.id)
      }
    }

    await this.persist()
    return checkpoint
  }

  /** 标记检查点完成 */
  async markCompleted(checkpointId: string): Promise<void> {
    const cp = this.checkpoints.get(checkpointId)
    if (cp) {
      cp.status = 'completed'
      await this.persist()
    }
  }

  /** 标记检查点中断 */
  async markInterrupted(checkpointId: string): Promise<void> {
    const cp = this.checkpoints.get(checkpointId)
    if (cp) {
      cp.status = 'interrupted'
      await this.persist()
    }
  }

  /** 获取会话的最新检查点 */
  getLatestCheckpoint(sessionId: string): CheckpointState | null {
    return Array.from(this.checkpoints.values())
      .filter(c => c.sessionId === sessionId && c.status !== 'completed')
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  }

  /** 获取会话的所有检查点 */
  getSessionCheckpoints(sessionId: string): CheckpointState[] {
    return Array.from(this.checkpoints.values())
      .filter(c => c.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 清理会话的旧检查点 */
  async cleanupSession(sessionId: string): Promise<void> {
    for (const [id, cp] of this.checkpoints) {
      if (cp.sessionId === sessionId) {
        this.checkpoints.delete(id)
      }
    }
    await this.persist()
  }

  get size(): number {
    return this.checkpoints.size
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'checkpoints.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as CheckpointState[]
      for (const cp of data) {
        this.checkpoints.set(cp.id, cp)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'checkpoints.json')
    await writeFile(filePath, JSON.stringify(Array.from(this.checkpoints.values()), null, 2), 'utf-8')
  }
}

// =============================================================================
// ToolTransactionLog — 工具调用事务日志
// =============================================================================

/** 事务日志条目 */
export interface ToolTransactionEntry {
  id: string
  sessionId: string
  stepNumber: number
  toolName: string
  params: Record<string, unknown>
  result: {
    success: boolean
    output?: string
    error?: string
    exitCode?: number
  }
  timestamp: number
  /** 是否可回退 */
  isReversible: boolean
  /** 回退命令（如果可回退） */
  rollbackCommand?: string
  /** 关联的检查点 ID */
  checkpointId?: string
}

/** 工具事务日志 */
export class ToolTransactionLog {
  private entries: ToolTransactionEntry[] = []
  private persistDir: string
  private maxEntries: number

  constructor(persistDir: string, maxEntries: number = 1000) {
    this.persistDir = resolve(persistDir)
    this.maxEntries = maxEntries
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 记录工具调用 */
  async record(entry: Omit<ToolTransactionEntry, 'id' | 'timestamp'>): Promise<ToolTransactionEntry> {
    const full: ToolTransactionEntry = {
      ...entry,
      id: `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    }
    this.entries.push(full)

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }

    await this.persist()
    return full
  }

  /** 获取会话的工具调用历史 */
  getSessionHistory(sessionId: string, limit: number = 50): ToolTransactionEntry[] {
    return this.entries
      .filter(e => e.sessionId === sessionId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
  }

  /** 获取可回退的调用 */
  getReversibleCalls(sessionId: string): ToolTransactionEntry[] {
    return this.entries
      .filter(e => e.sessionId === sessionId && e.isReversible && e.result.success)
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  /** 生成回放脚本 */
  generateReplayScript(sessionId: string): string {
    const history = this.getSessionHistory(sessionId).reverse()
    const lines = history.map(e =>
      `# Step ${e.stepNumber}: ${e.toolName}\n` +
      `# Params: ${JSON.stringify(e.params)}\n` +
      `# Result: ${e.result.success ? 'SUCCESS' : 'FAILED'}\n` +
      (e.result.error ? `# Error: ${e.result.error}\n` : '') +
      (e.isReversible && e.rollbackCommand ? `# Rollback: ${e.rollbackCommand}\n` : '')
    )
    return lines.join('\n')
  }

  get size(): number {
    return this.entries.length
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'tool-transactions.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      this.entries = JSON.parse(raw) as ToolTransactionEntry[]
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'tool-transactions.json')
    await writeFile(filePath, JSON.stringify(this.entries, null, 2), 'utf-8')
  }
}

// =============================================================================
// RetryFallback — 失败重试和回退
// =============================================================================

/** 重试策略 */
export interface RetryStrategy {
  /** 最大重试次数 */
  maxRetries: number
  /** 退避策略 */
  backoff: 'fixed' | 'linear' | 'exponential'
  /** 基础退避时间（毫秒） */
  baseDelayMs: number
  /** 最大退避时间（毫秒） */
  maxDelayMs: number
  /** 哪些错误可重试 */
  retryableErrors: string[]
}

/** 重试结果 */
export interface RetryResult<T> {
  success: boolean
  result?: T
  error?: string
  attempts: number
  totalDelayMs: number
}

/** 重试执行器 */
export class RetryExecutor {
  private strategies: Map<string, RetryStrategy> = new Map()

  /** 注册工具的重试策略 */
  registerStrategy(toolName: string, strategy: RetryStrategy): void {
    this.strategies.set(toolName, strategy)
  }

  /** 获取工具的重试策略 */
  getStrategy(toolName: string): RetryStrategy {
    return this.strategies.get(toolName) ?? {
      maxRetries: 2,
      backoff: 'exponential',
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryableErrors: ['timeout', 'rate_limit', 'network_error', 'temporary_failure'],
    }
  }

  /** 执行带重试的操作 */
  async execute<T>(
    toolName: string,
    operation: (attempt: number) => Promise<T>,
  ): Promise<RetryResult<T>> {
    const strategy = this.getStrategy(toolName)
    let totalDelay = 0

    for (let attempt = 0; attempt <= strategy.maxRetries; attempt++) {
      try {
        const result = await operation(attempt)
        return {
          success: true,
          result,
          attempts: attempt + 1,
          totalDelayMs: totalDelay,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)

        // 检查是否可重试
        const isRetryable = strategy.retryableErrors.some(pattern =>
          errorMessage.toLowerCase().includes(pattern.toLowerCase()),
        )

        if (!isRetryable || attempt >= strategy.maxRetries) {
          return {
            success: false,
            error: errorMessage,
            attempts: attempt + 1,
            totalDelayMs: totalDelay,
          }
        }

        // 计算退避时间
        const delay = this.calculateDelay(strategy, attempt)
        totalDelay += delay
        await this.sleep(delay)
      }
    }

    // 不应该到这里
    return {
      success: false,
      error: 'max retries exceeded',
      attempts: strategy.maxRetries + 1,
      totalDelayMs: totalDelay,
    }
  }

  private calculateDelay(strategy: RetryStrategy, attempt: number): number {
    let delay: number
    switch (strategy.backoff) {
      case 'fixed':
        delay = strategy.baseDelayMs
        break
      case 'linear':
        delay = strategy.baseDelayMs * (attempt + 1)
        break
      case 'exponential':
        delay = strategy.baseDelayMs * Math.pow(2, attempt)
        break
      default:
        delay = strategy.baseDelayMs
    }
    return Math.min(delay, strategy.maxDelayMs)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// =============================================================================
// SessionIsolation — 多 session 并发隔离
// =============================================================================

/** 会话隔离上下文 */
export interface SessionContext {
  sessionId: string
  userId?: string
  channel: string
  startedAt: number
  lastActiveAt: number
  /** 并发锁 */
  lock: {
    acquired: boolean
    acquiredAt?: number
    operation?: string
  }
  /** 资源限制 */
  limits: {
    maxToolCallsPerMinute: number
    maxConcurrentTools: number
    maxMemoryUsage: number
  }
  /** 运行时状态 */
  runtime: {
    toolCallsThisMinute: number
    activeToolCalls: number
    memoryUsageEstimate: number
  }
}

/** 会话隔离管理器 */
export class SessionIsolationManager {
  private sessions: Map<string, SessionContext> = new Map()
  private maxSessions: number

  constructor(maxSessions: number = 50) {
    this.maxSessions = maxSessions
  }

  /** 创建会话上下文 */
  createSession(sessionId: string, channel: string, userId?: string): SessionContext {
    // 如果超过最大会话数，清理最久未活跃的
    if (this.sessions.size >= this.maxSessions) {
      this.cleanupInactiveSessions()
    }

    const context: SessionContext = {
      sessionId,
      userId,
      channel,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      lock: { acquired: false },
      limits: {
        maxToolCallsPerMinute: 30,
        maxConcurrentTools: 3,
        maxMemoryUsage: 1000,
      },
      runtime: {
        toolCallsThisMinute: 0,
        activeToolCalls: 0,
        memoryUsageEstimate: 0,
      },
    }

    this.sessions.set(sessionId, context)
    return context
  }

  /** 获取会话上下文 */
  getSession(sessionId: string): SessionContext | null {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lastActiveAt = Date.now()
    }
    return session ?? null
  }

  /** 尝试获取锁 */
  acquireLock(sessionId: string, operation: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.lock.acquired) return false

    session.lock = {
      acquired: true,
      acquiredAt: Date.now(),
      operation,
    }
    return true
  }

  /** 释放锁 */
  releaseLock(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lock = { acquired: false }
    }
  }

  /** 检查是否可以执行工具调用 */
  canExecuteTool(sessionId: string): { allowed: boolean; reason: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { allowed: false, reason: 'session_not_found' }

    // 检查并发工具数
    if (session.runtime.activeToolCalls >= session.limits.maxConcurrentTools) {
      return { allowed: false, reason: 'max_concurrent_tools_reached' }
    }

    // 检查每分钟调用数
    if (session.runtime.toolCallsThisMinute >= session.limits.maxToolCallsPerMinute) {
      return { allowed: false, reason: 'rate_limit_exceeded' }
    }

    return { allowed: true, reason: 'ok' }
  }

  /** 记录工具调用开始 */
  recordToolCallStart(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.runtime.activeToolCalls++
      session.runtime.toolCallsThisMinute++
      session.lastActiveAt = Date.now()
    }
  }

  /** 记录工具调用结束 */
  recordToolCallEnd(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && session.runtime.activeToolCalls > 0) {
      session.runtime.activeToolCalls--
    }
  }

  /** 重置每分钟计数器 */
  resetMinuteCounters(): void {
    for (const session of this.sessions.values()) {
      session.runtime.toolCallsThisMinute = 0
    }
  }

  /** 关闭会话 */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 清理不活跃的会话 */
  cleanupInactiveSessions(maxIdleMs: number = 30 * 60 * 1000): number {
    const now = Date.now()
    let cleaned = 0
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt > maxIdleMs && !session.lock.acquired) {
        this.sessions.delete(id)
        cleaned++
      }
    }
    return cleaned
  }

  /** 获取活跃会话数 */
  get activeSessionCount(): number {
    return this.sessions.size
  }

  /** 获取所有会话统计 */
  getSessionStats(): Array<{
    sessionId: string
    channel: string
    activeToolCalls: number
    toolCallsThisMinute: number
    lockAcquired: boolean
  }> {
    return Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      channel: s.channel,
      activeToolCalls: s.runtime.activeToolCalls,
      toolCallsThisMinute: s.runtime.toolCallsThisMinute,
      lockAcquired: s.lock.acquired,
    }))
  }
}
