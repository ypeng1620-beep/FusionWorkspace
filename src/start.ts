/**
 * FusionWorkspace Entry Point
 * 
 * 整合所有模块的统一启动脚本：
 * - TAOR 循环核心
 * - 技能管理系统
 * - 多通道网关
 * - 记忆系统
 * 
 * 支持多种启动模式：
 * - standalone: 独立运行（stdio + websocket）
 * - server: 服务器模式（仅 websocket）
 * - agent: 集成到现有系统作为子模块
 */

import { readFileSync } from 'fs'
import { parseArgs } from 'util'
import { Gateway, WebSocketChannel, StdioChannel } from './gateway/gateway.js'
import { SkillManager, getDefaultSkillManager } from './skills/skillManager.js'
import { TAORLoop } from './agent/taorLoop.js'
import { ToolRegistry } from './tools/toolExecutor.js'
import { MemoryManager } from './memory/memoryManager.js'
import { SessionStore } from './memory/sessionStore.js'
import { PermissionWorkflowStore } from './permissions/permissionWorkflow.js'
import { ApprovalService } from './permissions/approvalService.js'
import { PermissionPolicyEngine } from './permissions/permissionPolicyEngine.js'
import { loadPermissionPolicyEngineFromFixture } from './permissions/permissionPolicyFixtures.js'
import { RuntimeMonitor, type RuntimeStatus } from './runtime/runtimeMonitor.js'
import { randomUUID } from 'crypto'
import { DefaultApprovalEventBus, ApprovalWaitManager, type ApprovalEventBus } from './protocol/approvalEventBus.js'
import { DefaultLoopController, type LoopController } from './protocol/loopController.js'
import { buildOutboundMessage, parseInboundMessage } from './protocol/messageTypes.js'
import {
  PhoenixAuditSnapshotStore,
  PhoenixAuditStore,
  type PhoenixAuditSnapshotFile,
  type PhoenixAuditSnapshotSaveInput,
} from './orchestrator/phoenixAudit.js'
import { PhoenixCore } from './orchestrator/phoenixCore.js'
import { FlameBreaker } from './reliability/flameBreaker.js'
import { AntibodyRepository } from './antibody/antibodyRepository.js'
import { AntibodyPolicy } from './antibody/antibodyPolicy.js'
import { AdapterFactory, loadAdapterConfig, type AdapterDefinition } from './gateway/adapterFactory.js'
import { validateExternalAdapterConfig } from './gateway/externalAdapterConfigValidation.js'
import { getDefaultProviderRegistry, type LlmConfig } from './llm/providerRegistry.js'
import type { LlmProvider } from './llm/llmProvider.js'
import { createMockProvider } from './llm/llmProvider.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 启动模式 */
export type StartupMode = 'standalone' | 'server' | 'agent' | 'stdio'

export type WorkspaceHealthStatus = 'ok' | 'degraded' | 'unavailable'
export type WorkspaceHealthCheckStatus = WorkspaceHealthStatus | 'disabled'

export interface WorkspaceHealthCheck {
  name: string
  status: WorkspaceHealthCheckStatus
  detail?: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceHealthReport {
  status: WorkspaceHealthStatus
  generatedAt: number
  checks: WorkspaceHealthCheck[]
}

export interface PermissionPolicyReloadResult {
  success: boolean
  fixturePath?: string
  stats?: Record<string, number>
  error?: string
}

/** 启动配置 */
export interface FusionWorkspaceConfig {
  /** 启动模式 */
  mode: StartupMode
  /** WebSocket 端口 */
  port?: number
  /** 技能目录 */
  skillsDir?: string
  /** 记忆数据库路径 */
  memoryDbPath?: string
  memoryForceFallback?: boolean
  memoryRequiredBackend?: 'any' | 'sqlite' | 'json'
  /** 工作目录 */
  cwd?: string
  /** 信任目录列表 */
  trustedDirectories?: string[]
  /** 权限模式 */
  permissionMode?: 'default' | 'plan' | 'bypass' | 'auto' | 'interactive' | 'sandbox' | 'restricted'
  /** 最大循环次数 */
  maxSteps?: number
  /** 是否启用记忆 */
  enableMemory?: boolean
  /** WebSocket 路径 */
  wsPath?: string
  /** 仪表盘静态文件路径 (可选, 如 "./dashboard") */
  dashboardPath?: string
  /** 是否启用仪表盘 (默认: true) */
  dashboardEnabled?: boolean
  /** 审批模式：promise（默认）或 event */
  approvalMode?: 'promise' | 'event'
  /** 审批请求过期时间（毫秒，默认 15 分钟） */
  pendingRequestExpiryMs?: number
  permissionPolicyFixturePath?: string
  phoenixSnapshotDir?: string
  phoenixSnapshotMaxSnapshots?: number
  phoenixRestoreSnapshotId?: string
  phoenixRestoreLatestSnapshot?: boolean
  phoenixSnapshotOnStop?: boolean
  phoenixSnapshotOnStopId?: string
  externalAdapters?: AdapterDefinition[]
  externalAdapterConfigPath?: string
  externalAdapterAutoRegister?: boolean
  startupHealthCheckOnly?: boolean
  llm?: LlmConfig
  llmProvider?: string
  llmModel?: string
  llmOptions?: Record<string, unknown>
  enableVectorSearch?: boolean
  embeddingDim?: number
}

/** 命令行参数 */
interface CLIArgs {
  config?: string
  mode?: string
  port?: number
  skills?: string
  memory?: string
  cwd?: string
  permission?: string
  maxSteps?: number
  'max-steps'?: string | number
  'memory-backend'?: string
  'external-adapter-config'?: string
  'external-adapter-auto-register'?: boolean
  'validate-config'?: boolean
  check?: boolean
  help?: boolean
}

// =============================================================================
// 帮助信息
// =============================================================================

const HELP_TEXT = `
FusionWorkspace — AI Agent Runtime

用法: npx tsx start.ts [选项]

选项:
  --mode <模式>      启动模式: standalone|server|stdio|agent (默认: standalone)
  --port <端口>      WebSocket 端口 (默认: 8080)
  --skills <路径>    技能目录 (默认: ~/.fusion_skills)
  --memory <路径>    记忆数据库路径
  --cwd <路径>       工作目录 (默认: 当前目录)
  --permission <模式> 权限模式 (默认: default)
  --max-steps <次数>  最大循环次数 (默认: 20)
  --help            显示帮助

示例:
  npx tsx start.ts --mode stdio
  npx tsx start.ts --mode server --port 9000
  npx tsx start.ts --mode standalone --permission plan

模式说明:
  standalone  - Stdio + WebSocket 双通道，适合开发调试
  server      - 仅 WebSocket，适合生产部署
  stdio       - 仅 Stdio，适合命令行工具
  agent       - 导入为模块，不启动通道
`

// =============================================================================
// 主启动器
// =============================================================================

class FusionWorkspace {
  private config: Required<FusionWorkspaceConfig>
  private gateway?: Gateway
  private skillManager?: SkillManager
  private memoryManager?: MemoryManager
  private toolRegistry?: ToolRegistry
  private taorLoop?: TAORLoop
  private sessionStore?: SessionStore
  private permissionWorkflow?: PermissionWorkflowStore
  private approvalService?: ApprovalService
  private permissionPolicyEngine?: PermissionPolicyEngine
  private permissionPolicyFixtureLoaded: boolean = false
  private runtimeMonitor?: RuntimeMonitor
  private phoenixCore?: PhoenixCore
  private phoenixAudit?: PhoenixAuditStore
  private phoenixSnapshotStore?: PhoenixAuditSnapshotStore
  private flameBreaker?: FlameBreaker
  private antibodyRepository?: AntibodyRepository
  private antibodyPolicy?: AntibodyPolicy
  private llmProvider?: LlmProvider
  private running: boolean = false
  private stopped: boolean = false
  private startPromise?: Promise<void>
  private stopPromise?: Promise<void>
  private lifecycle = {
    startAttempts: 0,
    failedStartAttempts: 0,
    lastStartError: undefined as string | undefined,
    lastStartedAt: undefined as number | undefined,
    stopAttempts: 0,
    lastStoppedAt: undefined as number | undefined,
    lastStopError: undefined as string | undefined,
    lastStateChangeAt: undefined as number | undefined,
  }
  // 审批双模支持
  private approvalEventBus?: ApprovalEventBus
  private loopController?: LoopController
  private approvalWaitManager?: ApprovalWaitManager

  constructor(config: FusionWorkspaceConfig) {
    this.config = {
      mode: config.mode ?? 'standalone',
      port: config.port ?? 8080,
      skillsDir: config.skillsDir ?? '',
      memoryDbPath: config.memoryDbPath ?? '',
      memoryForceFallback: config.memoryForceFallback ?? false,
      memoryRequiredBackend: config.memoryRequiredBackend ?? 'any',
      cwd: config.cwd ?? process.cwd(),
      trustedDirectories: config.trustedDirectories ?? [],
      permissionMode: config.permissionMode ?? 'default',
      maxSteps: config.maxSteps ?? 20,
      enableMemory: config.enableMemory ?? true,
      wsPath: config.wsPath ?? '/ws',
      dashboardPath: config.dashboardPath ?? '',
      dashboardEnabled: config.dashboardEnabled ?? true,
      approvalMode: config.approvalMode ?? 'promise',
      pendingRequestExpiryMs: config.pendingRequestExpiryMs ?? 15 * 60 * 1000,
      permissionPolicyFixturePath: config.permissionPolicyFixturePath ?? '',
      phoenixSnapshotDir: config.phoenixSnapshotDir ?? '',
      phoenixSnapshotMaxSnapshots: config.phoenixSnapshotMaxSnapshots ?? 20,
      phoenixRestoreSnapshotId: config.phoenixRestoreSnapshotId ?? '',
      phoenixRestoreLatestSnapshot: config.phoenixRestoreLatestSnapshot ?? false,
      phoenixSnapshotOnStop: config.phoenixSnapshotOnStop ?? false,
      phoenixSnapshotOnStopId: config.phoenixSnapshotOnStopId ?? '',
      externalAdapters: config.externalAdapters ?? [],
      externalAdapterConfigPath: config.externalAdapterConfigPath ?? '',
      externalAdapterAutoRegister: config.externalAdapterAutoRegister ?? false,
      startupHealthCheckOnly: config.startupHealthCheckOnly ?? false,
      enableVectorSearch: config.enableVectorSearch ?? false,
      embeddingDim: config.embeddingDim ?? 384,
      llm: config.llm ?? { providers: [] },
      llmProvider: config.llmProvider ?? 'mock',
      llmModel: config.llmModel ?? 'mock-1.0',
      llmOptions: config.llmOptions ?? {},
    }
  }

  /** 初始化所有组件 */
  async initialize(): Promise<void> {
    console.log('[FusionWorkspace] Initializing...')
    this.stopped = false
    this.runtimeMonitor = new RuntimeMonitor()
    this.phoenixCore = new PhoenixCore()
    this.phoenixAudit = new PhoenixAuditStore()
    this.phoenixSnapshotStore = new PhoenixAuditSnapshotStore({
      directory: this.config.phoenixSnapshotDir || `${this.config.cwd}/.fusion-runtime/phoenix-snapshots`,
      maxSnapshots: this.config.phoenixSnapshotMaxSnapshots,
    })
    let restoredSnapshotId = ''
    if (this.config.phoenixRestoreSnapshotId) {
      this.phoenixAudit = this.phoenixSnapshotStore.restore(this.config.phoenixRestoreSnapshotId)
      restoredSnapshotId = this.config.phoenixRestoreSnapshotId
    } else if (this.config.phoenixRestoreLatestSnapshot) {
      const restored = this.phoenixSnapshotStore.restoreLatest()
      if (restored) {
        this.phoenixAudit = restored.audit
        restoredSnapshotId = restored.snapshotId
      }
    }
    this.antibodyRepository = new AntibodyRepository()
    this.antibodyPolicy = new AntibodyPolicy({
      repository: this.antibodyRepository,
    })
    this.flameBreaker = new FlameBreaker({
      onTransition: (decision, transition) => {
        this.phoenixAudit?.recordReliabilityDecision({ decision, transition })
        if (this.antibodyPolicy) {
          const result = this.antibodyPolicy.observeReliabilityTransition({ decision, transition })
          this.phoenixAudit?.recordAntibodyPolicyResult({ result })
        }
      },
    })
    this.runtimeMonitor.recordEvent('info', 'phoenix', 'Phoenix governance audit initialized', {
      mode: 'observe_only',
      restoredSnapshotId: restoredSnapshotId || undefined,
    })
    this.runtimeMonitor.recordEvent('info', 'phoenix', 'FlameBreaker reliability monitor initialized', {
      mode: 'observe_only',
    })
    this.runtimeMonitor.recordEvent('info', 'phoenix', 'Antibody repository initialized', {
      mode: 'observe_only',
    })
    this.runtimeMonitor.recordEvent('info', 'phoenix', 'Antibody policy initialized', {
      mode: 'observe_only',
    })

    // 初始化工具注册表
    this.permissionWorkflow = new PermissionWorkflowStore({
      rootDir: `${this.config.cwd}/.fusion-runtime/permissions`,
    })
    this.approvalService = new ApprovalService(this.permissionWorkflow)
    this.permissionPolicyEngine = this.config.permissionPolicyFixturePath
      ? loadPermissionPolicyEngineFromFixture(this.config.permissionPolicyFixturePath)
      : new PermissionPolicyEngine()
    this.permissionPolicyFixtureLoaded = Boolean(this.config.permissionPolicyFixturePath)
    this.runtimeMonitor.recordEvent('info', 'permission', 'Permission policy engine initialized', {
      fixtureLoaded: this.permissionPolicyFixtureLoaded,
      stats: this.permissionPolicyEngine.getStats(),
    })

    // 初始化审批事件总线（event 模式）
    if (this.config.approvalMode === 'event') {
      this.approvalEventBus = new DefaultApprovalEventBus()
      this.loopController = new DefaultLoopController()
      this.approvalWaitManager = new ApprovalWaitManager(this.approvalEventBus)
      console.log('[FusionWorkspace] Approval event bus + loop controller initialized (event mode)')
    }

    this.toolRegistry = new ToolRegistry(this.config.permissionMode, {
      cwd: this.config.cwd,
      trustedDirectories: this.config.trustedDirectories,
    }, this.permissionWorkflow, this.permissionPolicyEngine)
    console.log('[FusionWorkspace] Tool registry initialized')

    // 初始化 LLM provider
    this.llmProvider = await this.initLlmProvider()

    // 初始化技能管理器
    this.skillManager = getDefaultSkillManager()
    if (this.config.skillsDir) {
      this.skillManager = new SkillManager({ skillsDir: this.config.skillsDir })
    }
    await this.skillManager.initialize()
    console.log(`[FusionWorkspace] Skill manager initialized (${this.skillManager.getAllSkills().length} skills)`)

    // 初始化记忆管理器（可选，失败时降级）
    if (this.config.enableMemory) {
      try {
        this.memoryManager = new MemoryManager({
          dbPath: this.config.memoryDbPath,
          enableVectorSearch: this.config.enableVectorSearch,
          embeddingDim: this.config.embeddingDim,
          forceFallback: this.config.memoryForceFallback,
          requiredBackend: this.config.memoryRequiredBackend,
          phoenixAudit: this.phoenixAudit,
        })
        console.log('[FusionWorkspace] Memory manager initialized')
      } catch (error) {
        console.warn('[FusionWorkspace] Memory manager failed to initialize, continuing without it:', (error as Error).message)
        this.memoryManager = undefined
        if (this.config.memoryRequiredBackend !== 'any') {
          throw error
        }
      }
    }

    this.sessionStore = new SessionStore({
      rootDir: `${this.config.cwd}/.fusion-runtime/sessions`,
    })

    if (this.config.externalAdapterConfigPath) {
      const loaded = await loadAdapterConfig(this.config.externalAdapterConfigPath)
      this.config.externalAdapters = [
        ...this.config.externalAdapters,
        ...loaded.adapters,
      ]
      this.runtimeMonitor.recordEvent('info', 'adapter', 'External adapter config loaded', {
        configPath: this.config.externalAdapterConfigPath,
        adapters: loaded.adapters.length,
      })
    }

    // 初始化网关
    this.gateway = new Gateway({
      onMessage: this.handleMessage.bind(this),
      onConnect: this.handleConnect.bind(this),
      onDisconnect: this.handleDisconnect.bind(this),
      onHealthCheck: async () => this.getHealthReport() as unknown as Record<string, unknown>,
    })

    // 根据模式添加通道
    if (this.config.mode === 'standalone' || this.config.mode === 'server') {
      this.gateway.addWebSocketChannel({
        type: 'websocket',
        port: this.config.port,
        wsPath: this.config.wsPath,
        dashboardPath: this.config.dashboardPath,
        dashboardEnabled: this.config.dashboardEnabled,
      })
    }

    if (this.config.mode === 'standalone' || this.config.mode === 'stdio') {
      this.gateway.addStdioChannel({
        type: 'stdio',
      })
    }

    if (this.config.externalAdapterAutoRegister && this.config.externalAdapters.length > 0) {
      await AdapterFactory.registerAll(this.gateway, this.config.externalAdapters)
    }

    console.log('[FusionWorkspace] Initialization complete')
  }

  /** 启动 */
  async start(): Promise<void> {
    if (this.stopPromise) {
      console.log('[FusionWorkspace] Waiting for stop before start')
      await this.stopPromise
    }

    if (this.startPromise) {
      console.log('[FusionWorkspace] Start already in progress')
      return this.startPromise
    }

    if (this.running) {
      console.warn('[FusionWorkspace] Already running')
      return
    }

    this.lifecycle.startAttempts++
    this.startPromise = this.startInternal()
    try {
      await this.startPromise
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const changedAt = Date.now()
      this.lifecycle.failedStartAttempts++
      this.lifecycle.lastStartError = message
      this.lifecycle.lastStateChangeAt = changedAt
      this.running = false
      this.closeMemoryManagerAfterFailedStart()
      this.runtimeMonitor?.markDegraded('Workspace start failed', {
        error: message,
      })
      throw error
    } finally {
      this.startPromise = undefined
    }
  }

  private async startInternal(): Promise<void> {
    await this.initialize()

    if (this.gateway) {
      await this.gateway.start()
    }

    this.running = true
    const changedAt = Date.now()
    this.lifecycle.lastStartedAt = changedAt
    this.lifecycle.lastStateChangeAt = changedAt
    this.runtimeMonitor?.markRunning()
    console.log(`[FusionWorkspace] Started in ${this.config.mode} mode`)

    // 如果是 stdio 模式，保持运行
    if (this.config.mode === 'stdio' || this.config.mode === 'standalone') {
      console.log('[FusionWorkspace] Ready. Type your message and press Enter...')
    }
  }

  /** 停止 */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      console.log('[FusionWorkspace] Stop already in progress')
      return this.stopPromise
    }

    this.stopPromise = this.stopInternal()
    try {
      await this.stopPromise
    } finally {
      this.stopPromise = undefined
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise) {
      console.log('[FusionWorkspace] Waiting for start before stop')
      try {
        await this.startPromise
      } catch (error) {
        console.warn('[FusionWorkspace] Startup failed while waiting to stop:', error)
      }
    }

    if (this.stopped) {
      console.log('[FusionWorkspace] Already stopped')
      return
    }

    console.log('[FusionWorkspace] Stopping...')
    this.lifecycle.lastStopError = undefined

    if (this.config.phoenixSnapshotOnStop) {
      this.savePhoenixAuditSnapshotBeforeStop()
    }

    if (this.gateway) {
      await this.gateway.stop()
    }

    try {
      this.memoryManager?.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lifecycle.lastStopError = message
      this.runtimeMonitor?.recordEvent('error', 'memory', 'Memory manager close failed', {
        error: message,
      })
    } finally {
      this.memoryManager = undefined
    }

    this.running = false
    this.stopped = true
    const changedAt = Date.now()
    this.lifecycle.stopAttempts++
    this.lifecycle.lastStoppedAt = changedAt
    this.lifecycle.lastStateChangeAt = changedAt
    this.runtimeMonitor?.markStopped()
    console.log('[FusionWorkspace] Stopped')
  }

  private closeMemoryManagerAfterFailedStart(): void {
    try {
      this.memoryManager?.close()
      this.memoryManager = undefined
    } catch (error) {
      this.runtimeMonitor?.recordEvent('error', 'memory', 'Memory manager close failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async initLlmProvider(): Promise<LlmProvider> {
    // 1) Config file takes priority
    if (this.config.llm) {
      const providerModule = await import('./llm/providerRegistry.js')
      const registry = await providerModule.loadProvidersFromConfig(this.config.llm!)
      const provider = registry.getDefault()
      console.log(`[FusionWorkspace] LLM provider from config: ${provider.name}/${provider.model}`)
      return provider
    }

    // 2) Explicit provider string (e.g. 'claude', 'openai-compat', 'mock')
    if (this.config.llmProvider === 'claude') {
      const { createClaudeProvider } = await import('./llm/claudeProvider.js')
      const provider = createClaudeProvider({
        model: this.config.llmModel ?? undefined,
        ...(this.config.llmOptions as Record<string, unknown>),
      } as Parameters<typeof createClaudeProvider>[0])
      console.log(`[FusionWorkspace] LLM provider: claude/${provider.model}`)
      return provider
    }

    if (this.config.llmProvider === 'openai-compat') {
      const { createOpenAICompatProvider } = await import('./llm/openaiCompatProvider.js')
      const provider = createOpenAICompatProvider({
        name: 'default',
        model: this.config.llmModel ?? 'gpt-4o',
        ...(this.config.llmOptions as Record<string, unknown>),
      } as Parameters<typeof createOpenAICompatProvider>[0])
      console.log(`[FusionWorkspace] LLM provider: openai-compat/${provider.model}`)
      return provider
    }

    // 3) Mock provider (explicit fallback for development)
    if (this.config.llmProvider === 'mock') {
      const provider = createMockProvider({ name: 'mock', model: this.config.llmModel ?? 'mock-1.0' })
      console.log('[FusionWorkspace] LLM provider: mock')
      return provider
    }

    // 4) Auto-detect from environment
    if (process.env.ANTHROPIC_API_KEY) {
      const { createClaudeProvider } = await import('./llm/claudeProvider.js')
      const provider = createClaudeProvider()
      console.log(`[FusionWorkspace] LLM provider (auto): claude/${provider.model}`)
      return provider
    }

    // 5) Fallback to mock
    const provider = createMockProvider({ name: 'fallback-mock' })
    console.log('[FusionWorkspace] LLM provider: fallback-mock (no real provider configured)')
    return provider
  }

  private savePhoenixAuditSnapshotBeforeStop(): void {
    try {
      this.savePhoenixAuditSnapshot({
        snapshotId: this.config.phoenixSnapshotOnStopId || `stop-${Date.now()}`,
        reason: 'workspace_stop',
      })
    } catch (error) {
      this.runtimeMonitor?.recordEvent('error', 'phoenix', 'Phoenix audit stop snapshot failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 处理消息 */
  private async handleMessage(message: any, session: any): Promise<void> {
    console.log(`[Message] ${session.channel}: ${message.content?.substring(0, 100)}...`)
    const turnStartedAt = Date.now()
    this.runtimeMonitor?.recordEvent('info', 'session', 'Incoming message received', {
      sessionId: session.id,
      channel: session.channel,
    })

    const approvalHandled = await this.tryHandleApprovalMessage(message, session)
    if (approvalHandled) {
      return
    }

    try {
      // 解析入站消息（优先结构化 payload，fallback content 字符串）
      const parsed = parseInboundMessage(
        message.content,
        message.type,
        message.payload,
      )

      // 创建 TAOR 循环实例
      const loop = new TAORLoop({
        initialPrompt: parsed.data.text ?? message.content,
        tools: this.toolRegistry!.listTools().map(name => {
          const tool = this.toolRegistry!.get(name)
          return {
            name,
            description: tool?.description ?? '',
            parameters: tool?.parameters ?? { type: 'object', properties: {} },
          }
        }),
        toolRegistry: this.toolRegistry,
        memoryManager: this.memoryManager ?? undefined,
        llmProvider: this.llmProvider,
        permissionMode: this.config.permissionMode,
        maxSteps: this.config.maxSteps,
        cwd: this.config.cwd,
        trustedDirectories: this.config.trustedDirectories,
        sessionId: session.id,
        userId: message.userId,
        channel: session.channel,
        sessionStore: this.sessionStore,
        // 审批双模配置
        approvalMode: this.config.approvalMode ?? 'promise',
        approvalEventBus: this.approvalEventBus,
        loopController: this.loopController,
        phoenixCore: this.phoenixCore,
        phoenixAudit: this.phoenixAudit,
        antibodyRepository: this.antibodyRepository,
        skillManager: this.skillManager,
        onConfirmationRequired: async (_toolUse: any, toolCall: any, riskLevel: number, requestId?: string) => {
          if (!requestId || !this.approvalService) {
            this.runtimeMonitor?.recordEvent('warn', 'permission', 'Approval request missing requestId; defaulting to deny', {
              sessionId: session.id,
              toolName: toolCall.name,
            })
            return false
          }

          // 交互模式：发送确认请求到客户端
          if (this.gateway) {
            const { type, payload, content } = buildOutboundMessage('confirmation_required', {
              requestId,
              toolName: toolCall.name,
              params: toolCall.params,
              riskLevel,
              message: `Confirm execution of ${toolCall.name}?`,
            })
            await this.gateway.sendToSession(session.id, {
              id: randomUUID(),
              type,
              role: 'system',
              content,
              payload,
              timestamp: Date.now(),
              channel: session.channel,
              sessionId: session.id,
            })
          }
          this.runtimeMonitor?.recordEvent('info', 'permission', 'Approval requested', {
            requestId,
            sessionId: session.id,
            toolName: toolCall.name,
            riskLevel,
          })
          return this.approvalService.waitForDecision(requestId)
        },
      })

      // 运行 TAOR 循环
      let response = ''
      for await (const event of loop.run()) {
        if (event.type === 'done') {
          response = event.result.finalText
          this.runtimeMonitor?.recordTurn({
            sessionId: session.id,
            channel: session.channel,
            userId: message.userId,
            startedAt: turnStartedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - turnStartedAt,
            stopReason: event.result.stopReason,
            stepCount: event.result.steps,
            toolCallCount: loop.getToolCalls().length,
            totalTokens: event.result.totalTokens,
          })
          this.runtimeMonitor?.recordEvent('info', 'taor', 'TAOR turn completed', {
            sessionId: session.id,
            stopReason: event.result.stopReason ?? 'unknown',
            steps: event.result.steps,
          })
        } else if (event.type === 'confirmation_needed') {
          // Event 模式：审批请求已通过 TAOR 内部 emit，此处记录
          this.runtimeMonitor?.recordEvent('info', 'permission', 'Confirmation needed (event mode)', {
            sessionId: session.id,
            requestId: event.requestId,
            toolName: event.toolName,
            riskLevel: event.riskLevel,
          })
        } else if (event.type === 'tool_result') {
          // 工具执行结果：直接输出内容（不加额外格式）
          const result = event.result
          if (result.is_error) {
            console.error(`⚠️ ${result.content}`)
          } else if (result.content) {
            console.log(result.content)
          }
        } else if (event.type === 'tool_call') {
          // 工具调用：静默处理，不打扰用户
          // 如果需要调试，可以取消注释下一行
          // console.log(`[Calling ${event.toolName}...]`)
        }
      }

      // 发送最终回复
      if (response && this.gateway) {
        const { type, payload, content } = buildOutboundMessage('assistant_response', {
          text: response,
          steps: loop.getToolCalls().length,
          stopReason: 'done',
        })
        await this.gateway.sendToSession(session.id, {
          id: randomUUID(),
          type,
          role: 'assistant',
          content,
          payload,
          timestamp: Date.now(),
          channel: session.channel,
          sessionId: session.id,
        })
      }
    } catch (error) {
      console.error('[Error] Message handling failed:', error)
      this.runtimeMonitor?.markDegraded('Message handling failed', {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      })

      if (this.gateway) {
        const { type, payload, content } = buildOutboundMessage('error', {
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
          suggestion: 'Please try again or rephrase your request.',
        })
        await this.gateway.sendToSession(session.id, {
          id: randomUUID(),
          type,
          role: 'system',
          content,
          payload,
          timestamp: Date.now(),
          channel: session.channel,
          sessionId: session.id,
        })
      }
    }
  }

  /** 处理连接 */
  private async handleConnect(session: any): Promise<void> {
    console.log(`[Connect] Session ${session.id} connected via ${session.channel}`)
    this.runtimeMonitor?.sessionConnected(session.id, session.channel)

    if (this.gateway) {
      const { type, payload, content } = buildOutboundMessage('welcome', {
        sessionId: session.id,
        skills: this.skillManager?.getSkillList().map(s => s.name) ?? [],
        version: '1.0.0',
      })
      await this.gateway.sendToSession(session.id, {
        id: randomUUID(),
        type,
        role: 'system',
        content,
        payload,
        timestamp: Date.now(),
        channel: session.channel,
        sessionId: session.id,
      })
    }
  }

  /** 处理断开 */
  private async handleDisconnect(session: any, reason: string): Promise<void> {
    console.log(`[Disconnect] Session ${session.id} disconnected: ${reason}`)
    this.runtimeMonitor?.sessionDisconnected(session.id, reason)
  }

  private async tryHandleApprovalMessage(message: any, session: any): Promise<boolean> {
    // 优先从结构化 payload 解析，fallback 从 content 字符串解析
    const payload = message.type === 'approval_response' && message.payload
      ? { requestId: message.payload.requestId as string, approved: message.payload.approved as boolean }
      : this.parseApprovalPayload(message.content)

    if (!payload || !this.approvalService) {
      return false
    }

    const resolved = this.approvalService.resolve(payload.requestId, payload.approved)
    if (this.config.approvalMode === 'event') {
      this.loopController?.resume(payload.requestId, payload.approved)
      this.approvalEventBus?.emitApprovalResolved({
        requestId: payload.requestId,
        approved: payload.approved,
        sessionId: session.id,
        userId: session.metadata?.externalId as string | undefined,
        timestamp: Date.now(),
      })
    }
    this.runtimeMonitor?.recordEvent(
      resolved ? 'info' : 'warn',
      'permission',
      resolved ? 'Approval response processed' : 'Approval response could not be matched',
      {
        requestId: payload.requestId,
        approved: payload.approved,
        sessionId: session.id,
      },
    )

    if (this.gateway) {
      const { type, payload: ackPayload, content } = buildOutboundMessage('approval_ack', {
        requestId: payload.requestId,
        approved: payload.approved,
        resolved,
      })
      await this.gateway.sendToSession(session.id, {
        id: randomUUID(),
        type,
        role: 'system',
        content,
        payload: ackPayload,
        timestamp: Date.now(),
        channel: session.channel,
        sessionId: session.id,
      })
    }

    return true
  }

  private parseApprovalPayload(content: string): { requestId: string; approved: boolean } | null {
    try {
      const parsed = JSON.parse(content) as { type?: string; requestId?: string; approved?: boolean }
      if (parsed.type === 'approval_response' && parsed.requestId && typeof parsed.approved === 'boolean') {
        return { requestId: parsed.requestId, approved: parsed.approved }
      }
    } catch {
      // ignore JSON parse failures and try text formats
    }

    const approveMatch = content.match(/^(approve|reject)\s+([a-z0-9-]+)$/i)
    if (approveMatch) {
      return {
        requestId: approveMatch[2],
        approved: approveMatch[1].toLowerCase() === 'approve',
      }
    }

    return null
  }

  /** 获取网关实例（用于 agent 模式集成） */
  getGateway(): Gateway | undefined {
    return this.gateway
  }

  /** 获取技能管理器 */
  getSkillManager(): SkillManager | undefined {
    return this.skillManager
  }

  /** 获取记忆管理器 */
  getMemoryManager(): MemoryManager | undefined {
    return this.memoryManager
  }

  /** 获取工具注册表 */
  getToolRegistry(): ToolRegistry | undefined {
    return this.toolRegistry
  }

  getPermissionPolicyEngine(): PermissionPolicyEngine {
    if (!this.permissionPolicyEngine) {
      this.permissionPolicyEngine = new PermissionPolicyEngine()
    }
    return this.permissionPolicyEngine
  }

  reloadPermissionPolicyFixture(path: string = this.config.permissionPolicyFixturePath): PermissionPolicyReloadResult {
    if (!path) {
      return {
        success: false,
        error: 'No permission policy fixture path configured',
      }
    }

    try {
      const nextEngine = loadPermissionPolicyEngineFromFixture(path)
      this.permissionPolicyEngine = nextEngine
      this.permissionPolicyFixtureLoaded = true
      this.toolRegistry?.setPermissionPolicyEngine(nextEngine)
      const stats = nextEngine.getStats()
      this.runtimeMonitor?.recordEvent('info', 'permission', 'Permission policy fixture reloaded', {
        fixturePath: path,
        stats,
      })
      return {
        success: true,
        fixturePath: path,
        stats,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runtimeMonitor?.recordEvent('error', 'permission', 'Permission policy fixture reload failed', {
        fixturePath: path,
        error: message,
      })
      return {
        success: false,
        fixturePath: path,
        error: message,
      }
    }
  }

  getRuntimeStatus(): RuntimeStatus {
    return this.runtimeMonitor?.getStatus({
      gateway: this.gateway,
      memoryManager: this.memoryManager,
      skillManager: this.skillManager,
      permissionWorkflow: this.permissionWorkflow,
      permissionPolicyEngine: this.permissionPolicyEngine,
      permissionPolicyFixtureLoaded: this.permissionPolicyFixtureLoaded,
      toolRegistry: this.toolRegistry,
      phoenixAudit: this.phoenixAudit,
      phoenixSnapshotStore: this.phoenixSnapshotStore,
      flameBreaker: this.flameBreaker,
      antibodyRepository: this.antibodyRepository,
      lifecycle: { ...this.lifecycle },
    }) ?? {
      status: this.running ? 'running' : 'stopped',
      uptimeMs: 0,
      startedAt: Date.now(),
      lifecycle: { ...this.lifecycle },
      activeSessions: 0,
      totalTurns: 0,
      recentTurns: [],
      recentEvents: [],
      subsystems: {
        gateway: { status: 'unavailable' },
        memory: { status: 'unavailable' },
        skills: { status: 'unavailable' },
        permissions: { status: 'unavailable' },
        tools: { status: 'unavailable' },
        phoenix: { status: 'unavailable' },
        adapters: { status: 'unavailable' },
      },
    }
  }

  /** 创建 TAOR 循环 */
  getHealthReport(): WorkspaceHealthReport {
    const checks: WorkspaceHealthCheck[] = [
      this.buildRuntimeHealthCheck(),
      this.toolRegistry
        ? { name: 'tools', status: 'ok', metadata: { totalTools: this.toolRegistry.listTools().length } }
        : { name: 'tools', status: 'unavailable', detail: 'Tool registry is not initialized' },
      this.permissionWorkflow && this.permissionPolicyEngine
        ? { name: 'permissions', status: 'ok', metadata: { policyEngine: this.permissionPolicyEngine.getStats() } }
        : { name: 'permissions', status: 'unavailable', detail: 'Permission workflow or policy engine is not initialized' },
      this.config.enableMemory
        ? this.memoryManager
          ? {
              name: 'memory',
              status: this.config.memoryRequiredBackend === 'sqlite' && this.memoryManager.getBackend() !== 'sqlite' ? 'degraded' : 'ok',
              detail: this.config.memoryRequiredBackend === 'sqlite' && this.memoryManager.getBackend() !== 'sqlite' ? 'Memory is using JSON fallback instead of required sqlite backend' : undefined,
              metadata: {
                backend: this.memoryManager.getBackend(),
                requiredBackend: this.config.memoryRequiredBackend,
                totalMemories: this.memoryManager.getTotalMemoryCount(),
              },
            }
          : { name: 'memory', status: 'unavailable', detail: 'Memory is enabled but not initialized' }
        : { name: 'memory', status: 'disabled', detail: 'Memory is disabled by configuration' },
      this.skillManager
        ? { name: 'skills', status: 'ok', metadata: { totalSkills: this.skillManager.getAllSkills().length } }
        : { name: 'skills', status: 'unavailable', detail: 'Skill manager is not initialized' },
      this.phoenixAudit && this.phoenixCore
        ? { name: 'phoenix', status: 'ok', metadata: { mode: 'advisory_only' } }
        : { name: 'phoenix', status: 'unavailable', detail: 'Phoenix governance is not initialized' },
      this.buildLlmHealthCheck(),
      this.buildGatewayHealthCheck(),
      this.buildExternalAdapterReadinessHealthCheck(),
      this.buildExternalIngressHealthCheck(),
    ]

    const status = checks.some(check => check.status === 'unavailable')
      ? 'unavailable'
      : checks.some(check => check.status === 'degraded')
        ? 'degraded'
        : 'ok'

    return {
      status,
      generatedAt: Date.now(),
      checks,
    }
  }

  private buildRuntimeHealthCheck(): WorkspaceHealthCheck {
    const status = this.getRuntimeStatus()
    const degradedEvent = status.recentEvents.find(event => event.source === 'runtime' && event.level === 'warn')
    const runtimeStatus = status.status === 'degraded'
      ? 'degraded'
      : status.status === 'running' || status.status === 'stopped' || status.status === 'starting'
        ? 'ok'
        : 'unavailable'

    return {
      name: 'runtime',
      status: runtimeStatus,
      detail: degradedEvent?.message,
      metadata: {
        status: status.status,
        uptimeMs: status.uptimeMs,
        activeSessions: status.activeSessions,
        lifecycle: status.lifecycle,
        error: degradedEvent?.metadata?.error,
      },
    }
  }

  private buildLlmHealthCheck(): WorkspaceHealthCheck {
    if (!this.llmProvider) {
      return { name: 'llm', status: 'unavailable', detail: 'LLM provider is not initialized' }
    }

    const caps = this.llmProvider.getCapabilities()
    const isMock = this.llmProvider.name === 'mock' || this.llmProvider.name === 'fallback-mock'
    return {
      name: 'llm',
      status: 'ok',
      detail: isMock ? 'Using mock LLM provider' : undefined,
      metadata: {
        provider: this.llmProvider.name,
        model: caps.model,
        contextWindow: caps.contextWindow,
        maxOutputTokens: caps.maxOutputTokens,
        streaming: caps.supportsStreaming,
        features: caps.supportedFeatures,
      },
    }
  }

  private buildGatewayHealthCheck(): WorkspaceHealthCheck {
    if (!this.gateway) {
      return { name: 'gateway', status: 'unavailable', detail: 'Gateway is not initialized' }
    }

    const stats = this.gateway.getStats()
    const errors = typeof stats.errors === 'number' ? stats.errors : 0
    const hasCleanupError = typeof stats.lastCleanupError === 'string' && stats.lastCleanupError.length > 0
    const gatewayRunning = stats.running === true
    const stoppedWhileWorkspaceRunning = this.running && !gatewayRunning

    return {
      name: 'gateway',
      status: errors > 0 || stoppedWhileWorkspaceRunning ? 'degraded' : 'ok',
      detail: stoppedWhileWorkspaceRunning
        ? 'Workspace is running but gateway is stopped'
        : hasCleanupError
          ? 'Gateway has recorded channel cleanup errors'
          : errors > 0
          ? 'Gateway has recorded channel errors'
          : undefined,
      metadata: stats as unknown as Record<string, unknown>,
    }
  }

  private buildExternalAdapterReadinessHealthCheck(): WorkspaceHealthCheck {
    const diagnostics = this.config.externalAdapters.map(adapter => {
      const required = adapter.requireProductionReady === true
      return {
        instanceId: String((adapter as { instanceId?: string }).instanceId ?? adapter.type),
        type: adapter.type,
        required,
        validation: validateExternalAdapterConfig(adapter, { strict: required }),
      }
    })

    if (diagnostics.length === 0) {
      return {
        name: 'external_adapter_readiness',
        status: 'disabled',
        detail: 'No external adapter definitions are configured',
        metadata: {
          configPath: this.config.externalAdapterConfigPath || undefined,
          diagnostics: [],
          totalAdapters: 0,
        },
      }
    }

    const unavailable = diagnostics.filter(item => item.validation.status === 'unavailable').length
    const degraded = diagnostics.filter(item => item.validation.status === 'degraded').length
    const status: WorkspaceHealthCheckStatus = unavailable > 0
      ? 'unavailable'
      : degraded > 0
        ? 'degraded'
        : 'ok'

    return {
      name: 'external_adapter_readiness',
      status,
      detail: unavailable > 0
        ? 'One or more required external adapters are not production-ready'
        : degraded > 0
          ? 'One or more external adapters have readiness warnings'
          : undefined,
      metadata: {
        configPath: this.config.externalAdapterConfigPath || undefined,
        totalAdapters: diagnostics.length,
        unavailable,
        degraded,
        diagnostics,
      },
    }
  }

  private buildExternalIngressHealthCheck(): WorkspaceHealthCheck {
    const channelStats = this.gateway?.getChannelStats() ?? {}
    const externalChannels: Record<string, Record<string, unknown>> = {}
    let totalRejected = 0

    for (const [channelId, stats] of Object.entries(channelStats)) {
      const entry = stats as Record<string, unknown>
      if (!entry.ingressGuard && !entry.ingressRejections && !entry.recentIngressAudits) {
        continue
      }
      externalChannels[channelId] = entry
      const rejections = entry.ingressRejections as Record<string, number> | undefined
      if (rejections) {
        totalRejected += Object.values(rejections).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
      }
    }

    const channelCount = Object.keys(externalChannels).length
    if (channelCount === 0) {
      return {
        name: 'external_ingress',
        status: 'disabled',
        detail: 'No guarded external ingress channels are registered',
        metadata: {
          channels: {},
          totalRejected: 0,
        },
      }
    }

    return {
      name: 'external_ingress',
      status: totalRejected > 0 ? 'degraded' : 'ok',
      detail: totalRejected > 0 ? 'External ingress has rejected messages' : undefined,
      metadata: {
        channelCount,
        totalRejected,
        channels: externalChannels,
      },
    }
  }

  createLoop(config: any): TAORLoop {
    return new TAORLoop({
      ...config,
      toolRegistry: this.toolRegistry,
      memoryManager: this.memoryManager ?? config.memoryManager,
      permissionMode: config.permissionMode ?? this.config.permissionMode,
      phoenixCore: this.phoenixCore ?? config.phoenixCore,
      phoenixAudit: this.phoenixAudit ?? config.phoenixAudit,
      antibodyRepository: this.antibodyRepository ?? config.antibodyRepository,
      skillManager: this.skillManager ?? config.skillManager,
    })
  }

  savePhoenixAuditSnapshot(input: PhoenixAuditSnapshotSaveInput): PhoenixAuditSnapshotFile {
    if (!this.phoenixAudit) {
      this.phoenixAudit = new PhoenixAuditStore()
    }
    if (!this.phoenixSnapshotStore) {
      this.phoenixSnapshotStore = new PhoenixAuditSnapshotStore({
        directory: this.config.phoenixSnapshotDir || `${this.config.cwd}/.fusion-runtime/phoenix-snapshots`,
        maxSnapshots: this.config.phoenixSnapshotMaxSnapshots,
      })
    }
    const saved = this.phoenixSnapshotStore.save(this.phoenixAudit, input)
    this.runtimeMonitor?.recordEvent('info', 'phoenix', 'Phoenix audit snapshot saved', {
      snapshotId: saved.snapshot.snapshotId,
      reason: saved.snapshot.reason,
      entries: saved.snapshot.entries.length,
      path: saved.path,
    })
    return saved
  }

  getFlameBreaker(): FlameBreaker {
    if (!this.flameBreaker) {
      if (!this.antibodyRepository) {
        this.antibodyRepository = new AntibodyRepository()
      }
      if (!this.antibodyPolicy) {
        this.antibodyPolicy = new AntibodyPolicy({
          repository: this.antibodyRepository,
        })
      }
      this.flameBreaker = new FlameBreaker({
        onTransition: (decision, transition) => {
          this.phoenixAudit?.recordReliabilityDecision({ decision, transition })
          if (this.antibodyPolicy) {
            const result = this.antibodyPolicy.observeReliabilityTransition({ decision, transition })
            this.phoenixAudit?.recordAntibodyPolicyResult({ result })
          }
        },
      })
    }
    return this.flameBreaker
  }

  getAntibodyRepository(): AntibodyRepository {
    if (!this.antibodyRepository) {
      this.antibodyRepository = new AntibodyRepository()
    }
    if (!this.antibodyPolicy) {
      this.antibodyPolicy = new AntibodyPolicy({
        repository: this.antibodyRepository,
      })
    }
    return this.antibodyRepository
  }
}

// =============================================================================
// 便捷启动函数
// =============================================================================

/** 快速启动 */
export async function start(config: Partial<FusionWorkspaceConfig> = {}): Promise<FusionWorkspace> {
  const workspace = new FusionWorkspace({
    mode: config.mode ?? 'standalone',
    ...config,
  })

  await workspace.start()
  return workspace
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeMemoryBackend(
  backend: unknown,
): Pick<FusionWorkspaceConfig, 'memoryForceFallback' | 'memoryRequiredBackend'> {
  if (backend === 'json') {
    return {
      memoryForceFallback: true,
      memoryRequiredBackend: 'json',
    }
  }
  if (backend === 'sqlite') {
    return {
      memoryForceFallback: false,
      memoryRequiredBackend: 'sqlite',
    }
  }
  if (backend !== undefined && backend !== 'any') {
    throw new Error(`Invalid runtime config memoryBackend: ${String(backend)}`)
  }
  return {
    memoryForceFallback: false,
    memoryRequiredBackend: 'any',
  }
}

function normalizeStartupMode(value: unknown, path: string): StartupMode {
  if (value === undefined) {
    return 'standalone'
  }
  if (value === 'standalone' || value === 'server' || value === 'agent' || value === 'stdio') {
    return value
  }
  throw new Error(`Invalid runtime config mode: ${String(value)} in ${path}`)
}

function normalizePermissionMode(value: unknown, path: string): FusionWorkspaceConfig['permissionMode'] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    value === 'default' ||
    value === 'plan' ||
    value === 'bypass' ||
    value === 'auto' ||
    value === 'interactive' ||
    value === 'sandbox' ||
    value === 'restricted'
  ) {
    return value
  }
  throw new Error(`Invalid runtime config permissionMode: ${String(value)} in ${path}`)
}

export function loadFusionWorkspaceConfigFile(path: string): FusionWorkspaceConfig {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed)) {
    throw new Error(`Runtime config must be a JSON object: ${path}`)
  }

  const config: FusionWorkspaceConfig = {
    mode: normalizeStartupMode(parsed.mode, path),
  }

  if (parsed.port !== undefined) config.port = Number(parsed.port)
  if (typeof parsed.skillsDir === 'string') config.skillsDir = parsed.skillsDir
  if (typeof parsed.memoryDbPath === 'string') config.memoryDbPath = parsed.memoryDbPath
  if (typeof parsed.cwd === 'string') config.cwd = parsed.cwd
  config.permissionMode = normalizePermissionMode(parsed.permissionMode, path)
  if (parsed.maxSteps !== undefined) config.maxSteps = Number(parsed.maxSteps)
  if (typeof parsed.enableMemory === 'boolean') config.enableMemory = parsed.enableMemory
  if (typeof parsed.wsPath === 'string') config.wsPath = parsed.wsPath
  if (typeof parsed.approvalMode === 'string') config.approvalMode = parsed.approvalMode as FusionWorkspaceConfig['approvalMode']
  if (parsed.pendingRequestExpiryMs !== undefined) config.pendingRequestExpiryMs = Number(parsed.pendingRequestExpiryMs)
  if (typeof parsed.permissionPolicyFixturePath === 'string') config.permissionPolicyFixturePath = parsed.permissionPolicyFixturePath
  if (typeof parsed.phoenixSnapshotDir === 'string') config.phoenixSnapshotDir = parsed.phoenixSnapshotDir
  if (parsed.phoenixSnapshotMaxSnapshots !== undefined) config.phoenixSnapshotMaxSnapshots = Number(parsed.phoenixSnapshotMaxSnapshots)
  if (typeof parsed.phoenixRestoreSnapshotId === 'string') config.phoenixRestoreSnapshotId = parsed.phoenixRestoreSnapshotId
  if (typeof parsed.phoenixRestoreLatestSnapshot === 'boolean') config.phoenixRestoreLatestSnapshot = parsed.phoenixRestoreLatestSnapshot
  if (typeof parsed.phoenixSnapshotOnStop === 'boolean') config.phoenixSnapshotOnStop = parsed.phoenixSnapshotOnStop
  if (typeof parsed.phoenixSnapshotOnStopId === 'string') config.phoenixSnapshotOnStopId = parsed.phoenixSnapshotOnStopId
  if (typeof parsed.externalAdapterConfigPath === 'string') config.externalAdapterConfigPath = parsed.externalAdapterConfigPath
  if (typeof parsed.externalAdapterAutoRegister === 'boolean') config.externalAdapterAutoRegister = parsed.externalAdapterAutoRegister
  if (typeof parsed.startupHealthCheckOnly === 'boolean') config.startupHealthCheckOnly = parsed.startupHealthCheckOnly
  if (typeof parsed.llmProvider === 'string') config.llmProvider = parsed.llmProvider
  if (typeof parsed.llmModel === 'string') config.llmModel = parsed.llmModel
  if (isRecord(parsed.llm)) config.llm = parsed.llm as unknown as LlmConfig
  if (isRecord(parsed.llmOptions)) config.llmOptions = parsed.llmOptions as Record<string, unknown>
  if (typeof parsed.enableVectorSearch === 'boolean') config.enableVectorSearch = parsed.enableVectorSearch
  if (parsed.embeddingDim !== undefined) config.embeddingDim = Number(parsed.embeddingDim)

  const memoryBackend = parsed.memoryBackend ?? parsed.memoryRequiredBackend
  if (memoryBackend !== undefined) {
    Object.assign(config, normalizeMemoryBackend(memoryBackend))
  } else {
    if (typeof parsed.memoryForceFallback === 'boolean') config.memoryForceFallback = parsed.memoryForceFallback
    if (parsed.memoryRequiredBackend === 'any' || parsed.memoryRequiredBackend === 'sqlite' || parsed.memoryRequiredBackend === 'json') {
      config.memoryRequiredBackend = parsed.memoryRequiredBackend
    }
  }

  return config
}

export function buildFusionWorkspaceConfigFromCliArgs(args: CLIArgs): FusionWorkspaceConfig {
  const base: Partial<FusionWorkspaceConfig> = args.config ? loadFusionWorkspaceConfigFile(args.config) : {}
  const cliMemoryBackend = normalizeMemoryBackend(args['memory-backend'])
  const mode = args.mode !== undefined
    ? (args.mode as StartupMode)
    : base.mode ?? 'standalone'
  const maxSteps = args.maxSteps ?? args['max-steps']
  const permissionMode = args.permission !== undefined
    ? args.permission as FusionWorkspaceConfig['permissionMode']
    : base.permissionMode ?? (mode === 'stdio' ? 'bypass' : 'default')

  return {
    ...base,
    mode,
    port: args.port !== undefined ? Number(args.port) : base.port,
    skillsDir: args.skills !== undefined ? args.skills : base.skillsDir ?? '',
    memoryDbPath: args.memory !== undefined ? args.memory : base.memoryDbPath ?? '',
    cwd: args.cwd !== undefined ? args.cwd : base.cwd ?? process.cwd(),
    permissionMode,
    maxSteps: maxSteps !== undefined ? Number(maxSteps) : base.maxSteps,
    memoryForceFallback: args['memory-backend'] !== undefined ? cliMemoryBackend.memoryForceFallback : base.memoryForceFallback ?? false,
    memoryRequiredBackend: args['memory-backend'] !== undefined ? cliMemoryBackend.memoryRequiredBackend : base.memoryRequiredBackend ?? 'any',
    externalAdapterConfigPath: args['external-adapter-config'] !== undefined ? args['external-adapter-config'] : base.externalAdapterConfigPath ?? '',
    externalAdapterAutoRegister: args['external-adapter-auto-register'] !== undefined ? args['external-adapter-auto-register'] : base.externalAdapterAutoRegister ?? false,
    startupHealthCheckOnly: args.check !== undefined ? args.check : base.startupHealthCheckOnly ?? false,
  }
}

// =============================================================================
// CLI 入口
// =============================================================================

async function main(): Promise<void> {
  // 解析命令行参数
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      mode: { type: 'string' },
      port: { type: 'string' },
      skills: { type: 'string' },
      memory: { type: 'string' },
      cwd: { type: 'string' },
      permission: { type: 'string' },
      'max-steps': { type: 'string' },
      'memory-backend': { type: 'string' },
      'external-adapter-config': { type: 'string' },
      'external-adapter-auto-register': { type: 'boolean' },
      'validate-config': { type: 'boolean' },
      check: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })

  const args = values as CLIArgs

  if (args.help) {
    console.log(`${HELP_TEXT}
  --config <path>                  Runtime JSON config file
  --external-adapter-config <path>  External adapter JSON config
  --external-adapter-auto-register  Auto-register external adapters on startup
  --validate-config                Validate config and print normalized runtime config without starting
  --check                         Start once, print health report, then stop`)
    return
  }

  if (args['validate-config']) {
    console.log(JSON.stringify({
      valid: true,
      config: buildFusionWorkspaceConfigFromCliArgs(args),
    }, null, 2))
    return
  }

  // 创建工作空间
  const workspace = new FusionWorkspace(buildFusionWorkspaceConfigFromCliArgs(args))

  // 启动
  await workspace.start()

  if (args.check) {
    console.log(JSON.stringify(workspace.getHealthReport(), null, 2))
    await workspace.stop()
    return
  }

  // 处理终止信号
  const shutdown = async () => {
    await workspace.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// 导出主类
export { FusionWorkspace }

// 如果是直接运行，执行 CLI
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
