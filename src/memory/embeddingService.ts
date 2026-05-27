/**
 * Embedding Service — vector embedding generation for the memory system.
 *
 * Supports multiple backends: Ollama (local), OpenAI, and direct API.
 * All backends share a common interface so the memory system can swap
 * embedding providers without code changes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  readonly name: string
  readonly dimension: number
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

export interface OllamaEmbedConfig {
  endpoint?: string
  model?: string
  dimension?: number
}

export interface OpenAIEmbedConfig {
  apiKey?: string
  model?: string
  dimension?: number
  baseURL?: string
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama'
  readonly dimension: number
  private endpoint: string
  private model: string

  constructor(config: OllamaEmbedConfig = {}) {
    this.endpoint = config.endpoint ?? process.env.EMBEDDING_ENDPOINT ?? 'http://localhost:11434/api/embeddings'
    this.model = config.model ?? process.env.EMBEDDING_MODEL ?? 'nomic-embed-text'
    this.dimension = config.dimension ?? 384
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    })

    if (!response.ok) {
      throw new Error(`[OllamaEmbed] HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as { embedding?: number[] }
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error('[OllamaEmbed] Response missing embedding array')
    }

    return data.embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = []
    for (const text of texts) {
      results.push(await this.embed(text))
    }
    return results
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai'
  readonly dimension: number
  private apiKey: string
  private model: string
  private baseURL: string

  constructor(config: OpenAIEmbedConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? ''
    this.model = config.model ?? 'text-embedding-3-small'
    this.dimension = config.dimension ?? 1536
    this.baseURL = config.baseURL ?? 'https://api.openai.com/v1'
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    })

    if (!response.ok) {
      throw new Error(`[OpenAIEmbed] HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>
    }

    const embedding = data.data?.[0]?.embedding
    if (!embedding) {
      throw new Error('[OpenAIEmbed] Response missing embedding data')
    }

    return embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    })

    if (!response.ok) {
      const results: number[][] = []
      for (const text of texts) {
        results.push(await this.embed(text))
      }
      return results
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>
    }

    return data.data.map((item) => item.embedding)
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no network required)
// ---------------------------------------------------------------------------

class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'deterministic'
  readonly dimension: number

  constructor(dimension = 384) {
    this.dimension = dimension
  }

  async embed(text: string): Promise<number[]> {
    return deterministicEmbed(text, this.dimension)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicEmbed(t, this.dimension))
  }
}

function deterministicEmbed(text: string, dimension: number): number[] {
  const hash = simpleHash(text)
  const vector = new Array<number>(dimension)
  for (let i = 0; i < dimension; i++) {
    vector[i] = Math.sin(hash * (i + 1) * 12.9898) * 43758.5453 % 1
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  return norm > 0 ? vector.map((v) => v / norm) : vector
}

function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _provider: EmbeddingProvider | null = null

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_provider) {
    _provider = createDefaultProvider()
  }
  return _provider
}

export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  _provider = provider
}

function createDefaultProvider(): EmbeddingProvider {
  const endpoint = process.env.EMBEDDING_ENDPOINT ?? ''
  const apiKey = process.env.EMBEDDING_API_KEY ?? ''

  if (apiKey && (endpoint.includes('openai') || process.env.OPENAI_API_KEY)) {
    return new OpenAIEmbeddingProvider()
  }

  if (endpoint) {
    return new OllamaEmbeddingProvider({ endpoint })
  }

  // No embedding service configured — use deterministic fallback
  return new DeterministicEmbeddingProvider()
}

// ---------------------------------------------------------------------------
// Convenience: generate embedding with the current provider
// ---------------------------------------------------------------------------

export async function embed(text: string, dim?: number): Promise<number[]> {
  const provider = getEmbeddingProvider()
  if (dim && dim !== provider.dimension) {
    // If caller requests a specific dimension that differs, use fallback
    return deterministicEmbed(text, dim)
  }
  try {
    return await provider.embed(text)
  } catch (err) {
    console.warn('[EmbeddingService] Provider failed, falling back to deterministic:', err)
    return deterministicEmbed(text, dim ?? provider.dimension)
  }
}

export async function embedBatch(texts: string[], dim?: number): Promise<number[][]> {
  const provider = getEmbeddingProvider()
  if (dim && dim !== provider.dimension) {
    return texts.map((t) => deterministicEmbed(t, dim))
  }
  try {
    return await provider.embedBatch(texts)
  } catch (err) {
    console.warn('[EmbeddingService] Provider batch failed, falling back:', err)
    return texts.map((t) => deterministicEmbed(t, dim ?? provider.dimension))
  }
}

// Re-export for convenience
export { OllamaEmbeddingProvider, OpenAIEmbeddingProvider, DeterministicEmbeddingProvider }
