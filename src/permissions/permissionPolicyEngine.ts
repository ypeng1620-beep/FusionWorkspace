/**
 * Permission Policy Engine — 渠道/身份维度权限决策
 *
 * 将权限从"本地判断器"升级为"策略引擎"：
 * - 按渠道（微信/飞书/WebSocket/Stdio）应用不同策略
 * - 按用户身份（用户 ID、群聊 ID、角色）应用不同白名单
 * - 按 Agent 角色（admin/editor/viewer）限制操作范围
 * - 支持策略继承和覆盖
 */

import type { PermissionMode } from './permissionGate.js'

// =============================================================================
// 类型定义
// =============================================================================

/** 渠道类型 */
export type ChannelId = 'wechat' | 'feishu' | 'websocket' | 'stdio' | 'webhook' | (string & {})

/** 用户角色 */
export type UserRole = 'admin' | 'editor' | 'viewer' | 'guest'

/** 身份上下文 */
export interface IdentityContext {
  /** 用户 ID */
  userId: string
  /** 渠道 */
  channel: ChannelId
  /** 群聊/频道 ID（可选） */
  groupId?: string
  /** 用户角色 */
  role: UserRole
  /** 是否是首次交互 */
  isFirstInteraction: boolean
  /** 信任等级（0-1，基于历史行为） */
  trustLevel: number
}

/** 工具类别 */
export type ToolCategory = 'read' | 'write' | 'execute' | 'network' | 'admin'

/** 渠道策略 */
export interface ChannelPolicy {
  /** 渠道 ID */
  channelId: ChannelId
  /** 默认权限模式 */
  defaultMode: PermissionMode
  /** 允许的工具类别 */
  allowedCategories: ToolCategory[]
  /** 禁止的工具名称（黑名单） */
  blockedTools: string[]
  /** 最大单次工具调用数 */
  maxToolCallsPerTurn: number
  /** 是否需要审批（按风险等级阈值） */
  approvalThreshold: number
  /** 是否允许文件操作 */
  allowFileOperations: boolean
  /** 是否允许 Shell 命令 */
  allowShellCommands: boolean
  /** 消息长度限制 */
  maxMessageLength: number
  /** 每日调用限制 */
  dailyCallLimit?: number
}

/** 用户策略 */
export interface UserPolicy {
  /** 用户 ID */
  userId: string
  /** 用户角色 */
  role: UserRole
  /** 覆盖的权限模式（如果设置则覆盖渠道默认值） */
  overrideMode?: PermissionMode
  /** 额外允许的工具 */
  extraAllowedTools: string[]
  /** 额外禁止的工具 */
  extraBlockedTools: string[]
  /** 信任目录（sandbox 模式） */
  trustedDirectories: string[]
  /** 信任等级 */
  trustLevel: number
  /** 备注 */
  note?: string
}

/** 群聊策略 */
export interface GroupPolicy {
  /** 群聊 ID */
  groupId: string
  /** 群聊权限模式 */
  mode: PermissionMode
  /** 群聊成员角色映射 */
  memberRoles: Record<string, UserRole>
  /** 群聊特定白名单 */
  whitelist: string[]
  /** 备注 */
  note?: string
}

/** 策略决策结果 */
export interface PolicyDecision {
  /** 是否允许 */
  allowed: boolean
  /** 使用的权限模式 */
  mode: PermissionMode
  /** 原因 */
  reason: string
  /** 是否需要审批 */
  requiresApproval: boolean
  /** 审批阈值 */
  approvalThreshold: number
  /** 应用的策略 ID */
  appliedPolicy: string
}

// =============================================================================
// 默认渠道策略
// =============================================================================

/** WebSocket 默认策略（开发调试，较宽松） */
export const WEBSOCKET_POLICY: ChannelPolicy = {
  channelId: 'websocket',
  defaultMode: 'default',
  allowedCategories: ['read', 'write', 'execute', 'network'],
  blockedTools: [],
  maxToolCallsPerTurn: 20,
  approvalThreshold: 7,
  allowFileOperations: true,
  allowShellCommands: true,
  maxMessageLength: 1024 * 1024,
}

/** Stdio 默认策略（CLI，中等） */
export const STDIO_POLICY: ChannelPolicy = {
  channelId: 'stdio',
  defaultMode: 'default',
  allowedCategories: ['read', 'write', 'execute', 'network'],
  blockedTools: [],
  maxToolCallsPerTurn: 15,
  approvalThreshold: 6,
  allowFileOperations: true,
  allowShellCommands: true,
  maxMessageLength: 4096,
}

/** 微信默认策略（严格） */
export const WECHAT_POLICY: ChannelPolicy = {
  channelId: 'wechat',
  defaultMode: 'auto',
  allowedCategories: ['read', 'write'],
  blockedTools: ['execute_command'],
  maxToolCallsPerTurn: 5,
  approvalThreshold: 4,
  allowFileOperations: false,
  allowShellCommands: false,
  maxMessageLength: 2048,
  dailyCallLimit: 100,
}

/** 飞书默认策略（中等严格） */
export const FEISHU_POLICY: ChannelPolicy = {
  channelId: 'feishu',
  defaultMode: 'auto',
  allowedCategories: ['read', 'write', 'network'],
  blockedTools: [],
  maxToolCallsPerTurn: 10,
  approvalThreshold: 5,
  allowFileOperations: true,
  allowShellCommands: false,
  maxMessageLength: 4096,
  dailyCallLimit: 200,
}

// =============================================================================
// 权限策略引擎
// =============================================================================

export class PermissionPolicyEngine {
  private channelPolicies: Map<ChannelId, ChannelPolicy> = new Map()
  private userPolicies: Map<string, UserPolicy> = new Map()
  private groupPolicies: Map<string, GroupPolicy> = new Map()

  constructor() {
    // 注册默认渠道策略
    this.registerChannelPolicy(WEBSOCKET_POLICY)
    this.registerChannelPolicy(STDIO_POLICY)
    this.registerChannelPolicy(WECHAT_POLICY)
    this.registerChannelPolicy(FEISHU_POLICY)
  }

  /** 注册渠道策略 */
  registerChannelPolicy(policy: ChannelPolicy): void {
    this.channelPolicies.set(policy.channelId, policy)
  }

  /** 注册用户策略 */
  registerUserPolicy(policy: UserPolicy): void {
    this.userPolicies.set(policy.userId, policy)
  }

  /** 注册群聊策略 */
  registerGroupPolicy(policy: GroupPolicy): void {
    this.groupPolicies.set(policy.groupId, policy)
  }

  /**
   * 决策：给定身份上下文和工具调用，是否允许
   */
  evaluate(identity: IdentityContext, toolName: string, toolCategory: ToolCategory, riskLevel: number): PolicyDecision {
    // 1. 获取渠道策略
    const channelPolicy = this.channelPolicies.get(identity.channel) ?? this.getDefaultChannelPolicy()

    // 2. 获取用户策略
    const userPolicy = this.userPolicies.get(identity.userId)

    // 3. 获取群聊策略
    const groupPolicy = identity.groupId ? this.groupPolicies.get(identity.groupId) : undefined

    // 4. 检查工具是否在渠道黑名单
    if (channelPolicy.blockedTools.includes(toolName)) {
      return {
        allowed: false,
        mode: channelPolicy.defaultMode,
        reason: `Tool '${toolName}' is blocked on channel '${identity.channel}'`,
        requiresApproval: false,
        approvalThreshold: channelPolicy.approvalThreshold,
        appliedPolicy: `channel:${identity.channel}`,
      }
    }

    // 5. 检查工具类别是否允许
    if (!channelPolicy.allowedCategories.includes(toolCategory)) {
      return {
        allowed: false,
        mode: channelPolicy.defaultMode,
        reason: `Category '${toolCategory}' not allowed on channel '${identity.channel}'`,
        requiresApproval: false,
        approvalThreshold: channelPolicy.approvalThreshold,
        appliedPolicy: `channel:${identity.channel}`,
      }
    }

    // 6. 检查文件/Shell 限制
    if (toolCategory === 'write' && !channelPolicy.allowFileOperations) {
      return {
        allowed: false,
        mode: channelPolicy.defaultMode,
        reason: `File operations not allowed on channel '${identity.channel}'`,
        requiresApproval: false,
        approvalThreshold: channelPolicy.approvalThreshold,
        appliedPolicy: `channel:${identity.channel}`,
      }
    }

    if (toolCategory === 'execute' && !channelPolicy.allowShellCommands) {
      return {
        allowed: false,
        mode: channelPolicy.defaultMode,
        reason: `Shell commands not allowed on channel '${identity.channel}'`,
        requiresApproval: false,
        approvalThreshold: channelPolicy.approvalThreshold,
        appliedPolicy: `channel:${identity.channel}`,
      }
    }

    // 7. 用户策略覆盖
    let effectiveMode = channelPolicy.defaultMode
    let effectiveBlockedTools = [...channelPolicy.blockedTools]
    let effectiveAllowedTools = [...channelPolicy.allowedCategories]

    if (userPolicy) {
      if (userPolicy.overrideMode) {
        effectiveMode = userPolicy.overrideMode
      }
      effectiveBlockedTools = [...effectiveBlockedTools, ...userPolicy.extraBlockedTools]
      if (effectiveBlockedTools.includes(toolName)) {
        return {
          allowed: false,
          mode: effectiveMode,
          reason: `Tool '${toolName}' is blocked for user '${identity.userId}'`,
          requiresApproval: false,
          approvalThreshold: channelPolicy.approvalThreshold,
          appliedPolicy: `user:${identity.userId}`,
        }
      }
      if (userPolicy.extraAllowedTools.includes(toolName)) {
        return {
          allowed: true,
          mode: effectiveMode,
          reason: `Tool '${toolName}' explicitly allowed for user '${identity.userId}'`,
          requiresApproval: riskLevel >= channelPolicy.approvalThreshold,
          approvalThreshold: channelPolicy.approvalThreshold,
          appliedPolicy: `user:${identity.userId}`,
        }
      }
    }

    // 8. 群聊策略覆盖
    if (groupPolicy) {
      effectiveMode = groupPolicy.mode
      if (groupPolicy.whitelist.includes(toolName)) {
        return {
          allowed: true,
          mode: effectiveMode,
          reason: `Tool '${toolName}' whitelisted in group '${identity.groupId}'`,
          requiresApproval: riskLevel >= channelPolicy.approvalThreshold,
          approvalThreshold: channelPolicy.approvalThreshold,
          appliedPolicy: `group:${identity.groupId}`,
        }
      }
    }

    // 9. 高风险工具需要审批
    const requiresApproval = riskLevel >= channelPolicy.approvalThreshold

    return {
      allowed: true,
      mode: effectiveMode,
      reason: `Allowed by channel '${identity.channel}' policy`,
      requiresApproval,
      approvalThreshold: channelPolicy.approvalThreshold,
      appliedPolicy: `channel:${identity.channel}`,
    }
  }

  /** 获取渠道的信任目录 */
  getTrustedDirectories(identity: IdentityContext): string[] {
    const userPolicy = this.userPolicies.get(identity.userId)
    if (userPolicy) {
      return userPolicy.trustedDirectories
    }
    return []
  }

  /** 获取渠道的最大工具调用数 */
  getMaxToolCallsPerTurn(channel: ChannelId): number {
    const policy = this.channelPolicies.get(channel)
    return policy?.maxToolCallsPerTurn ?? 10
  }

  /** 获取所有已注册的渠道 */
  getRegisteredChannels(): ChannelId[] {
    return Array.from(this.channelPolicies.keys())
  }

  /** 获取策略统计 */
  getStats(): Record<string, number> {
    return {
      channelPolicies: this.channelPolicies.size,
      userPolicies: this.userPolicies.size,
      groupPolicies: this.groupPolicies.size,
    }
  }

  private getDefaultChannelPolicy(): ChannelPolicy {
    return {
      channelId: 'unknown',
      defaultMode: 'auto',
      allowedCategories: ['read'],
      blockedTools: [],
      maxToolCallsPerTurn: 5,
      approvalThreshold: 3,
      allowFileOperations: false,
      allowShellCommands: false,
      maxMessageLength: 4096,
    }
  }
}
