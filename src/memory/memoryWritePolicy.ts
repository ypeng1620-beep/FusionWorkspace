/**
 * Memory Write Policy — 记忆写入策略增强版
 *
 * 控制：
 * - 什么该记（价值判断）
 * - 如何去重（相似度检测）
 * - 冲突解决（新旧值矛盾时如何处理）
 * - 污染控制（低置信度/错误来源隔离）
 * - 过期策略（不同类型不同生命周期）
 */

import type { MemoryScope, MemorySource } from './layeredMemory.js'
import { EmlScorer, type EmlScoreDecision, type EmlScoreInput, type EmlSignalType } from './emlScoring.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 写入决策 */
export interface WriteDecision {
  /** 是否写入 */
  shouldWrite: boolean
  /** 原因 */
  reason: string
  /** 置信度 */
  confidence: number
  /** 来源 */
  source: MemorySource
  /** 作用域 */
  scope: MemoryScope
  /** 过期时间（毫秒后，0 表示永不过期） */
  expiresAfterMs: number
  /** 是否需要去重检查 */
  needsDedup: boolean
  /** 去重键 */
  dedupKey?: string
  emlScore?: EmlScoreDecision
}

/** 去重检查结果 */
export interface DedupResult {
  /** 是否发现重复 */
  isDuplicate: boolean
  /** 相似条目 ID */
  similarId?: string
  /** 相似度 0-1 */
  similarity: number
  /** 建议操作 */
  action: 'skip' | 'update' | 'merge' | 'keep_both'
}

/** 冲突解决策略 */
export interface ConflictResolution {
  /** 新值是否覆盖旧值 */
  shouldOverride: boolean
  /** 原因 */
  reason: string
  /** 合并后的值（如果 action='merge'） */
  mergedValue?: string
}

// =============================================================================
// 记忆写入策略
// =============================================================================

export class MemoryWritePolicy {
  private emlScorer = new EmlScorer()
  /** 判断是否值得写入长期记忆 */
  evaluateForWrite(input: {
    content: string
    context: string
    userId?: string
    source?: MemorySource
    scope?: MemoryScope
    tags?: string[]
    eml?: EmlScoreInput
  }): WriteDecision {
    const content = input.content.trim()
    const context = input.context.trim().toLowerCase()
    const combined = `${content}\n${context}`.toLowerCase()

    // 1. 空内容或过短
    if (!content || content.length < 4) {
      return {
        shouldWrite: false,
        reason: 'content_too_short',
        confidence: 0,
        source: input.source ?? 'inferred',
        scope: input.scope ?? 'user',
        expiresAfterMs: 0,
        needsDedup: false,
        emlScore: this.evaluateEml(input, 'generic', 0.05, 0.05),
      }
    }

    // 2. 明确的用户偏好（"记住我喜欢..."）
    if (/^(记住|记得|我喜欢|我讨厌|不要用|always|never|prefer|remember)\b/i.test(content)) {
      return {
        shouldWrite: true,
        reason: 'explicit_preference',
        confidence: 1.0,
        source: 'explicit',
        scope: 'user',
        expiresAfterMs: 0, // 永不过期
        needsDedup: true,
        dedupKey: this.extractDedupKey(content),
        emlScore: this.evaluateEml(input, 'user_preference', 0.9, 1),
      }
    }

    // 3. 环境事实（"我的项目路径是..."）
    if (/\b(路径|目录|地址|url|端口|配置|环境|project|path|config|env)\b/i.test(combined)) {
      return {
        shouldWrite: true,
        reason: 'environmental_fact',
        confidence: 0.8,
        source: input.source ?? 'inferred',
        scope: input.scope ?? 'global',
        expiresAfterMs: 30 * 24 * 60 * 60 * 1000, // 30 天
        needsDedup: true,
        dedupKey: this.extractDedupKey(content),
        emlScore: this.evaluateEml(input, 'project_fact', 0.7, 0.8),
      }
    }

    // 4. 工作流/方案（可复用的步骤）
    if (/\b(步骤|流程|方案|方法|workflow|procedure|steps|how to)\b/i.test(combined)) {
      return {
        shouldWrite: true,
        reason: 'reusable_workflow',
        confidence: 0.6,
        source: input.source ?? 'inferred',
        scope: 'global',
        expiresAfterMs: 90 * 24 * 60 * 60 * 1000, // 90 天
        needsDedup: true,
        dedupKey: this.extractDedupKey(content),
        emlScore: this.evaluateEml(input, 'generic', 0.6, 0.6),
      }
    }

    // 5. 普通对话（低价值）
    return {
      shouldWrite: false,
      reason: 'low_value_conversation',
      confidence: 0.2,
      source: 'inferred',
      scope: 'session',
      expiresAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 天
      needsDedup: false,
      emlScore: this.evaluateEml(input, 'generic', 0.1, 0.2),
    }
  }

  /**
   * 去重检查
   * 基于关键词重叠率判断是否重复
   */
  checkDuplicate(newContent: string, existingContents: Array<{ id: string; content: string }>): DedupResult {
    if (existingContents.length === 0) {
      return { isDuplicate: false, similarity: 0, action: 'keep_both' }
    }

    const newTokens = this.tokenize(newContent)
    let bestMatch: DedupResult = { isDuplicate: false, similarity: 0, action: 'keep_both' }

    for (const existing of existingContents) {
      const existingTokens = this.tokenize(existing.content)
      const similarity = this.jaccardSimilarity(newTokens, existingTokens)

      if (similarity > bestMatch.similarity) {
        if (similarity >= 0.9) {
          bestMatch = {
            isDuplicate: true,
            similarId: existing.id,
            similarity,
            action: 'skip',
          }
        } else if (similarity >= 0.7) {
          bestMatch = {
            isDuplicate: true,
            similarId: existing.id,
            similarity,
            action: 'update',
          }
        } else if (similarity >= 0.5) {
          bestMatch = {
            isDuplicate: true,
            similarId: existing.id,
            similarity,
            action: 'merge',
          }
        }
      }
    }

    return bestMatch
  }

  /**
   * 冲突解决
   * 当新旧值矛盾时决定如何处理
   */
  resolveConflict(oldValue: string, newValue: string, oldConfidence: number, newConfidence: number, oldSource: MemorySource, newSource: MemorySource): ConflictResolution {
    // 1. 人工修正永远覆盖
    if (newSource === 'human_override') {
      return {
        shouldOverride: true,
        reason: 'human_override_always_wins',
      }
    }

    // 2. 明确告知覆盖推断
    if (newSource === 'explicit' && oldSource === 'inferred') {
      return {
        shouldOverride: true,
        reason: 'explicit_overrides_inferred',
      }
    }

    // 3. 高置信度覆盖低置信度
    if (newConfidence > oldConfidence + 0.2) {
      return {
        shouldOverride: true,
        reason: `higher_confidence (${newConfidence.toFixed(1)} > ${oldConfidence.toFixed(1)})`,
      }
    }

    // 4. 置信度接近时合并
    if (Math.abs(newConfidence - oldConfidence) < 0.2) {
      return {
        shouldOverride: false,
        reason: 'similar_confidence_suggests_merge',
        mergedValue: `${oldValue}; ${newValue}`,
      }
    }

    // 5. 默认保留旧值
    return {
      shouldOverride: false,
      reason: 'old_value_has_higher_or_equal_confidence',
    }
  }

  /**
   * 计算过期时间
   * 根据来源和置信度动态决定
   */
  calculateExpiry(source: MemorySource, confidence: number, scope: MemoryScope): number {
    // 人工修正和明确告知永不过期
    if (source === 'human_override' || source === 'explicit') {
      return 0
    }

    // 高置信度全局知识长期保留
    if (confidence >= 0.8 && scope === 'global') {
      return 180 * 24 * 60 * 60 * 1000 // 180 天
    }

    // 中等置信度
    if (confidence >= 0.5) {
      return 30 * 24 * 60 * 60 * 1000 // 30 天
    }

    // 低置信度短期保留
    return 7 * 24 * 60 * 60 * 1000 // 7 天
  }

  /**
   * 污染检查
   * 判断内容是否可能污染记忆库
   */
  checkContamination(content: string): { isContaminated: boolean; reason: string } {
    const lower = content.toLowerCase()

    // 1. 明显无意义内容
    if (/^(.{0,3})$/.test(content.trim())) {
      return { isContaminated: true, reason: 'too_short' }
    }

    // 2. 重复字符（"aaaaa"）
    if (/(.)\1{9,}/.test(content)) {
      return { isContaminated: true, reason: 'repetitive_characters' }
    }

    // 3. 明显错误/乱码
    if (/^[^\u4e00-\u9fa5a-zA-Z0-9\s]{10,}$/.test(content)) {
      return { isContaminated: true, reason: 'non_text_content' }
    }

    // 4. 过度夸张（可能为 AI slop）
    const hypeWords = ['revolutionary', 'groundbreaking', 'unprecedented', '革命性的', '突破性的']
    if (hypeWords.some(w => lower.includes(w))) {
      return { isContaminated: true, reason: 'potential_ai_slop' }
    }

    return { isContaminated: false, reason: 'clean' }
  }

  // =============================================================================
  // 私有方法
  // =============================================================================

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2)
    )
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1
    const intersection = new Set([...a].filter(x => b.has(x)))
    const union = new Set([...a, ...b])
    return intersection.size / union.size
  }

  private extractDedupKey(content: string): string {
    // 提取前 3 个有意义的词作为去重键
    const tokens = this.tokenize(content)
    return Array.from(tokens).slice(0, 3).join('_')
  }

  private evaluateEml(
    input: { content: string; context: string; eml?: EmlScoreInput },
    signalType: EmlSignalType,
    novelty: number,
    importance: number,
  ): EmlScoreDecision {
    if (input.eml) {
      return this.emlScorer.score(input.eml)
    }

    const combined = `${input.content}\n${input.context}`.toLowerCase()
    const redundancy = /(duplicate|重复|ok ok|same)/i.test(combined) ? 0.95 : 0.15
    const volatility = /(temporary|obsolete|volatile|临时|过期)/i.test(combined) ? 0.8 : 0.2
    const retrievalFrequency = /(often|frequent|always|每次)/i.test(combined) ? 0.7 : 0.3

    return this.emlScorer.score({
      novelty,
      importance,
      volatility,
      redundancy,
      retrievalFrequency,
      ageMs: 0,
      signalType,
    })
  }
}
