import {
  replayExternalAdapterFixtures,
  type ExternalAdapterReplayFixture,
  type NormalizedExternalInbound,
} from '../src/gateway/externalAdapterReplay.js'
import { ExternalChannel } from '../src/gateway/externalChannel.js'
import type { ChannelMessage } from '../src/gateway/gateway.js'

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

class ReplayProbeChannel extends ExternalChannel {
  delivered: ChannelMessage[] = []

  async start(): Promise<void> {
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async send(): Promise<void> {
    return
  }

  async receive(normalized: NormalizedExternalInbound): Promise<void> {
    await this.handleInboundMessage(
      normalized.messageId,
      normalized.externalUserId,
      normalized.content,
      normalized.metadata,
    )
  }
}

section('External Adapter Replay Tests')

async function testReplayRoutesFixturesThroughProviderChannels(): Promise<void> {
  console.log('\n1. replay mixed provider fixtures...')
  const wechat = new ReplayProbeChannel({
    type: 'wechat',
    ingressGuard: {
      requireSignature: true,
      secret: 'secret-1',
      rateLimit: { maxMessages: 10, windowMs: 60_000 },
    },
    events: {
      onMessage: message => wechat.delivered.push(message),
    },
  })
  const feishu = new ReplayProbeChannel({
    type: 'feishu',
    ingressGuard: {
      requireSignature: true,
      secret: 'secret-1',
      rateLimit: { maxMessages: 2, windowMs: 60_000 },
    },
    events: {
      onMessage: message => feishu.delivered.push(message),
    },
  })

  const fixtures: ExternalAdapterReplayFixture[] = [
    {
      provider: 'wechat',
      signature: 'secret-1:wx-1',
      body: {
        MsgId: 'wx-1',
        FromUserName: 'open-1',
        ToUserName: 'bot-1',
        MsgType: 'text',
        Content: 'wechat ok',
        CreateTime: 1777248552,
      },
    },
    {
      provider: 'wechat',
      signature: 'secret-1:wx-1',
      body: {
        MsgId: 'wx-1',
        FromUserName: 'open-1',
        ToUserName: 'bot-1',
        MsgType: 'text',
        Content: 'wechat duplicate',
        CreateTime: 1777248553,
      },
    },
    {
      provider: 'wechat',
      signature: 'wrong',
      body: {
        MsgId: 'wx-bad',
        FromUserName: 'open-1',
        ToUserName: 'bot-1',
        MsgType: 'text',
        Content: 'wechat bad signature',
        CreateTime: 1777248554,
      },
    },
    {
      provider: 'feishu',
      signature: 'secret-1:fs-1',
      body: makeFeishuBody('fs-1', 'feishu one'),
    },
    {
      provider: 'feishu',
      signature: 'secret-1:fs-2',
      body: makeFeishuBody('fs-2', 'feishu two'),
    },
    {
      provider: 'feishu',
      signature: 'secret-1:fs-3',
      body: makeFeishuBody('fs-3', 'feishu over limit'),
    },
  ]

  const result = await replayExternalAdapterFixtures(fixtures, async normalized => {
    if (normalized.channel === 'wechat') {
      await wechat.receive(normalized)
      return
    }
    if (normalized.channel === 'feishu') {
      await feishu.receive(normalized)
      return
    }
    throw new Error(`Unexpected channel: ${normalized.channel}`)
  })

  const wechatRejections = wechat.getStats().ingressRejections as Record<string, number>
  const feishuRejections = feishu.getStats().ingressRejections as Record<string, number>

  assert(result.total === 6, 'all fixtures are replayed')
  assert(result.byProvider.wechat === 3, 'wechat fixture count is reported')
  assert(result.byProvider.feishu === 3, 'feishu fixture count is reported')
  assert(wechat.delivered.length === 1, 'only one wechat message is dispatched')
  assert(feishu.delivered.length === 2, 'only two feishu messages are dispatched before rate limit')
  assert(wechatRejections.duplicate === 1, 'wechat duplicate rejection is counted')
  assert(wechatRejections.invalid_signature === 1, 'wechat invalid signature rejection is counted')
  assert(feishuRejections.rate_limited === 1, 'feishu rate limit rejection is counted')
}

function makeFeishuBody(messageId: string, text: string): ExternalAdapterReplayFixture['body'] {
  return {
    schema: '2.0',
    header: {
      event_id: `evt-${messageId}`,
      event_type: 'im.message.receive_v1',
      create_time: '1777248552000',
      token: 'verification-token',
      app_id: 'app-1',
      tenant_key: 'tenant-1',
    },
    event: {
      message: {
        message_id: messageId,
        sender: {
          sender_id: { open_id: 'ou-1' },
          sender_type: 'user',
        },
        chat_id: 'oc-1',
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: '1777248552000',
        update_time: '1777248552000',
      },
    },
  }
}

async function main(): Promise<void> {
  console.log('\nExternal Adapter Replay Test Suite')
  console.log('='.repeat(60))

  try {
    await testReplayRoutesFixturesThroughProviderChannels()
    console.log('\n' + '='.repeat(60))
    console.log('All External Adapter Replay tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
