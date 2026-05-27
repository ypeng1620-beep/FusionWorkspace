/**
 * Trajectory Compression — 会话轨迹压缩
 *
 * 融合 Hermes 的 trajectory compression 思想：
 * - 保护首尾轮次（第一轮和最后一轮永远保留原文）
 * - 中间轮次压缩为摘要
 * - 支持分段压缩（按 turn 窗口）
 * - 压缩后仍可恢复关键信息
 *
 * 用于：
 * 1. TAOR 循环上下文窗口超限时压缩旧消息
 * 2. 会话恢复时重建关键上下文
 * 3. 长期存储时节省空间
 */

import type { Message } from '../agent/taorLoop.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 压缩后的轮次 */
export interface CompressedTurn {
  /** 起始 turn 编号 */
  startTurn: number
  /** 结束 turn 编号 */
  endTurn: number
  /** 压缩后的摘要 */
  summary: string
  /** 原始消息数量 */
  originalMessageCount: number
  /** 保留的关键工具调用（不被压缩的） */
  preservedToolCalls: Array<{
    toolName: string
    input: Record<string, unknown>
    output: string
  }>
  /** 压缩时间 */
  compressedAt: number
  /** 压缩方法 */
  method: 'llm_summary' | 'template' | 'truncate'
}

/** 压缩结果 */
export interface CompressionResult {
  /** 压缩后的消息列表 */
  messages: Message[]
  /** 压缩掉的 turn 数量 */
  compressedTurns: number
  /** 保留的 turn 数量 */
  preservedTurns: number
  /** 原始消息数 */
  originalCount: number
  /** 压缩后消息数 */
  compressedCount: number
  /** 压缩率 */
  compressionRatio: number
}

/** 压缩配置 */
export interface TrajectoryCompressionConfig {
  /** 保留的首轮数量（默认 1） */
  headTurns?: number
  /** 保留的尾轮数量（默认 1） */
  tailTurns?: number
  /** 每个压缩段的 turn 数量（默认 5） */
  segmentSize?: number
  /** 压缩方法 */
  method?: 'llm_summary' | 'template' | 'truncate'
  /** LLM 摘要生成器（method='llm_summary' 时需要） */
  summaryGenerator?: (turns: Message[]) => Promise<string>
}

// =============================================================================
// 轨迹压缩器
// =============================================================================

export class TrajectoryCompressor {
  private config: Required<TrajectoryCompressionConfig>

  constructor(config: TrajectoryCompressionConfig = {}) {
    this.config = {
      headTurns: config.headTurns ?? 1,
      tailTurns: config.tailTurns ?? 1,
      segmentSize: config.segmentSize ?? 5,
      method: config.method ?? 'template',
      summaryGenerator: config.summaryGenerator ?? defaultSummaryGenerator,
    }
  }

  /**
   * 压缩消息历史
   *
   * 策略：
   * 1. 保留首轮 N 条（用户初始意图）
   * 2. 保留尾轮 N 条（最近上下文）
   * 3. 中间按段压缩为摘要
   */
  async compress(messages: Message[], currentTurn: number): Promise<CompressionResult> {
    if (messages.length <= 4) {
      // 消息太少，不需要压缩
      return {
        messages,
        compressedTurns: 0,
        preservedTurns: messages.length,
        originalCount: messages.length,
        compressedCount: messages.length,
        compressionRatio: 1.0,
      }
    }

    // 1. 识别首尾保留区
    const headCount = this.config.headTurns * 2 // 每轮 = user + assistant
    const tailCount = this.config.tailTurns * 2

    const headMessages = messages.slice(0, headCount)
    const tailMessages = messages.slice(-tailCount)

    // 2. 中间区域需要压缩
    const middleMessages = messages.slice(headCount, -tailCount)

    if (middleMessages.length === 0) {
      return {
        messages,
        compressedTurns: 0,
        preservedTurns: messages.length,
        originalCount: messages.length,
        compressedCount: messages.length,
        compressionRatio: 1.0,
      }
    }

    // 3. 按段压缩中间区域
    const compressed: Message[] = []
    let compressedTurns = 0
    const preservedToolCalls: CompressedTurn['preservedToolCalls'] = []

    for (let i = 0; i < middleMessages.length; i += this.config.segmentSize * 2) {
      const segment = middleMessages.slice(i, i + this.config.segmentSize * 2)
      const turnNumber = Math.floor((headCount + i) / 2) + 1

      // 提取工具调用
      const toolCallsInSegment = segment
        .filter(m => m.role === 'assistant' && typeof m.content === 'object' && m.content !== null)
        .flatMap(m => {
          const content = m.content as any
          if (Array.isArray(content)) {
            return content.filter((c: any) => c.type === 'tool_use')
          }
          return []
        })

      // 保留重要的工具调用（高风险/关键操作）
      const importantToolCalls = toolCallsInSegment.filter((tc: any) => {
        const name = tc.name ?? ''
        return ['write_file', 'execute_command', 'http_request'].includes(name)
      })

      // 生成摘要
      let summary: string
      if (this.config.method === 'llm_summary' && this.config.summaryGenerator) {
        summary = await this.config.summaryGenerator(segment)
      } else {
        summary = this.templateCompress(segment)
      }

      compressedTurns++

      // 创建压缩后的系统消息
      const compressedMessage: Message = {
        role: 'system',
        content: { type: 'text', text: `[Compressed turns ${turnNumber}-${turnNumber + Math.floor(segment.length / 2) - 1}]\n${summary}` },
      }
      compressed.push(compressedMessage)

      // 保留重要工具调用的摘要
      for (const tc of importantToolCalls.slice(0, 2)) {
        preservedToolCalls.push({
          toolName: tc.name,
          input: tc.input ?? {},
          output: typeof tc.content === 'string' ? tc.content : JSON.stringify(tc.content),
        })
      }
    }

    // 4. 组装最终结果
    const resultMessages = [
      ...headMessages,
      ...compressed,
      ...tailMessages,
    ]

    const originalTurns = Math.ceil(messages.length / 2)
    const preservedTurns = headCount + tailCount

    return {
      messages: resultMessages,
      compressedTurns,
      preservedTurns: Math.ceil(preservedTurns / 2),
      originalCount: messages.length,
      compressedCount: resultMessages.length,
      compressionRatio: resultMessages.length / messages.length,
    }
  }

  /**
   * 模板压缩（不使用 LLM）
   * 提取关键信息：用户意图、工具调用、结果
   */
  private templateCompress(messages: Message[]): string {
    const lines: string[] = []
    let userTurns = 0
    let toolCalls = 0

    for (const msg of messages) {
      if (msg.role === 'user') {
        userTurns++
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        if (text.length > 80) {
          lines.push(`User: ${text.slice(0, 80)}...`)
        } else {
          lines.push(`User: ${text}`)
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'object' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolCalls++
            } else if (block.type === 'text' && block.text) {
              // 忽略纯文本回复（已在摘要中体现）
            }
          }
        }
      }
    }

    const summary = `${userTurns} turns, ${toolCalls} tool calls`
    return lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n...' : '') + `\n[Summary: ${summary}]`
  }

  /**
   * 从压缩结果中恢复关键信息
   * 用于会话恢复场景
   */
  static extractKeyInfo(compressedMessages: Message[]): {
    initialRequest: string | null
    lastResponse: string | null
    toolCallsUsed: string[]
    compressedSegments: number
  } {
    let initialRequest: string | null = null
    let lastResponse: string | null = null
    const toolCallsUsed: string[] = []
    let compressedSegments = 0

    for (const msg of compressedMessages) {
      if (msg.role === 'user' && !initialRequest) {
        initialRequest = typeof msg.content === 'string' ? msg.content : ('text' in msg.content ? (msg.content as any).text : JSON.stringify(msg.content))
      }
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : ('text' in msg.content ? (msg.content as any).text : '')
        if (typeof text === 'string' && text.startsWith('[Compressed')) {
          compressedSegments++
        }
      }
      if (msg.role === 'assistant') {
        lastResponse = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if ((block as any).type === 'tool_use') {
              toolCallsUsed.push((block as any).name)
            }
          }
        }
      }
    }

    return { initialRequest, lastResponse, toolCallsUsed, compressedSegments }
  }
}

/** 默认摘要生成器（模板方式） */
async function defaultSummaryGenerator(turns: Message[]): Promise<string> {
  const userMessages = turns.filter(m => m.role === 'user')
  const assistantMessages = turns.filter(m => m.role === 'assistant')

  const userSummary = userMessages
    .map(m => {
      const text = typeof m.content === 'string' ? m.content : ('text' in m.content ? (m.content as any).text : JSON.stringify(m.content))
      return typeof text === 'string' ? text.slice(0, 60) : '[complex]'
    })
    .join('; ')

  const toolCount = assistantMessages.flatMap(m => {
    if (typeof m.content === 'object' && Array.isArray(m.content)) {
      return m.content.filter((c: any) => c.type === 'tool_use')
    }
    return []
  }).length

  return `Discussed: ${userSummary}. Used ${toolCount} tools.`
}
