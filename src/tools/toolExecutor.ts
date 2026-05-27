/**
 * Tool Executor — 四种原语工具 + 权限门集成
 * 
 * 融合 Claude Code 工具执行器设计：
 * - 工具注册表（ToolRegistry）
 * - 权限门检查（PermissionGate）
 * - 标准化结果格式
 * 
 * 四种原语工具：
 * 1. read_file(path) — 读取文件
 * 2. write_file(path, content) — 写入文件
 * 3. execute_command(command, cwd?) — 执行 Shell 命令
 * 4. http_request(url, method, headers?, body?) — HTTP 请求
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, mkdir, stat, unlink } from 'fs/promises'
import { dirname, resolve as pathResolve } from 'path'
import { existsSync } from 'fs'
import type { ToolCall, PermissionContext, PermissionDecision } from '../permissions/permissionGate.js'
import { 
  PermissionGate, 
  PermissionError, 
  NeedConfirmationError,
  RiskScorer,
  type PermissionMode 
} from '../permissions/permissionGate.js'
import { PermissionWorkflowStore, createToolFingerprint } from '../permissions/permissionWorkflow.js'
import type { PermissionPolicyEngine, ToolCategory, UserRole } from '../permissions/permissionPolicyEngine.js'

const execAsync = promisify(execCb)

// =============================================================================
// 类型定义
// =============================================================================

/** 工具函数类型 */
export type ToolFn<T extends Record<string, unknown> = Record<string, unknown>> = (
  params: T,
  context?: ToolContext
) => Promise<ToolResult>

/** 工具定义 */
export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
  // 使用更宽松的类型避免工具参数类型不兼容问题
  execute: (params: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>
}

/** 工具执行上下文 */
export interface ToolContext {
  cwd?: string
  permissionGate?: PermissionGate
  userId?: string
  sessionId?: string
  channel?: string
}

/** 标准化工具结果 */
export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  statusCode?: number
  riskLevel?: number
  requiresConfirmation?: boolean
  requestId?: string
}

/** HTTP 请求参数 */
export type ToolExecutionContext = Partial<PermissionContext>

export interface HttpRequestParams {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string
  timeout?: number
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 读取文件
 */
export async function readFileTool(
  params: { path: string; encoding?: string },
  context?: ToolContext
): Promise<ToolResult> {
  const gate = context?.permissionGate
  const toolCall: ToolCall = { name: 'read_file', params, cwd: context?.cwd }

  // 权限检查
  if (gate) {
    const decision = gate.check(toolCall)
    if (!decision.approved) {
      throw new PermissionError(`read_file 被拒绝: ${decision.reason}`, toolCall, decision.riskLevel)
    }
  }

  try {
    const path = pathResolve(context?.cwd || process.cwd(), params.path)
    const encoding = params.encoding || 'utf-8'
    
    if (!existsSync(path)) {
      return { success: false, error: `文件不存在: ${params.path}` }
    }

    const content = await readFile(path, encoding as BufferEncoding)
    return {
      success: true,
      data: content,
      stdout: content,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 写入文件
 */
export async function writeFileTool(
  params: { path: string; content: string; append?: boolean },
  context?: ToolContext
): Promise<ToolResult> {
  const gate = context?.permissionGate
  const toolCall: ToolCall = { name: 'write_file', params, cwd: context?.cwd }

  // 权限检查
  if (gate) {
    try {
      await gate.checkAsync(toolCall)
    } catch (error) {
      if (error instanceof PermissionError || error instanceof NeedConfirmationError) {
        throw error
      }
      throw new PermissionError(
        `write_file 权限检查失败: ${(error as Error).message}`,
        toolCall
      )
    }
  }

  try {
    const path = pathResolve(context?.cwd || process.cwd(), params.path)
    
    // 确保目录存在
    const dir = dirname(path)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    const flags = params.append ? 'a' : 'w'
    await writeFile(path, params.content, { flag: flags } as Parameters<typeof writeFile>[2])

    const action = params.append ? '追加写入' : '写入'
    return {
      success: true,
      data: { path, action, bytes: params.content.length },
      stdout: `${action}成功: ${params.path} (${params.content.length} bytes)`,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 执行 Shell 命令
 */
export async function executeCommandTool(
  params: { command: string; cwd?: string; timeout?: number; shell?: string },
  context?: ToolContext
): Promise<ToolResult> {
  const gate = context?.permissionGate
  const toolCall: ToolCall = { name: 'execute_command', params, cwd: params.cwd || context?.cwd }

  // 权限检查
  if (gate) {
    try {
      await gate.checkAsync(toolCall)
    } catch (error) {
      if (error instanceof PermissionError) {
        throw error
      }
      if (error instanceof NeedConfirmationError) {
        throw error
      }
      throw new PermissionError(
        `execute_command 权限检查失败: ${(error as Error).message}`,
        toolCall
      )
    }
  }

  const cwd = params.cwd || context?.cwd || process.cwd()
  const timeout = params.timeout || 60000 // 默认 60 秒超时

  try {
    // 在 Windows 上使用默认 shell
    const result = await execAsync(params.command, {
      cwd,
      timeout,
      shell: params.shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'),
      maxBuffer: 10 * 1024 * 1024, // 10MB
    })

    return {
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      data: { stdout: result.stdout, stderr: result.stderr },
    }
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean }
    return {
      success: false,
      stdout: execError.stdout || '',
      stderr: execError.stderr || '',
      exitCode: execError.code || 1,
      error: execError.killed ? '命令超时' : (execError.stderr || String(error)),
    }
  }
}

/**
 * HTTP 请求
 */
export async function httpRequestTool(
  params: HttpRequestParams,
  context?: ToolContext
): Promise<ToolResult> {
  const gate = context?.permissionGate
  const toolCall: ToolCall = { name: 'http_request', params: params as unknown as Record<string, unknown>, cwd: context?.cwd }

  // 权限检查
  if (gate) {
    try {
      await gate.checkAsync(toolCall)
    } catch (error) {
      if (error instanceof PermissionError || error instanceof NeedConfirmationError) {
        throw error
      }
      throw new PermissionError(
        `http_request 权限检查失败: ${(error as Error).message}`,
        toolCall
      )
    }
  }

  const method = params.method || 'GET'
  const timeout = params.timeout || 30000

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const fetchOptions: RequestInit = {
      method,
      headers: params.headers || {},
      signal: controller.signal,
    }

    if (params.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOptions.body = params.body
    }

    clearTimeout(timeoutId)

    const response = await fetch(params.url, fetchOptions)
    const statusCode = response.status
    const data = await response.text()

    return {
      success: statusCode >= 200 && statusCode < 300,
      statusCode,
      data,
      stdout: data,
      stderr: statusCode >= 400 ? `HTTP ${statusCode}` : undefined,
    }
  } catch (error: unknown) {
    const fetchError = error as { name?: string; message?: string }
    if (fetchError.name === 'AbortError') {
      return { success: false, error: '请求超时' }
    }
    return {
      success: false,
      error: fetchError.message || String(error),
    }
  }
}

// =============================================================================
// 工具注册表
// =============================================================================

/**
 * 工具注册表
 * 管理所有可用工具及其执行
 */
export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map()
  private permissionGate: PermissionGate
  private workflow?: PermissionWorkflowStore | null
  private policyEngine?: PermissionPolicyEngine
  private riskScorer: RiskScorer

  constructor(
    mode: PermissionMode = 'default',
    context: PermissionContext = {},
    workflow?: PermissionWorkflowStore | null,
    policyEngine?: PermissionPolicyEngine,
  ) {
    this.permissionGate = new PermissionGate(mode, context, workflow)
    this.workflow = workflow ?? null
    this.policyEngine = policyEngine
    this.riskScorer = new RiskScorer()
    this.registerBuiltins()
  }

  /**
   * 注册内置工具
   */
  private registerBuiltins(): void {
    // 使用 as any 避免函数参数类型不兼容
    const asToolFn = (fn: Function) => fn as unknown as (params: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>

    this.register({
      name: 'read_file',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          encoding: { type: 'string', description: '编码 (默认 utf-8)' },
        },
        required: ['path'],
      },
      execute: asToolFn(readFileTool),
    })

    this.register({
      name: 'write_file',
      description: '写入文件（可选追加）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
          append: { type: 'boolean', description: '追加模式 (默认 false)' },
        },
        required: ['path', 'content'],
      },
      execute: asToolFn(writeFileTool),
    })

    this.register({
      name: 'execute_command',
      description: '执行 Shell 命令',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录' },
          timeout: { type: 'number', description: '超时时间 (毫秒)' },
          shell: { type: 'string', description: '使用的 Shell' },
        },
        required: ['command'],
      },
      execute: asToolFn(executeCommandTool),
    })

    this.register({
      name: 'http_request',
      description: '发送 HTTP 请求',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '请求 URL' },
          method: { type: 'string', description: 'HTTP 方法' },
          headers: { type: 'object', description: '请求头' },
          body: { type: 'string', description: '请求体' },
          timeout: { type: 'number', description: '超时时间 (毫秒)' },
        },
        required: ['url'],
      },
      execute: asToolFn(httpRequestTool),
    })
  }

  /**
   * 注册工具
   */
  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool)
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /**
   * 获取工具
   */
  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  /**
   * 获取所有工具名称
   */
  listTools(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 执行工具
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    executionContext?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, error: `未知工具: ${name}` }
    }

    const permissionGate = this.createExecutionGate(executionContext)
    const context = permissionGate.getContext()
    const policyResult = this.evaluatePolicy(name, params, context)
    if (policyResult) {
      return policyResult
    }

    const toolContext: ToolContext = {
      cwd: context.cwd,
      permissionGate,
      userId: context.userId,
      sessionId: context.sessionId,
      channel: context.channel,
    }

    try {
      // 使用 as any 避免 ToolFn 的严格类型检查（工具参数类型各不相同）
      return await (tool.execute as (params: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>)(params, toolContext)
    } catch (error) {
      if (error instanceof PermissionError) {
        return {
          success: false,
          error: error.message,
          riskLevel: error.riskLevel,
        }
      }
      if (error instanceof NeedConfirmationError) {
        return {
          success: false,
          error: `需要确认: ${error.message}`,
          riskLevel: error.riskLevel,
          requiresConfirmation: true,
          requestId: error.requestId,
        }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async executeWithoutPermission(
    name: string,
    params: Record<string, unknown>,
    executionContext?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, error: `未知工具: ${name}` }
    }

    const context = this.getEffectiveContext(executionContext)
    const toolContext: ToolContext = {
      cwd: context.cwd,
      userId: context.userId,
      sessionId: context.sessionId,
      channel: context.channel,
    }

    try {
      return await (tool.execute as (params: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>)(params, toolContext)
    } catch (error) {
      if (error instanceof PermissionError || error instanceof NeedConfirmationError) {
        return {
          success: false,
          error: error.message,
          riskLevel: 'riskLevel' in error ? error.riskLevel : undefined,
        }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // =============================================================================
  // 权限配置
  // =============================================================================

  /**
   * 设置权限模式
   */
  setMode(mode: PermissionMode): void {
    this.permissionGate.setMode(mode)
  }

  /**
   * 获取当前权限模式
   */
  getMode(): PermissionMode {
    return this.permissionGate.getMode()
  }

  /**
   * 设置权限上下文
   */
  setContext(context: Partial<PermissionContext>): void {
    this.permissionGate.setContext(context)
  }

  /**
   * 添加信任目录
   */
  addTrustedDirectory(dir: string): void {
    this.permissionGate.addTrustedDirectory(dir)
  }

  /**
   * 设置白名单
   */
  setWhitelist(tools: string[]): void {
    this.permissionGate.setWhitelist(tools)
  }

  /**
   * 检查工具权限
   */
  checkPermission(name: string, params: Record<string, unknown>): PermissionDecision {
    return this.permissionGate.check({ name, params })
  }

  /**
   * 获取权限门实例（用于 TAOR 循环集成）
   */
  getPermissionGate(): PermissionGate {
    return this.permissionGate
  }

  setPermissionPolicyEngine(policyEngine: PermissionPolicyEngine | undefined): void {
    this.policyEngine = policyEngine
  }

  getPermissionPolicyEngine(): PermissionPolicyEngine | undefined {
    return this.policyEngine
  }

  private getEffectiveContext(executionContext?: ToolExecutionContext): PermissionContext {
    return {
      ...this.permissionGate.getContext(),
      ...(executionContext ?? {}),
    }
  }

  private createExecutionGate(executionContext?: ToolExecutionContext): PermissionGate {
    if (!executionContext) {
      return this.permissionGate
    }

    return new PermissionGate(
      this.permissionGate.getMode(),
      this.getEffectiveContext(executionContext),
      this.workflow,
    )
  }

  private evaluatePolicy(
    name: string,
    params: Record<string, unknown>,
    context: PermissionContext,
  ): ToolResult | null {
    if (!this.policyEngine) {
      return null
    }

    const risk = this.riskScorer.assess({ name, params, cwd: context.cwd }, context)
    const decision = this.policyEngine.evaluate({
      userId: context.userId || 'anonymous',
      channel: context.channel || 'unknown',
      role: 'guest' as UserRole,
      isFirstInteraction: false,
      trustLevel: 0,
    }, name, getToolCategory(name), risk.level)

    if (decision.allowed) {
      return null
    }

    const toolCall = { name, params, cwd: context.cwd }
    this.workflow?.logDecision({
      toolName: name,
      fingerprint: createToolFingerprint(toolCall),
      approved: false,
      reason: `Permission policy denied: ${decision.reason}`,
      riskLevel: risk.level,
      mode: `policy:${decision.appliedPolicy}`,
      sessionId: context.sessionId,
      userId: context.userId,
    })

    return {
      success: false,
      error: `Permission policy denied: ${decision.reason}`,
      riskLevel: risk.level,
      requiresConfirmation: false,
      data: {
        policyApplied: decision.appliedPolicy,
        mode: decision.mode,
      },
    }
  }
}

function getToolCategory(name: string): ToolCategory {
  const readTools = ['read_file', 'grep', 'glob', 'find', 'search']
  const writeTools = ['write_file', 'edit_file', 'create_file', 'delete_file', 'mkdir']
  const executeTools = ['execute_command', 'bash', 'shell', 'cmd', 'powershell', 'exec']
  const networkTools = ['http_request', 'fetch', 'curl', 'wget']

  if (readTools.includes(name)) return 'read'
  if (writeTools.includes(name)) return 'write'
  if (executeTools.includes(name)) return 'execute'
  if (networkTools.includes(name)) return 'network'
  return 'admin'
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 创建工具调用对象
 */
export function createToolCall(
  name: string,
  params: Record<string, unknown>
): ToolCall {
  return { name, params }
}

// =============================================================================
// 便捷执行函数
// =============================================================================

let _defaultRegistry: ToolRegistry | null = null

/**
 * 获取默认工具注册表（单例）
 */
export function getDefaultRegistry(): ToolRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new ToolRegistry()
  }
  return _defaultRegistry
}

/**
 * 重置默认注册表
 */
export function resetDefaultRegistry(): void {
  _defaultRegistry = null
}

/**
 * 快速执行工具
 */
export async function quickExecute(
  name: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  const registry = getDefaultRegistry()
  return registry.execute(name, params)
}
