/**
 * Adapter Schema — 适配器能力声明 + 配置 schema
 *
 * 定义 adapter 接入 core 所需的能力声明和配置结构。
 */

import { z } from 'zod'

// =============================================================================
// 适配器能力声明
// =============================================================================

export const AdapterCapabilitiesSchema = z.object({
  /** 支持富文本消息（图片、卡片、文件等） */
  richMessages: z.boolean().default(false),
  /** 支持文件上传 */
  fileUpload: z.boolean().default(false),
  /** 支持输入状态指示（typing indicator） */
  typingIndicator: z.boolean().default(false),
  /** 支持群聊 */
  groupChat: z.boolean().default(false),
  /** 支持审批按钮（微信卡片按钮等） */
  approvalButtons: z.boolean().default(false),
  /** 单条消息最大长度 */
  maxMessageLength: z.number().gte(1).default(4096),
  /** 支持流式输出 */
  supportsStreaming: z.boolean().default(false),
  /** 支持的内容类型列表 */
  supportedContentTypes: z.array(z.string()).default(['text']),
})

export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>

/** 默认能力（文本-only 通道） */
export const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  richMessages: false,
  fileUpload: false,
  typingIndicator: false,
  groupChat: false,
  approvalButtons: false,
  maxMessageLength: 4096,
  supportsStreaming: false,
  supportedContentTypes: ['text'],
}

/** WebSocket 通道能力 */
export const WEBSOCKET_CAPABILITIES: AdapterCapabilities = {
  richMessages: false,
  fileUpload: false,
  typingIndicator: false,
  groupChat: false,
  approvalButtons: false,
  maxMessageLength: 1024 * 1024,
  supportsStreaming: true,
  supportedContentTypes: ['text'],
}

/** Stdio 通道能力 */
export const STDIO_CAPABILITIES: AdapterCapabilities = {
  richMessages: false,
  fileUpload: false,
  typingIndicator: false,
  groupChat: false,
  approvalButtons: false,
  maxMessageLength: 4096,
  supportsStreaming: false,
  supportedContentTypes: ['text'],
}

// =============================================================================
// 适配器配置
// =============================================================================

export const AdapterConfigSchema = z.object({
  /** 通道类型（如 'wechat', 'feishu', 'websocket'） */
  type: z.string(),
  /** 实例 ID（同一类型多实例时用于区分） */
  instanceId: z.string().optional(),
  /** 能力声明 */
  capabilities: AdapterCapabilitiesSchema.optional(),
  /** 心跳间隔（毫秒） */
  heartbeatInterval: z.number().optional(),
  /** 连接超时（毫秒） */
  connectionTimeout: z.number().optional(),
  /** 最大消息大小（字节） */
  maxMessageSize: z.number().optional(),
  /** 适配器私有配置（如 appSecret, corpId 等） */
  adapterOptions: z.record(z.string(), z.unknown()).optional(),
})

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>

// =============================================================================
// 适配器状态
// =============================================================================

export const AdapterStatusSchema = z.object({
  type: z.string(),
  instanceId: z.string(),
  capabilities: AdapterCapabilitiesSchema,
  connected: z.boolean(),
  activeConversations: z.number(),
  lastEventAt: z.number(),
  rateLimitRemaining: z.number().optional(),
  errorMessage: z.string().optional(),
})

export type AdapterStatus = z.infer<typeof AdapterStatusSchema>
