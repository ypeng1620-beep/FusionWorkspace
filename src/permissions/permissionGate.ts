/**
 * Permission Gate — 七种权限模式的访问控制
 * 
 * 融合 Claude Code 权限模型：
 * - PermissionMode: default, plan, bypass, auto, interactive, sandbox, restricted
 * - RiskScorer: 基于工具类型/参数/目录的风险评估
 * - PermissionGate: 根据模式决策是否允许工具调用
 * 
 * 工具分类：
 * - Read: read_file, http_request (GET)
 * - Write: write_file, http_request (POST/PUT/DELETE)
 * - Shell: execute_command
 * - Admin: 系统管理命令
 */

import { basename, resolve } from 'path'
import {
  PermissionWorkflowStore,
  type ApprovalScope,
  createToolFingerprint,
} from './permissionWorkflow.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 七种权限模式 */
export type PermissionMode = 
  | 'default'   // 读取自动批准，写入/网络需确认
  | 'plan'      // 只读模式，禁止所有写入和 shell
  | 'bypass'    // 全自动批准（无确认）
  | 'auto'      // 基于风险评分自动决策
  | 'interactive' // 所有工具都需用户确认
  | 'sandbox'   // 限制读取 + 受限 shell
  | 'restricted' // 仅预批准的白名单工具

/** 工具调用 */
export interface ToolCall {
  name: string
  params: Record<string, unknown>
  cwd?: string
}

/** 权限检查上下文 */
export interface PermissionContext {
  cwd?: string
  userId?: string
  sessionId?: string
  channel?: string
  trustedDirectories?: string[]
  toolWhitelist?: string[]  // restricted 模式白名单
}

/** 权限决策结果 */
export interface PermissionDecision {
  approved: boolean
  reason: string
  requiresConfirmation?: boolean
  riskLevel?: number  // 1-10
}

/** 风险评估结果 */
export interface RiskAssessment {
  level: number       // 1-10
  factors: string[]   // 风险因素列表
  isDangerous: boolean
}

// =============================================================================
// 危险模式检测
// =============================================================================

/** 高风险命令模式（风险等级 10） */
const DANGEROUS_PATTERNS = [
  // 删除根目录
  { pattern: /^\s*rm\s+-rf\s+\/\s*$/, reason: '删除根目录', severity: 10 },
  { pattern: /^\s*rm\s+-rf\s+\/\*?\s*$/, reason: '递归删除根目录', severity: 10 },
  { pattern: /^\s*del\s+\/f?\s*\/s?\s*\/q?\s*$/i, reason: 'Windows 强制删除', severity: 10 },
  { pattern: /^\s*format\s+[a-z]:/i, reason: '格式化驱动器', severity: 10 },
  
  // 格式化命令
  { pattern: /^\s*mkfs/i, reason: '创建文件系统', severity: 10 },
  { pattern: /^\s*dd\s+.*of=\/dev\//i, reason: '直接写入设备', severity: 10 },
  
  // 系统修改
  { pattern: /^\s*chmod\s+-R?\s+777\s+/i, reason: '设置 777 权限', severity: 8 },
  { pattern: /^\s*chown\s+-R?\s+/i, reason: '修改文件所有者', severity: 7 },
  { pattern: /^\s*rm\s+-rf\s+/i, reason: '递归强制删除', severity: 7 },
  
  // 网络操作
  { pattern: /^curl.*--output|--download|download=/i, reason: '下载文件', severity: 6 },
  { pattern: /^wget/i, reason: '下载文件', severity: 6 },
  { pattern: /exec|eval|base64.*-d|bash.*-c/i, reason: '动态代码执行', severity: 9 },
  
  // Windows 危险命令
  { pattern: /reg\s+delete|reg\s+add.*\\/i, reason: '修改注册表', severity: 8 },
  { pattern: /shutdown|restart/i, reason: '系统关机/重启', severity: 9 },
  { pattern: /taskkill|pkill/i, reason: '终止进程', severity: 6 },
] as const

/** 中等风险模式（可提示确认） */
const MODERATE_PATTERNS = [
  { pattern: /^git\s+push|^git\s+force-push/i, reason: 'Git 推送', severity: 5 },
  { pattern: /^npm\s+publish|^pip\s+upload/i, reason: '发布包', severity: 6 },
  { pattern: /^docker\s+run.*-p\s+[0-9]+:/i, reason: 'Docker 端口映射', severity: 5 },
  { pattern: /\|\s*sh|\|\s*bash|\/bin\/sh|\/bin\/bash/i, reason: '管道到 shell', severity: 7 },
  { pattern: /curl.*-X\s+POST|curl.*-d\s+['"]/i, reason: 'HTTP POST 请求', severity: 4 },
  { pattern: /localhost|127\.0\.0\.1/i, reason: '本地网络请求', severity: 2 },
] as const

// =============================================================================
// 风险评分器
// =============================================================================

/**
 * 风险评分器
 * 评估工具调用的风险等级（1-10）
 */
export class RiskScorer {
  private dangerousPatterns = DANGEROUS_PATTERNS
  private moderatePatterns = MODERATE_PATTERNS

  /**
   * 评估工具调用的风险
   */
  assess(call: ToolCall, context?: PermissionContext): RiskAssessment {
    const factors: string[] = []
    let baseLevel = this.getBaseLevel(call.name)
    let level = baseLevel

    factors.push(`工具类型: ${call.name} (基础风险: ${baseLevel})`)

    // 检查命令参数中的危险模式
    const commandStr = this.extractCommandString(call.params)
    if (commandStr) {
      // 检查高危模式
      for (const dp of this.dangerousPatterns) {
        if (dp.pattern.test(commandStr)) {
          level = Math.max(level, dp.severity)
          factors.push(`危险模式: ${dp.reason} (风险: ${dp.severity})`)
        }
      }

      // 检查中危模式
      for (const mp of this.moderatePatterns) {
        if (mp.pattern.test(commandStr)) {
          level = Math.max(level, mp.severity)
          factors.push(`中危模式: ${mp.reason} (风险: ${mp.severity})`)
        }
      }

      // 检查路径风险
      const pathRisk = this.assessPathRisk(commandStr, context?.cwd)
      if (pathRisk > 0) {
        level = Math.max(level, pathRisk)
        factors.push(`路径风险: 系统目录访问 (风险: ${pathRisk})`)
      }

      // 检查外部网络请求
      if (this.hasExternalNetwork(call.params)) {
        level = Math.max(level, 5)
        factors.push('外部网络请求')
      }
    }

    // 检查工作目录风险
    if (context?.cwd) {
      const cwdRisk = this.assessCwdRisk(context.cwd)
      if (cwdRisk > 0) {
        level = Math.max(level, cwdRisk)
        factors.push(`工作目录风险: ${context.cwd} (风险: ${cwdRisk})`)
      }
    }

    return {
      level: Math.min(10, level),
      factors,
      isDangerous: level >= 7,
    }
  }

  /**
   * 获取工具的基础风险等级
   */
  private getBaseLevel(toolName: string): number {
    const readTools = ['read_file', 'grep', 'glob', 'find']
    const writeTools = ['write_file', 'edit_file', 'create_file', 'delete_file']
    const shellTools = ['execute_command', 'bash', 'shell', 'cmd', 'powershell']
    const networkTools = ['http_request', 'fetch', 'curl', 'wget']
    const adminTools = ['sudo', 'su', 'chmod', 'chown']

    if (readTools.includes(toolName)) return 1
    if (writeTools.includes(toolName)) return 3
    if (networkTools.includes(toolName)) return 4
    if (shellTools.includes(toolName)) return 6
    if (adminTools.includes(toolName)) return 9

    return 3 // 默认中等风险
  }

  /**
   * 从参数中提取命令字符串
   * 注意：path 是文件路径，不是命令，不应参与危险模式匹配
   */
  private extractCommandString(params: Record<string, unknown>): string | null {
    if (typeof params.command === 'string') return params.command
    if (typeof params.cmd === 'string') return params.cmd
    if (typeof params.script === 'string') return params.script
    if (typeof params.url === 'string') return params.url
    // 注意：不再提取 path 参数作为命令字符串
    // path 是文件路径，其风险由工具类型（read/write）决定，而非路径本身
    return null
  }

  /**
   * 检查是否有外部网络请求
   */
  private hasExternalNetwork(params: Record<string, unknown>): boolean {
    const url = params.url as string | undefined
    if (!url) return false
    
    // 排除 localhost/127.0.0.1
    if (url.includes('localhost') || url.includes('127.0.0.1')) return false
    
    // 检查是否为 HTTP/HTTPS URL
    return /^https?:\/\//i.test(url)
  }

  /**
   * 评估路径风险
   */
  private assessPathRisk(command: string, cwd?: string): number {
    const systemPaths = [
      '/bin', '/sbin', '/usr/sbin', '/etc', '/boot', '/sys', '/proc', '/dev',
      'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
      'C:\\System32', 'C:\\ProgramData',
    ]

    const fullPath = cwd ? resolve(cwd, command) : command

    for (const sp of systemPaths) {
      if (fullPath.toLowerCase().includes(sp.toLowerCase())) {
        return 6
      }
    }

    return 0
  }

  /**
   * 评估工作目录风险
   */
  private assessCwdRisk(cwd: string): number {
    const sensitiveDirs = [
      '/', '/root', '/home', '/etc', '/var', '/usr',
      'C:\\', 'C:\\Windows', 'C:\\Program Files',
    ]

    for (const dir of sensitiveDirs) {
      if (resolve(cwd).toLowerCase() === resolve(dir).toLowerCase()) {
        return 3
      }
    }

    return 0
  }

  /**
   * 检查特定危险模式（用于即时拦截）
   */
  matchesDangerousPattern(command: string): { match: boolean; reason: string; severity: number } | null {
    for (const dp of this.dangerousPatterns) {
      if (dp.pattern.test(command)) {
        return { match: true, reason: dp.reason, severity: dp.severity }
      }
    }
    return null
  }
}

// =============================================================================
// 权限门
// =============================================================================

/**
 * 权限门错误
 */
export class PermissionError extends Error {
  constructor(
    message: string,
    public readonly toolCall: ToolCall,
    public readonly riskLevel?: number
  ) {
    super(message)
    this.name = 'PermissionError'
  }
}

/**
 * 需要确认错误（用于 interactive/default 模式）
 */
export class NeedConfirmationError extends Error {
  constructor(
    message: string,
    public readonly toolCall: ToolCall,
    public readonly riskLevel: number,
    public readonly requestId?: string
  ) {
    super(message)
    this.name = 'NeedConfirmationError'
  }
}

/**
 * 权限门
 * 根据当前模式决定是否允许工具调用
 */
export class PermissionGate {
  private mode: PermissionMode
  private riskScorer: RiskScorer
  private context: PermissionContext
  private workflow: PermissionWorkflowStore | null

  constructor(
    initialMode: PermissionMode = 'default',
    context: PermissionContext = {},
    workflow?: PermissionWorkflowStore | null,
  ) {
    this.mode = initialMode
    this.riskScorer = new RiskScorer()
    this.context = context
    this.workflow = workflow ?? null
  }

  /**
   * 检查工具调用是否被允许
   */
  check(call: ToolCall): PermissionDecision {
    const risk = this.riskScorer.assess(call, this.context)
    const fingerprint = createToolFingerprint(call)

    const matchedApproval = this.workflow?.getMatchingApproval(
      call,
      this.context.sessionId,
      this.context.userId,
    )

    if (matchedApproval) {
      const decision = {
        approved: true,
        reason: `审批工作流：已存在${matchedApproval.scope}级授权`,
        riskLevel: risk.level,
      } satisfies PermissionDecision
      this.logDecision(call, decision, fingerprint)
      return decision
    }

    let decision: PermissionDecision
    switch (this.mode) {
      case 'bypass':
        decision = {
          approved: true,
          reason: 'bypass 模式：所有工具自动批准',
          riskLevel: risk.level,
        }
        break

      case 'plan':
        decision = this.checkPlanMode(call, risk)
        break

      case 'sandbox':
        decision = this.checkSandboxMode(call, risk)
        break

      case 'restricted':
        decision = this.checkRestrictedMode(call, risk)
        break

      case 'interactive':
        decision = {
          approved: false,
          reason: `interactive 模式：所有工具需要确认`,
          requiresConfirmation: true,
          riskLevel: risk.level,
        }
        break

      case 'auto':
        decision = this.checkAutoMode(call, risk)
        break

      case 'default':
      default:
        decision = this.checkDefaultMode(call, risk)
        break
    }

    this.logDecision(call, decision, fingerprint)
    return decision
  }

  /**
   * 检查工具调用（异步，支持需要确认的交互）
   *
   * 规则：
   * - bypass 模式：所有操作直接批准
   * - 高风险（>=9）或危险命令 → 抛出 PermissionError
   * - 需要确认 → 抛出 NeedConfirmationError
   * - 通过 → 返回决策
   */
  async checkAsync(call: ToolCall): Promise<PermissionDecision> {
    // bypass 模式：跳过所有检查，直接批准
    if (this.mode === 'bypass') {
      return {
        approved: true,
        reason: 'bypass 模式：所有操作自动批准',
        riskLevel: 0,
      }
    }

    const result = this.check(call)

    // 高风险（>=9）或危险命令直接拒绝
    const isHighRisk = result.riskLevel !== undefined && result.riskLevel >= 9
    if (isHighRisk || result.riskLevel === 10) {
      throw new PermissionError(
        `危险操作被自动拒绝: ${result.reason}`,
        call,
        result.riskLevel
      )
    }

    // 需要确认时抛出 NeedConfirmationError
    if (result.requiresConfirmation) {
      const request = this.workflow?.createPendingRequest(call, {
        sessionId: this.context.sessionId,
        userId: this.context.userId,
        riskLevel: result.riskLevel,
        reason: result.reason,
      })
      throw new NeedConfirmationError(
        `需要确认: ${result.reason}`,
        call,
        result.riskLevel ?? 3,
        request?.id,
      )
    }

    if (!result.approved) {
      throw new PermissionError(
        `操作被拒绝: ${result.reason}`,
        call,
        result.riskLevel
      )
    }

    return result
  }

  /**
   * 默认模式：读取自动批准，写入/网络/Shell 需确认
   */
  private checkDefaultMode(call: ToolCall, risk: RiskAssessment): PermissionDecision {
    const readTools = ['read_file', 'grep', 'glob', 'find', 'search']
    const writeTools = ['write_file', 'edit_file', 'create_file', 'delete_file', 'mkdir']
    const shellTools = ['execute_command', 'bash', 'shell', 'cmd', 'powershell', 'exec']
    const networkTools = ['http_request', 'fetch', 'curl', 'wget']

    if (readTools.includes(call.name)) {
      return {
        approved: true,
        reason: 'default 模式：读取操作自动批准',
        riskLevel: risk.level,
      }
    }

    if (writeTools.includes(call.name) || networkTools.includes(call.name)) {
      return {
        approved: false,
        reason: `default 模式：写入/网络操作需要确认 (${risk.level}/10)`,
        requiresConfirmation: true,
        riskLevel: risk.level,
      }
    }

    if (shellTools.includes(call.name)) {
      if (risk.isDangerous) {
        return {
          approved: false,
          reason: `default 模式：危险 Shell 命令被拒绝 (${risk.level}/10)`,
          riskLevel: risk.level,
        }
      }
      return {
        approved: false,
        reason: `default 模式：Shell 操作需要确认 (${risk.level}/10)`,
        requiresConfirmation: true,
        riskLevel: risk.level,
      }
    }

    // 未知工具，默认需要确认
    return {
      approved: false,
      reason: `default 模式：未知工具 ${call.name} 需要确认`,
      requiresConfirmation: true,
      riskLevel: risk.level,
    }
  }

  /**
   * Plan 模式：只读，禁止所有写入和 Shell
   */
  private checkPlanMode(call: ToolCall, risk: RiskAssessment): PermissionDecision {
    const readTools = ['read_file', 'grep', 'glob', 'find', 'search', 'http_request']
    const writeTools = ['write_file', 'edit_file', 'create_file', 'delete_file', 'mkdir']
    const shellTools = ['execute_command', 'bash', 'shell', 'cmd', 'powershell', 'exec']

    if (readTools.includes(call.name)) {
      return {
        approved: true,
        reason: 'plan 模式：读取操作允许',
        riskLevel: risk.level,
      }
    }

    if (writeTools.includes(call.name)) {
      return {
        approved: false,
        reason: 'plan 模式：禁止写入操作',
        riskLevel: risk.level,
      }
    }

    if (shellTools.includes(call.name)) {
      return {
        approved: false,
        reason: 'plan 模式：禁止 Shell 操作',
        riskLevel: risk.level,
      }
    }

    return {
      approved: false,
      reason: `plan 模式：${call.name} 不在允许列表`,
      riskLevel: risk.level,
    }
  }

  /**
   * 自动模式：基于风险评分自动决策
   * - 风险 1-3：自动批准
   * - 风险 4-6：需要确认
   * - 风险 7-10：自动拒绝
   */
  private checkAutoMode(call: ToolCall, risk: RiskAssessment): PermissionDecision {
    if (risk.level <= 3) {
      return {
        approved: true,
        reason: `auto 模式：低风险操作自动批准 (${risk.level}/10)`,
        riskLevel: risk.level,
      }
    }

    if (risk.level <= 6) {
      return {
        approved: false,
        reason: `auto 模式：中等风险需要确认 (${risk.level}/10)`,
        requiresConfirmation: true,
        riskLevel: risk.level,
      }
    }

    return {
      approved: false,
      reason: `auto 模式：高风险操作自动拒绝 (${risk.level}/10)`,
      riskLevel: risk.level,
    }
  }

  /**
   * 沙箱模式：限制读取 + 受限 Shell
   * 允许：读取文件、有限 shell（echo, ls, cd, pwd 等）
   * 禁止：写入、删除、网络请求、危险命令
   */
  private checkSandboxMode(call: ToolCall, risk: RiskAssessment): PermissionDecision {
    const readTools = ['read_file', 'grep', 'glob', 'find', 'search']
    const safeShellCommands = ['ls', 'pwd', 'cd', 'echo', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'find', 'which']

    // 信任目录检查仅对文件工具生效，shell 命令不适用
    if (this.context.trustedDirectories && this.context.trustedDirectories.length > 0) {
      const path = (call.params.path as string) || ''
      if (path && !readTools.includes(call.name)) {
        // 对于非读取工具的路径操作，检查信任目录
        const inTrustedDir = this.context.trustedDirectories.some(trusted => 
          resolve(path).startsWith(resolve(trusted))
        )
        if (!inTrustedDir) {
          return {
            approved: false,
            reason: 'sandbox 模式：只能在信任目录操作',
            riskLevel: risk.level,
          }
        }
      }
    }

    if (readTools.includes(call.name)) {
      return {
        approved: true,
        reason: 'sandbox 模式：读取操作允许',
        riskLevel: risk.level,
      }
    }

    // Shell 工具需要检查具体命令
    if (call.name === 'execute_command') {
      const command = (call.params.command as string) || ''
      const baseCmd = basename(command.split(/\s+/)[0] || '').toLowerCase()

      // 检查是否包含危险模式
      if (risk.isDangerous) {
        return {
          approved: false,
          reason: `sandbox 模式：危险命令被拒绝`,
          riskLevel: risk.level,
        }
      }

      // 检查是否为安全命令（支持带参数的命令）
      // 使用单词边界检测：ls, ls -la, cat file.txt 都匹配
      const isSafeCmd = safeShellCommands.some(safe => 
        command.toLowerCase() === safe ||  // 完全匹配
        command.toLowerCase().startsWith(`${safe} `) ||  // ls -la
        command.toLowerCase().includes(` ${safe} `) ||  // cat | ls
        command.toLowerCase().endsWith(` ${safe}`)  //末尾的 ls
      )

      if (isSafeCmd) {
        return {
          approved: true,
          reason: 'sandbox 模式：安全命令允许',
          riskLevel: risk.level,
        }
      }

      return {
        approved: false,
        reason: `sandbox 模式：${baseCmd} 不在安全命令列表`,
        riskLevel: risk.level,
      }
    }

    // 网络请求需要确认（可能泄露数据）
    if (call.name === 'http_request') {
      return {
        approved: false,
        reason: 'sandbox 模式：网络请求需要确认',
        requiresConfirmation: true,
        riskLevel: risk.level,
      }
    }

    return {
      approved: false,
      reason: `sandbox 模式：${call.name} 不在允许列表`,
      riskLevel: risk.level,
    }
  }

  /**
   * 受限模式：仅允许预批准的白名单工具
   */
  private checkRestrictedMode(call: ToolCall, risk: RiskAssessment): PermissionDecision {
    const whitelist = this.context.toolWhitelist || []

    if (whitelist.length === 0) {
      return {
        approved: false,
        reason: 'restricted 模式：白名单为空，所有操作被拒绝',
        riskLevel: risk.level,
      }
    }

    if (whitelist.includes(call.name)) {
      return {
        approved: true,
        reason: `restricted 模式：${call.name} 在白名单中`,
        riskLevel: risk.level,
      }
    }

    return {
      approved: false,
      reason: `restricted 模式：${call.name} 不在白名单中`,
      riskLevel: risk.level,
    }
  }

  // =============================================================================
  // 配置方法
  // =============================================================================

  /**
   * 切换权限模式
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /**
   * 获取当前模式
   */
  getMode(): PermissionMode {
    return this.mode
  }

  /**
   * 更新上下文
   */
  setContext(context: Partial<PermissionContext>): void {
    this.context = { ...this.context, ...context }
  }

  /**
   * 获取当前上下文
   */
  getContext(): PermissionContext {
    return { ...this.context }
  }

  /**
   * 设置白名单（restricted 模式）
   */
  setWhitelist(tools: string[]): void {
    this.context.toolWhitelist = tools
  }

  /**
   * 添加信任目录（sandbox 模式）
   */
  addTrustedDirectory(dir: string): void {
    if (!this.context.trustedDirectories) {
      this.context.trustedDirectories = []
    }
    this.context.trustedDirectories.push(dir)
  }

  /**
   * 绑定/替换审批工作流存储
   */
  setWorkflow(workflow: PermissionWorkflowStore | null): void {
    this.workflow = workflow
  }

  getWorkflow(): PermissionWorkflowStore | null {
    return this.workflow
  }

  /**
   * 手动登记授权结果，供确认后重试使用。
   */
  registerApproval(
    call: ToolCall,
    options: {
      scope?: ApprovalScope
      ttlMs?: number
      note?: string
      remainingUses?: number
    } = {},
  ): void {
    this.workflow?.registerApproval(call, {
      scope: options.scope,
      ttlMs: options.ttlMs,
      note: options.note,
      remainingUses: options.remainingUses,
      sessionId: this.context.sessionId,
      userId: this.context.userId,
    })
  }

  resolvePendingRequest(requestId: string, approved: boolean): void {
    this.workflow?.resolvePendingRequest(requestId, approved)
  }

  private logDecision(call: ToolCall, decision: PermissionDecision, fingerprint: string): void {
    this.workflow?.logDecision({
      toolName: call.name,
      fingerprint,
      approved: decision.approved,
      reason: decision.reason,
      riskLevel: decision.riskLevel,
      mode: this.mode,
      sessionId: this.context.sessionId,
      userId: this.context.userId,
    })
  }
}

// =============================================================================
// 便捷函数
// =============================================================================

let _defaultGate: PermissionGate | null = null

/**
 * 获取默认权限门实例（单例）
 */
export function getDefaultGate(): PermissionGate {
  if (!_defaultGate) {
    _defaultGate = new PermissionGate()
  }
  return _defaultGate
}

/**
 * 重置默认权限门
 */
export function resetDefaultGate(): void {
  _defaultGate = null
}

/**
 * 快速权限检查
 */
export function quickCheck(call: ToolCall, mode?: PermissionMode): PermissionDecision {
  const gate = new PermissionGate(mode || 'default')
  return gate.check(call)
}

/**
 * 评估风险等级
 */
export function assessRisk(call: ToolCall, context?: PermissionContext): RiskAssessment {
  const gate = new PermissionGate()
  const scorer = new RiskScorer()
  return scorer.assess(call, context)
}
