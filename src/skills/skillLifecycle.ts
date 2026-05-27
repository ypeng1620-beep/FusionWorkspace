/**
 * Skill Lifecycle — 技能全生命周期闭环
 *
 * 将技能从"静态资源"升级为"可发现、可评估、可修补、可进化"的系统。
 *
 * 生命周期阶段：
 * 1. Discovery    — 按触发词/任务类型/上下文自动发现匹配技能
 * 2. Execution    — 技能执行契约（返回什么/依赖什么工具/失败回退）
 * 3. Evaluation   — 使用是否成功/是否值得保留
 * 4. Patch        — 发现过时/错误后如何更新
 * 5. Forge        — 复杂任务完成后生成新技能草案
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'

// =============================================================================
// 类型定义
// =============================================================================

/** 技能发现上下文 */
export interface SkillDiscoveryContext {
  /** 用户输入文本 */
  userInput: string
  /** 当前使用的工具列表 */
  activeTools: string[]
  /** 当前渠道 */
  channel?: string
  /** 用户 ID */
  userId?: string
  /** 会话 ID */
  sessionId?: string
  /** 任务类型（如 code-review, data-analysis, writing） */
  taskType?: string
  /** 当前对话历史摘要 */
  conversationSummary?: string
}

/** 技能发现结果 */
export interface SkillDiscoveryResult {
  /** 匹配的技能 */
  skills: Array<{
    name: string
    score: number
    matchReason: string
    confidence: 'high' | 'medium' | 'low'
  }>
  /** 是否找到匹配 */
  found: boolean
  /** 建议（如果没有匹配） */
  suggestion?: string
}

/** 技能执行契约 */
export interface SkillExecutionContract {
  /** 技能名称 */
  skillName: string
  /** 必需的工具依赖 */
  requiredTools: string[]
  /** 可选的工具依赖 */
  optionalTools: string[]
  /** 期望的输入参数 */
  expectedInputs: Array<{
    name: string
    type: 'string' | 'number' | 'boolean' | 'object'
    required: boolean
    description: string
  }>
  /** 期望的输出格式 */
  expectedOutput: {
    type: 'text' | 'structured' | 'file'
    description: string
  }
  /** 失败回退策略 */
  fallbackStrategy: 'retry' | 'skip' | 'manual' | 'abort'
  /** 最大重试次数 */
  maxRetries: number
  /** 超时时间（毫秒） */
  timeoutMs: number
}

/** 技能执行记录 */
export interface SkillExecutionRecord {
  id: string
  skillName: string
  startedAt: number
  completedAt?: number
  success: boolean
  error?: string
  inputs: Record<string, unknown>
  output?: string
  durationMs: number
  toolsUsed: string[]
  retryCount: number
}

/** 技能评估报告 */
export interface SkillEvaluationReport {
  skillName: string
  totalExecutions: number
  successRate: number
  avgDurationMs: number
  lastExecutedAt: number
  errorPatterns: Array<{
    error: string
    count: number
    lastSeen: number
  }>
  toolDependencies: Record<string, number>
  recommendation: 'keep' | 'improve' | 'deprecate' | 'remove'
  recommendationReason: string
}

/** 技能修补建议 */
export interface SkillPatchProposal {
  id: string
  skillName: string
  /** 修补原因 */
  reason: string
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical'
  /** 当前版本 */
  currentVersion: string
  /** 建议版本 */
  proposedVersion: string
  /** 修补内容 */
  changes: Array<{
    type: 'update_prompt' | 'add_tool' | 'remove_tool' | 'update_params' | 'update_fallback'
    description: string
    before?: string
    after?: string
  }>
  /** 创建时间 */
  createdAt: number
  /** 状态 */
  status: 'open' | 'applied' | 'rejected' | 'pending_review'
  /** 应用结果 */
  appliedResult?: string
}

/** 技能锻造请求（从执行轨迹生成新技能） */
export interface SkillForgeRequest {
  /** 请求 ID */
  id: string
  /** 触发此技能的对话 */
  triggerPrompt: string
  /** 执行过程中使用的工具序列 */
  toolSequence: Array<{
    toolName: string
    params: Record<string, unknown>
    success: boolean
  }>
  /** 最终结果 */
  finalResult: string
  /** 执行步骤数 */
  stepCount: number
  /** 是否成功 */
  success: boolean
  /** 用户反馈 */
  userFeedback?: 'positive' | 'negative' | 'neutral'
  /** 建议的技能名称 */
  suggestedName?: string
  /** 建议的触发词 */
  suggestedTriggers?: string[]
}

/** 锻造出的技能草案 */
export interface SkillDraft {
  id: string
  name: string
  description: string
  triggers: string[]
  promptTemplate: string
  executionContract: SkillExecutionContract
  confidence: number
  sourceForgeRequestId: string
  createdAt: number
  status: 'draft' | 'approved' | 'rejected'
}

// =============================================================================
// 技能发现器
// =============================================================================

export class SkillDiscoverer {
  /** 按触发词发现技能 */
  discoverByTriggers(
    userInput: string,
    availableSkills: Array<{ name: string; triggers?: string[]; tags?: string[]; description: string }>,
  ): SkillDiscoveryResult {
    const lowerInput = userInput.toLowerCase()
    const matches: SkillDiscoveryResult['skills'] = []

    for (const skill of availableSkills) {
      let score = 0
      const matchReasons: string[] = []

      // 触发词匹配（最高权重）
      if (skill.triggers) {
        for (const trigger of skill.triggers) {
          if (lowerInput.includes(trigger.toLowerCase())) {
            score += 3
            matchReasons.push(`trigger:"${trigger}"`)
          }
        }
      }

      // 名称匹配
      if (lowerInput.includes(skill.name.toLowerCase())) {
        score += 2
        matchReasons.push(`name:"${skill.name}"`)
      }

      // 描述匹配
      if (skill.description && lowerInput.includes(skill.description.toLowerCase().slice(0, 40))) {
        score += 1
        matchReasons.push('description_match')
      }

      // 标签匹配
      if (skill.tags) {
        for (const tag of skill.tags) {
          if (lowerInput.includes(tag.toLowerCase())) {
            score += 1
            matchReasons.push(`tag:"${tag}"`)
          }
        }
      }

      if (score > 0) {
        matches.push({
          name: skill.name,
          score,
          matchReason: matchReasons.join(', '),
          confidence: score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low',
        })
      }
    }

    matches.sort((a, b) => b.score - a.score)

    return {
      skills: matches.slice(0, 5),
      found: matches.length > 0,
      suggestion: matches.length === 0 ? 'No matching skill found. Consider creating one via skill forge.' : undefined,
    }
  }

  /** 按任务类型发现技能 */
  discoverByTaskType(
    taskType: string,
    availableSkills: Array<{ name: string; tags?: string[]; description: string }>,
  ): SkillDiscoveryResult {
    const lowerTask = taskType.toLowerCase()
    const matches: SkillDiscoveryResult['skills'] = []

    for (const skill of availableSkills) {
      let score = 0
      const reasons: string[] = []

      if (skill.tags?.some(t => t.toLowerCase().includes(lowerTask))) {
        score += 3
        reasons.push(`task_type_match`)
      }

      if (skill.description.toLowerCase().includes(lowerTask)) {
        score += 1
        reasons.push('description_contains_task')
      }

      if (score > 0) {
        matches.push({
          name: skill.name,
          score,
          matchReason: reasons.join(', '),
          confidence: score >= 3 ? 'high' : 'medium',
        })
      }
    }

    matches.sort((a, b) => b.score - a.score)

    return {
      skills: matches.slice(0, 3),
      found: matches.length > 0,
    }
  }
}

// =============================================================================
// 技能执行契约管理器
// =============================================================================

export class SkillContractManager {
  private contracts: Map<string, SkillExecutionContract> = new Map()

  /** 注册技能契约 */
  registerContract(contract: SkillExecutionContract): void {
    this.contracts.set(contract.skillName, contract)
  }

  /** 获取技能契约 */
  getContract(skillName: string): SkillExecutionContract | null {
    return this.contracts.get(skillName) ?? null
  }

  /** 验证技能执行前置条件 */
  validatePreconditions(
    skillName: string,
    inputs: Record<string, unknown>,
    availableTools: string[],
  ): { valid: boolean; errors: string[] } {
    const contract = this.contracts.get(skillName)
    if (!contract) {
      return { valid: true, errors: [] } // 无契约则跳过验证
    }

    const errors: string[] = []

    // 检查必需工具
    for (const tool of contract.requiredTools) {
      if (!availableTools.includes(tool)) {
        errors.push(`Required tool '${tool}' not available`)
      }
    }

    // 检查必需输入
    for (const input of contract.expectedInputs) {
      if (input.required && !(input.name in inputs)) {
        errors.push(`Required input '${input.name}' missing`)
      }
    }

    return { valid: errors.length === 0, errors }
  }

  /** 生成默认契约（从技能元数据推断） */
  inferContract(skillName: string, triggers: string[], description: string): SkillExecutionContract {
    return {
      skillName,
      requiredTools: [],
      optionalTools: [],
      expectedInputs: [],
      expectedOutput: { type: 'text', description: description.slice(0, 100) },
      fallbackStrategy: 'retry',
      maxRetries: 2,
      timeoutMs: 30000,
    }
  }

  /** 获取所有已注册契约 */
  getAllContracts(): SkillExecutionContract[] {
    return Array.from(this.contracts.values())
  }
}

// =============================================================================
// 技能评估器
// =============================================================================

export class SkillEvaluator {
  private records: Map<string, SkillExecutionRecord[]> = new Map()
  private persistDir: string

  constructor(persistDir: string) {
    this.persistDir = resolve(persistDir)
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 记录技能执行 */
  async recordExecution(record: Omit<SkillExecutionRecord, 'id' | 'completedAt' | 'durationMs'>): Promise<SkillExecutionRecord> {
    const fullRecord: SkillExecutionRecord = {
      ...record,
      id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      completedAt: Date.now(),
      durationMs: Date.now() - record.startedAt,
    }

    const skillRecords = this.records.get(record.skillName) ?? []
    skillRecords.push(fullRecord)

    // 保留最近 100 条记录
    if (skillRecords.length > 100) {
      skillRecords.splice(0, skillRecords.length - 100)
    }

    this.records.set(record.skillName, skillRecords)
    await this.persist()
    return fullRecord
  }

  /** 生成技能评估报告 */
  generateReport(skillName: string): SkillEvaluationReport | null {
    const records = this.records.get(skillName)
    if (!records || records.length === 0) return null

    const totalExecutions = records.length
    const successCount = records.filter(r => r.success).length
    const successRate = successCount / totalExecutions
    const avgDurationMs = records.reduce((sum, r) => sum + r.durationMs, 0) / totalExecutions
    const lastExecutedAt = records[records.length - 1].completedAt ?? records[records.length - 1].startedAt

    // 错误模式分析
    const errorMap = new Map<string, { count: number; lastSeen: number }>()
    for (const record of records) {
      if (!record.success && record.error) {
        const existing = errorMap.get(record.error) ?? { count: 0, lastSeen: 0 }
        existing.count++
        existing.lastSeen = Math.max(existing.lastSeen, record.completedAt ?? record.startedAt)
        errorMap.set(record.error, existing)
      }
    }

    const errorPatterns = Array.from(errorMap.entries())
      .map(([error, data]) => ({ error, count: data.count, lastSeen: data.lastSeen }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    // 工具依赖统计
    const toolDeps: Record<string, number> = {}
    for (const record of records) {
      for (const tool of record.toolsUsed) {
        toolDeps[tool] = (toolDeps[tool] ?? 0) + 1
      }
    }

    // 推荐
    let recommendation: SkillEvaluationReport['recommendation']
    let recommendationReason: string

    if (totalExecutions < 3) {
      recommendation = 'keep'
      recommendationReason = 'insufficient_data'
    } else if (successRate >= 0.8) {
      recommendation = 'keep'
      recommendationReason = `high_success_rate (${(successRate * 100).toFixed(0)}%)`
    } else if (successRate >= 0.5) {
      recommendation = 'improve'
      recommendationReason = `moderate_success_rate (${(successRate * 100).toFixed(0)}%), needs improvement`
    } else if (successRate >= 0.2) {
      recommendation = 'deprecate'
      recommendationReason = `low_success_rate (${(successRate * 100).toFixed(0)}%), consider deprecating`
    } else {
      recommendation = 'remove'
      recommendationReason = `very_low_success_rate (${(successRate * 100).toFixed(0)}%), recommend removal`
    }

    return {
      skillName,
      totalExecutions,
      successRate,
      avgDurationMs,
      lastExecutedAt,
      errorPatterns,
      toolDependencies: toolDeps,
      recommendation,
      recommendationReason,
    }
  }

  /** 获取所有技能的评估摘要 */
  getAllSummaries(): Array<{ skillName: string; totalExecutions: number; successRate: number; recommendation: string }> {
    const summaries: Array<{ skillName: string; totalExecutions: number; successRate: number; recommendation: string }> = []

    for (const skillName of this.records.keys()) {
      const report = this.generateReport(skillName)
      if (report) {
        summaries.push({
          skillName,
          totalExecutions: report.totalExecutions,
          successRate: report.successRate,
          recommendation: report.recommendation,
        })
      }
    }

    return summaries.sort((a, b) => b.totalExecutions - a.totalExecutions)
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'execution-records.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, SkillExecutionRecord[]>
      for (const [skillName, records] of Object.entries(data)) {
        this.records.set(skillName, records)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private async persist(): Promise<void> {
    const filePath = join(this.persistDir, 'execution-records.json')
    const data: Record<string, SkillExecutionRecord[]> = {}
    for (const [skillName, records] of this.records) {
      data[skillName] = records
    }
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }
}

// =============================================================================
// 技能锻造器
// =============================================================================

export class SkillForge {
  private drafts: Map<string, SkillDraft> = new Map()
  private persistDir: string

  constructor(persistDir: string) {
    this.persistDir = resolve(persistDir)
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 从执行轨迹锻造新技能草案 */
  forgeSkill(request: SkillForgeRequest): SkillDraft {
    // 从工具序列推断技能名称
    const name = request.suggestedName ?? this.inferSkillName(request.toolSequence)
    const triggers = request.suggestedTriggers ?? this.inferTriggers(request.triggerPrompt)

    // 生成 prompt 模板
    const promptTemplate = this.generatePromptTemplate(request)

    // 推断执行契约
    const requiredTools = [...new Set(request.toolSequence.filter(t => t.success).map(t => t.toolName))]
    const contract: SkillExecutionContract = {
      skillName: name,
      requiredTools,
      optionalTools: [],
      expectedInputs: [],
      expectedOutput: { type: 'text', description: request.finalResult.slice(0, 100) },
      fallbackStrategy: request.success ? 'retry' : 'manual',
      maxRetries: 2,
      timeoutMs: 30000,
    }

    // 计算置信度
    const confidence = this.calculateConfidence(request)

    const draft: SkillDraft = {
      id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: `Auto-generated from execution trace (${request.stepCount} steps)`,
      triggers,
      promptTemplate,
      executionContract: contract,
      confidence,
      sourceForgeRequestId: request.id,
      createdAt: Date.now(),
      status: 'draft',
    }

    this.drafts.set(draft.id, draft)
    this.persist()
    return draft
  }

  /** 审批技能草案 */
  approveDraft(draftId: string): SkillDraft | null {
    const draft = this.drafts.get(draftId)
    if (!draft) return null
    draft.status = 'approved'
    this.persist()
    return draft
  }

  /** 拒绝技能草案 */
  rejectDraft(draftId: string): SkillDraft | null {
    const draft = this.drafts.get(draftId)
    if (!draft) return null
    draft.status = 'rejected'
    this.persist()
    return draft
  }

  /** 获取所有草案 */
  getDrafts(status?: SkillDraft['status']): SkillDraft[] {
    const all = Array.from(this.drafts.values())
    if (status) return all.filter(d => d.status === status)
    return all
  }

  /** 获取待审批的草案 */
  getPendingDrafts(): SkillDraft[] {
    return this.getDrafts('draft')
  }

  private inferSkillName(toolSequence: SkillForgeRequest['toolSequence']): string {
    const tools = toolSequence.filter(t => t.success).map(t => t.toolName)
    if (tools.length === 0) return 'unknown-skill'
    return tools.slice(0, 2).join('-').replace(/_/g, '-') + '-skill'
  }

  private inferTriggers(prompt: string): string[] {
    // 提取前 3 个有意义的词
    const words = prompt
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
    return [...new Set(words)].slice(0, 3)
  }

  private generatePromptTemplate(request: SkillForgeRequest): string {
    const toolSteps = request.toolSequence
      .filter(t => t.success)
      .map((t, i) => `${i + 1}. Call ${t.toolName} with params: ${JSON.stringify(t.params)}`)
      .join('\n')

    return `# Skill: To be defined

## Trigger
When the user asks about: ${request.triggerPrompt.slice(0, 80)}...

## Steps
${toolSteps || 'No successful tool calls to extract.'}

## Expected Output
${request.finalResult.slice(0, 200)}
`
  }

  private calculateConfidence(request: SkillForgeRequest): number {
    let confidence = 0.5

    // 成功执行加分
    if (request.success) confidence += 0.2

    // 用户反馈
    if (request.userFeedback === 'positive') confidence += 0.2
    else if (request.userFeedback === 'negative') confidence -= 0.3

    // 步骤数适中加分（太少可能太简单，太多可能太复杂）
    if (request.stepCount >= 2 && request.stepCount <= 10) confidence += 0.1

    return Math.max(0.1, Math.min(1.0, confidence))
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'skill-drafts.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as SkillDraft[]
      for (const draft of data) {
        this.drafts.set(draft.id, draft)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private persist(): void {
    const filePath = join(this.persistDir, 'skill-drafts.json')
    writeFile(filePath, JSON.stringify(Array.from(this.drafts.values()), null, 2), 'utf-8').catch(() => {})
  }
}

// =============================================================================
// 技能修补管理器
// =============================================================================

export class SkillPatchManager {
  private proposals: Map<string, SkillPatchProposal> = new Map()
  private persistDir: string

  constructor(persistDir: string) {
    this.persistDir = resolve(persistDir)
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.persistDir)) {
      await mkdir(this.persistDir, { recursive: true })
    }
    await this.loadFromDisk()
  }

  /** 创建修补建议 */
  createProposal(proposal: Omit<SkillPatchProposal, 'id' | 'createdAt' | 'status'>): SkillPatchProposal {
    const full: SkillPatchProposal = {
      ...proposal,
      id: `patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      status: 'open',
    }
    this.proposals.set(full.id, full)
    this.persist()
    return full
  }

  /** 应用修补 */
  applyProposal(proposalId: string, result: string): SkillPatchProposal | null {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) return null
    proposal.status = 'applied'
    proposal.appliedResult = result
    this.persist()
    return proposal
  }

  /** 拒绝修补 */
  rejectProposal(proposalId: string): SkillPatchProposal | null {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) return null
    proposal.status = 'rejected'
    this.persist()
    return proposal
  }

  /** 获取开放的修补建议 */
  getOpenProposals(skillName?: string): SkillPatchProposal[] {
    const all = Array.from(this.proposals.values()).filter(p => p.status === 'open')
    if (skillName) return all.filter(p => p.skillName === skillName)
    return all
  }

  /** 按技能获取所有修补历史 */
  getProposalsForSkill(skillName: string): SkillPatchProposal[] {
    return Array.from(this.proposals.values())
      .filter(p => p.skillName === skillName)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, 'patch-proposals.json')
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as SkillPatchProposal[]
      for (const proposal of data) {
        this.proposals.set(proposal.id, proposal)
      }
    } catch {
      // 忽略损坏的文件
    }
  }

  private persist(): void {
    const filePath = join(this.persistDir, 'patch-proposals.json')
    writeFile(filePath, JSON.stringify(Array.from(this.proposals.values()), null, 2), 'utf-8').catch(() => {})
  }
}
