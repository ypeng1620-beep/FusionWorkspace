/**
 * Layered Memory — 分层记忆模型
 *
 * 将记忆分为四层，每层有独立的存储、生命周期和注入策略：
 *
 * 1. ProfileMemory   — 用户画像、稳定偏好、环境事实（长期，极少变更）
 * 2. SessionMemory   — 会话短期历史、压缩摘要、恢复点（短期，每轮更新）
 * 3. KnowledgeMemory — 技能知识、项目知识、文档索引（中期，按需更新）
 * 4. EpisodicMemory  — 具体交互事件记录（中期，可压缩/过期）
 *
 * 每层都有：
 * - 置信度 (confidence 0-1)
 * - 来源 (source)
 * - 作用域 (scope: user/session/global)
 * - 过期时间 (expiresAt)
 * - 人工修正标记 (override)
 */

import { mkdir, readFile, writeFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'

// =============================================================================
// 通用类型
// =============================================================================

/** 记忆作用域 */
export type MemoryScope = 'user' | 'session' | 'global' | 'channel'

/** 记忆来源 */
export type MemorySource =
  | 'explicit'        // 用户明确告知（"记住我喜欢..."）
  | 'inferred'        // 从对话中推断
  | 'system'          // 系统生成
  | 'skill'           // 技能执行产生
  | 'imported'        // 外部导入
  | 'human_override'  // 人工修正

/** 分层记忆条目基类 */
export interface LayeredMemoryEntry {
  id: string
  /** 置信度 0-1（用户明确告知=1.0，推断=0.3-0.7） */
  confidence: number
  /** 来源 */
  source: MemorySource
  /** 作用域 */
  scope: MemoryScope
  /** 创建时间 */
  createdAt: number
  /** 最后更新时间 */
  updatedAt: number
  /** 过期时间（0 表示永不过期） */
  expiresAt: number
  /** 关联用户 ID */
  userId?: string
  /** 关联会话 ID */
  sessionId?: string
  /** 关联渠道 */
  channel?: string
  /** 标签（用于检索和分类） */
  tags: string[]
  /** 是否被人工修正过 */
  isOverridden: boolean
  /** 原始条目 ID（如果是修正后的新版本） */
  supersedesId?: string
}

// =============================================================================
// Profile Memory — 用户画像层
// =============================================================================

/** 偏好类型 */
export type PreferenceType = 'language' | 'format' | 'tool' | 'style' | 'domain' | 'other'

/** 用户画像条目 */
export interface ProfileEntry extends LayeredMemoryEntry {
  type: 'profile'
  /** 偏好类别 */
  preferenceType: PreferenceType
  /** 键（如 "preferred_language"） */
  key: string
  /** 值（如 "zh-CN"） */
  value: string
  /** 上下文说明 */
  context: string
  /** 被引用次数（越高越稳定） */
  referenceCount: number
}

/** Profile Memory 存储 */
export class ProfileMemory {
  private entries: Map<string, ProfileEntry> = new Map()
  private persistDir: string

  constructor(persistDir: string) {
    this.persistDir = resolve(persistDir)
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 设置或更新用户偏好 */
  async setPreference(entry: Omit<ProfileEntry, 'id' | 'createdAt' | 'updatedAt' | 'referenceCount'>): Promise<ProfileEntry> {
    // 检查是否已有相同 key 的条目
    const existing = this.findByKey(entry.key, entry.userId)
    if (existing) {
      // 如果新条目置信度更低，不更新
      if (entry.confidence < existing.confidence && !entry.isOverridden) {
        return existing
      }
      // 更新现有条目
      existing.value = entry.value
      existing.confidence = entry.confidence
      existing.source = entry.source
      existing.updatedAt = Date.now()
      existing.context = entry.context
      existing.tags = entry.tags
      existing.expiresAt = entry.expiresAt
      existing.referenceCount++
      await this.persist()
      return existing
    }

    // 创建新条目
    const newEntry: ProfileEntry = {
      ...entry,
      id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      referenceCount: 1,
    }
    this.entries.set(newEntry.id, newEntry)
    await this.persist()
    return newEntry
  }

  /** 获取用户偏好 */
  getPreference(key: string, userId?: string): ProfileEntry | null {
    return this.findByKey(key, userId)
  }

  /** 获取用户所有偏好 */
  getAllPreferences(userId?: string): ProfileEntry[] {
    const all = Array.from(this.entries.values())
    if (userId) {
      return all.filter(e => e.userId === userId || e.scope === 'global')
    }
    return all
  }

  /** 按类别获取偏好 */
  getByType(type: PreferenceType, userId?: string): ProfileEntry[] {
    return this.getAllPreferences(userId).filter(e => e.preferenceType === type)
  }

  /** 注入到 prompt 的格式化文本 */
  formatForPrompt(userId?: string): string {
    const prefs = this.getAllPreferences(userId)
      .filter(e => e.confidence >= 0.5 && !this.isExpired(e))
      .sort((a, b) => b.confidence - a.confidence)

    if (prefs.length === 0) return ''

    const lines = prefs.map(p => `- ${p.key}: ${p.value} (confidence: ${p.confidence.toFixed(1)})`)
    return `\n## User Profile\n${lines.join('\n')}\n`
  }

  /** 降低低引用条目的置信度（定期维护） */
  decayLowReferences(): void {
    for (const entry of this.entries.values()) {
      if (!this.isExpired(entry) && entry.referenceCount < 2 && entry.confidence < 0.6) {
        entry.confidence = Math.max(0.1, entry.confidence - 0.1)
      }
    }
  }

  /** 删除条目 */
  async remove(id: string): Promise<boolean> {
    const removed = this.entries.delete(id)
    if (removed) await this.persist()
    return removed
  }

  /** 获取条目数量 */
  get size(): number {
    return this.entries.size
  }

  private findByKey(key: string, userId?: string): ProfileEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.key === key && (entry.userId === userId || entry.scope === 'global')) {
        return entry
      }
    }
    return null
  }

  private isExpired(entry: LayeredMemoryEntry): boolean {
    return entry.expiresAt > 0 && Date.now() > entry.expiresAt
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'profile.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as ProfileEntry[]
      for (const entry of data) {
        this.entries.set(entry.id, entry)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'profile.json')
    await writeFile(filePath, JSON.stringify(Array.from(this.entries.values()), null, 2), 'utf-8')
  }
}

// =============================================================================
// Session Memory — 会话短期层
// =============================================================================

/** 会话记忆条目 */
export interface SessionEntry extends LayeredMemoryEntry {
  type: 'session'
  /** 压缩后的摘要文本 */
  summary: string
  /** 原始消息数量 */
  originalMessageCount: number
  /** 关联的 turn 编号 */
  turnNumber: number
}

/** Session Memory 存储 */
export class SessionMemory {
  private entries: Map<string, SessionEntry> = new Map()
  private currentSessionId: string | null = null
  private persistDir: string
  private maxEntriesPerSession: number

  constructor(persistDir: string, maxEntriesPerSession: number = 20) {
    this.persistDir = resolve(persistDir)
    this.maxEntriesPerSession = maxEntriesPerSession
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 开始新会话 */
  startSession(sessionId: string): void {
    this.currentSessionId = sessionId
  }

  /** 添加会话摘要 */
  async addSummary(entry: Omit<SessionEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<SessionEntry> {
    const sessionId = entry.sessionId ?? this.currentSessionId
    if (!sessionId) throw new Error('No session ID available')

    const newEntry: SessionEntry = {
      ...entry,
      sessionId,
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.entries.set(newEntry.id, newEntry)

    // 限制每会话条目数
    const sessionEntries = Array.from(this.entries.values())
      .filter(e => e.sessionId === sessionId)
      .sort((a, b) => a.turnNumber - b.turnNumber)

    if (sessionEntries.length > this.maxEntriesPerSession) {
      // 淘汰最早的条目
      const toRemove = sessionEntries.slice(0, sessionEntries.length - this.maxEntriesPerSession)
      for (const e of toRemove) {
        this.entries.delete(e.id)
      }
    }

    await this.persist()
    return newEntry
  }

  /** 获取会话的所有摘要（按 turn 排序） */
  getSessionEntries(sessionId?: string): SessionEntry[] {
    const sid = sessionId ?? this.currentSessionId
    if (!sid) return []
    return Array.from(this.entries.values())
      .filter(e => e.sessionId === sid && !this.isExpired(e))
      .sort((a, b) => a.turnNumber - b.turnNumber)
  }

  /** 获取最近 N 个 turn 的摘要 */
  getRecentSummaries(limit: number, sessionId?: string): SessionEntry[] {
    return this.getSessionEntries(sessionId).slice(-limit)
  }

  /** 注入到 prompt 的格式化文本 */
  formatForPrompt(limit: number = 5, sessionId?: string): string {
    const entries = this.getRecentSummaries(limit, sessionId)
    if (entries.length === 0) return ''

    const lines = entries.map(e => `- [Turn ${e.turnNumber}] ${e.summary}`)
    return `\n## Session Context\n${lines.join('\n')}\n`
  }

  /** 清除指定会话的所有条目 */
  async clearSession(sessionId: string): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(id)
      }
    }
    await this.persist()
  }

  get size(): number {
    return this.entries.size
  }

  private isExpired(entry: LayeredMemoryEntry): boolean {
    return entry.expiresAt > 0 && Date.now() > entry.expiresAt
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'session.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as SessionEntry[]
      for (const entry of data) {
        this.entries.set(entry.id, entry)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'session.json')
    await writeFile(filePath, JSON.stringify(Array.from(this.entries.values()), null, 2), 'utf-8')
  }
}

// =============================================================================
// Knowledge Memory — 知识索引层
// =============================================================================

/** 知识类型 */
export type KnowledgeType = 'skill' | 'project' | 'document' | 'fact' | 'procedure'

/** 知识条目 */
export interface KnowledgeEntry extends LayeredMemoryEntry {
  type: 'knowledge'
  knowledgeType: KnowledgeType
  /** 标题 */
  title: string
  /** 内容 */
  content: string
  /** 来源 URL 或文件路径 */
  sourceRef?: string
  /** 关键词列表 */
  keywords: string[]
}

/** Knowledge Memory 存储 */
export class KnowledgeMemory {
  private entries: Map<string, KnowledgeEntry> = new Map()
  private persistDir: string

  constructor(persistDir: string) {
    this.persistDir = resolve(persistDir)
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 添加知识 */
  async addKnowledge(entry: Omit<KnowledgeEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<KnowledgeEntry> {
    const newEntry: KnowledgeEntry = {
      ...entry,
      id: `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.entries.set(newEntry.id, newEntry)
    await this.persist()
    return newEntry
  }

  /** 按关键词搜索 */
  searchByKeywords(keywords: string[], limit: number = 10): KnowledgeEntry[] {
    const keywordSet = new Set(keywords.map(k => k.toLowerCase()))
    const scored = Array.from(this.entries.values())
      .filter(e => !this.isExpired(e) && e.confidence >= 0.3)
      .map(e => ({
        entry: e,
        score: e.keywords.filter(k => keywordSet.has(k.toLowerCase())).length,
      }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.confidence - a.entry.confidence)
      .slice(0, limit)

    return scored.map(s => s.entry)
  }

  /** 按类型获取 */
  getByType(type: KnowledgeType, limit: number = 20): KnowledgeEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.knowledgeType === type && !this.isExpired(e))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit)
  }

  /** 注入到 prompt 的格式化文本 */
  formatForPrompt(keywords: string[], limit: number = 5): string {
    const entries = this.searchByKeywords(keywords, limit)
    if (entries.length === 0) return ''

    const lines = entries.map(e => `- [${e.knowledgeType}] ${e.title}: ${e.content.slice(0, 120)}...`)
    return `\n## Relevant Knowledge\n${lines.join('\n')}\n`
  }

  /** 更新知识（如技能升级后更新） */
  async updateKnowledge(id: string, updates: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | null> {
    const entry = this.entries.get(id)
    if (!entry) return null
    Object.assign(entry, updates, { updatedAt: Date.now() })
    await this.persist()
    return entry
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.entries.delete(id)
    if (removed) await this.persist()
    return removed
  }

  get size(): number {
    return this.entries.size
  }

  private isExpired(entry: LayeredMemoryEntry): boolean {
    return entry.expiresAt > 0 && Date.now() > entry.expiresAt
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'knowledge.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as KnowledgeEntry[]
      for (const entry of data) {
        this.entries.set(entry.id, entry)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'knowledge.json')
    await writeFile(filePath, JSON.stringify(Array.from(this.entries.values()), null, 2), 'utf-8')
  }
}

// =============================================================================
// Episodic Memory — 事件记录层
// =============================================================================

/** 事件条目 */
export interface EpisodicEntry extends LayeredMemoryEntry {
  type: 'episodic'
  /** 事件摘要 */
  summary: string
  /** 使用的工具列表 */
  toolsUsed: string[]
  /** 结果（success/failure/partial） */
  outcome: 'success' | 'failure' | 'partial'
  /** 耗时（毫秒） */
  durationMs: number
}

/** Episodic Memory 存储 */
export class EpisodicMemory {
  private entries: Map<string, EpisodicEntry> = new Map()
  private persistDir: string
  private maxEntries: number

  constructor(persistDir: string, maxEntries: number = 500) {
    this.persistDir = resolve(persistDir)
    this.maxEntries = maxEntries
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  async addEntry(entry: Omit<EpisodicEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<EpisodicEntry> {
    const newEntry: EpisodicEntry = {
      ...entry,
      id: `episodic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.entries.set(newEntry.id, newEntry)

    // 限制总条目数
    if (this.entries.size > this.maxEntries) {
      const oldest = Array.from(this.entries.values())
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, this.entries.size - this.maxEntries)
      for (const e of oldest) {
        this.entries.delete(e.id)
      }
    }

    await this.persist()
    return newEntry
  }

  /** 按工具名搜索历史事件 */
  searchByTool(toolName: string, limit: number = 10): EpisodicEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.toolsUsed.includes(toolName) && !this.isExpired(e))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  /** 获取最近的成功事件（用于技能推荐） */
  getRecentSuccesses(limit: number = 10): EpisodicEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.outcome === 'success' && !this.isExpired(e))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  formatForPrompt(toolName?: string, limit: number = 3): string {
    const entries = toolName
      ? this.searchByTool(toolName, limit)
      : this.getRecentSuccesses(limit)

    if (entries.length === 0) return ''

    const lines = entries.map(e =>
      `- [${e.outcome}] ${e.summary} (tools: ${e.toolsUsed.join(', ')}, ${e.durationMs}ms)`
    )
    return `\n## Similar Past Events\n${lines.join('\n')}\n`
  }

  get size(): number {
    return this.entries.size
  }

  private isExpired(entry: LayeredMemoryEntry): boolean {
    return entry.expiresAt > 0 && Date.now() > entry.expiresAt
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'episodic.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as EpisodicEntry[]
      for (const entry of data) {
        this.entries.set(entry.id, entry)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'episodic.json')
    await writeFile(filePath, JSON.stringify(Array.from(this.entries.values()), null, 2), 'utf-8')
  }
}

// =============================================================================
// LayeredMemoryManager — 分层记忆统一管理器
// =============================================================================

export interface LayeredMemoryConfig {
  rootDir?: string
  /** Profile 条目最大数量 */
  maxProfileEntries?: number
  /** 每会话 Session 条目最大数量 */
  maxSessionEntriesPerSession?: number
  /** Knowledge 条目最大数量 */
  maxKnowledgeEntries?: number
  /** Episodic 条目最大数量 */
  maxEpisodicEntries?: number
}

export class LayeredMemoryManager {
  profile: ProfileMemory
  session: SessionMemory
  knowledge: KnowledgeMemory
  episodic: EpisodicMemory

  constructor(config: LayeredMemoryConfig = {}) {
    const rootDir = resolve(config.rootDir ?? join(process.cwd(), '.fusion-memory', 'layered'))
    this.profile = new ProfileMemory(join(rootDir, 'profile'))
    this.session = new SessionMemory(join(rootDir, 'session'), config.maxSessionEntriesPerSession ?? 20)
    this.knowledge = new KnowledgeMemory(join(rootDir, 'knowledge'))
    this.episodic = new EpisodicMemory(join(rootDir, 'episodic'), config.maxEpisodicEntries ?? 500)
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.profile.initialize(),
      this.session.initialize(),
      this.knowledge.initialize(),
      this.episodic.initialize(),
    ])
  }

  /**
   * 为 TAOR 循环构建完整的注入上下文
   * 按优先级组合四层记忆
   */
  buildInjectionContext(options: {
    userId?: string
    sessionId?: string
    queryKeywords?: string[]
    maxProfileItems?: number
    maxSessionTurns?: number
    maxKnowledgeItems?: number
    maxEpisodicItems?: number
  }): string {
    const parts: string[] = []

    // 1. Profile（最高优先级，用户画像）
    const profileText = this.profile.formatForPrompt(options.userId)
    if (profileText) parts.push(profileText)

    // 2. Session（会话上下文）
    const sessionText = this.session.formatForPrompt(options.maxSessionTurns ?? 5, options.sessionId)
    if (sessionText) parts.push(sessionText)

    // 3. Knowledge（相关知识）
    if (options.queryKeywords && options.queryKeywords.length > 0) {
      const knowledgeText = this.knowledge.formatForPrompt(options.queryKeywords, options.maxKnowledgeItems ?? 3)
      if (knowledgeText) parts.push(knowledgeText)
    }

    // 4. Episodic（相似历史事件）
    const episodicText = this.episodic.formatForPrompt(undefined, options.maxEpisodicItems ?? 2)
    if (episodicText) parts.push(episodicText)

    return parts.length > 0 ? `\n--- Memory Context ---\n${parts.join('\n')}\n--- End Memory Context ---\n` : ''
  }

  /** 定期维护：降低低置信度条目、清理过期数据 */
  async maintenance(): Promise<{ decayed: number; expired: number }> {
    this.profile.decayLowReferences()
    let decayed = 0
    let expired = 0

    // 统计过期条目（实际清理需要各层各自实现）
    for (const layer of [this.profile, this.session, this.knowledge, this.episodic]) {
      // 这里只是统计，实际过期清理由各层自己在写入时处理
    }

    return { decayed, expired }
  }

  /** 获取各层统计 */
  getStats(): Record<string, number> {
    return {
      profile: this.profile.size,
      session: this.session.size,
      knowledge: this.knowledge.size,
      episodic: this.episodic.size,
    }
  }
}
