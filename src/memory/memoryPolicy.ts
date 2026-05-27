/**
 * Memory Policy — 记忆写入/召回策略层
 *
 * 把原始对话整理成更适合长期存储与召回的文本，
 * 并控制哪些交互值得进入长期记忆。
 */

export interface MemoryPolicyInput {
  prompt: string
  response: string
  toolNames: string[]
  sessionId?: string
  userId?: string
  timestamp?: number
}

export interface MemoryPolicyDecision {
  shouldStore: boolean
  reason: string
  category: 'preference' | 'workflow' | 'fact' | 'conversation'
  importance: 'low' | 'medium' | 'high'
  recallQuery: string
}

export class MemoryPolicy {
  decide(input: MemoryPolicyInput): MemoryPolicyDecision {
    const normalizedPrompt = input.prompt.trim()
    const normalizedResponse = input.response.trim()
    const text = `${normalizedPrompt}\n${normalizedResponse}`.toLowerCase()

    if (!normalizedPrompt || !normalizedResponse) {
      return {
        shouldStore: false,
        reason: 'empty_prompt_or_response',
        category: 'conversation',
        importance: 'low',
        recallQuery: normalizedPrompt,
      }
    }

    if (normalizedPrompt.length < 8 && normalizedResponse.length < 24 && input.toolNames.length === 0) {
      return {
        shouldStore: false,
        reason: 'too_trivial',
        category: 'conversation',
        importance: 'low',
        recallQuery: normalizedPrompt,
      }
    }

    if (/(偏好|喜欢|讨厌|不要|记住|always|never|prefer)/i.test(text)) {
      return {
        shouldStore: true,
        reason: 'stable_preference_detected',
        category: 'preference',
        importance: 'high',
        recallQuery: this.buildRecallQuery(normalizedPrompt, input.toolNames),
      }
    }

    if (input.toolNames.length >= 2 || /(修复|排查|调试|方案|workflow|步骤|恢复|配置)/i.test(text)) {
      return {
        shouldStore: true,
        reason: 'reusable_workflow_detected',
        category: 'workflow',
        importance: 'medium',
        recallQuery: this.buildRecallQuery(normalizedPrompt, input.toolNames),
      }
    }

    return {
      shouldStore: true,
      reason: 'default_useful_interaction',
      category: 'conversation',
      importance: 'medium',
      recallQuery: this.buildRecallQuery(normalizedPrompt, input.toolNames),
    }
  }

  buildMemoryEntry(input: MemoryPolicyInput, decision: MemoryPolicyDecision): string {
    const timestamp = new Date(input.timestamp ?? Date.now()).toISOString()
    const toolSection = input.toolNames.length > 0 ? input.toolNames.join(', ') : 'none'

    return [
      `[Memory/${decision.category}]`,
      `time=${timestamp}`,
      `importance=${decision.importance}`,
      input.sessionId ? `session=${input.sessionId}` : undefined,
      input.userId ? `user=${input.userId}` : undefined,
      `tools=${toolSection}`,
      '',
      `[User] ${input.prompt.trim()}`,
      `[Assistant] ${input.response.trim()}`,
    ].filter(Boolean).join('\n')
  }

  formatRecallContext(results: Array<{ content: string }>): string {
    if (results.length === 0) {
      return ''
    }

    const lines = results.map((result, index) => {
      const content = result.content.length > 220
        ? `${result.content.slice(0, 220)}...`
        : result.content
      return `${index + 1}. ${content}`
    })

    return `\n\n## Relevant Memory\n${lines.join('\n')}\n`
  }

  private buildRecallQuery(prompt: string, toolNames: string[]): string {
    const tokens = prompt
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 2)
      .slice(0, 6)

    return [...tokens, ...toolNames.slice(0, 2)].join(' ').trim() || prompt
  }
}
