import type { FeishuAdapterConfig } from './feishuChannel.js'
import type { WeChatAdapterConfig } from './wechatChannel.js'

const DEFAULT_RATE_LIMIT = {
  maxMessages: 60,
  windowMs: 60_000,
}

export function createWeChatProductionAdapterTemplate(): WeChatAdapterConfig {
  return {
    type: 'wechat',
    requireProductionReady: true,
    ingressGuard: {
      requireSignature: true,
      secret: '${WECHAT_INGRESS_SECRET}',
      rateLimit: { ...DEFAULT_RATE_LIMIT },
    },
    ingressAuditLogPath: '.fusion-runtime/external-ingress/wechat.jsonl',
    ingressAuditMaxBytes: 10 * 1024 * 1024,
    adapterOptions: {
      appId: '${WECHAT_APP_ID}',
      appSecret: '${WECHAT_APP_SECRET}',
      token: '${WECHAT_TOKEN}',
      path: '/wechat',
      port: 8081,
    },
  }
}

export function createFeishuProductionAdapterTemplate(): FeishuAdapterConfig {
  return {
    type: 'feishu',
    requireProductionReady: true,
    ingressGuard: {
      requireSignature: true,
      secret: '${FEISHU_INGRESS_SECRET}',
      rateLimit: { ...DEFAULT_RATE_LIMIT },
    },
    ingressAuditLogPath: '.fusion-runtime/external-ingress/feishu.jsonl',
    ingressAuditMaxBytes: 10 * 1024 * 1024,
    adapterOptions: {
      appId: '${FEISHU_APP_ID}',
      appSecret: '${FEISHU_APP_SECRET}',
      verificationToken: '${FEISHU_VERIFICATION_TOKEN}',
      path: '/feishu',
      port: 8082,
    },
  }
}
