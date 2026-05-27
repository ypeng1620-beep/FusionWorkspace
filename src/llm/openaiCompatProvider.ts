/**
 * OpenAI-Compatible Provider — FusionWorkspace LLM abstraction layer (Phase 7)
 *
 * Supports: MiniMax, DeepSeek, Groq, Ollama, and any other OpenAI-compatible API.
 * Configured via baseURL + apiKey + model; uses the `openai` npm package (v6.x).
 *
 * Usage:
 *   import { createOpenAICompatProvider } from './llm/openaiCompatProvider.js'
 *   const llm = createOpenAICompatProvider({
 *     name: 'minimax',
 *     baseURL: 'https://api.minimax.io/v1',
 *     model: 'MiniMax-M2.7',
 *   })
 *   for await (const chunk of llm.streamChat(messages, tools)) { ... }
 */

import OpenAI from 'openai'
import type {
  LlmProvider,
  LlmFeature,
  LlmCapabilities,
  LlmChatOptions,
  ChatResult,
} from './llmProvider.js'
import type {
  Message,
  ToolDef,
  ResponseChunk,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  MessageContent,
} from '../agent/taorLoop.js'

// =============================================================================
// Configuration
// =============================================================================

export interface OpenAICompatProviderOptions {
  /** Human-readable provider label, e.g. 'minimax', 'deepseek', 'groq', 'ollama' */
  name?: string
  /** API key — defaults to `process.env.OPENAI_API_KEY` if omitted */
  apiKey?: string
  /** Base URL for the OpenAI-compatible endpoint (required for non-OpenAI providers) */
  baseURL?: string
  /** Model name (required) */
  model?: string
  /** Default maximum tokens per completion */
  maxTokens?: number
  /** Default temperature (0-2) */
  temperature?: number
}

// =============================================================================
// Internal helpers — message format conversion
// =============================================================================

/**
 * Normalize a Message's `content` field into an array of content blocks.
 * Handles single-block, multi-block array, and legacy string content.
 */
function normalizeContentBlocks(content: MessageContent | MessageContent[]): MessageContent[] {
  return Array.isArray(content) ? content : [content]
}

/**
 * Convert a single TAOR content block to its textual representation.
 * Used for system messages and fallback string content.
 */
function blockToText(block: MessageContent): string {
  if (typeof block === 'string') return block
  if ('text' in block && typeof block.text === 'string') return block.text
  if (block.type === 'tool_use') return '' // tool_use blocks have no display text
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content
    if (Array.isArray(block.content)) return block.content.map(b => blockToText(b as MessageContent)).join('\n')
    return JSON.stringify(block.content)
  }
  return String(block)
}

/**
 * Extract a plain-text string from a message's content for role='system' messages.
 */
function extractSystemText(content: MessageContent | MessageContent[]): string {
  if (typeof content === 'string') return content
  const blocks = normalizeContentBlocks(content)
  return blocks.map(blockToText).filter(Boolean).join('\n')
}

/**
 * Convert TAOR Message[] into OpenAI ChatCompletionMessageParam[].
 *
 * Mapping rules:
 *   system messages           → role: 'system'
 *   user text messages        → role: 'user', content: string
 *   assistant text messages   → role: 'assistant', content: string
 *   assistant tool_use blocks → role: 'assistant', content: null, tool_calls: [...]
 *   tool_result blocks        → role: 'tool', tool_call_id, content: string
 */
function toOpenAIMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemMsg = messages.find(m => m.role === 'system')
  const nonSystemMsgs = messages.filter(m => m.role !== 'system')

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  // System message goes first
  if (systemMsg) {
    result.push({
      role: 'system',
      content: extractSystemText(systemMsg.content),
    })
  }

  for (const m of nonSystemMsgs) {
    const blocks = normalizeContentBlocks(m.content)

    if (blocks.length === 0) {
      // Empty message — skip tool role (requires tool_call_id), push others
      if (m.role !== 'tool') {
        result.push({
          role: mapRole(m.role) as 'user' | 'assistant' | 'system',
          content: '',
        })
      }
      continue
    }

    // Classify blocks
    const textBlocks = blocks.filter(b => b.type === 'text') as TextContent[]
    const toolUseBlocks = blocks.filter(b => b.type === 'tool_use') as ToolUseContent[]
    const toolResultBlocks = blocks.filter(b => b.type === 'tool_result') as ToolResultContent[]

    // Tool results from a 'tool' role → individual tool messages
    if (m.role === 'tool' || toolResultBlocks.length > 0) {
      for (const tr of toolResultBlocks) {
        const tc = tr as ToolResultContent
        result.push({
          role: 'tool',
          tool_call_id: tc.tool_use_id,
          content: typeof tc.content === 'string'
            ? tc.content
            : JSON.stringify(tc.content),
        })
      }
      // If there were non-tool-result blocks in a tool message, append them as a note
      const otherBlocks = blocks.filter(b => b.type !== 'tool_result')
      if (otherBlocks.length > 0) {
        result.push({
          role: 'tool',
          content: JSON.stringify(otherBlocks),
        } as OpenAI.Chat.ChatCompletionMessageParam)
      }
      continue
    }

    // Assistant message with tool_use blocks
    if (m.role === 'assistant' && toolUseBlocks.length > 0) {
      const openaiToolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = toolUseBlocks.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      }))

      // Assistant content: concatenate text blocks, or null if only tool calls
      const textContent = textBlocks.map(t => t.text).join('\n') || null

      result.push({
        role: 'assistant',
        content: textContent,
        tool_calls: openaiToolCalls,
        ...(m.name ? { name: m.name } : {}),
      } as OpenAI.Chat.ChatCompletionMessageParam)
      continue
    }

    // Standard user/assistant text message (tool-messages are handled above)
    const textContent = textBlocks.map(t => t.text).join('\n')
    result.push({
      role: mapRole(m.role) as 'user' | 'assistant' | 'system',
      content: textContent || extractSystemText(m.content),
      ...(m.name ? { name: m.name } : {}),
    })
  }

  return result
}

/**
 * Map TAOR MessageRole to OpenAI chat completion role string.
 */
function mapRole(role: string): 'user' | 'assistant' | 'system' | 'tool' {
  const allowed = ['user', 'assistant', 'system', 'tool']
  if (allowed.includes(role)) return role as 'user' | 'assistant' | 'system' | 'tool'
  // Fallback: map unknown roles to 'user'
  return 'user'
}

// =============================================================================
// Internal helpers — tool definition conversion
// =============================================================================

interface OpenAIFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Convert TAOR ToolDef[] into OpenAI function tool definitions.
 */
function toOpenAITools(tools: ToolDef[]): OpenAIFunctionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }))
}

// =============================================================================
// Internal helpers — streaming tool call accumulation
// =============================================================================

interface PendingToolCall {
  id: string
  name: string
  argumentsJson: string
}

/**
 * Accumulate partial streaming tool call deltas into full tool calls.
 * OpenAI streams tool calls incrementally: first the id + name, then
 * arguments in fragments.
 */
class ToolCallAccumulator {
  private calls = new Map<number, PendingToolCall>()

  /** Ingest a tool-call delta array from a streaming chunk. */
  ingest(deltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]): void {
    for (const delta of deltas) {
      const index = delta.index ?? 0
      let pending = this.calls.get(index)
      if (!pending) {
        pending = { id: '', name: '', argumentsJson: '' }
        this.calls.set(index, pending)
      }
      if (delta.id) pending.id = delta.id
      if (delta.type === 'function' && delta.function) {
        if (delta.function.name) pending.name += delta.function.name
        if (delta.function.arguments) pending.argumentsJson += delta.function.arguments
      }
    }
  }

  /** Check whether any accumulated tool calls are complete enough to parse. */
  hasComplete(): boolean {
    for (const tc of this.calls.values()) {
      if (tc.id && tc.name && tc.argumentsJson) return true
    }
    return false
  }

  /**
   * Finalize and return all fully-formed tool calls.
   * Attempts to parse accumulated JSON; falls back to empty object on failure.
   */
  finalize(): ToolUseContent[] {
    const result: ToolUseContent[] = []
    for (const tc of this.calls.values()) {
      if (!tc.id || !tc.name) continue
      let input: Record<string, unknown> = {}
      if (tc.argumentsJson) {
        try {
          input = JSON.parse(tc.argumentsJson)
        } catch {
          // If arguments are malformed JSON, pass them as a raw string property
          input = { _raw_arguments: tc.argumentsJson }
        }
      }
      result.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
    }
    return result
  }

  /** Clear accumulated state for a new stream. */
  reset(): void {
    this.calls.clear()
  }
}

// =============================================================================
// Internal helpers — feature detection
// =============================================================================

/**
 * Heuristic: does this model support thinking/reasoning tokens?
 *
 * Models known to support reasoning_content:
 *   - DeepSeek R1 (deepseek-reasoner, deepseek-r1-*)
 *   - OpenAI o1, o1-mini, o1-preview, o3, o3-mini, o4-mini
 *   - Models with 'reasoning' or 'think' in their name
 */
function modelSupportsThinking(model: string): boolean {
  const lower = model.toLowerCase()
  const thinkingPatterns = [
    'r1', 'reasoner', 'reasoning',
    'o1', 'o1-mini', 'o1-preview',
    'o3', 'o3-mini',
    'o4', 'o4-mini',
    '-think',
  ]
  return thinkingPatterns.some(p => lower.includes(p))
}

// =============================================================================
// Provider implementation
// =============================================================================

class OpenAICompatProvider implements LlmProvider {
  public readonly name: string
  public readonly model: string

  private readonly client: OpenAI
  private readonly options: Required<Pick<OpenAICompatProviderOptions, 'maxTokens' | 'temperature'>>

  constructor(opts: OpenAICompatProviderOptions) {
    this.name = opts.name || 'openai-compat'
    this.model = opts.model || 'gpt-4o'

    if (!opts.model) {
      throw new Error(
        `[${this.name}] OpenAICompatProvider requires a "model" option. ` +
        `Example: createOpenAICompatProvider({ model: "gpt-4o" })`,
      )
    }

    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error(
        `[${this.name}] No API key provided. Set OPENAI_API_KEY env var or pass apiKey option.`,
      )
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL || undefined,
    })

    this.options = {
      maxTokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.7,
    }
  }

  // ===========================================================================
  // streamChat — OpenAI streaming completions with SSE processing
  // ===========================================================================

  async *streamChat(
    messages: Message[],
    tools: ToolDef[],
    options?: LlmChatOptions,
  ): AsyncGenerator<ResponseChunk, void, unknown> {
    const openaiMessages = toOpenAIMessages(messages)
    const openaiTools = toOpenAITools(tools)
    const accumulator = new ToolCallAccumulator()
    const textBuffer: string[] = []

    const maxTokens = options?.maxTokens ?? this.options.maxTokens
    const temperature = options?.temperature ?? this.options.temperature

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
        max_tokens: maxTokens,
        temperature,
        top_p: options?.topP,
        stop: options?.stopSequences,
        stream: true,
        ...(options?.extra ?? {}),
      })

      let finishReason: string | null = null
      let usage:
        | { input_tokens: number; output_tokens: number }
        | undefined

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta

        // Text content — yield incrementally
        if (delta?.content) {
          textBuffer.push(delta.content)
          const textBlock: TextContent = { type: 'text', text: delta.content }
          yield { type: 'content_block', content: textBlock }
        }

        // Tool call deltas — accumulate
        if (delta?.tool_calls && delta.tool_calls.length > 0) {
          accumulator.ingest(
            delta.tool_calls as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[],
          )
        }

        // Capture finish reason (may appear in a chunk before the stream ends)
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason
        }

        // Capture usage if available (some providers include it in the final chunk)
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
          }
        }
      }

      // Yield accumulated tool calls (if any) before the done chunk
      const finalToolCalls = accumulator.finalize()
      for (const tc of finalToolCalls) {
        yield {
          type: 'content_block',
          content: tc,
        }
      }

      // Yield the done chunk
      const fullText = textBuffer.join('')
      const stopReason = finishReason || 'end_turn'

      yield {
        type: 'done',
        text: fullText,
        stop_reason: stopReason,
        usage,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[${this.name}] streamChat error:`, message)
      yield {
        type: 'done',
        text: `Error [${this.name}]: ${message}`,
        stop_reason: 'error',
      }
    }
  }

  // ===========================================================================
  // chat — non-streaming completion
  // ===========================================================================

  async chat(
    messages: Message[],
    tools: ToolDef[],
    options?: LlmChatOptions,
  ): Promise<ChatResult> {
    const openaiMessages = toOpenAIMessages(messages)
    const openaiTools = toOpenAITools(tools)

    const maxTokens = options?.maxTokens ?? this.options.maxTokens
    const temperature = options?.temperature ?? this.options.temperature

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
        max_tokens: maxTokens,
        temperature,
        top_p: options?.topP,
        stop: options?.stopSequences,
        stream: false,
        ...(options?.extra ?? {}),
      })

      const choice = response.choices[0]
      if (!choice) {
        return { text: '', toolCalls: [], stopReason: 'empty' }
      }

      const msg = choice.message
      let text = ''
      const toolCalls: ChatResult['toolCalls'] = []

      if (msg.content) {
        text = msg.content
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          if (tc.type !== 'function') continue
          let input: Record<string, unknown> = {}
          if (tc.function.arguments) {
            try {
              input = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function.arguments as Record<string, unknown>)
            } catch {
              input = { _raw_arguments: tc.function.arguments }
            }
          }
          toolCalls.push({ id: tc.id, name: tc.function.name, input })
        }
      }

      return {
        text,
        toolCalls,
        stopReason: choice.finish_reason || 'end_turn',
        usage: response.usage
          ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
          : undefined,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[${this.name}] chat error:`, message)
      return {
        text: `Error [${this.name}]: ${message}`,
        toolCalls: [],
        stopReason: 'error',
      }
    }
  }

  // ===========================================================================
  // Feature / capability queries
  // ===========================================================================

  supportsFeature(feature: LlmFeature): boolean {
    switch (feature) {
      case 'streaming':
        return true
      case 'toolUse':
        return true
      case 'thinking':
        return modelSupportsThinking(this.model)
      case 'promptCaching':
        return false // varies by provider; not supported generically
      default:
        return false
    }
  }

  getCapabilities(): LlmCapabilities {
    return {
      model: this.model,
      contextWindow: 0, // unknown — depends on provider + model
      maxOutputTokens: this.options.maxTokens,
      streaming: true,
      supportsStreaming: true,
      supportsThinking: modelSupportsThinking(this.model),
      supportsPromptCaching: false,
      supportsToolUse: true,
      supportedFeatures: (['streaming', 'toolUse'] as LlmFeature[]).concat(
        modelSupportsThinking(this.model) ? ['thinking' as LlmFeature] : [],
      ),
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an OpenAI-compatible LLM provider.
 *
 * Example usage:
 * ```typescript
 * // MiniMax
 * const minimax = createOpenAICompatProvider({
 *   name: 'minimax',
 *   baseURL: 'https://api.minimax.io/v1',
 *   model: 'MiniMax-M2.7',
 *   temperature: 0.8,
 * })
 *
 * // DeepSeek
 * const deepseek = createOpenAICompatProvider({
 *   name: 'deepseek',
 *   baseURL: 'https://api.deepseek.com/v1',
 *   model: 'deepseek-chat',
 * })
 *
 * // Groq
 * const groq = createOpenAICompatProvider({
 *   name: 'groq',
 *   baseURL: 'https://api.groq.com/openai/v1',
 *   model: 'llama-3.3-70b-versatile',
 * })
 *
 * // Ollama (local)
 * const ollama = createOpenAICompatProvider({
 *   name: 'ollama',
 *   baseURL: 'http://localhost:11434/v1',
 *   model: 'llama3.1:8b',
 * })
 * ```
 */
export function createOpenAICompatProvider(
  options: OpenAICompatProviderOptions,
): LlmProvider {
  return new OpenAICompatProvider(options)
}
