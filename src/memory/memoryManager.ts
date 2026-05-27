/**
 * Memory Manager — 协调短期 LRU 缓存和长期 SQLite 存储
 * 
 * 融合 Hermes 的：
 * - trajectory.py: 轨迹压缩思想（保护首尾轮次）
 * - hermes_state.py: 会话存储设计
 * 
 * 功能：
 * 1. LRU 短期缓存（内存 Map，容量 100 条）
 * 2. FTS5 长期存储（SQLite）
 * 3. 自动在缓存和存储之间交换数据
 * 4. 摘要生成（调用外部 LLM）
 * 5. 自动清理过期数据（可配置定时任务）
 * 6. 事件钩子（缓存未命中、摘要生成等）
 */

import { FTS5MemoryStore, type Memory, type SearchResult } from './fts5Memory.js'
import { MemoryPolicy, type MemoryPolicyDecision, type MemoryPolicyInput } from './memoryPolicy.js'
import { EmlScorer, type EmlScoreDecision, type EmlSignalType } from './emlScoring.js'
import type { PhoenixAuditStore } from '../orchestrator/phoenixAudit.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 缓存条目 */
interface CacheEntry {
  memory: Memory
  accessedAt: number   // 最后访问时间（用于 LRU）
}

/** LLM 摘要生成器类型 */
export type SummaryGenerator = (
  memories: Memory[]
) => Promise<string>

/** Memory Manager 配置 */
export interface MemoryManagerConfig {
  /** 缓存容量（默认 100） */
  cacheCapacity?: number
  /** 缓存 TTL（毫秒，默认 1 小时） */
  cacheTtlMs?: number
  /** 数据库路径 */
  dbPath?: string
  /** 是否启用向量搜索 */
  enableVectorSearch?: boolean
  /** 向量维度 */
  embeddingDim?: number
  /** 自动清理间隔（毫秒，默认 24 小时）。设为 0 则禁用自动清理。 */
  autoCleanupIntervalMs?: number
  /** 自动清理保留天数（默认 30 天） */
  autoCleanupMaxAgeDays?: number
  /** Force JSON fallback, mainly for tests and constrained runtimes. */
  forceFallback?: boolean
  /** Fail fast when the actual memory backend does not match the required backend. */
  requiredBackend?: 'any' | 'sqlite' | 'json'
  phoenixAudit?: PhoenixAuditStore
}

/** Memory Manager 运行结果 */
export interface MemoryOperationResult {
  success: boolean
  memory?: Memory
  searchResults?: SearchResult[]
  error?: string
}

/** 事件钩子类型 */
export interface MemoryManagerEvents {
  /** 缓存未命中时触发（返回是否命中） */
  onCacheMiss?: (id: string, source: 'sqlite' | 'not_found') => void
  /** 摘要生成完成后触发 */
  onSummaryGenerated?: (summaryId: string, memoryIds: string[]) => void
  /** 记忆添加时触发 */
  onMemoryAdded?: (memory: Memory) => void
  /** 缓存淘汰时触发 */
  onCacheEvict?: (memoryId: string) => void
  /** 错误时触发 */
  onError?: (error: Error) => void
}

// =============================================================================
// LRU 缓存
// =============================================================================

/**
 * LRU 缓存实现
 * 当容量超限时，淘汰最久未访问的条目
 */
export class LRUCache<K, V> {
  private store: Map<K, V> = new Map()
  private maxSize: number

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize
  }

  /** 获取值（已访问则移到末尾） */
  get(key: K): V | undefined {
    const value = this.store.get(key)
    if (value !== undefined) {
      // 移到末尾（最新访问）
      this.store.delete(key)
      this.store.set(key, value)
    }
    return value
  }

  /** 设置值（如果存在则更新，否则添加） */
  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.maxSize) {
      // 淘汰最旧的（Map 的插入顺序即 LRU 顺序）
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
      }
    }
    this.store.set(key, value)
  }

  /** 设置值并返回被淘汰的键（如果有） */
  setWithEvict(key: K, value: V): K | undefined {
    let evictedKey: K | undefined

    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        evictedKey = oldestKey
        this.store.delete(oldestKey)
      }
    }

    this.store.set(key, value)
    return evictedKey
  }

  /** 检查是否存在 */
  has(key: K): boolean {
    return this.store.has(key)
  }

  /** 删除 */
  delete(key: K): boolean {
    return this.store.delete(key)
  }

  /** 获取所有键 */
  keys(): K[] {
    return Array.from(this.store.keys())
  }

  /** 获取大小 */
  get size(): number {
    return this.store.size
  }

  /** 清空 */
  clear(): void {
    this.store.clear()
  }

  /** 获取最近访问的 N 个键（LRU 顺序的末尾） */
  getRecent(limit: number): K[] {
    const allKeys = Array.from(this.store.keys())
    return allKeys.slice(-limit)
  }

  /** 淘汰最旧的 N 条目，返回被淘汰的键 */
  evictOldest(count: number): K[] {
    const evicted: K[] = []
    for (let i = 0; i < count && this.store.size > 0; i++) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
        evicted.push(oldestKey)
      }
    }
    return evicted
  }
}

// =============================================================================
// Memory Manager
// =============================================================================

export class MemoryManager {
  private cache: LRUCache<string, CacheEntry>
  private store: FTS5MemoryStore
  private policy: MemoryPolicy
  private emlScorer: EmlScorer
  private phoenixAudit: PhoenixAuditStore | null = null
  private config: Omit<Required<MemoryManagerConfig>, 'phoenixAudit'> & { phoenixAudit: PhoenixAuditStore | null }
  private summaryGenerator: SummaryGenerator | null = null
  private events: Required<MemoryManagerEvents>
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: MemoryManagerConfig = {}, events: MemoryManagerEvents = {}) {
    this.config = {
      cacheCapacity: config.cacheCapacity ?? 100,
      cacheTtlMs: config.cacheTtlMs ?? 60 * 60 * 1000, // 1 hour
      dbPath: config.dbPath ?? '',
      enableVectorSearch: config.enableVectorSearch ?? false,
      embeddingDim: config.embeddingDim ?? 384,
      autoCleanupIntervalMs: config.autoCleanupIntervalMs ?? 24 * 60 * 60 * 1000, // 24 hours
      autoCleanupMaxAgeDays: config.autoCleanupMaxAgeDays ?? 30,
      forceFallback: config.forceFallback ?? false,
      requiredBackend: config.requiredBackend ?? 'any',
      phoenixAudit: config.phoenixAudit ?? null,
    }
    this.phoenixAudit = this.config.phoenixAudit

    // 初始化事件钩子（确保所有钩子都存在）
    this.events = {
      onCacheMiss: events.onCacheMiss ?? (() => {}),
      onSummaryGenerated: events.onSummaryGenerated ?? (() => {}),
      onMemoryAdded: events.onMemoryAdded ?? (() => {}),
      onCacheEvict: events.onCacheEvict ?? (() => {}),
      onError: events.onError ?? (() => {}),
    }

    // 初始化缓存
    this.cache = new LRUCache<string, CacheEntry>(this.config.cacheCapacity)
    this.policy = new MemoryPolicy()
    this.emlScorer = new EmlScorer()

    // 初始化长期存储
    this.store = new FTS5MemoryStore({
      dbPath: this.config.dbPath,
      enableVectorSearch: this.config.enableVectorSearch,
      embeddingDim: this.config.embeddingDim,
      forceFallback: this.config.forceFallback,
    })

    // 启动自动清理定时器
    if (this.config.requiredBackend !== 'any' && this.store.getBackend() !== this.config.requiredBackend) {
      const actual = this.store.getBackend()
      this.store.close()
      throw new Error(`Required memory backend ${this.config.requiredBackend} unavailable; actual backend is ${actual}`)
    }

    if (this.config.autoCleanupIntervalMs > 0) {
      this.startAutoCleanup()
    }
  }

  // ===========================================================================
  // 缓存操作
  // ===========================================================================

  /**
   * 添加记忆
   *
   * 流程：
   * 1. 生成 embedding（如果需要）
   * 2. 写入 SQLite（得到真实的 memory.id）
   * 3. 如果 cache 满了，淘汰最旧的条目
   * 4. 写入 LRU 缓存（用真实的 memory.id）
   */
  async addMemory(content: string, embedding?: number[]): Promise<Memory> {
    // 添加到 SQLite（先获取真实的 memory.id）
    const memory = await this.store.addMemory(content, embedding)

    // 检查是否需要淘汰缓存条目（用真实的 memory.id）
    const evictedKey = this.cache.setWithEvict(memory.id, {
      memory,
      accessedAt: Date.now(),
    })

    // 处理被淘汰的条目
    if (evictedKey !== undefined) {
      this.events.onCacheEvict(evictedKey)
    }

    // 触发事件
    this.events.onMemoryAdded(memory)

    return memory
  }

  /**
   * 依据策略层写入交互记忆。
   * 对无价值或过短的交互自动跳过，避免污染长期存储。
   */
  async addInteractionMemory(input: MemoryPolicyInput): Promise<Memory | null> {
    const decision = this.policy.decide(input)
    this.recordEmlAudit(input, decision)
    if (!decision.shouldStore) {
      return null
    }

    const entry = this.policy.buildMemoryEntry(input, decision)
    return this.addMemory(entry)
  }

  /**
   * 批量添加记忆
   */
  async addMemories(contents: string[]): Promise<Memory[]> {
    const results: Memory[] = []
    for (const content of contents) {
      results.push(await this.addMemory(content))
    }
    return results
  }

  /**
   * 获取记忆
   * 
   * 流程：
   * 1. 先查缓存
   * 2. 缓存命中则更新访问时间
   * 3. 未命中则查 SQLite，返回并加入缓存
   */
  getMemory(id: string): Memory | null {
    // 先查缓存
    const cached = this.cache.get(id)
    if (cached) {
      // 更新访问时间
      this.cache.set(id, { ...cached, accessedAt: Date.now() })
      return cached.memory
    }

    // 缓存未命中，查询 SQLite
    const memory = this.store.getMemory(id)
    if (memory) {
      // 加入缓存
      this.cache.set(id, { memory, accessedAt: Date.now() })
      this.events.onCacheMiss(id, 'sqlite')
    } else {
      this.events.onCacheMiss(id, 'not_found')
    }

    return memory
  }

  /**
   * 删除记忆
   * 
   * 流程：
   * 1. 从缓存删除
   * 2. 从 SQLite 删除
   */
  deleteMemory(id: string): boolean {
    // 从缓存删除
    this.cache.delete(id)

    // 从 SQLite 删除
    return this.store.deleteMemory(id)
  }

  // ===========================================================================
  // 搜索操作
  // ===========================================================================

  /**
   * 全文搜索记忆
   * 
   * 注意：搜索结果不会自动加入缓存（按需加载）
   * 
   * FTS5 查询语法：
   * - 精确词: `word`（默认）
   * - 前缀搜索: `word*`（匹配 word、words、wordplay 等）
   * - OR 查询: `word1 OR word2`
   * - AND 查询: `word1 word2`（默认）
   * - 短语查询: `"exact phrase"`
   * - 否定: `-exclude`
   * 
   * @example
   * searchMemories('科技*')       // 前缀匹配
   * searchMemories('AI OR 人工智能')  // OR 查询
   * searchMemories('"机器学习"')   // 短语查询
   */
  searchMemories(query: string, limit: number = 10): SearchResult[] {
    return this.store.searchMemories(query, limit)
  }

  /**
   * 用策略层格式化召回结果，供上层直接注入 prompt。
   */
  recallForPrompt(query: string, limit: number = 3): string {
    const results = this.searchMemories(query, limit)
    return this.policy.formatRecallContext(results)
  }

  /**
   * Vector similarity search via sqlite-vec HNSW index.
   * Falls back to brute-force cosine similarity when vec0 is unavailable.
   */
  async vectorSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    return this.store.vectorSearch(query, limit)
  }

  /**
   * Hybrid search combining FTS5 keyword + vector similarity via RRF fusion.
   *
   * Runs both search strategies in parallel and merges results with
   * Reciprocal Rank Fusion for a unified relevance ranking.
   */
  async hybridSearch(
    query: string,
    limit: number = 10,
    options?: { fts5Weight?: number; vectorWeight?: number },
  ): Promise<SearchResult[]> {
    return this.store.hybridSearch(query, limit, options)
  }

  // ===========================================================================
  // 摘要操作
  // ===========================================================================

  /**
   * 设置摘要生成器
   * 
   * @param generator 接收记忆数组，返回摘要字符串的异步函数
   */
  setSummaryGenerator(generator: SummaryGenerator): void {
    this.summaryGenerator = generator
  }

  /**
   * 摘要一组记忆
   * 
   * 流程：
   * 1. 获取记忆内容
   * 2. 调用 LLM 生成摘要
   * 3. 存入 summaries 表
   */
  async summarizeMemories(ids: string[]): Promise<Memory | null> {
    if (!this.summaryGenerator) {
      throw new Error('Summary generator not set. Call setSummaryGenerator() first.')
    }

    if (ids.length === 0) return null

    try {
      // 获取记忆内容
      const memories: Memory[] = []
      for (const id of ids) {
        const memory = this.getMemory(id)
        if (memory) memories.push(memory)
      }

      if (memories.length === 0) return null

      // 调用 LLM 生成摘要
      const summaryText = await this.summaryGenerator(memories)

      // 存入 summaries 表
      const summary = this.store.createSummary(ids, summaryText)

      // 触发事件
      this.events.onSummaryGenerated(summary.id, ids)

      // 返回一个"摘要记忆"作为结果
      const summaryMemory = await this.addMemory(
        `[Summary]\n${summaryText}\n\n[Based on ${memories.length} memories: ${ids.join(', ')}]`
      )

      return summaryMemory
    } catch (error) {
      if (error instanceof Error) {
        this.events.onError(error)
      }
      throw error
    }
  }

  /**
   * 获取最近的摘要
   */
  getRecentSummaries(limit: number = 10) {
    return this.store.getRecentSummaries(limit)
  }

  // ===========================================================================
  // 缓存与存储同步
  // ===========================================================================

  /**
   * 刷新缓存
   * 
   * 注意：新添加的记忆已经在 addMemory 时写入了 SQLite，
   * 因此这里只需要清理过期条目即可。
   */
  flushCache(): void {
    this.cleanupExpired()
  }

  /**
   * 清理过期缓存条目
   */
  cleanupExpired(): number {
    const now = Date.now()
    const ttl = this.config.cacheTtlMs
    let cleaned = 0

    for (const key of this.cache.keys()) {
      const entry = this.cache.get(key)
      if (entry && (now - entry.accessedAt) > ttl) {
        this.cache.delete(key)
        cleaned++
      }
    }

    return cleaned
  }

  /**
   * 将缓存中的数据预热到 SQLite
   *
   * 注意：由于 addMemory 在写入缓存的同时也写入了 SQLite，
   * 这个方法实际上不需要。保留它仅用于显式的批量持久化场景。
   */
  async warmPersist(): Promise<void> {
    for (const key of this.cache.keys()) {
      const entry = this.cache.get(key)
      if (entry) {
        // 确保 SQLite 中有这条记录
        const existing = this.store.getMemory(key)
        if (!existing) {
          // 写入 SQLite（使用已有的 embedding）
          await this.store.addMemory(entry.memory.content, entry.memory.embedding ?? undefined)
        }
      }
    }
  }

  // ===========================================================================
  // 自动清理
  // ===========================================================================

  /** 启动自动清理定时器 */
  private startAutoCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      try {
        const result = this.store.cleanup(this.config.autoCleanupMaxAgeDays)
        if (result.deletedMemories > 0 || result.deletedSummaries > 0) {
          console.log(
            `[MemoryManager] Auto-cleanup: deleted ${result.deletedMemories} memories, ${result.deletedSummaries} summaries`
          )
        }
      } catch (error) {
        if (error instanceof Error) {
          this.events.onError(error)
        }
      }
    }, this.config.autoCleanupIntervalMs)
  }

  /** 停止自动清理定时器 */
  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  // ===========================================================================
  // 统计与维护
  // ===========================================================================

  /** 获取缓存大小 */
  getCacheSize(): number {
    return this.cache.size
  }

  /** 获取缓存容量 */
  getCacheCapacity(): number {
    return this.config.cacheCapacity
  }

  /** 获取 SQLite 中的记忆总数 */
  getTotalMemoryCount(): number {
    return this.store.getMemoryCount()
  }

  /** 获取 SQLite 中的摘要总数 */
  getTotalSummaryCount(): number {
    return this.store.getSummaryCount()
  }

  /**
   * 清理旧记忆和摘要
   * 
   * @param maxAgeDays 保留天数
   */
  cleanup(maxAgeDays: number = 30): { deletedMemories: number; deletedSummaries: number } {
    return this.store.cleanup(maxAgeDays)
  }

  /**
   * 设置事件钩子（在运行时可更新）
   */
  setEvents(events: Partial<MemoryManagerEvents>): void {
    this.events = { ...this.events, ...events }
  }

  /** 关闭管理器 */
  close(): void {
    this.stopAutoCleanup()
    this.flushCache()
    this.store.close()
  }

  // ===========================================================================
  // 批量操作（用于轨迹压缩）
  // ===========================================================================

  /**
   * 获取最近的 N 条记忆
   * 
   * 优先从 LRU 缓存获取，如果缓存不足则从 SQLite 补充
   */
  getRecentMemories(limit: number = 10): Memory[] {
    const results: Memory[] = []

    // 1. 先从 LRU 缓存获取（保持 LRU 顺序）
    const recentKeys = this.cache.getRecent(Math.min(limit, this.cache.size))
    for (const key of recentKeys) {
      const memory = this.getMemory(key)
      if (memory) results.push(memory)
    }

    // 2. 如果缓存不够，从 SQLite 获取（按创建时间倒序）
    if (results.length < limit) {
      const needed = limit - results.length
      const existingIds = new Set(results.map(m => m.id))

      // 从 store 获取最新的记忆（排除已缓存的）
      const additional = this.store.getRecentMemories(needed + results.length)
        .filter(m => !existingIds.has(m.id))
        .slice(0, needed)

      results.push(...additional)

      // 将从 SQLite 获取的也加入缓存
      for (const memory of additional) {
        this.cache.set(memory.id, { memory, accessedAt: memory.createdAt })
      }
    }

    return results
  }

  /**
   * 获取记忆的时间范围
   */
  getMemoryTimeRange(): { oldest: number; newest: number } | null {
    return this.store.getMemoryTimeRange()
  }

  getBackend(): 'sqlite' | 'json' {
    return this.store.getBackend()
  }

  private recordEmlAudit(input: MemoryPolicyInput, policyDecision: MemoryPolicyDecision): void {
    if (!this.phoenixAudit) {
      return
    }

    this.phoenixAudit.recordMemoryScoreDecision({
      decision: this.scoreInteractionMemory(input, policyDecision),
      sessionId: input.sessionId,
      userId: input.userId,
      source: 'memory_manager.addInteractionMemory',
      policyReason: policyDecision.reason,
      policyCategory: policyDecision.category,
      shouldStore: policyDecision.shouldStore,
    })
  }

  private scoreInteractionMemory(input: MemoryPolicyInput, policyDecision: MemoryPolicyDecision): EmlScoreDecision {
    const text = `${input.prompt}\n${input.response}`.toLowerCase()
    const signalType = this.mapPolicyCategoryToSignal(policyDecision.category)
    const importance = !policyDecision.shouldStore
      ? 0.05
      : policyDecision.importance === 'high'
      ? 0.95
      : policyDecision.importance === 'medium'
        ? 0.6
        : 0.2
    const novelty = policyDecision.shouldStore ? 0.65 : 0.05
    const redundancy = !policyDecision.shouldStore || /duplicate|重复|same|ok ok/i.test(text) ? 0.95 : 0.2
    const volatility = /temporary|obsolete|volatile|临时|过期/i.test(text) ? 0.8 : 0.2
    const retrievalFrequency = input.toolNames.length >= 2 || /always|prefer|remember|每次/i.test(text) ? 0.6 : 0.2

    return this.emlScorer.score({
      novelty,
      importance,
      volatility,
      redundancy,
      retrievalFrequency,
      ageMs: Math.max(0, Date.now() - (input.timestamp ?? Date.now())),
      signalType,
    })
  }

  private mapPolicyCategoryToSignal(category: MemoryPolicyDecision['category']): EmlSignalType {
    if (category === 'preference') return 'user_preference'
    if (category === 'fact') return 'project_fact'
    if (category === 'workflow') return 'project_fact'
    return 'generic'
  }

  /**
   * 获取策略层实例
   */
  getPolicy(): MemoryPolicy {
    return this.policy
  }
}

// =============================================================================
// 便捷函数
// =============================================================================

let _defaultManager: MemoryManager | null = null

/**
 * 获取默认 MemoryManager 实例（单例）
 */
export function getDefaultManager(): MemoryManager {
  if (!_defaultManager) {
    _defaultManager = new MemoryManager()
  }
  return _defaultManager
}

/**
 * 关闭默认实例
 */
export function closeDefaultManager(): void {
  if (_defaultManager) {
    _defaultManager.close()
    _defaultManager = null
  }
}

// =============================================================================
// 简单摘要生成器（默认实现）
// =============================================================================

/**
 * 简单的摘要生成器
 * 将多个记忆合并为一个摘要字符串
 * 
 * 实际生产中应替换为 LLM 调用
 */
export async function defaultSummaryGenerator(memories: Memory[]): Promise<string> {
  if (memories.length === 0) return ''

  const contents = memories.map(m => `- ${m.content}`).join('\n')
  
  return `## Memory Summary\n\nThis summary covers ${memories.length} memories:\n\n${contents}\n\n---\n*Generated at ${new Date().toISOString()}*`
}
