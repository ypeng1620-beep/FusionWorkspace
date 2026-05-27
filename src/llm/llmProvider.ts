/**
 * LLM Provider Interface — FusionWorkspace abstraction layer
 *
 * All LLM backends (Claude, MiniMax, DeepSeek, OpenAI, etc.) implement
 * this interface so the TAOR loop can swap providers without code changes.
 */
import type { Message, ToolDef, ResponseChunk } from '../agent/taorLoop.js'

// =============================================================================
// Feature flags
// =============================================================================

export type LlmFeature = 'streaming' | 'thinking' | 'promptCaching' | 'toolUse' | 'vision'

// =============================================================================
// Chat options (per-call overrides)
// =============================================================================

export interface LlmChatOptions {
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  stopSequences?: string[]
  thinkingEnabled?: boolean
  thinkingBudgetTokens?: number
  topP?: number
  signal?: AbortSignal
  extra?: Record<string, unknown>
}

// =============================================================================
// Capabilities descriptor
// =============================================================================

export interface LlmCapabilities {
  model: string
  contextWindow: number
  maxOutputTokens: number
  streaming: boolean
  supportsStreaming: boolean
  supportsThinking: boolean
  supportsPromptCaching: boolean
  supportsToolUse: boolean
  supportedFeatures: LlmFeature[]
}

// =============================================================================
// Chat result (non-streaming)
// =============================================================================

export interface ChatResult {
  text: string
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string | null
  usage?: { inputTokens: number; outputTokens: number }
}

// =============================================================================
// Main provider interface
// =============================================================================

export interface LlmProvider {
  readonly name: string
  readonly model: string

  streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: LlmChatOptions,
  ): AsyncGenerator<ResponseChunk, void, unknown>

  chat(
    messages: Message[],
    tools: ToolDef[],
    options?: LlmChatOptions,
  ): Promise<ChatResult>

  supportsFeature(feature: LlmFeature): boolean

  getCapabilities(): LlmCapabilities
}

// =============================================================================
// Mock Provider
// =============================================================================

export interface MockProviderOptions {
  name?: string
  model?: string
  responseText?: string
  toolHandler?: (name: string, input: Record<string, unknown>) => string
}

export function createMockProvider(options: MockProviderOptions = {}): LlmProvider {
  const name = options.name ?? 'mock'
  const model = options.model ?? 'mock-1.0'
  const responseText = options.responseText ?? 'This is a mock response. No real LLM is configured.'

  return {
    name,
    model,

    async *streamChat(messages, _tools, _opts) {
      const lastMsg = messages[messages.length - 1]
      const text =
        typeof lastMsg.content === 'object' && 'text' in lastMsg.content
          ? (lastMsg.content as { text: string }).text
          : ''

      if (text.startsWith('USE_TOOL:') && options.toolHandler) {
        const toolName = text.replace('USE_TOOL:', '').trim()
        yield {
          type: 'content_block',
          content: { type: 'tool_use', id: `mock_${Date.now()}`, name: toolName, input: {} },
        }
        return
      }

      if (text.includes('[FINAL_ANSWER]')) {
        yield { type: 'done', text: text.replace('[FINAL_ANSWER]', '').trim(), stop_reason: 'end_turn' }
        return
      }

      yield { type: 'content_block', content: { type: 'text', text: responseText } }
      yield {
        type: 'done',
        text: responseText,
        stop_reason: 'end_turn',
        usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(responseText.length / 4) },
      }
    },

    async chat(messages, tools, opts) {
      const chunks: ResponseChunk[] = []
      for await (const chunk of this.streamChat(messages, tools, opts)) {
        chunks.push(chunk)
      }
      return collectChatResult(chunks)
    },

    supportsFeature(feature) {
      return feature === 'toolUse'
    },

    getCapabilities() {
      return {
        model,
        contextWindow: 8000,
        maxOutputTokens: 2048,
        streaming: true,
        supportsStreaming: true,
        supportsThinking: false,
        supportsPromptCaching: false,
        supportsToolUse: true,
        supportedFeatures: ['toolUse'] as LlmFeature[],
      }
    },
  }
}

// =============================================================================
// Helpers
// =============================================================================

export function collectChatResult(chunks: ResponseChunk[]): ChatResult {
  let text = ''
  const toolCalls: ChatResult['toolCalls'] = []
  let stopReason: string | null = null
  let usage: ChatResult['usage']

  for (const chunk of chunks) {
    if (chunk.type === 'content_block' && chunk.content) {
      if (chunk.content.type === 'text') {
        text += (chunk.content as { type: 'text'; text: string }).text
      } else if (chunk.content.type === 'tool_use') {
        const tc = chunk.content as {
          type: 'tool_use'
          id: string
          name: string
          input: Record<string, unknown>
        }
        toolCalls.push({ id: tc.id, name: tc.name, input: tc.input })
      }
    }
    if (chunk.type === 'done') {
      if (chunk.text) text = chunk.text
      stopReason = chunk.stop_reason ?? null
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.input_tokens, outputTokens: chunk.usage.output_tokens }
      }
    }
  }

  return { text, toolCalls, stopReason, usage }
}
