import { ExternalIngressGuard } from '../src/gateway/externalIngressGuard.js'
import { ExternalChannel } from '../src/gateway/externalChannel.js'
import type { ChannelMessage, Session } from '../src/gateway/gateway.js'

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

section('External Ingress Guard Tests')

async function testValidMessagePassesWithStableIdempotencyKey(): Promise<void> {
  console.log('\n1. valid message...')
  const guard = new ExternalIngressGuard({
    channel: 'wechat',
    requireSignature: true,
    secret: 'secret-1',
    rateLimit: { maxMessages: 2, windowMs: 60_000 },
  })

  const decision = guard.inspect({
    channel: 'wechat',
    messageId: 'msg-1',
    externalUserId: 'user-1',
    content: 'hello',
    timestamp: 1000,
    signature: 'secret-1:msg-1',
  })

  assert(decision.allowed === true, 'valid signed message is allowed')
  assert(decision.idempotencyKey === 'wechat:msg-1', 'idempotency key is channel-scoped')
  assert(decision.reason === 'accepted', 'accepted decision reason is stable')
}

async function testDuplicateMessageIsRejected(): Promise<void> {
  console.log('\n2. duplicate message...')
  const guard = new ExternalIngressGuard({
    channel: 'feishu',
    dedupWindowMs: 60_000,
  })

  const first = guard.inspect({
    channel: 'feishu',
    messageId: 'msg-dup',
    externalUserId: 'user-1',
    content: 'first',
    timestamp: 1000,
  })
  const duplicate = guard.inspect({
    channel: 'feishu',
    messageId: 'msg-dup',
    externalUserId: 'user-1',
    content: 'second',
    timestamp: 1001,
  })

  assert(first.allowed === true, 'first message is accepted')
  assert(duplicate.allowed === false, 'duplicate message is rejected')
  assert(duplicate.reason === 'duplicate', 'duplicate decision reason is stable')
}

async function testInvalidSignatureIsRejectedBeforeDedup(): Promise<void> {
  console.log('\n3. invalid signature...')
  const guard = new ExternalIngressGuard({
    channel: 'wechat',
    requireSignature: true,
    secret: 'secret-1',
  })

  const decision = guard.inspect({
    channel: 'wechat',
    messageId: 'msg-bad-signature',
    externalUserId: 'user-1',
    content: 'hello',
    timestamp: 1000,
    signature: 'wrong',
  })
  const retryWithValidSignature = guard.inspect({
    channel: 'wechat',
    messageId: 'msg-bad-signature',
    externalUserId: 'user-1',
    content: 'hello',
    timestamp: 1001,
    signature: 'secret-1:msg-bad-signature',
  })

  assert(decision.allowed === false, 'invalid signature is rejected')
  assert(decision.reason === 'invalid_signature', 'invalid signature reason is stable')
  assert(retryWithValidSignature.allowed === true, 'rejected signature does not poison dedup cache')
}

async function testRateLimitIsPerUserAndChannel(): Promise<void> {
  console.log('\n4. rate limit...')
  const guard = new ExternalIngressGuard({
    channel: 'wechat',
    rateLimit: { maxMessages: 2, windowMs: 60_000 },
  })

  const first = guard.inspect({ channel: 'wechat', messageId: 'm1', externalUserId: 'u1', content: '1', timestamp: 1 })
  const second = guard.inspect({ channel: 'wechat', messageId: 'm2', externalUserId: 'u1', content: '2', timestamp: 2 })
  const third = guard.inspect({ channel: 'wechat', messageId: 'm3', externalUserId: 'u1', content: '3', timestamp: 3 })
  const otherUser = guard.inspect({ channel: 'wechat', messageId: 'm4', externalUserId: 'u2', content: '4', timestamp: 4 })

  assert(first.allowed === true, 'first message within limit is allowed')
  assert(second.allowed === true, 'second message within limit is allowed')
  assert(third.allowed === false, 'third message over limit is rejected')
  assert(third.reason === 'rate_limited', 'rate limit reason is stable')
  assert(otherUser.allowed === true, 'rate limit is isolated by user')
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

  async receive(
    messageId: string,
    externalUserId: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.handleInboundMessage(messageId, externalUserId, content, metadata)
  }
}

async function testExternalChannelUsesIngressGuardBeforeDispatch(): Promise<void> {
  console.log('\n5. external channel integration...')
  const delivered: ChannelMessage[] = []
  const sessions: Session[] = []

  const channel = new ProbeExternalChannel({
    type: 'wechat',
    ingressGuard: {
      requireSignature: true,
      secret: 'secret-1',
      rateLimit: {
        maxMessages: 2,
        windowMs: 60_000,
      },
    },
    events: {
      onMessage: (message, session) => {
        delivered.push(message)
        sessions.push(session)
      },
    },
  })

  await channel.receive('msg-invalid', 'user-1', 'blocked', {
    signature: 'wrong',
  })
  assert(delivered.length === 0, 'invalid signed message is not dispatched')

  await channel.receive('msg-valid', 'user-1', 'hello', {
    signature: 'secret-1:msg-valid',
  })
  assert(delivered.length === 1, 'accepted message reaches channel callback')
  assert(sessions[0]?.id === 'user-1', 'accepted message creates the external user session')
  assert(delivered[0]?.metadata?.idempotencyKey === 'wechat:msg-valid', 'accepted message carries idempotency metadata')

  await channel.receive('msg-valid', 'user-1', 'duplicate', {
    signature: 'secret-1:msg-valid',
  })
  assert(delivered.length === 1, 'duplicate accepted id is blocked before callback')
}

async function main(): Promise<void> {
  console.log('\nExternal Ingress Guard Test Suite')
  console.log('='.repeat(60))

  try {
    await testValidMessagePassesWithStableIdempotencyKey()
    await testDuplicateMessageIsRejected()
    await testInvalidSignatureIsRejectedBeforeDedup()
    await testRateLimitIsPerUserAndChannel()
    await testExternalChannelUsesIngressGuardBeforeDispatch()
    console.log('\n' + '='.repeat(60))
    console.log('All External Ingress Guard tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
