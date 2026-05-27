/**
 * 适配器工厂 — 统一创建和注册外部渠道适配器
 *
 * 从配置文件加载适配器定义，创建实例并注册到 Gateway。
 */

import type { Gateway } from './gateway.js'
import type { ExternalChannelConfig } from './externalChannel.js'
import type { WeChatAdapterConfig } from './wechatChannel.js'
import type { FeishuAdapterConfig } from './feishuChannel.js'
import { WeChatChannel } from './wechatChannel.js'
import { FeishuChannel } from './feishuChannel.js'
import {
  assertExternalAdapterConfigReady,
  validateExternalAdapterConfig,
  type ExternalAdapterConfigValidationResult,
} from './externalAdapterConfigValidation.js'

// =============================================================================
// 适配器定义
// =============================================================================

export type AdapterDefinition = WeChatAdapterConfig | FeishuAdapterConfig | ExternalChannelConfig

/** 适配器注册表配置 */
export interface AdapterRegistryConfig {
  /** 适配器列表 */
  adapters: AdapterDefinition[]
}

export interface AdapterReadinessDiagnostic {
  instanceId: string
  type: string
  validation: ExternalAdapterConfigValidationResult
}

// =============================================================================
// 适配器工厂
// =============================================================================

export class AdapterFactory {
  static validateDefinitions(definitions: AdapterDefinition[]): AdapterReadinessDiagnostic[] {
    return definitions.map(def => ({
      instanceId: this.getInstanceId(def),
      type: def.type,
      validation: validateExternalAdapterConfig(def, { strict: false }),
    }))
  }

  /** 从配置创建适配器实例 */
  static createAdapter(config: AdapterDefinition) {
    const type = config.type.toLowerCase()

    switch (type) {
      case 'wechat':
      case 'wx':
      case 'weixin':
        return new WeChatChannel(config as WeChatAdapterConfig)

      case 'feishu':
      case 'lark':
        return new FeishuChannel(config as FeishuAdapterConfig)

      default:
        throw new Error(`Unknown adapter type: ${type}`)
    }
  }

  /** 批量创建并注册到 Gateway */
  static async registerAll(gateway: Gateway, definitions: AdapterDefinition[]): Promise<void> {
    const registeredInstanceIds: string[] = []
    const startedChannels: Array<{ instanceId: string; channel: { stop(): Promise<void> } }> = []
    for (const def of definitions) {
      if (def.requireProductionReady) {
        assertExternalAdapterConfigReady(def, { strict: true })
      }
    }

    for (const def of definitions) {
      const adapter = this.createAdapter(def)
      const instanceId = this.getInstanceId(def)
      gateway.addChannel(adapter, instanceId)
      registeredInstanceIds.push(instanceId)
      console.log(`[AdapterFactory] Registered adapter: ${instanceId} (${def.type})`)
    }

    // 启动所有适配器
    for (const def of definitions) {
      const instanceId = this.getInstanceId(def)
      const channel = (gateway as any).channels?.get?.(instanceId)
      if (channel) {
        try {
          await channel.start()
          startedChannels.push({ instanceId, channel })
          console.log(`[AdapterFactory] Started adapter: ${instanceId}`)
        } catch (error) {
          await channel.stop().catch(() => undefined)
          await this.rollbackBatch(gateway, registeredInstanceIds, startedChannels)
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Failed to start adapter ${instanceId}: ${message}`)
        }
      }
    }
  }

  private static async rollbackBatch(
    gateway: Gateway,
    registeredInstanceIds: string[],
    startedChannels: Array<{ instanceId: string; channel: { stop(): Promise<void> } }>,
  ): Promise<void> {
    for (const { channel } of [...startedChannels].reverse()) {
      await channel.stop().catch(() => undefined)
    }

    for (const instanceId of registeredInstanceIds) {
      gateway.removeChannel(instanceId)
    }
  }

  private static getInstanceId(def: AdapterDefinition): string {
    return String((def as { instanceId?: string }).instanceId ?? def.type)
  }
}

/** 从 JSON 文件加载适配器配置 */
export async function loadAdapterConfig(filePath: string): Promise<AdapterRegistryConfig> {
  const { readFile } = await import('fs/promises')
  const { existsSync } = await import('fs')

  if (!existsSync(filePath)) {
    return { adapters: [] }
  }

  const raw = await readFile(filePath, 'utf-8')
  return JSON.parse(raw) as AdapterRegistryConfig
}

/** 默认适配器配置（空） */
export const DEFAULT_ADAPTER_CONFIG: AdapterRegistryConfig = {
  adapters: [],
}
