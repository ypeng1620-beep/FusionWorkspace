/**
 * FTS5 Memory System — SQLite FTS5 full-text search + sqlite-vec vector search.
 *
 * Hybrid search combines FTS5 BM25 keyword ranking with vec0 cosine-distance
 * vector ranking via Reciprocal Rank Fusion (RRF).
 */

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { getEmbeddingProvider, type EmbeddingProvider } from './embeddingService.js'

// =============================================================================
// 类型定义
// =============================================================================

export interface Memory {
  id: string
  content: string
  embedding: number[] | null   // 向量 embedding（稀疏或密集）
  createdAt: number             // Unix timestamp (ms)
}

export interface MemorySummary {
  id: string
  memoryIds: string[]           // 被摘要的记忆 IDs
  summaryText: string
  createdAt: number
}

export interface SearchResult {
  id: string
  content: string
  rank: number                  // FTS5 MATCH 排名（越小越相关）
  createdAt: number
  score?: number                // 向量相似度（如果可用）
}

export interface FTS5MemoryConfig {
  /** 数据库路径（默认 ~/.fusion-workspace/memory.db） */
  dbPath?: string
  /** 是否启用向量相似度搜索（使用 sqlite-vec HNSW 索引） */
  enableVectorSearch?: boolean
  /** 向量维度（默认 384，需与 embedding 模型输出匹配） */
  embeddingDim?: number
  /** 强制使用 JSON fallback（测试/调试用） */
  forceFallback?: boolean
  /** 混合搜索 FTS5 权重（0-1，默认 0.5） */
  hybridFts5Weight?: number
  /** 混合搜索向量权重（0-1，默认 0.5） */
  hybridVectorWeight?: number
}

interface FallbackState {
  memories: Memory[]
  summaries: MemorySummary[]
}

// =============================================================================
// Embedding helpers — delegates to embeddingService
// =============================================================================

/** Re-export EmbedConfig for backwards compatibility. */
export type { EmbeddingProvider as EmbedConfigProvider } from './embeddingService.js'

/**
 * Generate an embedding for the given text.
 * Delegates to the configured embedding provider with deterministic fallback.
 */
let _embedResolver: ((text: string, dim?: number) => Promise<number[]>) | null = null

export async function embed(text: string, dim?: number): Promise<number[]> {
  if (!_embedResolver) {
    const mod = await import('./embeddingService.js')
    _embedResolver = mod.embed
  }
  return _embedResolver(text, dim)
}

// ---------------------------------------------------------------------------
// Backwards-compatible embed configuration API
// ---------------------------------------------------------------------------

/** @deprecated Use EmbeddingProvider from embeddingService instead. */
export interface EmbedConfig {
  endpoint?: string
  model?: string
  dimension?: number
  apiKey?: string
}

let _legacyEmbedConfig: EmbedConfig = {
  endpoint: process.env.EMBEDDING_ENDPOINT ?? 'http://localhost:11434/api/embeddings',
  model: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
  dimension: 384,
  apiKey: process.env.EMBEDDING_API_KEY,
}

/** @deprecated Use setEmbeddingProvider from embeddingService instead. */
export function configureEmbed(config: Partial<EmbedConfig>): void {
  _legacyEmbedConfig = { ..._legacyEmbedConfig, ...config }
}

/** @deprecated Use getEmbeddingProvider from embeddingService instead. */
export function getEmbedConfig(): Readonly<EmbedConfig> {
  return { ..._legacyEmbedConfig }
}

// =============================================================================
// FTS5 Memory Store
// =============================================================================

export class FTS5MemoryStore {
  private db: Database.Database | null = null
  private config: Required<FTS5MemoryConfig>
  private embeddingDim: number
  private fallbackPath: string
  private fallbackState: FallbackState = { memories: [], summaries: [] }
  private backend: 'sqlite' | 'json'
  private vecLoaded = false
  private embeddingProvider: EmbeddingProvider

  constructor(config: FTS5MemoryConfig = {}) {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '.'
    const defaultPath = join(homeDir, '.fusion-workspace', 'memory.db')

    this.config = {
      dbPath: config.dbPath ?? defaultPath,
      enableVectorSearch: config.enableVectorSearch ?? false,
      embeddingDim: config.embeddingDim ?? 384,
      forceFallback: config.forceFallback ?? false,
      hybridFts5Weight: config.hybridFts5Weight ?? 0.5,
      hybridVectorWeight: config.hybridVectorWeight ?? 0.5,
    }
    this.embeddingDim = this.config.embeddingDim
    this.fallbackPath = `${this.config.dbPath}.fallback.json`
    this.backend = this.config.forceFallback ? 'json' : 'sqlite'
    this.embeddingProvider = getEmbeddingProvider()

    // 确保目录存在
    const dir = join(this.config.dbPath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    if (this.config.forceFallback) {
      this.loadFallbackState()
      return
    }

    try {
      // 初始化数据库
      this.db = new Database(this.config.dbPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.initTables()
    } catch (error) {
      console.warn('[FTS5MemoryStore] SQLite backend unavailable, falling back to JSON store:', error)
      this.db = null
      this.backend = 'json'
      this.loadFallbackState()
    }
  }

  /** 初始化表结构 */
  private initTables(): void {
    if (!this.db) return

    // Load sqlite-vec extension (best-effort)
    try {
      sqliteVec.load(this.db)
      this.vecLoaded = true
    } catch (err) {
      console.warn('[FTS5MemoryStore] sqlite-vec extension could not be loaded:', err)
      this.vecLoaded = false
    }

    // 记忆主表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        content     TEXT NOT NULL,
        embedding   TEXT,  -- JSON 序列化的浮点数数组
        created_at  INTEGER NOT NULL DEFAULT (unix_timestamp() * 1000)
      )
    `)

    // FTS5 虚拟表（全文搜索）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='porter unicode61'
      )
    `)

    // sqlite-vec vec0 虚拟表（向量索引，HNSW）
    if (this.config.enableVectorSearch && this.vecLoaded) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
            embedding FLOAT[${this.embeddingDim}]
          )
        `)
      } catch (err) {
        console.warn('[FTS5MemoryStore] Could not create vec0 virtual table:', err)
        this.vecLoaded = false
      }
    }

    // 摘要表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        id           TEXT PRIMARY KEY,
        memory_ids   TEXT NOT NULL,  -- JSON 序列化的 string[]
        summary_text TEXT NOT NULL,
        created_at   INTEGER NOT NULL DEFAULT (unix_timestamp() * 1000)
      )
    `)

    // 索引（加速查询）
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_created_at
      ON memories(created_at DESC)
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_summaries_created_at
      ON summaries(created_at DESC)
    `)
  }

  // ===========================================================================
  // 记忆 CRUD
  // ===========================================================================

  /**
   * 添加记忆
   * @param content 记忆文本
   * @param embedding 可选，预计算的 embedding（如果不提供则自动生成）
   */
  async addMemory(content: string, embedding?: number[]): Promise<Memory> {
    const id = randomUUID()
    const createdAt = Date.now()

    // 生成 embedding（如果未提供）
    const vector = embedding ?? await embed(content, this.embeddingDim)

    const memory = { id, content, embedding: vector, createdAt }

    if (this.backend === 'json') {
      this.fallbackState.memories.push(memory)
      this.persistFallbackState()
      return memory
    }

    // 插入 SQLite — use a transaction so rowid is stable for vec0
    const insertAll = this.db!.transaction(() => {
      const stmt = this.db!.prepare(`
        INSERT INTO memories (id, content, embedding, created_at)
        VALUES (?, ?, ?, ?)
      `)
      stmt.run(id, content, JSON.stringify(vector), createdAt)

      // 同步到 FTS5 虚拟表
      const row = this.db!.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(id) as { rowid: number }
      if (row) {
        this.db!.prepare(`INSERT INTO memories_fts (rowid, content) VALUES (?, ?)`).run(row.rowid, content)

        // 同步到 vec0 虚拟表
        if (this.config.enableVectorSearch && this.vecLoaded) {
          try {
            this.db!.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`).run(
              row.rowid,
              JSON.stringify(vector),
            )
          } catch (err) {
            // vec0 insert failure is non-fatal — vector search will just miss this entry
          }
        }
      }
    })

    insertAll()
    return memory
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
   */
  getMemory(id: string): Memory | null {
    if (this.backend === 'json') {
      return this.fallbackState.memories.find(memory => memory.id === id) ?? null
    }

    const stmt = this.db!.prepare(`
      SELECT id, content, embedding, created_at as createdAt 
      FROM memories WHERE id = ?
    `)
    const row = stmt.get(id) as { id: string; content: string; embedding: string; createdAt: number } | undefined

    if (!row) return null

    return {
      id: row.id,
      content: row.content,
      embedding: row.embedding ? JSON.parse(row.embedding) : null,
      createdAt: row.createdAt,
    }
  }

  /**
   * 删除记忆
   */
  deleteMemory(id: string): boolean {
    if (this.backend === 'json') {
      const before = this.fallbackState.memories.length
      this.fallbackState.memories = this.fallbackState.memories.filter(memory => memory.id !== id)
      if (before !== this.fallbackState.memories.length) {
        this.persistFallbackState()
        return true
      }
      return false
    }

    // Get rowid before deletion
    const row = this.db!.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(id) as { rowid: number } | undefined
    if (!row) return false

    // Delete from FTS5 and vec0 first
    this.db!.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(row.rowid)
    if (this.config.enableVectorSearch && this.vecLoaded) {
      try { this.db!.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(row.rowid) } catch { /* ignore */ }
    }

    // Delete from main table
    const result = this.db!.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
    return result.changes > 0
  }

  // ===========================================================================
  // FTS5 全文搜索
  // ===========================================================================

  /**
   * 搜索记忆（全文搜索）
   * 
   * @param query 搜索查询
   * @param limit 返回数量限制
   * @returns 按相关度排序的结果
   */
  searchMemories(query: string, limit: number = 10): SearchResult[] {
    if (!query.trim()) return []

    if (this.backend === 'json') {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
      return this.fallbackState.memories
        .map(memory => {
          const haystack = memory.content.toLowerCase()
          const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
          return { memory, score }
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
        .slice(0, limit)
        .map(item => ({
          id: item.memory.id,
          content: item.memory.content,
          rank: Math.max(1, tokens.length - item.score),
          createdAt: item.memory.createdAt,
        }))
    }

    try {
      const stmt = this.db!.prepare(`
        SELECT m.id, m.content, m.created_at as createdAt,
               fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `)

      const rows = stmt.all(query, limit) as Array<{
        id: string
        content: string
        createdAt: number
        rank: number
      }>

      return rows.map(row => ({
        id: row.id,
        content: row.content,
        rank: row.rank,
        createdAt: row.createdAt,
      }))
    } catch (error) {
      // FTS5 查询语法错误时返回空结果
      console.error('[FTS5] Search error:', error)
      return []
    }
  }

  // ===========================================================================
  // 向量相似度搜索 (sqlite-vec HNSW)
  // ===========================================================================

  async vectorSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.config.enableVectorSearch) {
      throw new Error('Vector search is not enabled. Set enableVectorSearch: true in config.')
    }

    const queryEmbedding = await embed(query, this.embeddingDim)

    if (this.backend === 'json') {
      const scored = this.fallbackState.memories
        .filter(memory => memory.embedding)
        .map(memory => ({
          id: memory.id,
          content: memory.content,
          createdAt: memory.createdAt,
          score: cosineSimilarity(queryEmbedding, memory.embedding as number[]),
        }))
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit).map(item => ({
        id: item.id,
        content: item.content,
        rank: 0,
        createdAt: item.createdAt,
        score: item.score,
      }))
    }

    // Use sqlite-vec KNN when available, fall back to brute-force scan
    if (this.vecLoaded) {
      try {
        const embeddingJson = JSON.stringify(queryEmbedding)
        const rows = this.db!.prepare(`
          SELECT m.id, m.content, m.created_at as createdAt, v.distance
          FROM memories_vec v
          JOIN memories m ON m.rowid = v.rowid
          WHERE v.embedding MATCH ?
          ORDER BY v.distance
          LIMIT ?
        `).all(embeddingJson, limit) as Array<{
          id: string; content: string; createdAt: number; distance: number
        }>

        return rows.map(row => ({
          id: row.id,
          content: row.content,
          rank: 0,
          createdAt: row.createdAt,
          score: 1 - row.distance, // convert cosine distance to similarity
        }))
      } catch (err) {
        console.warn('[FTS5MemoryStore] vec0 KNN failed, falling back to brute-force:', err)
      }
    }

    // Brute-force fallback: full table scan + cosine similarity in JS
    const stmt = this.db!.prepare(`
      SELECT id, content, embedding, created_at as createdAt
      FROM memories WHERE embedding IS NOT NULL
    `)
    const rows = stmt.all() as Array<{
      id: string; content: string; embedding: string; createdAt: number
    }>

    const scored = rows.map(row => {
      const memoryEmbedding = JSON.parse(row.embedding) as number[]
      return {
        id: row.id, content: row.content, createdAt: row.createdAt,
        score: cosineSimilarity(queryEmbedding, memoryEmbedding),
      }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(r => ({
      id: r.id, content: r.content, rank: 0, createdAt: r.createdAt, score: r.score,
    }))
  }

  // ===========================================================================
  // 混合搜索 (FTS5 + Vector with RRF fusion)
  // ===========================================================================

  /**
   * Hybrid search combining FTS5 keyword matching with vector similarity.
   * Uses Reciprocal Rank Fusion (RRF) to merge result sets.
   *
   * @param query - Natural language query (used for both FTS5 and vector)
   * @param limit - Max results to return
   * @param options - Optional fusion weight overrides
   */
  async hybridSearch(
    query: string,
    limit: number = 10,
    options?: { fts5Weight?: number; vectorWeight?: number },
  ): Promise<SearchResult[]> {
    const fts5Weight = options?.fts5Weight ?? this.config.hybridFts5Weight
    const vectorWeight = options?.vectorWeight ?? this.config.hybridVectorWeight

    // Run both searches in parallel
    const [fts5Results, vectorResults] = await Promise.all([
      Promise.resolve(this.searchMemories(query, limit * 2)),
      this.config.enableVectorSearch
        ? this.vectorSearch(query, limit * 2).catch(() => [] as SearchResult[])
        : Promise.resolve([] as SearchResult[]),
    ])

    // If only one source has results, return that source directly
    if (fts5Results.length === 0) return vectorResults.slice(0, limit)
    if (vectorResults.length === 0) return fts5Results.slice(0, limit)

    // Reciprocal Rank Fusion
    const k = 60
    const fused = new Map<string, { result: SearchResult; rrfScore: number }>()

    for (let i = 0; i < fts5Results.length; i++) {
      const r = fts5Results[i]
      const rrf = fts5Weight / (k + i + 1)
      fused.set(r.id, { result: { ...r, score: r.score ?? 0 }, rrfScore: rrf })
    }

    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i]
      const rrf = vectorWeight / (k + i + 1)
      const existing = fused.get(r.id)
      if (existing) {
        existing.rrfScore += rrf
        // Keep the higher vector score
        if ((r.score ?? 0) > (existing.result.score ?? 0)) {
          existing.result.score = r.score
        }
      } else {
        fused.set(r.id, { result: { ...r, score: r.score ?? 0 }, rrfScore: rrf })
      }
    }

    // Sort by RRF score descending, return top N
    return [...fused.values()]
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit)
      .map(entry => ({
        ...entry.result,
        rank: 0, // rank is meaningless in hybrid; use score
      }))
  }

  // ===========================================================================
  // 摘要管理
  // ===========================================================================

  /**
   * 创建摘要
   * 
   * @param memoryIds 要摘要的记忆 IDs
   * @param summaryText 摘要文本（由外部 LLM 生成）
   */
  createSummary(memoryIds: string[], summaryText: string): MemorySummary {
    const id = randomUUID()
    const createdAt = Date.now()

    const summary = { id, memoryIds, summaryText, createdAt }

    if (this.backend === 'json') {
      this.fallbackState.summaries.push(summary)
      this.persistFallbackState()
      return summary
    }

    const stmt = this.db!.prepare(`
      INSERT INTO summaries (id, memory_ids, summary_text, created_at)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(id, JSON.stringify(memoryIds), summaryText, createdAt)

    return summary
  }

  /**
   * 获取摘要
   */
  getSummary(id: string): MemorySummary | null {
    if (this.backend === 'json') {
      return this.fallbackState.summaries.find(summary => summary.id === id) ?? null
    }

    const stmt = this.db!.prepare(`
      SELECT id, memory_ids, summary_text as summaryText, created_at as createdAt
      FROM summaries WHERE id = ?
    `)
    const row = stmt.get(id) as { id: string; memory_ids: string; summaryText: string; createdAt: number } | undefined

    if (!row) return null

    return {
      id: row.id,
      memoryIds: JSON.parse(row.memory_ids),
      summaryText: row.summaryText,
      createdAt: row.createdAt,
    }
  }

  /**
   * 获取最近的摘要
   */
  getRecentSummaries(limit: number = 10): MemorySummary[] {
    if (this.backend === 'json') {
      return [...this.fallbackState.summaries]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
    }

    const stmt = this.db!.prepare(`
      SELECT id, memory_ids, summary_text as summaryText, created_at as createdAt
      FROM summaries
      ORDER BY created_at DESC
      LIMIT ?
    `)

    const rows = stmt.all(limit) as Array<{
      id: string
      memory_ids: string
      summaryText: string
      createdAt: number
    }>

    return rows.map(row => ({
      id: row.id,
      memoryIds: JSON.parse(row.memory_ids),
      summaryText: row.summaryText,
      createdAt: row.createdAt,
    }))
  }

  /**
   * 删除过期的摘要和记忆
   * 
   * @param maxAgeDays 保留天数（默认 30 天）
   */
  cleanup(maxAgeDays: number = 30): { deletedMemories: number; deletedSummaries: number } {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

    if (this.backend === 'json') {
      const beforeMemories = this.fallbackState.memories.length
      const beforeSummaries = this.fallbackState.summaries.length
      this.fallbackState.memories = this.fallbackState.memories.filter(memory => memory.createdAt >= cutoff)
      this.fallbackState.summaries = this.fallbackState.summaries.filter(summary => summary.createdAt >= cutoff)
      this.persistFallbackState()
      return {
        deletedMemories: beforeMemories - this.fallbackState.memories.length,
        deletedSummaries: beforeSummaries - this.fallbackState.summaries.length,
      }
    }

    // 删除旧摘要
    const summaryResult = this.db!.prepare(`
      DELETE FROM summaries WHERE created_at < ?
    `).run(cutoff)

    // 删除旧记忆（先删除 FTS5 和 vec0）
    const toDelete = this.db!.prepare(`
      SELECT rowid FROM memories WHERE created_at < ?
    `).all(cutoff) as Array<{ rowid: number }>

    for (const row of toDelete) {
      this.db!.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(row.rowid)
      if (this.config.enableVectorSearch && this.vecLoaded) {
        try { this.db!.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(row.rowid) } catch { /* ignore */ }
      }
    }

    const memoryResult = this.db!.prepare(`
      DELETE FROM memories WHERE created_at < ?
    `).run(cutoff)

    return {
      deletedMemories: memoryResult.changes,
      deletedSummaries: summaryResult.changes,
    }
  }

  // ===========================================================================
  // 统计
  // ===========================================================================

  /** 获取记忆总数 */
  getMemoryCount(): number {
    if (this.backend === 'json') {
      return this.fallbackState.memories.length
    }
    const row = this.db!.prepare(`SELECT COUNT(*) as count FROM memories`).get() as { count: number }
    return row.count
  }

  /** 获取摘要总数 */
  getSummaryCount(): number {
    if (this.backend === 'json') {
      return this.fallbackState.summaries.length
    }
    const row = this.db!.prepare(`SELECT COUNT(*) as count FROM summaries`).get() as { count: number }
    return row.count
  }

  /**
   * 获取记忆的时间范围
   * 公开方法，替代直接访问私有 db 属性
   */
  getMemoryTimeRange(): { oldest: number; newest: number } | null {
    if (this.backend === 'json') {
      if (this.fallbackState.memories.length === 0) return null
      const timestamps = this.fallbackState.memories.map(memory => memory.createdAt)
      return {
        oldest: Math.min(...timestamps),
        newest: Math.max(...timestamps),
      }
    }

    const row = this.db!.prepare(`
      SELECT MIN(created_at) as oldest, MAX(created_at) as newest 
      FROM memories
    `).get() as { oldest: number; newest: number } | undefined

    if (!row || (row.oldest === null && row.newest === null)) return null
    return { oldest: row.oldest, newest: row.newest }
  }

  /**
   * 获取最近的 N 条记忆（从 SQLite，按创建时间倒序）
   * 
   * @param limit 返回数量
   */
  getRecentMemories(limit: number): Memory[] {
    if (this.backend === 'json') {
      return [...this.fallbackState.memories]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
    }

    const stmt = this.db!.prepare(`
      SELECT id, content, embedding, created_at as createdAt
      FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `)

    const rows = stmt.all(limit) as Array<{
      id: string
      content: string
      embedding: string | null
      createdAt: number
    }>

    return rows.map(row => ({
      id: row.id,
      content: row.content,
      embedding: row.embedding ? JSON.parse(row.embedding) : null,
      createdAt: row.createdAt,
    }))
  }

  /** 关闭数据库 */
  close(): void {
    if (this.backend === 'json') {
      this.persistFallbackState()
      return
    }
    this.db?.close()
  }

  getBackend(): 'sqlite' | 'json' {
    return this.backend
  }

  private loadFallbackState(): void {
    if (!existsSync(this.fallbackPath)) {
      this.fallbackState = { memories: [], summaries: [] }
      return
    }

    try {
      this.fallbackState = JSON.parse(readFileSync(this.fallbackPath, 'utf-8')) as FallbackState
    } catch {
      this.fallbackState = { memories: [], summaries: [] }
    }
  }

  private persistFallbackState(): void {
    writeFileSync(this.fallbackPath, JSON.stringify(this.fallbackState, null, 2), 'utf-8')
  }
}

// =============================================================================
// 余弦相似度
// =============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

// =============================================================================
// 便捷函数
// =============================================================================

let _defaultStore: FTS5MemoryStore | null = null

/** 获取默认记忆存储实例（单例） */
export function getDefaultStore(): FTS5MemoryStore {
  if (!_defaultStore) {
    _defaultStore = new FTS5MemoryStore()
  }
  return _defaultStore
}

/** 关闭默认实例 */
export function closeDefaultStore(): void {
  if (_defaultStore) {
    _defaultStore.close()
    _defaultStore = null
  }
}
