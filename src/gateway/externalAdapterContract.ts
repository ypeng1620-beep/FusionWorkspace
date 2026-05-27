import type { ChannelType } from './gateway.js'

export interface NormalizedExternalInbound {
  channel: ChannelType
  messageId: string
  externalUserId: string
  content: string
  metadata: Record<string, unknown> & {
    signature?: string
    provider: string
  }
}

export interface WeChatInboundPayload {
  signature?: string
  body: {
    MsgId?: string
    FromUserName?: string
    ToUserName?: string
    MsgType?: string
    Content?: string
    PicUrl?: string
    MediaId?: string
    Event?: string
    EventKey?: string
    CreateTime?: number
  }
}

export interface FeishuInboundPayload {
  signature?: string
  body: {
    schema?: string
    header?: {
      event_id?: string
      event_type?: string
      create_time?: string
      token?: string
      app_id?: string
      tenant_key?: string
    }
    event?: {
      message?: {
        message_id?: string
        sender?: {
          sender_id?: {
            open_id?: string
            user_id?: string
            union_id?: string
          }
          sender_type?: string
        }
        chat_id?: string
        message_type?: string
        content?: string
        create_time?: string
        update_time?: string
      }
    }
  }
}

export function normalizeWeChatInbound(payload: WeChatInboundPayload): NormalizedExternalInbound {
  const body = payload.body
  const messageId = body.MsgId ?? `${body.FromUserName ?? 'unknown'}:${body.CreateTime ?? 0}`
  const msgType = body.MsgType ?? 'unknown'

  return {
    channel: 'wechat',
    messageId,
    externalUserId: body.FromUserName ?? 'unknown',
    content: body.Content ?? body.PicUrl ?? body.EventKey ?? `[${msgType} message]`,
    metadata: {
      provider: 'wechat',
      signature: payload.signature,
      msgType,
      mediaId: body.MediaId,
      fromUserName: body.FromUserName,
      toUserName: body.ToUserName,
      event: body.Event,
      createTime: body.CreateTime,
    },
  }
}

export function normalizeFeishuInbound(payload: FeishuInboundPayload): NormalizedExternalInbound {
  const message = payload.body.event?.message
  const messageId = message?.message_id ?? payload.body.header?.event_id ?? 'unknown'
  const messageType = message?.message_type ?? 'unknown'
  const externalUserId = message?.sender?.sender_id?.open_id ?? 'unknown'

  // Warn if required fields are missing — prevents silently swallowing upstream issues
  if (!message?.message_id && !payload.body.header?.event_id) {
    console.warn('[normalizeFeishuInbound] Missing both message_id and event_id — upstream payload may be malformed')
  }
  if (!message?.sender?.sender_id?.open_id) {
    console.warn('[normalizeFeishuInbound] Missing sender open_id — user identity may be lost')
  }

  return {
    channel: 'feishu',
    messageId,
    externalUserId,
    content: extractFeishuContent(message?.content, messageType),
    metadata: {
      provider: 'feishu',
      signature: payload.signature,
      messageType,
      chatId: message?.chat_id,
      eventId: payload.body.header?.event_id,
      eventType: payload.body.header?.event_type,
      tenantKey: payload.body.header?.tenant_key,
    },
  }
}

function extractFeishuContent(content: string | undefined, messageType: string): string {
  if (!content) {
    return `[${messageType} message]`
  }
  if (messageType !== 'text') {
    return content
  }
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return parsed.text ?? content
  } catch {
    return content
  }
}
