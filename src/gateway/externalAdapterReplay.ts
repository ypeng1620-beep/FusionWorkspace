import {
  normalizeFeishuInbound,
  normalizeWeChatInbound,
  type FeishuInboundPayload,
  type NormalizedExternalInbound,
  type WeChatInboundPayload,
} from './externalAdapterContract.js'

export type { NormalizedExternalInbound } from './externalAdapterContract.js'

export type ExternalAdapterReplayProvider = 'wechat' | 'feishu'

export type ExternalAdapterReplayFixture =
  | ({ provider: 'wechat' } & WeChatInboundPayload)
  | ({ provider: 'feishu' } & FeishuInboundPayload)

export interface ExternalAdapterReplayResult {
  total: number
  byProvider: Record<ExternalAdapterReplayProvider, number>
}

export async function replayExternalAdapterFixtures(
  fixtures: ExternalAdapterReplayFixture[],
  dispatch: (normalized: NormalizedExternalInbound) => void | Promise<void>,
): Promise<ExternalAdapterReplayResult> {
  const result: ExternalAdapterReplayResult = {
    total: 0,
    byProvider: {
      wechat: 0,
      feishu: 0,
    },
  }

  for (const fixture of fixtures) {
    const normalized = normalizeFixture(fixture)
    result.total++
    result.byProvider[fixture.provider]++
    await dispatch(normalized)
  }

  return result
}

function normalizeFixture(fixture: ExternalAdapterReplayFixture): NormalizedExternalInbound {
  if (fixture.provider === 'wechat') {
    return normalizeWeChatInbound(fixture)
  }
  return normalizeFeishuInbound(fixture)
}
