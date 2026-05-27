/**
 * Claude Provider — Anthropic Messages API backend for the FusionWorkspace
 * LLM abstraction layer.
 *
 * Implements `LlmProvider` using `@anthropic-ai/sdk`.  Supports streaming,
 * tool use, prompt caching, and extended thinking.
 *
 * @module claudeProvider
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LlmProvider,
  LlmChatOptions,
  LlmFeature,
  LlmCapabilities,
  ChatResult,
} from './llmProvider.js'
import type {
  Message,
  ToolDef,
  ResponseChunk,
  MessageContent,
  TextContent,
  ToolUseContent,
} from '../agent/taorLoop.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClaudeProviderOptions {
  /** Anthropic API key — defaults to `ANTHROPIC_API_KEY` env var. */
  apiKey?: string
  /** Model ID forwarded to the API. */
  model?: string
  /** Maximum output tokens per request. */
  maxTokens?: number
  /** Enable extended thinking (default false). */
  thinkingEnabled?: boolean
  /** Token budget for extended thinking (when enabled). */
  thinkingBudgetTokens?: number
}

const DEFAULT_MODEL = 'claude-sonnet-4-6-20250514'
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_THINKING_BUDGET = 16000

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/** Extract plain-text from a FusionWorkspace message content union. */
function extractText(content: MessageContent | MessageContent[]): string {
  const blocks = Array.isArray(content) ? content : [content]
  return blocks
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/**
 * Convert FusionWorkspace messages into the shape expected by the Anthropic
 * Messages API.  System messages are lifted into the top-level `system`
 * parameter; everything else becomes a `MessageParam`.
 */
function convertMessages(
  messages: Message[],
): { system?: string; anthropicMessages: Anthropic.MessageParam[] } {
  const systemParts: string[] = []
  const anthropicMessages: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    // ---- system -----------------------------------------------------------
    if (msg.role === 'system') {
      const text = extractText(msg.content)
      if (text) systemParts.push(text)
      continue
    }

    // ---- user / assistant / tool ------------------------------------------
    const content = Array.isArray(msg.content) ? msg.content : [msg.content]
    const blocks: Anthropic.ContentBlockParam[] = []

    for (const block of content) {
      switch (block.type) {
        case 'text':
          blocks.push({ type: 'text', text: block.text })
          break

        case 'tool_use':
          blocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          } as Anthropic.ToolUseBlockParam)
          break

        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content),
          } as Anthropic.ToolResultBlockParam)
          break
      }
    }

    // Anthropic only accepts 'user' | 'assistant' — tool-role messages
    // from FusionWorkspace become 'user'.
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'
    anthropicMessages.push({ role, content: blocks })
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  return { system, anthropicMessages }
}

/** Convert FusionWorkspace tool definitions to Anthropic's `Tool` shape. */
function convertTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const schemaBase = t.input_schema ?? {}
    const input_schema: Anthropic.Tool.InputSchema = {
      type: 'object',
      properties: (schemaBase as any).properties ?? {},
      required: (schemaBase as any).required,
    }
    return {
      name: t.name,
      description: t.description,
      input_schema,
    }
  })
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude'

  readonly model: string
  private client: Anthropic
  private maxTokens: number
  private thinkingEnabled: boolean
  private thinkingBudgetTokens: number

  constructor(options?: Partial<ClaudeProviderOptions>) {
    const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error(
        '[ClaudeProvider] ANTHROPIC_API_KEY is not set — pass it via options.apiKey or the ANTHROPIC_API_KEY environment variable',
      )
    }

    this.model = options?.model ?? DEFAULT_MODEL
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS
    this.thinkingEnabled = options?.thinkingEnabled ?? false
    this.thinkingBudgetTokens = options?.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET

    this.client = new Anthropic({ apiKey })
  }

  // -----------------------------------------------------------------------
  // Streaming
  // -----------------------------------------------------------------------

  async *streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: LlmChatOptions,
  ): AsyncGenerator<ResponseChunk, void, unknown> {
    const { system, anthropicMessages } = convertMessages(messages)
    const anthropicTools = convertTools(tools)

    const thinkingEnabled = options?.thinkingEnabled ?? this.thinkingEnabled
    const thinkingBudgetTokens = options?.thinkingBudgetTokens ?? this.thinkingBudgetTokens
    const maxTokens = options?.maxTokens ?? this.maxTokens

    // ---- per-block state (tool_use input arrives incrementally) -----------
    interface PendingBlock {
      type: 'text' | 'tool_use' | 'thinking'
      id?: string
      name?: string
      jsonBuffer?: string
    }
    const pendingBlocks = new Map<number, PendingBlock>()

    let fullText = ''
    let inputTokens = 0
    let stopReason: string | undefined = undefined
    let outputTokens = 0

    try {
      const stream = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system: system,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        ...(thinkingEnabled
          ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudgetTokens } }
          : {}),
        stream: true,
      })

      for await (const event of stream) {
        switch (event.type) {
          // ---- message_start ----------------------------------------------
          case 'message_start':
            inputTokens = event.message.usage.input_tokens
            break

          // ---- content_block_start ----------------------------------------
          case 'content_block_start': {
            const block = event.content_block
            if (block.type === 'text') {
              pendingBlocks.set(event.index, { type: 'text' })
              const chunk: ResponseChunk = {
                type: 'content_block',
                content: { type: 'text', text: block.text },
              }
              fullText += block.text
              yield chunk
            } else if (block.type === 'tool_use') {
              pendingBlocks.set(event.index, {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                jsonBuffer: '',
              })
              // Tool-use is yielded on content_block_stop once JSON is complete
            } else if (block.type === 'thinking') {
              pendingBlocks.set(event.index, { type: 'thinking' })
              // thinking text arrives via thinking_delta; signature is ignored
            }
            break
          }

          // ---- content_block_delta ----------------------------------------
          case 'content_block_delta': {
            const delta = event.delta
            if (delta.type === 'text_delta') {
              fullText += delta.text
              yield {
                type: 'content_block',
                content: { type: 'text', text: delta.text },
              }
            } else if (delta.type === 'input_json_delta') {
              const pending = pendingBlocks.get(event.index)
              if (pending && pending.type === 'tool_use') {
                pending.jsonBuffer = (pending.jsonBuffer ?? '') + delta.partial_json
              }
            } else if (delta.type === 'thinking_delta') {
              fullText += delta.thinking
              yield {
                type: 'content_block',
                content: { type: 'text', text: delta.thinking },
              }
            }
            // signature_delta is internal — ignore
            break
          }

          // ---- content_block_stop -----------------------------------------
          case 'content_block_stop': {
            const pending = pendingBlocks.get(event.index)
            if (pending && pending.type === 'tool_use') {
              let input: Record<string, unknown> = {}
              const raw = (pending.jsonBuffer ?? '').trim()
              if (raw) {
                try {
                  input = JSON.parse(raw) as Record<string, unknown>
                } catch {
                  // If JSON is malformed (shouldn't happen), yield with empty input
                }
              }
              const content: ToolUseContent = {
                type: 'tool_use',
                id: pending.id!,
                name: pending.name!,
                input,
              }
              yield { type: 'content_block', content }
            }
            pendingBlocks.delete(event.index)
            break
          }

          // ---- message_delta ----------------------------------------------
          case 'message_delta':
            // Anthropic returns stop_reason as string | null — normalize to undefined
            stopReason = event.delta.stop_reason ?? undefined
            outputTokens = event.usage.output_tokens
            break

          // ---- message_stop (terminal) ------------------------------------
          case 'message_stop':
            // stream complete — fall through to final yield below
            break
        }
      }
    } catch (error: unknown) {
      throw wrapError(error)
    }

    // ---- terminal done chunk ----------------------------------------------
    yield {
      type: 'done',
      text: fullText,
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }
  }

  // -----------------------------------------------------------------------
  // Non-streaming convenience
  // -----------------------------------------------------------------------

  async chat(
    messages: Message[],
    tools: ToolDef[],
    options?: LlmChatOptions,
  ): Promise<ChatResult> {
    let text = ''
    const toolCalls: ChatResult['toolCalls'] = []
    let stopReason: string | null = null
    let inputTokens = 0
    let outputTokens = 0

    for await (const chunk of this.streamChat(messages, tools, options)) {
      if (chunk.type === 'content_block' && chunk.content) {
        if (chunk.content.type === 'text') {
          text += chunk.content.text
        } else if (chunk.content.type === 'tool_use') {
          toolCalls.push({
            id: chunk.content.id,
            name: chunk.content.name,
            input: chunk.content.input,
          })
        }
      } else if (chunk.type === 'done') {
        // The final 'done' chunk carries the complete accumulated text,
        // stop reason, and usage — prefer those over incremental values.
        if (chunk.text) text = chunk.text
        // ResponseChunk.stop_reason is string | undefined — ChatResult expects string | null
        stopReason = chunk.stop_reason ?? null
        if (chunk.usage) {
          inputTokens = chunk.usage.input_tokens
          outputTokens = chunk.usage.output_tokens
        }
      }
    }

    return { text, toolCalls, stopReason, usage: { inputTokens, outputTokens } }
  }

  // -----------------------------------------------------------------------
  // Feature flags
  // -----------------------------------------------------------------------

  supportsFeature(feature: LlmFeature): boolean {
    switch (feature) {
      case 'streaming':
        return true
      case 'thinking':
        return true
      case 'promptCaching':
        return true
      case 'toolUse':
        return true
      case 'vision':
        // Claude supports vision but it is not exposed through this provider
        // yet — image blocks would require additional message conversion work.
        return false
      default: {
        const _exhaustive: never = feature
        void _exhaustive
        return false
      }
    }
  }

  // -----------------------------------------------------------------------
  // Capabilities
  // -----------------------------------------------------------------------

  getCapabilities(): LlmCapabilities {
    return {
      model: this.model,
      contextWindow: 200_000,
      maxOutputTokens: this.maxTokens,
      streaming: true,
      supportsStreaming: true,
      supportsThinking: true,
      supportsPromptCaching: true,
      supportsToolUse: true,
      supportedFeatures: ['streaming', 'thinking', 'promptCaching', 'toolUse'] as LlmFeature[],
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Claude-backed `LlmProvider` with optional overrides. */
export function createClaudeProvider(
  options?: Partial<ClaudeProviderOptions>,
): LlmProvider {
  return new ClaudeProvider(options)
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Wrap an error with the provider name for traceability. */
function wrapError(error: unknown): Error {
  const providerTag = '[ClaudeProvider]'

  // Anthropic SDK throws errors with a `status` property
  if (error != null && typeof error === 'object' && 'status' in error) {
    const apiError = error as { status: unknown; message?: string }
    const msg = apiError.message ?? 'Unknown API error'
    return new Error(`${providerTag} API error (status ${String(apiError.status)}): ${msg}`)
  }

  if (error instanceof Error) {
    return new Error(`${providerTag} ${error.message}`)
  }

  return new Error(`${providerTag} Unexpected error: ${String(error)}`)
}
