/**
 * Message Protocol — 核心消息类型定义 + Zod schema
 *
 * 定义 core ↔ adapter 之间的所有协议消息类型。
 * 每条消息都有 Zod schema（运行时校验）+ TS interface（编译时校验）。
 */

import { z } from 'zod'

// =============================================================================
// 消息类型枚举
// =============================================================================

/** 出站消息类型（core → adapter） */
export type OutboundMessageType =
  | 'welcome'
  | 'confirmation_required'
  | 'approval_ack'
  | 'approval_expired'
  | 'assistant_response'
  | 'tool_result'
  | 'progress_update'
  | 'error'

/** 入站消息类型（adapter → core） */
export type InboundMessageType =
  | 'user_message'
  | 'approval_response'
  | 'cancel_request'
  | 'session_context_restore'
  | 'rich_message'

/** 联合类型 */
export type MessageType = OutboundMessageType | InboundMessageType

// =============================================================================
// 出站消息 Payload Schema
// =============================================================================

export const WelcomePayloadSchema = z.object({
  sessionId: z.string(),
  channel: z.string(),
  message: z.string(),
})
export type WelcomePayload = z.infer<typeof WelcomePayloadSchema>

export const ConfirmationRequiredPayloadSchema = z.object({
  requestId: z.string().uuid(),
  toolName: z.string(),
  params: z.record(z.string(), z.unknown()),
  riskLevel: z.number().gte(1).lte(10),
  message: z.string(),
})
export type ConfirmationRequiredPayload = z.infer<typeof ConfirmationRequiredPayloadSchema>

export const ApprovalAckPayloadSchema = z.object({
  requestId: z.string().uuid(),
  approved: z.boolean(),
  resolved: z.boolean(),
})
export type ApprovalAckPayload = z.infer<typeof ApprovalAckPayloadSchema>

export const ApprovalExpiredPayloadSchema = z.object({
  requestId: z.string().uuid(),
  toolName: z.string(),
  message: z.string(),
})
export type ApprovalExpiredPayload = z.infer<typeof ApprovalExpiredPayloadSchema>

export const AssistantResponsePayloadSchema = z.object({
  text: z.string(),
  steps: z.number().optional(),
  toolCalls: z.number().optional(),
  stopReason: z.string().nullable().optional(),
})
export type AssistantResponsePayload = z.infer<typeof AssistantResponsePayloadSchema>

export const ToolResultPayloadSchema = z.object({
  toolName: z.string(),
  success: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
})
export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>

export const ProgressUpdatePayloadSchema = z.object({
  phase: z.enum(['thinking', 'tool_call', 'step_start', 'step_end']),
  message: z.string(),
  step: z.number().optional(),
})
export type ProgressUpdatePayload = z.infer<typeof ProgressUpdatePayloadSchema>

export const ErrorPayloadSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  recoverable: z.boolean().default(false),
  suggestion: z.string().optional(),
})
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>

// =============================================================================
// 入站消息 Payload Schema
// =============================================================================

export const UserMessagePayloadSchema = z.object({
  text: z.string(),
})
export type UserMessagePayload = z.infer<typeof UserMessagePayloadSchema>

export const ApprovalResponsePayloadSchema = z.object({
  requestId: z.string().uuid(),
  approved: z.boolean(),
  note: z.string().optional(),
})
export type ApprovalResponsePayload = z.infer<typeof ApprovalResponsePayloadSchema>

export const CancelRequestPayloadSchema = z.object({
  sessionId: z.string().optional(),
  reason: z.string().optional(),
})
export type CancelRequestPayload = z.infer<typeof CancelRequestPayloadSchema>

export const SessionContextRestorePayloadSchema = z.object({
  sessionId: z.string().optional(),
  conversationId: z.string().optional(),
})
export type SessionContextRestorePayload = z.infer<typeof SessionContextRestorePayloadSchema>

export const RichMessagePayloadSchema = z.object({
  contentType: z.string(),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type RichMessagePayload = z.infer<typeof RichMessagePayloadSchema>

// =============================================================================
// 联合 Schema（用于运行时解析）
// =============================================================================

export const OutboundPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), data: WelcomePayloadSchema }),
  z.object({ type: z.literal('confirmation_required'), data: ConfirmationRequiredPayloadSchema }),
  z.object({ type: z.literal('approval_ack'), data: ApprovalAckPayloadSchema }),
  z.object({ type: z.literal('approval_expired'), data: ApprovalExpiredPayloadSchema }),
  z.object({ type: z.literal('assistant_response'), data: AssistantResponsePayloadSchema }),
  z.object({ type: z.literal('tool_result'), data: ToolResultPayloadSchema }),
  z.object({ type: z.literal('progress_update'), data: ProgressUpdatePayloadSchema }),
  z.object({ type: z.literal('error'), data: ErrorPayloadSchema }),
])

export const InboundPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), data: UserMessagePayloadSchema }),
  z.object({ type: z.literal('approval_response'), data: ApprovalResponsePayloadSchema }),
  z.object({ type: z.literal('cancel_request'), data: CancelRequestPayloadSchema }),
  z.object({ type: z.literal('session_context_restore'), data: SessionContextRestorePayloadSchema }),
  z.object({ type: z.literal('rich_message'), data: RichMessagePayloadSchema }),
])

// =============================================================================
// 辅助函数
// =============================================================================

/** 解析入站消息 payload（优先从结构化 payload 字段，fallback 解析 content 字符串） */
export function parseInboundMessage(
  content: string,
  type?: InboundMessageType,
  payload?: Record<string, unknown>,
): { type: InboundMessageType; data: Record<string, unknown> } {
  // 优先使用结构化 payload
  if (type && payload) {
    return { type, data: payload }
  }

  // Fallback: 从 content 字符串解析
  try {
    const parsed = JSON.parse(content)
    if (parsed.type) {
      return { type: parsed.type as InboundMessageType, data: parsed }
    }
    // 无 type 字段，视为普通用户消息
    return { type: 'user_message', data: { text: content } }
  } catch {
    return { type: 'user_message', data: { text: content } }
  }
}

/** 构建出站消息（同时设置 type/payload 和 content fallback） */
export function buildOutboundMessage(
  type: OutboundMessageType,
  data: Record<string, unknown>,
): { type: OutboundMessageType; payload: Record<string, unknown>; content: string } {
  return {
    type,
    payload: data,
    content: JSON.stringify({ type, ...data }),
  }
}
