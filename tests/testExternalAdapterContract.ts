import {
  normalizeFeishuInbound,
  normalizeWeChatInbound,
} from '../src/gateway/externalAdapterContract.js'
import { ExternalChannel } from '../src/gateway/externalChannel.js'
import type { ChannelMessage } from '../src/gateway/gateway.js'
import { existsSync } from 'fs'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
  console.log(`  ok ${message}`)
}

function section(name: string): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('='.repeat(60))
}

section('External Adapter Contract Tests')

async function testWeChatPayloadNormalizesToGuardInput(): Promise<void> {
  console.log('\n1. wechat normalize...')
  const normalized = normalizeWeChatInbound({
    signature: 'secret-1:wx-1',
    body: {
      MsgId: 'wx-1',
      FromUserName: 'open-1',
      ToUserName: 'bot-1',
      MsgType: 'text',
      Content: 'hello wechat',
      CreateTime: 1777248552,
    },
  })

  assert(normalized.channel === 'wechat', 'wechat channel is fixed')
  assert(normalized.messageId === 'wx-1', 'wechat message id is preserved')
  assert(normalized.externalUserId === 'open-1', 'wechat sender is external user')
  assert(normalized.content === 'hello wechat', 'wechat text content is preserved')
  assert(normalized.metadata.signature === 'secret-1:wx-1', 'wechat signature is mapped into metadata')
  assert(normalized.metadata.provider === 'wechat', 'wechat provider metadata is stable')
}

async function testFeishuPayloadNormalizesToGuardInput(): Promise<void> {
  console.log('\n2. feishu normalize...')
  const normalized = normalizeFeishuInbound({
    signature: 'secret-1:fs-1',
    body: {
      schema: '2.0',
      header: {
        event_id: 'evt-1',
        event_type: 'im.message.receive_v1',
        create_time: '1777248552000',
        token: 'verification-token',
        app_id: 'app-1',
        tenant_key: 'tenant-1',
      },
      event: {
        message: {
          message_id: 'fs-1',
          sender: {
            sender_id: { open_id: 'ou-1' },
            sender_type: 'user',
          },
          chat_id: 'oc-1',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello feishu' }),
          create_time: '1777248552000',
          update_time: '1777248552000',
        },
      },
    },
  })

  assert(normalized.channel === 'feishu', 'feishu channel is fixed')
  assert(normalized.messageId === 'fs-1', 'feishu message id is preserved')
  assert(normalized.externalUserId === 'ou-1', 'feishu sender is external user')
  assert(normalized.content === 'hello feishu', 'feishu JSON text content is extracted')
  assert(normalized.metadata.signature === 'secret-1:fs-1', 'feishu signature is mapped into metadata')
  assert(normalized.metadata.chatId === 'oc-1', 'feishu chat id is retained')
}

class ProbeExternalChannel extends ExternalChannel {
  async start(): Promise<void> {
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async send(): Promise<void> {
    return
  }

  async receive(normalized: ReturnType<typeof normalizeWeChatInbound>): Promise<void> {
    await this.handleInboundMessage(
      normalized.messageId,
      normalized.externalUserId,
      normalized.content,
      normalized.metadata,
    )
  }
}

async function testRejectedIngressIsCountedAndNotDispatched(): Promise<void> {
  console.log('\n3. rejected ingress stats...')
  const delivered: ChannelMessage[] = []
  const channel = new ProbeExternalChannel({
    type: 'wechat',
    ingressGuard: {
      requireSignature: true,
      secret: 'secret-1',
    },
    events: {
      onMessage: message => delivered.push(message),
    },
  })

  await channel.receive(normalizeWeChatInbound({
    signature: 'wrong',
    body: {
      MsgId: 'wx-bad',
      FromUserName: 'open-1',
      ToUserName: 'bot-1',
      MsgType: 'text',
      Content: 'blocked',
      CreateTime: 1777248552,
    },
  }))

  const stats = channel.getStats()
  const rejections = stats.ingressRejections as Record<string, number> | undefined

  assert(delivered.length === 0, 'rejected ingress is not dispatched')
  assert(rejections?.invalid_signature === 1, 'invalid signature rejection is counted')
}

async function testRejectedIngressEmitsStructuredAuditWithoutContent(): Promise<void> {
  console.log('\n4. rejected ingress audit...')
  const delivered: ChannelMessage[] = []
  const auditEvents: Array<Record<string, unknown>> = []
  const channel = new ProbeExternalChannel({
    type: 'wechat',
    ingressGuard: {
      requireSignature: true,
      secret: 'secret-1',
    },
    events: {
      onMessage: message => delivered.push(message),
      onIngressAudit: event => auditEvents.push(event),
    },
  })

  await channel.receive(normalizeWeChatInbound({
    signature: 'wrong',
    body: {
      MsgId: 'wx-audit',
      FromUserName: 'open-audit',
      ToUserName: 'bot-1',
      MsgType: 'text',
      Content: 'do not audit this body',
      CreateTime: 1777248552,
    },
  }))

  const stats = channel.getStats()
  const recentAudits = stats.recentIngressAudits as Array<Record<string, unknown>> | undefined
  const audit = auditEvents[0]

  assert(delivered.length === 0, 'audited rejection is not dispatched')
  assert(auditEvents.length === 1, 'one structured audit event is emitted')
  assert(audit?.eventType === 'external_ingress_rejected', 'audit event type is stable')
  assert(audit?.provider === 'wechat', 'audit records provider')
  assert(audit?.channel === 'wechat', 'audit records channel')
  assert(audit?.reason === 'invalid_signature', 'audit records rejection reason')
  assert(audit?.messageId === 'wx-audit', 'audit records message id')
  assert(audit?.idempotencyKey === 'wechat:wx-audit', 'audit records idempotency key')
  assert(audit?.externalUserId === 'open-audit', 'audit records external user id')
  assert(!('content' in audit!), 'audit does not store message content')
  assert(recentAudits?.[0]?.messageId === 'wx-audit', 'recent audit is exposed in stats')
}

async function testRejectedIngressAuditPersistsJsonlAndRotates(): Promise<void> {
  console.log('\n5. rejected ingress audit persistence...')
  const auditDir = await mkdtemp(join(tmpdir(), 'external-ingress-audit-'))
  const auditPath = join(auditDir, 'ingress-audit.jsonl')
  const channel = new ProbeExternalChannel({
    type: 'wechat',
    ingressGuard: {
      requireSignature: true,
      secret: 'secret-1',
    },
    ingressAuditLogPath: auditPath,
    ingressAuditMaxBytes: 1,
  })

  await channel.receive(normalizeWeChatInbound({
    signature: 'wrong',
    body: {
      MsgId: 'wx-persist-1',
      FromUserName: 'open-persist',
      ToUserName: 'bot-1',
      MsgType: 'text',
      Content: 'first body must not persist',
      CreateTime: 1777248552,
    },
  }))
  await channel.receive(normalizeWeChatInbound({
    signature: 'wrong',
    body: {
      MsgId: 'wx-persist-2',
      FromUserName: 'open-persist',
      ToUserName: 'bot-1',
      MsgType: 'text',
      Content: 'second body must not persist',
      CreateTime: 1777248553,
    },
  }))

  const rotatedPath = `${auditPath}.1`
  const current = await readFile(auditPath, 'utf8')
  const rotated = await readFile(rotatedPath, 'utf8')

  assert(existsSync(auditPath), 'current audit JSONL exists')
  assert(existsSync(rotatedPath), 'rotated audit JSONL exists')
  assert(current.includes('wx-persist-2'), 'current audit file contains newest rejection')
  assert(rotated.includes('wx-persist-1'), 'rotated audit file contains older rejection')
  assert(!current.includes('second body must not persist'), 'current audit file omits message content')
  assert(!rotated.includes('first body must not persist'), 'rotated audit file omits message content')
}

async function main(): Promise<void> {
  console.log('\nExternal Adapter Contract Test Suite')
  console.log('='.repeat(60))

  try {
    await testWeChatPayloadNormalizesToGuardInput()
    await testFeishuPayloadNormalizesToGuardInput()
    await testRejectedIngressIsCountedAndNotDispatched()
    await testRejectedIngressEmitsStructuredAuditWithoutContent()
    await testRejectedIngressAuditPersistsJsonlAndRotates()
    console.log('\n' + '='.repeat(60))
    console.log('All External Adapter Contract tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
