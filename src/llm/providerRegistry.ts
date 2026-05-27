/**
 * Provider Registry — runtime provider registration and lookup.
 *
 * Supports multiple named providers so different channels or sessions
 * can use different LLM backends.
 */
import type { LlmProvider, LlmFeature } from './llmProvider.js'
import { createMockProvider } from './llmProvider.js'

// =============================================================================
// Registry
// =============================================================================

export interface ProviderEntry {
  provider: LlmProvider
  default: boolean
  addedAt: number
}

export interface ProviderRegistrySnapshot {
  providers: Record<string, { name: string; model: string; isDefault: boolean }>
  defaultProvider: string | null
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderEntry>()
  private defaultId: string | null = null

  /** Register a provider under a given id. */
  register(id: string, provider: LlmProvider, setDefault = false): void {
    const isDefault = setDefault || this.providers.size === 0
    this.providers.set(id, { provider, default: isDefault, addedAt: Date.now() })
    if (isDefault) {
      this.defaultId = id
    }
  }

  /** Unregister a provider. */
  unregister(id: string): boolean {
    const existed = this.providers.delete(id)
    if (id === this.defaultId) {
      this.defaultId = null
      const first = this.providers.keys().next().value as string | undefined
      if (first) {
        const entry = this.providers.get(first)
        if (entry) {
          entry.default = true
          this.defaultId = first
        }
      }
    }
    return existed
  }

  /** Get a provider by id. */
  get(id: string): LlmProvider | null {
    const entry = this.providers.get(id)
    return entry?.provider ?? null
  }

  /** Get the default provider. Falls back to mock if nothing registered. */
  getDefault(): LlmProvider {
    if (this.defaultId) {
      const entry = this.providers.get(this.defaultId)
      if (entry) return entry.provider
    }
    // Fallback: register a mock provider so callers always get something
    const mock = createMockProvider({ name: 'fallback-mock' })
    this.register('__fallback__', mock, true)
    return mock
  }

  /** Set the default provider by id. */
  setDefault(id: string): boolean {
    const entry = this.providers.get(id)
    if (!entry) return false

    if (this.defaultId) {
      const old = this.providers.get(this.defaultId)
      if (old) old.default = false
    }
    entry.default = true
    this.defaultId = id
    return true
  }

  /** List all registered provider ids. */
  list(): string[] {
    return Array.from(this.providers.keys()).filter(k => k !== '__fallback__')
  }

  /** Get a snapshot for runtime status. */
  snapshot(): ProviderRegistrySnapshot {
    const result: ProviderRegistrySnapshot = {
      providers: {},
      defaultProvider: this.defaultId,
    }
    for (const [id, entry] of this.providers) {
      result.providers[id] = {
        name: entry.provider.name,
        model: entry.provider.model,
        isDefault: entry.default,
      }
    }
    return result
  }

  /** Number of registered providers (excluding internal fallback). */
  get size(): number {
    return this.list().length
  }
}

// =============================================================================
// Singleton
// =============================================================================

let _defaultRegistry: ProviderRegistry | null = null

export function getDefaultProviderRegistry(): ProviderRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new ProviderRegistry()
  }
  return _defaultRegistry
}

export function resetDefaultProviderRegistry(): void {
  _defaultRegistry = null
}

// =============================================================================
// Factory helpers
// =============================================================================

export interface LlmConfigEntry {
  id: string
  provider: string // 'claude' | 'openai-compat' | 'mock'
  model: string
  default?: boolean
  options?: Record<string, unknown>
}

export interface LlmConfig {
  providers: LlmConfigEntry[]
}

export async function loadProvidersFromConfig(config: LlmConfig): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry()

  for (const entry of config.providers) {
    let provider: LlmProvider

    switch (entry.provider) {
      case 'claude': {
        const { createClaudeProvider } = await import('./claudeProvider.js')
        provider = createClaudeProvider({
          model: entry.model ?? (entry.options?.model as string),
          ...entry.options as Record<string, unknown>,
        } as Parameters<typeof createClaudeProvider>[0])
        break
      }
      case 'openai-compat': {
        const { createOpenAICompatProvider } = await import('./openaiCompatProvider.js')
        provider = createOpenAICompatProvider({
          name: entry.id,
          model: entry.model ?? (entry.options?.model as string | undefined) ?? 'gpt-4o',
          baseURL: entry.options?.baseURL as string | undefined,
          apiKey: entry.options?.apiKey as string | undefined,
        })
        break
      }
      case 'mock': {
        provider = createMockProvider({
          name: entry.id,
          model: entry.model ?? 'mock-1.0',
        })
        break
      }
      default:
        throw new Error(`Unknown LLM provider type: ${entry.provider} (entry: ${entry.id})`)
    }

    registry.register(entry.id, provider, entry.default ?? false)
  }

  return registry
}
