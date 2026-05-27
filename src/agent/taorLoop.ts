/**
 * TAOR Loop — Think → Action → Observe → Reflect
 * 
 * 融合 Claude Code QueryEngine 的核心循环逻辑：
 * - 主循环：query() generator 驱动
 * - 上下文窗口：滑动窗口保留最近 N 条消息
 * - 工具执行：通过回调注入，权限门独立
 * - 终止条件：final_answer 或 max_steps
 * - 记忆系统：FTS5 + LRU 缓存（可选）
 * - 权限系统：七模式权限门 + 工具注册表（可选）
 * 
 * 纯 TypeScript，无 UI 依赖，可独立运行
 */

import type { ApprovalEventBus, ApprovalNeededEvent } from '../protocol/approvalEventBus.js'
import type { LoopController, LoopPausedState } from '../protocol/loopController.js'
import type { PhoenixAuditStore } from '../orchestrator/phoenixAudit.js'
import type { PhoenixCore } from '../orchestrator/phoenixCore.js'
import type { AntibodyRepository } from '../antibody/antibodyRepository.js'
import OpenAI from 'openai'
import type { LlmProvider } from '../llm/llmProvider.js'

// =============================================================================
// 类型定义
// =============================================================================

// ContentBlockParam type - simplified version for standalone use
interface ContentBlockParam {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | ContentBlockParam[]
}
import { MemoryManager } from '../memory/memoryManager.js'
import { SessionStore } from '../memory/sessionStore.js'
import type { SkillManager } from '../skills/skillManager.js'
import { ToolRegistry, createToolCall, type ToolContext, type ToolExecutionContext } from '../tools/toolExecutor.js'
import { 
  PermissionGate, 
  PermissionError, 
  NeedConfirmationError,
  type PermissionMode,
  type ToolCall,
} from '../permissions/permissionGate.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

/** 消息内容块 */
export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string | TextContent[]
}

export type MessageContent = TextContent | ToolUseContent | ToolResultContent

/** 对话消息 */
export interface Message {
  role: MessageRole
  content: MessageContent | MessageContent[]
  name?: string
  timestamp?: number
}

/** 工具定义 */
export interface ToolDef {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

/** 工具调用结果 */
export interface ToolResult {
  tool_use_id: string
  tool_name: string
  content: string
  is_error?: boolean
}

/** LLM 响应块 */
export interface ResponseChunk {
  type: 'content_block' | 'tool_use' | 'message_delta' | 'done'
  content?: TextContent | ToolUseContent
  text?: string  // 用于 'done' 类型的最终文本
  stop_reason?: string
  usage?: { input_tokens: number; output_tokens: number }
}

/** 工具执行器回调类型 */
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, unknown>
) => Promise<ToolResult>

/** LLM 调用器类型 */
export type LLMCaller = (
  messages: Message[],
  tools: ToolDef[],
  model?: string
) => AsyncGenerator<ResponseChunk, void, unknown>

/** 确认处理器回调类型 */
export type ConfirmationHandler = (
  toolUse: ToolUseContent,
  toolCall: ToolCall,
  riskLevel: number,
  requestId?: string
) => Promise<boolean>

/** TAOR 运行配置 */
export interface TAORConfig {
  /** 初始 prompt */
  initialPrompt: string
  /** 工具列表 */
  tools: ToolDef[]
  /** 工具执行器（必需，除非提供 toolRegistry） */
  toolExecutor?: ToolExecutor
  /** LLM 调用器（默认使用模拟 LLM） */
  llmCaller?: LLMCaller
  llmProvider?: LlmProvider
  /** 模型名称 */
  model?: string
  /** 最大循环次数（默认 20） */
  maxSteps?: number
  /** 滑动窗口大小（默认 10 条消息） */
  contextWindowSize?: number
  /** 系统提示 */
  systemPrompt?: string
  /** 是否启用 thinking（默认关闭） */
  thinkingEnabled?: boolean
  /** 是否启用记忆系统（默认 true） */
  enableMemory?: boolean
  /** 记忆管理器实例（如果 enableMemory=true，必须提供） */
  memoryManager?: MemoryManager
  /** 记忆搜索结果注入条数（默认 3） */
  memorySearchLimit?: number
  /** 权限模式（默认 'default'） */
  permissionMode?: PermissionMode
  /** 工具注册表（如果提供，使用集成的权限检查） */
  toolRegistry?: ToolRegistry
  /** 工作目录 */
  cwd?: string
  /** 信任目录列表（sandbox 模式） */
  trustedDirectories?: string[]
  /** 确认处理器（interactive/default 模式需要） */
  onConfirmationRequired?: ConfirmationHandler
  /** 当前会话 ID */
  sessionId?: string
  /** 当前用户 ID */
  userId?: string
  /** 当前渠道 */
  channel?: string
  /** 会话恢复存储 */
  sessionStore?: SessionStore
  /** 最大输入 token 预算（粗估） */
  maxInputTokens?: number
  /** 最大输出 token 预算（粗估） */
  maxOutputTokens?: number
  /** 最大工具调用次数 */
  maxToolCalls?: number
  /** LLM 调用重试次数 */
  llmRetryAttempts?: number
  /** LLM 重试基础退避毫秒 */
  llmRetryBaseMs?: number
  /** 运行审计保留条数 */
  runtimeAuditLimit?: number
  /** 审批模式：promise（阻塞，默认）或 event（事件驱动，适配 webhook 通道） */
  approvalMode?: 'promise' | 'event'
  /** 审批事件总线（event 模式需要） */
  approvalEventBus?: ApprovalEventBus
  /** 循环控制器（event 模式需要） */
  loopController?: LoopController
  phoenixCore?: PhoenixCore
  phoenixAudit?: PhoenixAuditStore
  antibodyRepository?: AntibodyRepository
  antibodyLookupPatterns?: string[]
  skillManager?: SkillManager
}

/** TAOR 运行结果 */
export interface TAORResult {
  /** 最终回复文本 */
  finalText: string
  /** 循环次数 */
  steps: number
  /** 完整消息历史 */
  messages: Message[]
  /** 是否达到最大步数 */
  reachedMaxSteps: boolean
  /** 停止原因 */
  stopReason: string | null
  /** 总 token 消耗（估算） */
  totalTokens?: { input: number; output: number }
  /** 运行时审计轨迹 */
  runtimeAudit?: RuntimeAuditEntry[]
}

/** 内部状态 */
interface TAORState {
  messages: Message[]
  toolCalls: ToolCallRecord[]
  stepCount: number
  stopReason: string | null
  reachedMaxSteps: boolean
  initialPrompt: string  // 保存初始 prompt，用于记忆存储
  finalResponse: string  // 保存最终回复，用于记忆存储
  totalTokens: { input: number; output: number }
  runtimeAudit: RuntimeAuditEntry[]
  llmAttempts: number
}

interface ToolCallRecord {
  step: number
  toolName: string
  toolInput: Record<string, unknown>
  toolResult: ToolResult
}

export interface RuntimeAuditEntry {
  step: number
  phase: 'startup' | 'memory' | 'recovery' | 'budget' | 'llm' | 'tool' | 'persist' | 'error' | 'phoenix'
  status: 'info' | 'warn' | 'error'
  detail: string
  timestamp: number
}

// =============================================================================
// 滑动上下文窗口
// =============================================================================

/**
 * 简单的滑动窗口上下文管理器
 * 保留最近 N 条消息，自动压缩旧消息
 */
export class SlidingContextWindow {
  private messages: Message[] = []
  private maxSize: number

  constructor(maxSize = 10) {
    this.maxSize = maxSize
  }

  /** 添加消息 */
  push(msg: Message): void {
    this.messages.push(msg)
    this.trim()
  }

  /** 添加用户消息 */
  pushUser(content: string): void {
    this.push({
      role: 'user',
      content: { type: 'text', text: content },
      timestamp: Date.now(),
    })
  }

  /** 添加助手消息 */
  pushAssistant(content: MessageContent | MessageContent[]): void {
    this.push({
      role: 'assistant',
      content: content,
      timestamp: Date.now(),
    })
  }

  /** 添加工具结果消息 */
  pushToolResult(result: ToolResult): void {
    this.push({
      role: 'user', // Claude Code 中 tool_result 作为 user role 回传
      content: {
        type: 'tool_result',
        tool_use_id: result.tool_use_id,
        content: result.content,
      },
      timestamp: Date.now(),
    })
  }

  /** 获取当前上下文（最近的 maxSize 条消息） */
  getContext(): Message[] {
    return [...this.messages]
  }

  /** 获取消息摘要（用于压缩） */
  getSummary(): string {
    return `[${this.messages.length} messages in history]`
  }

  /** 压缩旧消息为摘要 */
  compress(): void {
    if (this.messages.length <= 2) return

    // 保留第一条系统消息 + 最近几条
    const systemMessages = this.messages.filter(m => m.role === 'system')
    const recentMessages = this.messages.slice(-this.maxSize)

    this.messages = [
      ...systemMessages,
      {
        role: 'system',
        content: {
          type: 'text',
          text: `[Compressed ${this.messages.length - recentMessages.length} earlier messages]`,
        },
        timestamp: Date.now(),
      },
      ...recentMessages,
    ]
  }

  /** 修剪超过上限的消息 */
  private trim(): void {
    // 系统消息永远保留
    const systemMsgs = this.messages.filter(m => m.role === 'system')
    const nonSystemMsgs = this.messages.filter(m => m.role !== 'system')

    if (nonSystemMsgs.length > this.maxSize) {
      const toCompress = nonSystemMsgs.slice(0, -this.maxSize)
      const kept = nonSystemMsgs.slice(-this.maxSize)

      this.messages = [
        ...systemMsgs,
        {
          role: 'system',
          content: {
            type: 'text',
            text: `[Earlier ${toCompress.length} messages compressed]`,
          },
          timestamp: Date.now(),
        },
        ...kept,
      ]
    }
  }

  /** 获取消息数量 */
  get length(): number {
    return this.messages.length
  }
}

// =============================================================================
// TAOR 循环核心
// =============================================================================

/**
 * TAOR 循环运行器
 * 
 * Think → Action → Observe → Reflect → Repeat
 * 
 * 融合 Claude Code 的：
 * - Generator 模式（异步迭代器返回中间结果）
 * - 工具调用记录
 * - 上下文压缩
 * - 终止条件检测（final_answer / max_steps）
 * - 记忆系统（可选，FTS5 + LRU）
 * - 权限系统（可选，七模式权限门）
 */
export class TAORLoop {
  private config: Required<TAORConfig>
  private context: SlidingContextWindow
  private state: TAORState
  private manager: MemoryManager | null = null
  private toolRegistry: ToolRegistry | null = null
  private permissionGate: PermissionGate | null = null
  private sessionStore: SessionStore | null = null
  /** 待发出的 confirmation_needed 事件（event 模式下由 executeToolCall 设置，run() 发出） */
  private _pendingConfirmationEvent: Extract<TAORStepEvent, { type: 'confirmation_needed' }> | null = null
  private _pendingApprovalContext: {
    requestId: string
    loopId: string
    toolUse: ToolUseContent
    toolCall: ToolCall
    riskLevel: number
  } | null = null

  constructor(config: TAORConfig) {
    // 构建配置对象（允许某些字段为 null）
    type MutableConfig = {
      [K in keyof TAORConfig]: TAORConfig[K] extends (...args: infer R) => infer R2
        ? TAORConfig[K]
        : TAORConfig[K] | null
    }

    const fullConfig: MutableConfig = {
      llmCaller: config.llmCaller ?? (config.llmProvider ? undefined : (process.env.MINIMAX_API_KEY ? createMiniMaxCaller() : defaultLLMCaller)),
      llmProvider: config.llmProvider ?? null,
      model: config.model ?? 'claude-sonnet-4-6',
      maxSteps: config.maxSteps ?? 20,
      contextWindowSize: config.contextWindowSize ?? 10,
      systemPrompt: config.systemPrompt ?? '',
      thinkingEnabled: config.thinkingEnabled ?? false,
      enableMemory: config.enableMemory ?? true,
      memoryManager: config.memoryManager ?? null,
      memorySearchLimit: config.memorySearchLimit ?? 3,
      permissionMode: config.permissionMode ?? 'default',
      toolRegistry: config.toolRegistry ?? null,
      toolExecutor: config.toolExecutor ?? (async () => ({ tool_use_id: '', tool_name: '', content: 'No executor configured', is_error: true })),
      tools: config.tools,
      initialPrompt: config.initialPrompt,
      cwd: config.cwd ?? process.cwd(),
      trustedDirectories: config.trustedDirectories ?? [],
      onConfirmationRequired: config.onConfirmationRequired ?? null,
      sessionId: config.sessionId ?? '',
      userId: config.userId ?? '',
      channel: config.channel ?? '',
      sessionStore: config.sessionStore ?? null,
      maxInputTokens: config.maxInputTokens ?? 12000,
      maxOutputTokens: config.maxOutputTokens ?? 4000,
      maxToolCalls: config.maxToolCalls ?? 24,
      llmRetryAttempts: config.llmRetryAttempts ?? 2,
      llmRetryBaseMs: config.llmRetryBaseMs ?? 250,
      runtimeAuditLimit: config.runtimeAuditLimit ?? 200,
      approvalMode: config.approvalMode ?? 'promise',
      approvalEventBus: config.approvalEventBus ?? null,
      loopController: config.loopController ?? null,
      phoenixCore: config.phoenixCore ?? null,
      phoenixAudit: config.phoenixAudit ?? null,
      antibodyRepository: config.antibodyRepository ?? null,
      antibodyLookupPatterns: config.antibodyLookupPatterns ?? [],
      skillManager: config.skillManager ?? null,
    } as MutableConfig

    this.config = fullConfig as Required<TAORConfig>

    this.context = new SlidingContextWindow(this.config.contextWindowSize)

    // 初始化记忆管理器
    if (this.config.enableMemory && this.config.memoryManager) {
      this.manager = this.config.memoryManager
    }

    if (this.config.sessionStore) {
      this.sessionStore = this.config.sessionStore
    }

    // 初始化权限系统和工具注册表
    this.initializePermissionSystem()

    this.state = {
      messages: [],
      toolCalls: [],
      stepCount: 0,
      stopReason: null,
      reachedMaxSteps: false,
      initialPrompt: config.initialPrompt,
      finalResponse: '',
      totalTokens: { input: 0, output: 0 },
      runtimeAudit: [],
      llmAttempts: 0,
    }
  }

  /**
   * 初始化权限系统和工具注册表
   */
  private initializePermissionSystem(): void {
    // 如果提供了工具注册表，直接使用
    if (this.config.toolRegistry) {
      this.toolRegistry = this.config.toolRegistry
      this.permissionGate = this.toolRegistry.getPermissionGate()
      return
    }

    // 否则创建权限门和注册表
    this.permissionGate = new PermissionGate(this.config.permissionMode, {
      cwd: this.config.cwd,
      trustedDirectories: this.config.trustedDirectories,
      sessionId: this.config.sessionId,
      userId: this.config.userId,
      channel: this.config.channel,
    })

    this.toolRegistry = new ToolRegistry(this.config.permissionMode, {
      cwd: this.config.cwd,
      trustedDirectories: this.config.trustedDirectories,
      sessionId: this.config.sessionId,
      userId: this.config.userId,
      channel: this.config.channel,
    })
  }

  private getToolExecutionContext(): ToolExecutionContext {
    return {
      cwd: this.config.cwd,
      trustedDirectories: this.config.trustedDirectories,
      sessionId: this.config.sessionId,
      userId: this.config.userId,
      channel: this.config.channel,
    }
  }

  /**
   * 执行工具调用（带权限检查）
   */
  private async executeToolCall(toolUse: ToolUseContent): Promise<ToolResult> {
    const { name, input, id } = toolUse

    // 如果没有工具注册表，使用原始执行器
    if (!this.toolRegistry) {
      return this.config.toolExecutor(name, input)
    }

    try {
      if (this.state.toolCalls.length >= this.config.maxToolCalls) {
        this.recordAudit(this.state.stepCount, 'budget', 'warn', `Tool call budget exceeded at ${this.state.toolCalls.length}/${this.config.maxToolCalls}`)
        return {
          tool_use_id: id,
          tool_name: name,
          content: `Tool budget exceeded: max ${this.config.maxToolCalls} tool calls`,
          is_error: true,
        }
      }

      // 通过工具注册表执行（自动进行权限检查）
      const result = await this.toolRegistry.execute(name, input, this.getToolExecutionContext())
      if (!result.success && result.requiresConfirmation) {
        const requestId = result.requestId ?? `auto-${Date.now()}-${this.state.stepCount}`
        const toolCall = createToolCall(name, input)

        if (this.config.approvalMode === 'event' && this.config.approvalEventBus) {
          const loopId = requestId
          const event: ApprovalNeededEvent = {
            requestId,
            sessionId: this.config.sessionId ?? '',
            conversationId: this.config.channel,
            userId: this.config.userId,
            channel: (this.config.channel as any) ?? 'unknown',
            toolName: name,
            toolCall,
            riskLevel: result.riskLevel ?? 3,
            message: `Tool '${name}' requires approval (risk: ${result.riskLevel ?? 3}/10)`,
            timestamp: Date.now(),
          }
          this.config.approvalEventBus.emitApprovalNeeded(event)

          const pausedState: LoopPausedState = {
            loopId,
            sessionId: this.config.sessionId ?? '',
            stepCount: this.state.stepCount,
            pendingConfirmation: {
              requestId,
              toolCall,
              riskLevel: result.riskLevel ?? 3,
            },
            pausedAt: Date.now(),
          }
          this.config.loopController?.pause(loopId, pausedState)
          this._pendingConfirmationEvent = {
            type: 'confirmation_needed' as const,
            step: this.state.stepCount,
            requestId,
            toolName: name,
            toolInput: toolCall.params,
            riskLevel: result.riskLevel ?? 3,
          }
          this._pendingApprovalContext = {
            requestId,
            loopId,
            toolUse,
            toolCall,
            riskLevel: result.riskLevel ?? 3,
          }
          return {
            tool_use_id: id,
            tool_name: name,
            content: `Waiting for approval (requestId: ${requestId})`,
            is_error: false,
          }
        }

        if (this.config.onConfirmationRequired) {
          const approved = await this.config.onConfirmationRequired(
            toolUse,
            toolCall,
            result.riskLevel ?? 3,
            requestId,
          )

          if (approved) {
            if (requestId) {
              this.permissionGate?.resolvePendingRequest(requestId, true)
            }
            this.permissionGate?.registerApproval(toolCall, {
              scope: 'once',
              note: 'approved via confirmation handler',
              remainingUses: 1,
            })
            return await this.executeToolCall(toolUse)
          }

          if (requestId) {
            this.permissionGate?.resolvePendingRequest(requestId, false)
          }
        }

        return {
          tool_use_id: id,
          tool_name: name,
          content: `Confirmation required but not granted: ${result.error ?? name}`,
          is_error: true,
        }
      }
      this.recordAudit(this.state.stepCount, 'tool', result.success ? 'info' : 'warn', `${name} -> ${result.success ? 'success' : 'failure'}`)

      return {
        tool_use_id: id,
        tool_name: name,
        content: result.success
          ? (result.stdout ?? result.data as string ?? JSON.stringify(result.data))
          : `Error: ${result.error}`,
        is_error: !result.success,
      }
    } catch (error) {
      if (error instanceof NeedConfirmationError) {
        // Event 模式：emit 事件 + 返回等待状态（不阻塞循环）
        if (this.config.approvalMode === 'event' && this.config.approvalEventBus) {
          const requestId = error.requestId ?? `auto-${Date.now()}-${this.state.stepCount}`
          const loopId = requestId
          const event: ApprovalNeededEvent = {
            requestId,
            sessionId: this.config.sessionId ?? '',
            conversationId: this.config.channel,
            userId: this.config.userId,
            channel: (this.config.channel as any) ?? 'unknown',
            toolName: name,
            toolCall: error.toolCall,
            riskLevel: error.riskLevel,
            message: `Tool '${name}' requires approval (risk: ${error.riskLevel}/10)`,
            timestamp: Date.now(),
          }
          this.config.approvalEventBus.emitApprovalNeeded(event)

          // 保存暂停状态
          const pausedState: LoopPausedState = {
            loopId,
            sessionId: this.config.sessionId ?? '',
            stepCount: this.state.stepCount,
            pendingConfirmation: {
              requestId,
              toolCall: error.toolCall,
              riskLevel: error.riskLevel,
            },
            pausedAt: Date.now(),
          }
          this.config.loopController?.pause(loopId, pausedState)

          // 记录待发出的 confirmation_needed 事件（由 run() generator 发出）
          this._pendingConfirmationEvent = {
            type: 'confirmation_needed' as const,
            step: this.state.stepCount,
            requestId,
            toolName: name,
            toolInput: error.toolCall.params,
            riskLevel: error.riskLevel,
          }
          this._pendingApprovalContext = {
            requestId,
            loopId,
            toolUse,
            toolCall: error.toolCall,
            riskLevel: error.riskLevel,
          }

          // 返回等待状态（循环继续但工具未执行）
          return {
            tool_use_id: id,
            tool_name: name,
            content: `Waiting for approval (requestId: ${requestId})`,
            is_error: false,
          }
        }

        // Promise 模式（保持现有逻辑）
        if (this.config.onConfirmationRequired) {
          const approved = await this.config.onConfirmationRequired(
            toolUse,
            error.toolCall,
            error.riskLevel,
            error.requestId,
          )

          if (approved) {
            if (error.requestId) {
              this.permissionGate?.resolvePendingRequest(error.requestId, true)
            }
            this.permissionGate?.registerApproval(error.toolCall, {
              scope: 'once',
              note: 'approved via confirmation handler',
              remainingUses: 1,
            })
            return await this.executeToolCall(toolUse)
          }

          if (error.requestId) {
            this.permissionGate?.resolvePendingRequest(error.requestId, false)
          }
        }

        return {
          tool_use_id: id,
          tool_name: name,
          content: `Confirmation required but not granted: ${error.message}`,
          is_error: true,
        }
      }

      if (error instanceof PermissionError) {
        this.recordAudit(this.state.stepCount, 'tool', 'warn', `${name} permission denied`)
        return {
          tool_use_id: id,
          tool_name: name,
          content: `Permission denied: ${error.message}`,
          is_error: true,
        }
      }

      this.recordAudit(this.state.stepCount, 'error', 'error', `${name} execution failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        tool_use_id: id,
        tool_name: name,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      }
    }
  }

  private async resolvePendingApproval(): Promise<ToolResult | null> {
    const pending = this._pendingApprovalContext
    if (!pending) {
      return null
    }

    this._pendingApprovalContext = null

    const approved = await this.config.loopController?.waitForResume(
      pending.loopId,
      {
        loopId: pending.loopId,
        sessionId: this.config.sessionId ?? '',
        stepCount: this.state.stepCount,
        pendingConfirmation: {
          requestId: pending.requestId,
          toolCall: pending.toolCall,
          riskLevel: pending.riskLevel,
        },
        pausedAt: Date.now(),
      },
    ) ?? false

    if (approved) {
      this.permissionGate?.resolvePendingRequest(pending.requestId, true)
      this.permissionGate?.registerApproval(pending.toolCall, {
        scope: 'once',
        note: 'approved via event mode controller',
        remainingUses: 1,
      })
      this.recordAudit(this.state.stepCount, 'tool', 'info', `${pending.toolUse.name} approval granted`)
      return await this.executeApprovedToolCall(pending.toolUse)
    }

    this.permissionGate?.resolvePendingRequest(pending.requestId, false)
    this.recordAudit(this.state.stepCount, 'tool', 'warn', `${pending.toolUse.name} approval denied`)
    return {
      tool_use_id: pending.toolUse.id,
      tool_name: pending.toolUse.name,
      content: `Confirmation required but not granted: request ${pending.requestId}`,
      is_error: true,
    }
  }

  private async executeApprovedToolCall(toolUse: ToolUseContent): Promise<ToolResult> {
    const { id, name, input } = toolUse

    if (!this.toolRegistry) {
      return this.config.toolExecutor(name, input)
    }

    const result = await this.toolRegistry.executeWithoutPermission(name, input, this.getToolExecutionContext())
    this.recordAudit(this.state.stepCount, 'tool', result.success ? 'info' : 'warn', `${name} -> ${result.success ? 'success' : 'failure'} (approved)`)

    return {
      tool_use_id: id,
      tool_name: name,
      content: result.success
        ? (result.stdout ?? result.data as string ?? JSON.stringify(result.data))
        : `Error: ${result.error}`,
      is_error: !result.success,
    }
  }

  /**
   * 运行 TAOR 循环
   * 返回最终结果和完整消息历史
   */
  async *run(): AsyncGenerator<TAORStepEvent, TAORResult, void> {
    const {
      initialPrompt,
      tools,
      toolExecutor,
      llmCaller,
      model,
      systemPrompt,
      thinkingEnabled,
      enableMemory,
      memorySearchLimit,
    } = this.config

    // ===== Step 0: 记忆系统集成 =====
    // 在首次 LLM 调用前，从记忆系统检索相关上下文
    let effectiveMemorySearchLimit = memorySearchLimit
    if (enableMemory && this.manager && this.config.phoenixCore && this.config.phoenixAudit) {
      const memoryRecallDecision = this.config.phoenixCore.recommendMemoryRecall({
        prompt: initialPrompt,
        configuredLimit: memorySearchLimit,
        sessionId: this.config.sessionId || undefined,
        userId: this.config.userId || undefined,
        channel: this.config.channel || undefined,
      })
      effectiveMemorySearchLimit = memoryRecallDecision.effectiveLimit
      this.config.phoenixAudit.recordMemoryRecallDecision(memoryRecallDecision)
      this.recordAudit(
        0,
        'phoenix',
        memoryRecallDecision.effectiveLimit > memorySearchLimit ? 'warn' : 'info',
        `Phoenix memory recall depth recommendation: ${memorySearchLimit} -> ${memoryRecallDecision.effectiveLimit}`,
      )
    }

    let memoryContext = ''
    if (enableMemory && this.manager) {
      try {
        memoryContext = this.manager.recallForPrompt(initialPrompt, effectiveMemorySearchLimit)
        if (memoryContext) {
          this.recordAudit(0, 'memory', 'info', 'Injected memory recall context')
        }
      } catch (error) {
        console.warn('[TAOR] Memory search failed:', error)
        this.recordAudit(0, 'memory', 'warn', `Memory search failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    let recoveredContext = ''
    if (this.sessionStore && this.config.sessionId) {
      try {
        const snapshot = await this.sessionStore.getSnapshot(this.config.sessionId)
        if (snapshot) {
          recoveredContext = `\n\n## Recovered Session State\n${snapshot.compactSummary}\n`
          this.recordAudit(0, 'recovery', 'info', 'Recovered previous session snapshot')
        }
      } catch (error) {
        console.warn('[TAOR] Session recovery failed:', error)
        this.recordAudit(0, 'recovery', 'warn', `Session recovery failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 1: 初始化 — 添加用户初始 prompt（含记忆上下文）
    const promptWithContext = memoryContext || recoveredContext
      ? `${initialPrompt}${memoryContext}${recoveredContext}`
      : initialPrompt

    this.context.pushUser(promptWithContext)
    this.state.initialPrompt = promptWithContext  // 保存含上下文的 prompt
    this.state.totalTokens.input += roughTokenEstimate(promptWithContext)
    this.recordAudit(0, 'startup', 'info', 'TAOR loop initialized')
    if (this.config.phoenixAudit) {
      if (this.config.phoenixCore) {
        const governanceDecision = this.config.phoenixCore.evaluateGovernance({
          prompt: promptWithContext,
          sessionId: this.config.sessionId || undefined,
          userId: this.config.userId || undefined,
          channel: this.config.channel || undefined,
        })
        this.config.phoenixAudit.recordGovernanceDecision(governanceDecision)
        const skillLookupDecision = this.config.phoenixCore.recommendSkillLookup({
          prompt: promptWithContext,
          availableSkillCount: this.config.skillManager?.getAllSkills().length,
          sessionId: this.config.sessionId || undefined,
          userId: this.config.userId || undefined,
          channel: this.config.channel || undefined,
        })
        if (skillLookupDecision.shouldLookup) {
          const matches = this.config.skillManager
            ? this.config.skillManager.findTriggeredSkills(skillLookupDecision.query, skillLookupDecision.maxResults)
            : []
          this.config.phoenixAudit.recordSkillLookupDecision({
            decision: skillLookupDecision,
            matches,
          })
          this.recordAudit(
            0,
            'phoenix',
            'info',
            `Phoenix skill lookup recommended "${skillLookupDecision.query}" and found ${matches.length} match(es)`,
          )
        }
      }
      this.config.phoenixAudit.recordIntentRoute({
        prompt: promptWithContext,
        sessionId: this.config.sessionId || undefined,
        userId: this.config.userId || undefined,
        channel: this.config.channel || undefined,
      })
      this.config.phoenixAudit.recordMemoryScorePlaceholder({
        sessionId: this.config.sessionId || undefined,
        userId: this.config.userId || undefined,
        memoryEnabled: Boolean(enableMemory && this.manager),
        recallInjected: Boolean(memoryContext),
      })
      this.config.phoenixAudit.recordReliabilityPlaceholder({
        sessionId: this.config.sessionId || undefined,
        userId: this.config.userId || undefined,
        maxSteps: this.config.maxSteps,
        maxToolCalls: this.config.maxToolCalls,
      })
      if (this.config.antibodyRepository) {
        for (const pattern of this.config.antibodyLookupPatterns) {
          const evaluation = this.config.antibodyRepository.evaluate({ pattern })
          this.config.phoenixAudit.recordAntibodyLookupDecision({
            pattern,
            evaluation,
            sessionId: this.config.sessionId || undefined,
            userId: this.config.userId || undefined,
          })
          this.recordAudit(
            0,
            'phoenix',
            evaluation.matchedActiveRules.length > 0 ? 'warn' : 'info',
            `Phoenix antibody lookup observed ${evaluation.matchedActiveRules.length} active rule(s) for ${pattern}`,
          )
        }
      }
      this.recordAudit(0, 'phoenix', 'info', 'Phoenix governance audit recorded observe-only decisions')
    }

    yield {
      type: 'start',
      step: 0,
      contextLength: this.context.length,
    }

    // Step 2: 进入循环
    while (true) {
      try {
      this.state.stepCount++

      // 检查终止条件
      if (this.state.stepCount > this.config.maxSteps) {
        this.state.reachedMaxSteps = true
        this.state.stopReason = 'max_steps'
        this.recordAudit(this.state.stepCount, 'budget', 'warn', 'Step budget exceeded')
        break
      }

      if (this.state.totalTokens.input > this.config.maxInputTokens) {
        this.state.stopReason = 'input_budget_exceeded'
        this.recordAudit(this.state.stepCount, 'budget', 'warn', `Input budget exceeded at ${this.state.totalTokens.input}/${this.config.maxInputTokens}`)
        break
      }

      yield {
        type: 'step_start',
        step: this.state.stepCount,
        contextLength: this.context.length,
      }

      // ===== Think =====
      // 构建消息，准备调用 LLM
      const messages = this.context.getContext()

      // 构建系统提示
      const systemContent = [
        ...(systemPrompt ? [{ type: 'text' as const, text: systemPrompt }] : []),
        {
          type: 'text' as const,
          text: `You are running in TAOR loop mode. Respond with tool calls to complete tasks.`,
        },
        {
          type: 'text' as const,
          text: `Tools available: ${tools.map(t => t.name).join(', ')}`,
        },
      ]

      // ===== Action =====
      // 调用 LLM，获取响应
      let hasFinalAnswer = false
      let finalText = ''

      try {
        const callMessages = [...(systemContent.length ? [{ role: 'system' as const, content: systemContent }] : []), ...messages]
        for await (const chunk of this.callLLMWithRetry(
          callMessages,
          tools,
          model,
          this.state.stepCount,
        )) {
          if (chunk.usage) {
            this.state.totalTokens.input += chunk.usage.input_tokens
            this.state.totalTokens.output += chunk.usage.output_tokens
          }
          if (chunk.type === 'content_block') {
            const content = chunk.content as TextContent
            if (content.type === 'text') {
              this.state.totalTokens.output += roughTokenEstimate(content.text)
              yield {
                type: 'think',
                step: this.state.stepCount,
                text: content.text,
              }
            } else if (content.type === 'tool_use') {
              // ===== Observe =====
              const toolUse = content as unknown as ToolUseContent

              yield {
                type: 'tool_call',
                step: this.state.stepCount,
                toolName: toolUse.name,
                toolInput: toolUse.input,
              }

              // 执行工具（带权限检查）
              const result = await this.executeToolCall(toolUse)
              let resolvedResult = result

              // Event 模式下，如果 executeToolCall 设置了待发出的 confirmation 事件，立即发出
              if (this._pendingConfirmationEvent) {
                yield this._pendingConfirmationEvent
                this._pendingConfirmationEvent = null
                resolvedResult = (await this.resolvePendingApproval()) ?? result
              }

              // 记录工具调用
              this.state.toolCalls.push({
                step: this.state.stepCount,
                toolName: toolUse.name,
                toolInput: toolUse.input,
                toolResult: resolvedResult,
              })

              // 将工具结果加入上下文
              this.context.pushToolResult(resolvedResult)

              yield {
                type: 'tool_result',
                step: this.state.stepCount,
                toolName: toolUse.name,
                result: resolvedResult,
              }
            }
          } else if (chunk.type === 'done') {
            hasFinalAnswer = true
            finalText = chunk.text ?? ''
            this.state.finalResponse = finalText
            this.state.stopReason = chunk.stop_reason ?? 'end_turn'
            this.state.totalTokens.output += roughTokenEstimate(finalText)
          }
        }
      } catch (error) {
        this.state.stopReason = 'llm_error'
        if (this.config.phoenixCore && this.config.phoenixAudit) {
          const fallbackDecision = this.config.phoenixCore.recommendFallbackPath({
            subsystem: 'llm',
            operationKey: 'llm.call',
            error,
            sessionId: this.config.sessionId || undefined,
            userId: this.config.userId || undefined,
            channel: this.config.channel || undefined,
          })
          this.config.phoenixAudit.recordFallbackPathDecision(fallbackDecision)
          this.recordAudit(
            this.state.stepCount,
            'phoenix',
            'warn',
            `Phoenix fallback path recommendation: ${fallbackDecision.recommendedPath}`,
          )
        }
        this.recordAudit(this.state.stepCount, 'error', 'error', `LLM execution failed: ${error instanceof Error ? error.message : String(error)}`)
        yield {
          type: 'error',
          step: this.state.stepCount,
          error: error instanceof Error ? error.message : String(error),
        }
        break
      }

      // ===== Reflect =====
      // 检查终止条件
      if (hasFinalAnswer || this.state.stopReason === 'end_turn') {
        if (this.state.totalTokens.output > this.config.maxOutputTokens) {
          this.recordAudit(this.state.stepCount, 'budget', 'warn', `Output budget exceeded at ${this.state.totalTokens.output}/${this.config.maxOutputTokens}`)
        }
        if (finalText) {
          this.context.pushAssistant({ type: 'text', text: finalText })
        }

        // ===== 保存记忆 =====
        if (enableMemory && this.manager) {
          try {
            await this.manager.addInteractionMemory({
              prompt: this.state.initialPrompt,
              response: finalText,
              toolNames: this.state.toolCalls.map(call => call.toolName),
              sessionId: this.config.sessionId || undefined,
              userId: this.config.userId || undefined,
            })
          } catch (error) {
            console.warn('[TAOR] Failed to save memory:', error)
            this.recordAudit(this.state.stepCount, 'persist', 'warn', `Memory persistence failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        if (this.sessionStore && this.config.sessionId) {
          try {
            await this.sessionStore.saveSnapshot({
              sessionId: this.config.sessionId,
              updatedAt: Date.now(),
              userId: this.config.userId || undefined,
              channel: this.config.channel || undefined,
              initialPrompt: this.state.initialPrompt,
              finalResponse: finalText,
              stopReason: this.state.stopReason,
              stepCount: this.state.stepCount,
              toolCallCount: this.state.toolCalls.length,
              compactSummary: this.sessionStore.buildCompactSummary({
                initialPrompt: this.state.initialPrompt,
                finalResponse: finalText,
                stopReason: this.state.stopReason,
                stepCount: this.state.stepCount,
                toolCallCount: this.state.toolCalls.length,
              }),
              recentMessages: this.context.getContext(),
              totalTokens: this.state.totalTokens,
              runtimeAudit: this.state.runtimeAudit,
            })
            this.recordAudit(this.state.stepCount, 'persist', 'info', 'Session snapshot persisted')
          } catch (error) {
            console.warn('[TAOR] Failed to persist session snapshot:', error)
            this.recordAudit(this.state.stepCount, 'persist', 'warn', `Session snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        break
      }

      // 检查是否达到最大步数
      if (this.state.stepCount >= this.config.maxSteps) {
        this.state.reachedMaxSteps = true
        this.state.stopReason = 'max_steps'
        this.recordAudit(this.state.stepCount, 'budget', 'warn', 'Reached max steps')
        break
      }

      yield {
        type: 'step_end',
        step: this.state.stepCount,
        contextLength: this.context.length,
      }
      } catch (error) {
        this.state.stopReason = 'runtime_error'
        this.recordAudit(this.state.stepCount, 'error', 'error', `Unhandled loop error: ${error instanceof Error ? error.message : String(error)}`)
        yield {
          type: 'error',
          step: this.state.stepCount,
          error: error instanceof Error ? error.message : String(error),
        }
        break
      }
    }

    // ===== 最终结果 =====
    const result: TAORResult = {
      finalText: this.state.finalResponse,
      steps: this.state.stepCount,
      messages: this.context.getContext(),
      reachedMaxSteps: this.state.reachedMaxSteps,
      stopReason: this.state.stopReason,
      totalTokens: this.state.totalTokens,
      runtimeAudit: [...this.state.runtimeAudit],
    }

    yield {
      type: 'done',
      step: this.state.stepCount,
      result,
    }

    return result
  }

  /** 获取工具调用记录 */
  getToolCalls(): ToolCallRecord[] {
    return [...this.state.toolCalls]
  }

  /** 获取当前步数 */
  getStepCount(): number {
    return this.state.stepCount
  }

  /** 获取记忆管理器实例 */
  getMemoryManager(): MemoryManager | null {
    return this.manager
  }

  /** 获取工具注册表实例 */
  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry
  }

  /** 获取权限门实例 */
  getPermissionGate(): PermissionGate | null {
    return this.permissionGate
  }

  /** 切换权限模式 */
  setPermissionMode(mode: PermissionMode): void {
    if (this.permissionGate) {
      this.permissionGate.setMode(mode)
    }
    if (this.toolRegistry) {
      this.toolRegistry.setMode(mode)
    }
  }

  /** 设置确认处理器 */
  setConfirmationHandler(handler: ConfirmationHandler): void {
    this.config.onConfirmationRequired = handler
  }

  getRuntimeAudit(): RuntimeAuditEntry[] {
    return [...this.state.runtimeAudit]
  }

  private async *callLLMWithRetry(
    messages: Message[],
    tools: ToolDef[],
    model: string,
    step: number,
  ): AsyncGenerator<ResponseChunk, void, unknown> {
    let attempt = 0
    let lastError: unknown = null

    // Build per-call options from TAOR config
    const chatOptions = {
      systemPrompt: this.config.systemPrompt || undefined,
      thinkingEnabled: this.config.thinkingEnabled,
      maxTokens: this.config.maxOutputTokens,
    }

    while (attempt <= this.config.llmRetryAttempts) {
      try {
        this.state.llmAttempts += 1
        this.recordAudit(step, 'llm', 'info', `LLM attempt ${attempt + 1}`)

        if (this.config.llmProvider) {
          for await (const chunk of this.config.llmProvider.streamChat(messages, tools, chatOptions)) {
            yield chunk
          }
        } else if (this.config.llmCaller) {
          for await (const chunk of this.config.llmCaller(messages, tools, model)) {
            yield chunk
          }
        } else {
          throw new Error('No LLM provider or caller configured')
        }

        return
      } catch (error) {
        lastError = error
        const canRetry = attempt < this.config.llmRetryAttempts
        this.recordAudit(step, 'llm', canRetry ? 'warn' : 'error', `LLM attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!canRetry) {
          break
        }
        const backoffMs = this.config.llmRetryBaseMs * Math.pow(2, attempt)
        await delay(backoffMs)
        attempt += 1
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private recordAudit(
    step: number,
    phase: RuntimeAuditEntry['phase'],
    status: RuntimeAuditEntry['status'],
    detail: string,
  ): void {
    this.state.runtimeAudit.push({
      step,
      phase,
      status,
      detail,
      timestamp: Date.now(),
    })

    if (this.state.runtimeAudit.length > this.config.runtimeAuditLimit) {
      this.state.runtimeAudit = this.state.runtimeAudit.slice(-this.config.runtimeAuditLimit)
    }
  }
}

// =============================================================================
// 事件类型
// =============================================================================

export type TAORStepEvent =
  | { type: 'start'; step: number; contextLength: number }
  | { type: 'step_start'; step: number; contextLength: number }
  | { type: 'think'; step: number; text: string }
  | { type: 'tool_call'; step: number; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; step: number; toolName: string; result: ToolResult }
  | { type: 'step_end'; step: number; contextLength: number }
  | { type: 'done'; step: number; result: TAORResult }
  | { type: 'error'; step: number; error: string }
  | { type: 'confirmation_needed'; step: number; requestId: string; toolName: string; toolInput: Record<string, unknown>; riskLevel: number }

function roughTokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// =============================================================================
// MiniMax LLM Caller（当环境变量 MINIMAX_API_KEY 设置时使用）
// 内部委托给 OpenAICompatProvider，避免重复构造 OpenAI client。
// =============================================================================

function createMiniMaxCaller(): LLMCaller {
  const apiKey = process.env.MINIMAX_API_KEY
  const baseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1'

  let provider: import('../llm/llmProvider.js').LlmProvider | null = null

  return async function* (
    messages: Message[],
    tools: ToolDef[],
    _model?: string
  ): AsyncGenerator<ResponseChunk, void, unknown> {
    if (!apiKey) {
      yield { type: 'done', text: 'Error: MINIMAX_API_KEY not set', stop_reason: 'error' }
      return
    }

    // Lazy-init provider on first call
    if (!provider) {
      const { createOpenAICompatProvider } = await import('../llm/openaiCompatProvider.js')
      provider = createOpenAICompatProvider({
        name: 'minimax',
        model: 'MiniMax-M2.7',
        baseURL: baseUrl,
        apiKey,
      })
    }

    // Convert TAOR internal Message[] to standard chat messages
    const chatMessages = messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content }
      }
      const c = m.content as unknown as Record<string, unknown>
      if (c.type === 'text') {
        return { role: m.role, content: (c as { text: string }).text }
      }
      if (c.type === 'tool_result') {
        const tc = c as { tool_use_id: string; content: unknown }
        return { role: 'tool' as const, content: typeof tc.content === 'string' ? tc.content : JSON.stringify(tc.content) }
      }
      if (c.type === 'tool_use') {
        const tc = c as { id: string; name: string; input: Record<string, unknown> }
        return { role: 'assistant' as const, content: JSON.stringify({ tool_use: { id: tc.id, name: tc.name, input: tc.input } }) }
      }
      return { role: m.role, content: '' }
    })

    try {
      for await (const chunk of provider.streamChat(chatMessages as unknown as Message[], tools, {})) {
        yield chunk
      }
    } catch (error) {
      console.error('[MiniMax] API error:', error)
      yield { type: 'done', text: `Error: ${error instanceof Error ? error.message : String(error)}`, stop_reason: 'error' }
    }
  }
}

// =============================================================================
// 默认 LLM 模拟器（用于测试/演示）
// =============================================================================

/**
 * 默认 LLM 模拟器
 * 当未提供 llmCaller 时使用
 * 支持简单的自然语言命令理解，用于验证循环逻辑
 */
async function* defaultLLMCaller(
  messages: Message[],
  _tools: ToolDef[],
  _model?: string
): AsyncGenerator<ResponseChunk, void, unknown> {
  const lastMsg = messages[messages.length - 1]

  // 如果上一条是 tool_result，返回工具执行结果
  if (lastMsg.role === 'user' && typeof lastMsg.content === 'object' && 'type' in lastMsg.content && lastMsg.content.type === 'tool_result') {
    const toolResult = lastMsg.content as ToolResultContent
    yield {
      type: 'done',
      text: typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content),
      stop_reason: 'end_turn',
    }
    return
  }

  if (typeof lastMsg.content === 'object' && 'text' in lastMsg.content) {
    const text = lastMsg.content.text as string

    // 检测终止指令
    if (text.includes('[FINAL_ANSWER]')) {
      yield { type: 'done', text: text.replace('[FINAL_ANSWER]', '').trim(), stop_reason: 'end_turn' }
      return
    }

    // 模拟工具调用 USE_TOOL:toolName
    if (text.startsWith('USE_TOOL:')) {
      const toolName = text.replace('USE_TOOL:', '').trim()
      yield {
        type: 'content_block',
        content: { type: 'tool_use', id: `tool_${Date.now()}`, name: toolName, input: {} } as ToolUseContent,
      }
      return
    }

    // 简单命令理解
    const lower = text.toLowerCase()

    // 读取文件: read/cat/type + 路径
    if (lower.includes('read') || lower.includes('读取') || lower.includes('cat ') || lower.includes('type ')) {
      const pathMatch = text.match(/[A-Za-z]:\\[^\s"']+|["'][^"']+["']|^([\/][^\s]+)/m)?.[0]
        || text.match(/package\.json|tsconfig\.json|README\.md/i)?.[0]
      if (pathMatch) {
        yield {
          type: 'content_block',
          content: { type: 'tool_use', id: `tool_${Date.now()}`, name: 'read_file', input: { path: pathMatch.replace(/["']/g, '') } } as ToolUseContent,
        }
        return
      }
    }

    // 列出文件: list/ls/dir/列出
    if (lower.includes('list') || lower.includes('ls ') || lower.includes('dir') || lower.includes('列出')) {
      yield {
        type: 'content_block',
        content: { type: 'tool_use', id: `tool_${Date.now()}`, name: 'execute_command', input: { command: process.platform === 'win32' ? 'dir' : 'ls' } } as ToolUseContent,
      }
      return
    }

    // HTTP 请求: fetch/http/请求 + URL
    if (lower.includes('fetch') || lower.includes('http') || lower.includes('请求') || lower.includes('获取')) {
      const urlMatch = text.match(/https?:\/\/[^\s"']+/)?.[0]
      if (urlMatch) {
        yield {
          type: 'content_block',
          content: { type: 'tool_use', id: `tool_${Date.now()}`, name: 'http_request', input: { url: urlMatch } } as ToolUseContent,
        }
        return
      }
    }

    // 写入文件: write/echo/写入 + 内容
    if (lower.includes('write') || lower.includes('写入') || lower.includes('echo ')) {
      const contentMatch = text.match(/content[=:][\s]*(["'][^"']+["']|.+$)/i)?.[1]
        || text.match(/[:：]\s*(.+)$/)?.[1]
      if (contentMatch) {
        yield {
          type: 'content_block',
          content: { type: 'tool_use', id: `tool_${Date.now()}`, name: 'write_file', input: { path: 'output.txt', content: contentMatch.replace(/["']/g, '') } } as ToolUseContent,
        }
        return
      }
    }

    // 默认：回显
    yield {
      type: 'done',
      text: `[Echo] Received: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`,
      stop_reason: 'end_turn',
    }
  }
}

// =============================================================================
// 便捷函数
// =============================================================================

/**
 * 运行 TAOR 循环的快捷方式
 * 接收 prompt 和工具执行器，返回最终结果
 */
export async function runTAOR(config: TAORConfig): Promise<TAORResult> {
  const loop = new TAORLoop(config)

  let finalResult: TAORResult | undefined

  for await (const event of loop.run()) {
    if (event.type === 'done') {
      finalResult = event.result
    }
  }

  return finalResult ?? {
    finalText: '',
    steps: 0,
    messages: [],
    reachedMaxSteps: false,
    stopReason: 'no_result',
  }
}

// =============================================================================
// 示例：如何使用
// =============================================================================

/*
// 示例用法（含权限系统）：

import { runTAOR } from './src/agent/taorLoop.js'
import { ToolRegistry } from './src/tools/toolExecutor.js'
import { PermissionGate } from './src/permissions/permissionGate.js'
import readline from 'readline'

const registry = new ToolRegistry('default')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

const question = (query: string): Promise<string> =>
  new Promise(resolve => rl.question(query, resolve))

const confirmationHandler: ConfirmationHandler = async (toolUse, toolCall, riskLevel) => {
  console.log(`\n⚠️ Tool requires confirmation:`)
  console.log(` Tool: ${toolCall.name}`)
  console.log(` Arguments: ${JSON.stringify(toolCall.params, null, 2)}`)
  console.log(` Risk score: ${riskLevel}/10`)
  const answer = await question(` Approve? (y/N): `)
  return answer.toLowerCase() === 'y'
}

const result = await runTAOR({
  initialPrompt: 'List the files in the current directory',
  tools: [
    {
      name: 'read_file',
      description: 'Read file content',
      input_schema: { path: { type: 'string' } },
    },
    {
      name: 'write_file',
      description: 'Write file content',
      input_schema: { path: { type: 'string' }, content: { type: 'string' } },
    },
    {
      name: 'execute_command',
      description: 'Execute a shell command',
      input_schema: { command: { type: 'string' } },
    },
  ],
  toolRegistry: registry,
  permissionMode: 'default',
  onConfirmationRequired: confirmationHandler,
  maxSteps: 20,
})

console.log(result.finalText)
console.log(`Completed in ${result.steps} steps`)
rl.close()
*/
