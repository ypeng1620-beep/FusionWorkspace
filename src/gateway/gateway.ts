/**
 * Gateway — 多通道接入系统
 * 
 * 融合 OpenClaw Channel 系统设计：
 * - 支持多种通道：WebSocket、HTTP、Webhook、stdio
 * - 统一的消息格式
 * - 通道优先级和熔断
 * - 心跳保活
 * 
 * 纯 TypeScript，基于 ws + express
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import express, { Express, Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'
import type { MessageType, OutboundMessageType } from '../protocol/messageTypes.js'
import type { AdapterCapabilities } from '../protocol/adapterSchema.js'
import { DEFAULT_CAPABILITIES, WEBSOCKET_CAPABILITIES, STDIO_CAPABILITIES } from '../protocol/adapterSchema.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

/** 已知通道类型 */
export type KnownChannelType = 'websocket' | 'http' | 'webhook' | 'stdio'

/** 通道类型（开放扩展，支持自定义 adapter 类型如 'wechat', 'feishu'） */
export type ChannelType = KnownChannelType | (string & {})

/** 消息结构 */
export interface ChannelMessage {
  id: string
  /** 消息类型（结构化协议字段，优先使用） */
  type?: MessageType
  role: MessageRole
  content: string
  /** 结构化 payload（与 type 配套使用） */
  payload?: Record<string, unknown>
  timestamp: number
  metadata?: Record<string, unknown>
  channel?: ChannelType
  sessionId?: string
  userId?: string
  /** 对话 ID（多轮对话场景，如微信 openId、飞书 chatId） */
  conversationId?: string
}

/** 通道配置 */
export interface ChannelConfig {
  type: ChannelType
  /** WebSocket/HTTP 服务器端口 */
  port?: number
  /** WebSocket 路径 */
  wsPath?: string
  /** HTTP 路由前缀 */
  httpPrefix?: string
  /** stdio 模式 */
  stdioMode?: boolean
  /** Webhook 回调 URL */
  webhookUrl?: string
  /** Webhook 密钥 */
  webhookSecret?: string
  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number
  /** 连接超时（毫秒） */
  connectionTimeout?: number
  /** 最大消息大小 */
  maxMessageSize?: number
  /** 仪表盘静态文件路径 (可选, 如 "./dashboard") */
  dashboardPath?: string
  /** 是否启用仪表盘 (默认: true) */
  dashboardEnabled?: boolean
}

/** 会话 */
export interface Session {
  id: string
  channel: ChannelType
  connectedAt: number
  lastActiveAt: number
  metadata: Record<string, unknown>
  /** 通道私有传输引用（WS 放 WebSocket, 微信放 adapterRef 等） */
  transport?: unknown
  /** 对话 ID（多轮对话场景） */
  conversationId?: string
}

/** 通道事件回调 */
export interface ChannelEvents {
  onMessage?: (message: ChannelMessage, session: Session) => void | Promise<void>
  onConnect?: (session: Session) => void | Promise<void>
  onDisconnect?: (session: Session, reason: string) => void | Promise<void>
  onError?: (session: Session, error: Error) => void | Promise<void>
  onHealthCheck?: () => Record<string, unknown> | Promise<Record<string, unknown>>
}

/** 网关统计 */
export interface GatewayStats {
  uptime: number
  running: boolean
  totalConnections: number
  activeSessions: number
  totalMessages: number
  /** 按通道实例 ID 统计的消息数 */
  messagesPerChannel: Record<string, number>
  errors: number
  lastError?: string
  lastCleanupError?: string
}

// =============================================================================
// 消息路由器
// =============================================================================

/**
 * 消息路由器
 * 负责消息的路由、分发、过滤
 */
export class MessageRouter {
  private routes: Map<string, Array<(message: ChannelMessage) => void | Promise<void>>> = new Map()
  private filters: Array<(message: ChannelMessage) => ChannelMessage | null> = []

  /** 添加路由 */
  addRoute(pattern: string, handler: (message: ChannelMessage) => void | Promise<void>): void {
    if (!this.routes.has(pattern)) {
      this.routes.set(pattern, [])
    }
    this.routes.get(pattern)!.push(handler)
  }

  /** 添加消息过滤器 */
  addFilter(filter: (message: ChannelMessage) => ChannelMessage | null): void {
    this.filters.push(filter)
  }

  /** 路由消息 */
  async dispatch(message: ChannelMessage): Promise<void> {
    // 应用过滤器
    let processedMessage = message
    for (const filter of this.filters) {
      const result = filter(processedMessage)
      if (!result) return  // 被过滤掉
      processedMessage = result
    }

    // 匹配路由
    const wildcardHandlers = this.routes.get('*') ?? []

    for (const [pattern, handlers] of this.routes) {
      if (pattern === '*') continue  // wildcards dispatched once below
      if (message.content.includes(pattern)) {
        for (const handler of handlers) {
          await handler(processedMessage)
        }
      }
    }

    // 执行通用处理器
    for (const handler of wildcardHandlers) {
      await handler(processedMessage)
    }
  }
}

// =============================================================================
// 通道基类
// =============================================================================

/**
 * 通道接口
 */
export interface IChannel {
  /** 启动通道 */
  start(): Promise<void>
  /** 停止通道 */
  stop(): Promise<void>
  /** 发送消息 */
  send(message: ChannelMessage, session?: Session): Promise<void>
  /** 广播消息 */
  broadcast(message: Omit<ChannelMessage, 'id' | 'timestamp'>): Promise<void>
  /** 获取类型 */
  getType(): ChannelType
  /** 获取统计 */
  getStats(): Record<string, unknown>
  /** 获取适配器能力声明 */
  getCapabilities(): AdapterCapabilities
  /** Channel health probe — optionally checks external API reachability. */
  healthCheck?(): Promise<{ status: 'ok' | 'degraded' | 'unavailable'; detail?: string }>
}

// =============================================================================
// WebSocket 通道
// =============================================================================

/**
 * WebSocket 通道
 */
export class WebSocketChannel implements IChannel {
  private wss?: WebSocketServer
  private sessions: Map<string, Session> = new Map()
  private events: ChannelEvents
  private config: Required<ChannelConfig>
  private server?: Server
  private heartbeatTimer?: NodeJS.Timeout

  constructor(config: ChannelConfig, events: ChannelEvents = {}) {
    // 只扩展已提供的字段，避免 Required 类型的严格检查
    this.config = {
      type: config.type,
      port: config.port ?? 8080,
      wsPath: config.wsPath ?? '/ws',
      httpPrefix: config.httpPrefix ?? '/api',
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      connectionTimeout: config.connectionTimeout ?? 60000,
      maxMessageSize: config.maxMessageSize ?? 1024 * 1024,
    } as Required<ChannelConfig>
    // 补充可选字段（如果提供的话）
    if (config.type === 'webhook') {
      (this.config as any).webhookUrl = config.webhookUrl
      ;(this.config as any).webhookSecret = config.webhookSecret
    }
    this.events = events
  }

  async start(): Promise<void> {
    const app = express()
    app.use(express.json({ limit: this.config.maxMessageSize }))

    // Dashboard static files
    const dashboardEnabled = this.config.dashboardEnabled ?? true
    const dashboardPath = this.config.dashboardPath
    if (dashboardEnabled && dashboardPath) {
      const resolved = join(process.cwd(), dashboardPath)
      if (existsSync(resolved)) {
        app.use('/dashboard', express.static(resolved))
        console.log(`[Gateway] Dashboard served from ${resolved} at /dashboard`)
      }
    }

    app.get(`${this.config.httpPrefix}/live`, (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        live: true,
        channel: 'websocket',
        sessions: this.sessions.size,
        uptime: process.uptime(),
      })
    })

    app.get(`${this.config.httpPrefix}/ready`, async (_req: Request, res: Response) => {
      const extra = await this.events.onHealthCheck?.()
      res.json({
        channel: 'websocket',
        sessions: this.sessions.size,
        uptime: process.uptime(),
        ...(extra ?? { status: 'ok' }),
      })
    })

    // HTTP 健康检查端点
    app.get(`${this.config.httpPrefix}/health`, async (_req: Request, res: Response) => {
      const base = {
        status: 'ok',
        channel: 'websocket',
        sessions: this.sessions.size,
        uptime: process.uptime(),
      }
      const extra = await this.events.onHealthCheck?.()
      res.json(extra ? { ...base, ...extra } : base)
    })

    app.get(`${this.config.httpPrefix}/status`, async (_req: Request, res: Response) => {
      const extra = await this.events.onHealthCheck?.()
      res.json({
        channel: 'websocket',
        sessions: this.sessions.size,
        uptime: process.uptime(),
        ...(extra ?? {}),
      })
    })

    // HTTP 消息端点
    app.post(`${this.config.httpPrefix}/message`, async (req: Request, res: Response) => {
      const message: ChannelMessage = {
        id: randomUUID(),
        role: 'user',
        content: req.body.content || '',
        timestamp: Date.now(),
        channel: 'http',
        sessionId: req.body.sessionId,
        metadata: req.body.metadata,
      }

      try {
        await this.events.onMessage?.(message, this.createEmptySession('http'))
        res.json({ success: true, messageId: message.id })
      } catch (error) {
        res.status(500).json({ success: false, error: String(error) })
      }
    })

    // WebSocket 升级端点
    app.get(this.config.wsPath, (req: IncomingMessage, socket, head) => {
      // WebSocket 升级由 wss 处理
    })

    this.server = createServer(app)

    this.wss = new WebSocketServer({
      server: this.server,
      path: this.config.wsPath,
    })

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const sessionId = randomUUID()
      const session: Session = {
        id: sessionId,
        channel: 'websocket',
        connectedAt: Date.now(),
        lastActiveAt: Date.now(),
        metadata: {
          remoteAddress: req.socket.remoteAddress,
        },
        transport: ws,
      }

      this.sessions.set(sessionId, session)
      this.events.onConnect?.(session)

      ws.on('message', async (data: Buffer) => {
        try {
          const message: ChannelMessage = {
            id: randomUUID(),
            role: 'user',
            content: data.toString(),
            timestamp: Date.now(),
            channel: 'websocket',
            sessionId,
          }

          session.lastActiveAt = Date.now()
          await this.events.onMessage?.(message, session)
        } catch (error) {
          this.events.onError?.(session, error as Error)
        }
      })

      ws.on('close', () => {
        this.sessions.delete(sessionId)
        this.events.onDisconnect?.(session, 'connection_closed')
      })

      ws.on('error', (error: Error) => {
        this.events.onError?.(session, error)
      })
    })

    // 启动 HTTP 服务器
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[Gateway] WebSocket channel listening on port ${this.config.port}`)
        resolve()
      })
      this.server!.on('error', reject)
    })

    // 启动心跳
    this.startHeartbeat()
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [sessionId, session] of this.sessions) {
        const ws = session.transport as WebSocket | undefined
        if (ws && ws.readyState === WebSocket.OPEN) {
          const inactiveMs = Date.now() - session.lastActiveAt
          if (inactiveMs > this.config.connectionTimeout) {
            ws.terminate()
            this.sessions.delete(sessionId)
            this.events.onDisconnect?.(session, 'timeout')
          } else {
            // 发送 ping
            ws.ping()
          }
        }
      }
    }, this.config.heartbeatInterval)
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    for (const session of this.sessions.values()) {
      const ws = session.transport as WebSocket | undefined
      ws?.terminate()
    }
    this.sessions.clear()

    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve())
    })

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
  }

  async send(message: ChannelMessage, session?: Session): Promise<void> {
    const ws = session?.transport as WebSocket | undefined
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Session not connected')
    }

    const payload = JSON.stringify(message)
    ws.send(payload)
  }

  async broadcast(message: Omit<ChannelMessage, 'id' | 'timestamp'>): Promise<void> {
    const fullMessage: ChannelMessage = {
      ...message,
      id: randomUUID(),
      timestamp: Date.now(),
    }

    const payload = JSON.stringify(fullMessage)

    for (const session of this.sessions.values()) {
      const ws = session.transport as WebSocket | undefined
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(payload)
      }
    }
  }

  getType(): ChannelType {
    return 'websocket'
  }

  getStats(): Record<string, unknown> {
    return {
      type: 'websocket',
      port: this.config.port,
      activeSessions: this.sessions.size,
      totalConnections: this.sessions.size,
    }
  }

  getCapabilities(): AdapterCapabilities {
    return WEBSOCKET_CAPABILITIES
  }

  private createEmptySession(channel: ChannelType): Session {
    return {
      id: randomUUID(),
      channel,
      connectedAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: {},
    }
  }
}

// =============================================================================
// Webhook 通道
// =============================================================================

/**
 * Webhook 通道
 * 主动推送消息到外部 Webhook URL
 */
export class WebhookChannel implements IChannel {
  private config: Required<ChannelConfig>
  private events: ChannelEvents
  private messageQueue: ChannelMessage[] = []
  private retryTimer?: NodeJS.Timeout
  private maxRetries: number = 3

  constructor(config: ChannelConfig, events: ChannelEvents = {}) {
    // Webhook 使用简化配置
    this.config = {
      type: config.type,
      webhookUrl: config.webhookUrl ?? '',
      webhookSecret: config.webhookSecret ?? '',
      heartbeatInterval: config.heartbeatInterval ?? 60000,
      maxMessageSize: config.maxMessageSize ?? 1024 * 1024,
    } as Required<ChannelConfig>
    this.events = events
  }

  async start(): Promise<void> {
    if (!this.config.webhookUrl) {
      throw new Error('webhookUrl is required for webhook channel')
    }

    // 启动重试队列处理器
    this.retryTimer = setInterval(() => {
      this.processQueue()
    }, this.config.heartbeatInterval)

    console.log(`[Gateway] Webhook channel configured for ${this.config.webhookUrl}`)
  }

  async stop(): Promise<void> {
    if (this.retryTimer) {
      clearInterval(this.retryTimer)
    }
  }

  async send(message: ChannelMessage): Promise<void> {
    try {
      await this.deliverMessage(message)
    } catch (error) {
      // 加入重试队列
      this.messageQueue.push(message)
    }
  }

  private async deliverMessage(message: ChannelMessage, retries: number = 0): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Gateway-Message-Id': message.id,
    }

    if (this.config.webhookSecret) {
      headers['X-Webhook-Secret'] = this.config.webhookSecret
    }

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status}`)
    }
  }

  private async processQueue(): Promise<void> {
    if (this.messageQueue.length === 0) return

    const message = this.messageQueue.shift()
    if (!message) return

    const MAX_RETRIES = 3
    const retries = (message as any)._retries ?? 0

    try {
      await this.deliverMessage(message)
    } catch (error) {
      if (retries < MAX_RETRIES) {
        (message as any)._retries = retries + 1
        this.messageQueue.push(message)
        console.warn(`[Webhook] Delivery failed for ${message.id}, requeued (${retries + 1}/${MAX_RETRIES})`)
      } else {
        console.error(`[Webhook] Delivery failed permanently for ${message.id}:`, error)
      }
    }
  }

  async broadcast(): Promise<void> {
    // Webhook 通道不支持广播（单向推送）
    console.warn('[Webhook] Broadcast not supported on webhook channel')
  }

  getType(): ChannelType {
    return 'webhook'
  }

  getStats(): Record<string, unknown> {
    return {
      type: 'webhook',
      webhookUrl: this.config.webhookUrl,
      queueLength: this.messageQueue.length,
    }
  }

  getCapabilities(): AdapterCapabilities {
    return DEFAULT_CAPABILITIES
  }
}

// =============================================================================
// Stdio 通道
// =============================================================================

/**
 * Stdio 通道
 * 用于命令行交互
 */
export class StdioChannel implements IChannel {
  private events: ChannelEvents
  private running: boolean = false

  constructor(_config: ChannelConfig, events: ChannelEvents = {}) {
    this.events = events
  }

  async start(): Promise<void> {
    this.running = true

    // 从 stdin 读取行
    const readLine = await import('readline')
    const rl = readLine.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })

    // 创建会话对象（每次启动生成唯一 ID）
    const session: Session = {
      id: randomUUID(),
      channel: 'stdio',
      connectedAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: {},
    }

    rl.on('line', async (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return

      try {
        const message: ChannelMessage = {
          id: randomUUID(),
          role: 'user',
          content: trimmed,
          timestamp: Date.now(),
          channel: 'stdio',
          sessionId: session.id,
        }

        await this.events.onMessage?.(message, session)
      } catch (error) {
        this.events.onError?.(session, error instanceof Error ? error : new Error(String(error)))
      }
    })

    console.log('[Gateway] Stdio channel started')
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async send(message: ChannelMessage): Promise<void> {
    // 输出到 stdout
    console.log(message.content)
  }

  async broadcast(message: Omit<ChannelMessage, 'id' | 'timestamp'>): Promise<void> {
    console.log(message.content)
  }

  getType(): ChannelType {
    return 'stdio'
  }

  getStats(): Record<string, unknown> {
    return {
      type: 'stdio',
      running: this.running,
    }
  }

  getCapabilities(): AdapterCapabilities {
    return STDIO_CAPABILITIES
  }
}

// =============================================================================
// 网关主类
// =============================================================================

/**
 * 多通道网关
 * 
 * 管理多种接入通道，统一消息处理
 */
export class Gateway {
  /** 通道注册表（key 为实例 ID，支持同类型多实例） */
  private channels: Map<string, IChannel> = new Map()
  private router: MessageRouter
  private events: ChannelEvents
  private sessions: Map<string, Session> = new Map()
  private stats: GatewayStats
  private startTime: number
  private running: boolean = false
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined

  constructor(events: ChannelEvents = {}) {
    this.router = new MessageRouter()
    this.events = events
    this.startTime = Date.now()

    this.stats = {
      uptime: 0,
      running: false,
      totalConnections: 0,
      activeSessions: 0,
      totalMessages: 0,
      messagesPerChannel: {},
      errors: 0,
    }

    // 注册默认消息处理器
    this.router.addRoute('*', async (message: ChannelMessage) => {
      this.stats.totalMessages++
      const channelKey = message.channel ?? 'unknown'
      this.stats.messagesPerChannel[channelKey] = (this.stats.messagesPerChannel[channelKey] ?? 0) + 1
      await this.events.onMessage?.(message, this.sessions.get(message.sessionId ?? '') ?? this.createEmptySession(message.channel ?? 'http'))
    })
  }

  /**
   * 添加通道
   * @param channel 通道实例
   * @param instanceId 可选实例 ID（用于同类型多实例，如 'wechat-cs-1'）
   */
  addChannel(channel: IChannel, instanceId?: string): void {
    const key = instanceId ?? channel.getType()
    this.channels.set(key, channel)
  }

  removeChannel(instanceId: string): boolean {
    return this.channels.delete(instanceId)
  }

  /** 配置并添加 WebSocket 通道 */
  addWebSocketChannel(config: ChannelConfig, events?: ChannelEvents): void {
    const channel = new WebSocketChannel(config, {
      ...this.events,
      ...events,
    })
    this.channels.set('websocket', channel)
  }

  /** 配置并添加 Webhook 通道 */
  addWebhookChannel(config: ChannelConfig, events?: ChannelEvents): void {
    const channel = new WebhookChannel(config, {
      ...this.events,
      ...events,
    })
    this.channels.set('webhook', channel)
  }

  /** 配置并添加 Stdio 通道 */
  addStdioChannel(config: ChannelConfig, events?: ChannelEvents): void {
    const channel = new StdioChannel(config, {
      ...this.events,
      ...events,
    })
    this.channels.set('stdio', channel)
  }

  /** 添加路由 */
  addRoute(pattern: string, handler: (message: ChannelMessage) => void | Promise<void>): void {
    this.router.addRoute(pattern, handler)
  }

  /** 添加消息过滤器 */
  addFilter(filter: (message: ChannelMessage) => ChannelMessage | null): void {
    this.router.addFilter(filter)
  }

  /** 启动网关 */
  async start(): Promise<void> {
    if (this.stopPromise) {
      console.log('[Gateway] Waiting for stop before start')
      await this.stopPromise
    }
    if (this.running) {
      this.stats.running = true
      console.log('[Gateway] Already running')
      return
    }
    if (this.startPromise) {
      console.log('[Gateway] Start already in progress')
      return this.startPromise
    }

    this.startPromise = this.startChannels()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  private async startChannels(): Promise<void> {
    console.log('[Gateway] Starting...')
    const startedChannels: Array<{ type: string; channel: IChannel }> = []

    for (const [type, channel] of this.channels) {
      try {
        await channel.start()
        startedChannels.push({ type, channel })
        console.log(`[Gateway] Channel '${type}' started`)
      } catch (error) {
        console.error(`[Gateway] Failed to start channel '${type}':`, error)
        this.stats.errors++
        const message = error instanceof Error ? error.message : String(error)
        const startupError = `Failed to start channel '${type}': ${message}`
        this.stats.lastError = startupError
        for (const { type: startedType, channel: startedChannel } of [...startedChannels].reverse()) {
          try {
            await startedChannel.stop()
            console.log(`[Gateway] Channel '${startedType}' stopped after startup failure`)
          } catch (stopError) {
            console.error(`[Gateway] Error stopping channel '${startedType}' after startup failure:`, stopError)
            this.stats.errors++
            const stopMessage = stopError instanceof Error ? stopError.message : String(stopError)
            this.stats.lastCleanupError = `Failed to stop channel '${startedType}' after startup failure: ${stopMessage}`
          }
        }
        this.running = false
        this.stats.running = false
        throw new Error(startupError)
      }
    }

    this.running = true
    this.stats.running = true
    console.log('[Gateway] Started successfully')
  }

  /** 停止网关 */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      console.log('[Gateway] Stop already in progress')
      return this.stopPromise
    }
    if (this.startPromise) {
      console.log('[Gateway] Waiting for start before stop')
      try {
        await this.startPromise
      } catch (error) {
        console.error('[Gateway] Startup failed while waiting to stop:', error)
      }
    }
    if (!this.running) {
      this.stats.running = false
      console.log('[Gateway] Already stopped')
      return
    }

    this.stopPromise = this.stopChannels()
    try {
      await this.stopPromise
    } finally {
      this.stopPromise = undefined
    }
  }

  private async stopChannels(): Promise<void> {
    console.log('[Gateway] Stopping...')

    for (const [type, channel] of this.channels) {
      try {
        await channel.stop()
        console.log(`[Gateway] Channel '${type}' stopped`)
      } catch (error) {
        console.error(`[Gateway] Error stopping channel '${type}':`, error)
        this.stats.errors++
        const message = error instanceof Error ? error.message : String(error)
        this.stats.lastError = `Failed to stop channel '${type}': ${message}`
      }
    }

    this.running = false
    this.stats.running = false
    console.log('[Gateway] Stopped')
  }

  /** 发送消息到指定会话 */
  async sendToSession(sessionId: string, message: ChannelMessage): Promise<void> {
    let session = this.sessions.get(sessionId)
    
    // 如果会话不存在，自动创建一个
    if (!session) {
      console.log(`[Gateway] Session '${sessionId}' not found, auto-creating for ${message.channel}...`)
      session = {
        id: sessionId,
        channel: message.channel ?? 'stdio',
        connectedAt: Date.now(),
        lastActiveAt: Date.now(),
        metadata: { autoCreated: true },
      }
      this.sessions.set(sessionId, session)
    }

    // 先尝试按精确实例 ID 查找，再回退到按通道类型查找
    const channel = this.findChannelForSession(session)
    if (!channel) {
      throw new Error(`Channel '${session.channel}' not available`)
    }

    await channel.send(message, session)
  }

  /** 为会话查找匹配的通道（优先实例 ID，回退通道类型） */
  private findChannelForSession(session: Session): IChannel | undefined {
    // 如果 metadata 中有 instanceId，优先使用
    const instanceId = session.metadata?.instanceId as string | undefined
    if (instanceId && this.channels.has(instanceId)) {
      return this.channels.get(instanceId)
    }
    // 回退：按通道类型查找第一个匹配的
    for (const [key, channel] of this.channels) {
      if (channel.getType() === session.channel || key === session.channel) {
        return channel
      }
    }
    return undefined
  }

  /** 广播消息到所有会话 */
  async broadcast(message: Omit<ChannelMessage, 'id' | 'timestamp'>): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.broadcast(message)
      } catch (error) {
        console.error(`[Gateway] Broadcast error on channel '${channel.getType()}':`, error)
      }
    }
  }

  /** 广播到指定通道类型 */
  async broadcastToChannel(channelType: ChannelType, message: Omit<ChannelMessage, 'id' | 'timestamp'>): Promise<void> {
    // 查找所有匹配该类型的通道
    const matchingChannels = Array.from(this.channels.values()).filter(
      ch => ch.getType() === channelType
    )
    if (matchingChannels.length === 0) {
      throw new Error(`Channel '${channelType}' not configured`)
    }

    for (const channel of matchingChannels) {
      await channel.broadcast(message)
    }
  }

  /** 获取统计信息 */
  getStats(): GatewayStats {
    return {
      ...this.stats,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      activeSessions: this.sessions.size,
    }
  }

  /** 获取通道统计（按实例 ID 分组） */
  getChannelStats(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {}

    for (const [key, channel] of this.channels) {
      result[key] = channel.getStats()
    }

    return result
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.running
  }

  /** 获取会话 */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  /** 获取所有会话 */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values())
  }

  private createEmptySession(channel: ChannelType): Session {
    return {
      id: randomUUID(),
      channel,
      connectedAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: {},
    }
  }
}

// =============================================================================
// 便捷函数
// =============================================================================

/** 创建默认网关 */
export function createGateway(events?: ChannelEvents): Gateway {
  return new Gateway(events)
}

// =============================================================================
// 示例
// =============================================================================

/*
// 基本用法：

import { Gateway, WebSocketChannel } from './gateway/gateway.js'

const gateway = new Gateway({
  onMessage: async (message, session) => {
    console.log(`[${session.channel}] ${message.role}: ${message.content}`)
    
    // 处理消息并回复
    if (message.role === 'user') {
      await gateway.sendToSession(session.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Echo: ${message.content}`,
        timestamp: Date.now(),
        channel: session.channel,
        sessionId: session.id,
      })
    }
  },
})

// 添加 WebSocket 通道
gateway.addWebSocketChannel({
  type: 'websocket',
  port: 8080,
  wsPath: '/ws',
})

// 添加 Stdio 通道
gateway.addStdioChannel({
  type: 'stdio',
})

// 启动
await gateway.start()

// 广播
await gateway.broadcast({
  role: 'system',
  content: 'System update available',
})

// 获取统计
console.log(gateway.getStats())

// 停止
await gateway.stop()
*/
