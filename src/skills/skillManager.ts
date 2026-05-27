/**
 * Skill Manager — 技能自我进化系统
 * 
 * 融合 Hermes SkillForge + OpenClaw skills 的技能管理设计：
 * - 技能目录：~/.fusion_skills/（每个技能一个 SKILL.md）
 * - Frontmatter 格式：name/description/version/tags/triggers
 * - 技能内容：prompt 模板 + {{参数}} 占位符
 * - 自动生成：基于轨迹压缩的技能自创建
 * - 技能评估：使用统计 → 进化/淘汰
 * 
 * 纯 TypeScript，无外部依赖
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'

// =============================================================================
// 类型定义
// =============================================================================

/** 技能元数据（从 frontmatter 解析） */
export interface SkillMetadata {
  name: string
  description: string
  version: string
  tags?: string[]
  triggers?: string[]  // 触发词列表
  author?: string
  createdAt?: string
  updatedAt?: string
  usageCount: number
  successRate: number  // 0-1
  avgLatencyMs?: number
}

/** 技能完整对象 */
export interface Skill {
  metadata: SkillMetadata
  content: string  // prompt 模板正文
  filePath: string
}

/** 技能调用参数 */
export interface SkillCallParams {
  skillName: string
  params?: Record<string, string>
  context?: Record<string, unknown>
}

/** 技能执行结果 */
export interface SkillExecutionResult {
  success: boolean
  output: string
  skillName: string
  params: Record<string, string>
  latencyMs: number
  error?: string
}

/** 技能生成请求 */
export interface SkillGenerationRequest {
  name: string
  description: string
  triggerPhrases: string[]
  instructionTemplate: string
  examples?: string[]
  initialVersion?: string
}

/** 技能评估数据 */
export interface SkillEvaluation {
  skillName: string
  callCount: number
  successCount: number
  failureCount: number
  avgLatencyMs: number
  lastCalled?: number  // timestamp
  trending: 'rising' | 'stable' | 'declining'
}

export interface SkillTriggerMatch {
  skill: Skill
  score: number
  matchedBy: Array<'name' | 'description' | 'tag' | 'trigger'>
}

export interface SkillPatchSuggestion {
  id: string
  skillName: string
  reason: string
  createdAt: number
  severity: 'low' | 'medium' | 'high'
  examples?: string[]
  status: 'open' | 'applied' | 'dismissed'
}

export interface SkillLifecycleReport {
  generatedAt: string
  totalSkills: number
  evaluations: SkillEvaluation[]
  needsImprovement: SkillEvaluation[]
  trendingSkills: SkillEvaluation[]
  openPatchSuggestions: SkillPatchSuggestion[]
}

/** 技能管理器配置 */
export interface SkillManagerConfig {
  /** 技能目录路径 */
  skillsDir?: string
  /** 最大技能数量（默认 100） */
  maxSkills?: number
  /** 进化阈值：调用次数低于此值则考虑淘汰 */
  evolutionThreshold?: number
  /** 成功率阈值：低于此值则考虑重写 */
  successRateThreshold?: number
  /** 自动保存评估数据 */
  autoSaveStats?: boolean
  /** 评估数据文件路径 */
  statsFile?: string
  /** 生命周期文件路径 */
  lifecycleFile?: string
}

// =============================================================================
// Frontmatter 解析
// =============================================================================

/** 解析 YAML frontmatter */
function parseFrontmatter(content: string): { metadata: Partial<SkillMetadata>; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return { metadata: {}, body: content }
  }

  const frontmatterStr = match[1]
  const body = match[2]

  const metadata: Partial<SkillMetadata> = {}

  // 简单 YAML 解析（支持基本类型）
  for (const line of frontmatterStr.split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1).trim()

    if (value === '') continue

    // 解析值类型
    if (value === 'true') metadata[key as keyof SkillMetadata] = true as never
    else if (value === 'false') metadata[key as keyof SkillMetadata] = false as never
    else if (!isNaN(Number(value))) metadata[key as keyof SkillMetadata] = Number(value) as never
    else if (value.startsWith('[') && value.endsWith(']')) {
      // 简单数组解析
      const items = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''))
      metadata[key as keyof SkillMetadata] = items as never
    } else {
      metadata[key as keyof SkillMetadata] = value.replace(/['"]/g, '') as never
    }
  }

  return { metadata, body }
}

/** 生成 YAML frontmatter */
function generateFrontmatter(metadata: Partial<SkillMetadata>, body: string): string {
  const lines: string[] = ['---']

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || key === 'usageCount' || key === 'successRate' || key === 'avgLatencyMs') {
      // 这些字段由系统管理，不写入 frontmatter
      continue
    }

    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(v => `'${v}'`).join(', ')}]`)
    } else if (typeof value === 'string' && value.includes(':')) {
      lines.push(`${key}: '${value}'`)
    } else {
      lines.push(`${key}: ${value}`)
    }
  }

  lines.push('---')
  lines.push(body)

  return lines.join('\n')
}

// =============================================================================
// 技能评估器
// =============================================================================

/**
 * 技能评估器
 * 跟踪技能使用情况，计算成功率，识别退化趋势
 */
export class SkillEvaluator {
  private evaluations: Map<string, SkillEvaluation> = new Map()
  private statsFile?: string

  constructor(statsFile?: string) {
    this.statsFile = statsFile
  }

  /** 记录技能调用 */
  recordCall(skillName: string, success: boolean, latencyMs: number): void {
    const eval_ = this.evaluations.get(skillName) ?? {
      skillName,
      callCount: 0,
      successCount: 0,
      failureCount: 0,
      avgLatencyMs: 0,
      trending: 'stable' as const,
    }

    eval_.callCount++
    if (success) eval_.successCount++
    else eval_.failureCount++

    // 更新平均延迟（指数移动平均）
    eval_.avgLatencyMs = eval_.avgLatencyMs * 0.7 + latencyMs * 0.3
    eval_.lastCalled = Date.now()

    // 计算趋势（基于最近 10 次调用）
    if (eval_.callCount >= 10) {
      const recentSuccessRate = eval_.successCount / eval_.callCount
      const recentCalls = eval_.callCount
      // 简化趋势计算：callCount 变化率
      eval_.trending = recentCalls > 50 ? 'rising' : recentCalls < 20 ? 'declining' : 'stable'
    }

    this.evaluations.set(skillName, eval_)
  }

  /** 获取技能评估 */
  getEvaluation(skillName: string): SkillEvaluation | undefined {
    return this.evaluations.get(skillName)
  }

  /** 获取所有评估 */
  getAllEvaluations(): SkillEvaluation[] {
    return Array.from(this.evaluations.values())
  }

  /** 获取需要进化的技能列表 */
  getSkillsNeedingEvolution(threshold: number = 0.6, minCalls: number = 5): SkillEvaluation[] {
    return this.getAllEvaluations().filter(
      e => e.callCount >= minCalls && (e.successCount / e.callCount) < threshold
    )
  }

  /** 获取需要淘汰的技能列表 */
  getSkillsForRetirement(threshold: number = 10): SkillEvaluation[] {
    return this.getAllEvaluations().filter(e => e.callCount < threshold && e.trending === 'declining')
  }

  /** 获取趋势上升的技能 */
  getTrendingSkills(): SkillEvaluation[] {
    return this.getAllEvaluations().filter(e => e.trending === 'rising')
  }

  load(evaluations: SkillEvaluation[]): void {
    this.evaluations.clear()
    for (const evaluation of evaluations) {
      this.evaluations.set(evaluation.skillName, evaluation)
    }
  }

  export(): SkillEvaluation[] {
    return this.getAllEvaluations()
  }
}

// =============================================================================
// 技能生成器（基于轨迹压缩思想）
// =============================================================================

/**
 * 技能自动生成器
 * 
 * 基于 Hermes SkillForge 的技能自创建逻辑：
 * 1. 轨迹分析：检测重复模式 → 提取共性
 * 2. 模板抽象：用 {{参数}} 替换具体值
 * 3. 验证生成：使用少量示例验证
 */
export class SkillGenerator {
  /**
   * 从轨迹序列生成技能
   * 
   * @param trajectory 轨迹序列（用户意图 → 工具调用 → 结果）
   * @param request 生成请求
   * @returns 生成的技能内容
   */
  async generateFromTrajectory(
    trajectory: Array<{
      intent?: string
      toolCalls?: Array<{ name: string; params: Record<string, unknown>; result?: unknown }>
      result?: string
    }>,
    request: SkillGenerationRequest
  ): Promise<string> {
    // Step 1: 提取共性工具调用模式
    const toolPatterns = this.extractToolPatterns(trajectory)

    // Step 2: 识别参数占位符
    const placeholders = this.identifyPlaceholders(trajectory)

    // Step 3: 生成 prompt 模板
    return this.buildPromptTemplate(request, toolPatterns, placeholders)
  }

  /** 提取工具调用模式 */
  private extractToolPatterns(
    trajectory: Array<{
      toolCalls?: Array<{ name: string; params: Record<string, unknown>; result?: unknown }>
    }>
  ): Map<string, number> {
    const patterns = new Map<string, number>()

    for (const step of trajectory) {
      if (!step.toolCalls) continue
      for (const call of step.toolCalls) {
        const key = `${call.name}(${Object.keys(call.params).join(', ')})`
        patterns.set(key, (patterns.get(key) ?? 0) + 1)
      }
    }

    return patterns
  }

  /** 识别可参数化的值 */
  private identifyPlaceholders(
    trajectory: Array<{
      toolCalls?: Array<{ name: string; params: Record<string, unknown> }>
    }>
  ): Set<string> {
    const placeholders = new Set<string>()
    const sampleValues = new Map<string, Set<unknown>>()

    // 收集同类参数的不同值
    for (const step of trajectory) {
      if (!step.toolCalls) continue
      for (const call of step.toolCalls) {
        for (const [key, value] of Object.entries(call.params)) {
          if (!sampleValues.has(key)) sampleValues.set(key, new Set())
          sampleValues.get(key)!.add(value)
        }
      }
    }

    // 如果一个参数有多个不同值，它应该被参数化
    for (const [key, values] of sampleValues) {
      if (values.size > 1) {
        placeholders.add(key)
      }
    }

    return placeholders
  }

  /** 构建 prompt 模板 */
  private buildPromptTemplate(
    request: SkillGenerationRequest,
    toolPatterns: Map<string, number>,
    placeholders: Set<string>
  ): string {
    const lines: string[] = [
      `# ${request.name}`,
      '',
      request.description || '自动生成的技能',
      '',
      '## 触发条件',
      request.triggerPhrases.map(p => `- ${p}`).join('\n'),
      '',
      '## 执行步骤',
    ]

    // 添加工具调用建议（按频率排序）
    const sortedPatterns = Array.from(toolPatterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    for (const [pattern] of sortedPatterns) {
      lines.push(`1. ${pattern}`)
    }

    if (request.examples && request.examples.length > 0) {
      lines.push('', '## 示例')
      for (const example of request.examples) {
        lines.push(`\`\`\`\n${example}\n\`\`\``)
      }
    }

    return lines.join('\n')
  }

  /**
   * 改进现有技能
   * 基于失败案例重写 prompt
   */
  async improveSkill(
    currentContent: string,
    failureCases: Array<{ input: string; expected: string; actual: string }>
  ): Promise<string> {
    // 简单实现：添加错误处理指导
    const improvement = [
      '',
      '## 错误处理（进化添加）',
      '如果遇到以下情况，请尝试：',
    ]

    for (const failure of failureCases.slice(0, 3)) {
      improvement.push(`- 输入 "${failure.input}" 时：${failure.actual}`)
    }

    return currentContent + improvement.join('\n')
  }
}

// =============================================================================
// 技能管理器
// =============================================================================

/**
 * 技能管理器
 * 
 * 负责：
 * - 技能加载/保存/删除
 * - 技能检索（按名称/标签/触发词）
 * - 技能执行（参数注入）
 * - 技能进化/淘汰
 */
export class SkillManager {
  private skillsDir: string
  private skills: Map<string, Skill> = new Map()
  private evaluator: SkillEvaluator
  private generator: SkillGenerator
  private config: Required<SkillManagerConfig>
  private patchSuggestions: SkillPatchSuggestion[] = []
  private dirty: boolean = false  // 是否有未保存的更改

  constructor(config: SkillManagerConfig = {}) {
    // 默认技能目录：~/.fusion_skills
    const homeDir = process.env.USERPROFILE || process.env.HOME || ''
    this.skillsDir = config.skillsDir || join(homeDir, '.fusion_skills')

    this.config = {
      skillsDir: this.skillsDir,
      maxSkills: config.maxSkills ?? 100,
      evolutionThreshold: config.evolutionThreshold ?? 10,
      successRateThreshold: config.successRateThreshold ?? 0.6,
      autoSaveStats: config.autoSaveStats ?? true,
      statsFile: config.statsFile ?? join(this.skillsDir, '.evaluations.json'),
      lifecycleFile: config.lifecycleFile ?? join(this.skillsDir, '.lifecycle.json'),
    }

    this.evaluator = new SkillEvaluator(this.config.statsFile)
    this.generator = new SkillGenerator()
  }

  /** 初始化：确保技能目录存在，加载所有技能 */
  async initialize(): Promise<void> {
    if (!existsSync(this.skillsDir)) {
      await mkdir(this.skillsDir, { recursive: true })
    }

    await this.loadAllSkills()
    await this.loadLifecycleState()
  }

  /** 加载所有技能 */
  async loadAllSkills(): Promise<void> {
    this.skills.clear()

    let files: string[]
    try {
      files = await readdir(this.skillsDir)
    } catch {
      // 目录不存在或为空
      return
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue

      const filePath = join(this.skillsDir, file)
      try {
        const skill = await this.loadSkill(filePath)
        this.skills.set(skill.metadata.name, skill)
      } catch (error) {
        console.warn(`[SkillManager] Failed to load skill from ${filePath}:`, error)
      }
    }

    console.log(`[SkillManager] Loaded ${this.skills.size} skills`)
  }

  /** 加载单个技能 */
  async loadSkill(filePath: string): Promise<Skill> {
    const content = await readFile(filePath, 'utf-8')
    const { metadata: rawMetadata, body } = parseFrontmatter(content)

    const metadata: SkillMetadata = {
      name: rawMetadata.name ?? 'unknown',
      description: rawMetadata.description ?? '',
      version: rawMetadata.version ?? '1.0',
      tags: rawMetadata.tags ?? [],
      triggers: rawMetadata.triggers ?? [],
      author: rawMetadata.author,
      createdAt: rawMetadata.createdAt,
      updatedAt: rawMetadata.updatedAt,
      usageCount: rawMetadata.usageCount ?? 0,
      successRate: rawMetadata.successRate ?? 1.0,
      avgLatencyMs: rawMetadata.avgLatencyMs,
    }

    return { metadata, content: body.trim(), filePath }
  }

  /** 保存技能到文件 */
  async saveSkill(skill: Skill): Promise<void> {
    const dir = dirname(skill.filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    const metadataToSave = {
      ...skill.metadata,
      updatedAt: new Date().toISOString(),
    }

    const content = generateFrontmatter(metadataToSave, skill.content)
    await writeFile(skill.filePath, content, 'utf-8')
    this.dirty = true
  }

  private async loadLifecycleState(): Promise<void> {
    if (!existsSync(this.config.lifecycleFile)) {
      return
    }

    try {
      const raw = await readFile(this.config.lifecycleFile, 'utf-8')
      const data = JSON.parse(raw) as {
        evaluations?: SkillEvaluation[]
        patchSuggestions?: SkillPatchSuggestion[]
      }

      this.evaluator.load(data.evaluations ?? [])
      this.patchSuggestions = data.patchSuggestions ?? []

      for (const evaluation of this.evaluator.getAllEvaluations()) {
        const skill = this.skills.get(evaluation.skillName)
        if (!skill) continue
        skill.metadata.usageCount = evaluation.callCount
        skill.metadata.successRate = evaluation.callCount > 0
          ? evaluation.successCount / evaluation.callCount
          : 1
        skill.metadata.avgLatencyMs = evaluation.avgLatencyMs
      }
    } catch (error) {
      console.warn('[SkillManager] Failed to load lifecycle state:', error)
    }
  }

  private async persistLifecycleState(): Promise<void> {
    const payload = {
      savedAt: new Date().toISOString(),
      evaluations: this.evaluator.export(),
      patchSuggestions: this.patchSuggestions,
    }

    await writeFile(this.config.lifecycleFile, JSON.stringify(payload, null, 2), 'utf-8')
  }

  /** 创建新技能 */
  async createSkill(request: SkillGenerationRequest): Promise<Skill> {
    // 检查技能数量限制
    if (this.skills.size >= this.config.maxSkills) {
      throw new Error(`Maximum number of skills (${this.config.maxSkills}) reached`)
    }

    // 检查名称冲突
    if (this.skills.has(request.name)) {
      throw new Error(`Skill '${request.name}' already exists`)
    }

    // 生成技能内容
    const content = `# ${request.name}\n\n${request.description}\n\n`

    const now = new Date().toISOString()
    const metadata: SkillMetadata = {
      name: request.name,
      description: request.description,
      version: request.initialVersion ?? '1.0',
      triggers: request.triggerPhrases,
      createdAt: now,
      updatedAt: now,
      usageCount: 0,
      successRate: 1.0,
    }

    const fileName = `${request.name.replace(/[^a-z0-9_-]/gi, '_')}.md`
    const filePath = join(this.skillsDir, fileName)

    const skill: Skill = { metadata, content, filePath }
    await this.saveSkill(skill)
    this.skills.set(skill.metadata.name, skill)

    return skill
  }

  /** 删除技能 */
  async deleteSkill(name: string): Promise<void> {
    const skill = this.skills.get(name)
    if (!skill) return

    try {
      await unlink(skill.filePath)
    } catch {
      // 文件可能已删除
    }

    this.skills.delete(name)
    this.dirty = true
  }

  /** 按名称获取技能 */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  /** 按触发词搜索技能 */
  findSkillByTrigger(trigger: string): Skill | undefined {
    return this.findTriggeredSkills(trigger, 1)[0]?.skill
  }

  findTriggeredSkills(input: string, limit: number = 5): SkillTriggerMatch[] {
    const lower = input.toLowerCase()
    const matches: SkillTriggerMatch[] = []

    for (const skill of this.skills.values()) {
      let score = 0
      const matchedBy: SkillTriggerMatch['matchedBy'] = []

      if (lower.includes(skill.metadata.name.toLowerCase())) {
        score += 5
        matchedBy.push('name')
      }
      if (skill.metadata.description && lower.includes(skill.metadata.description.toLowerCase())) {
        score += 2
        matchedBy.push('description')
      }
      if (skill.metadata.tags?.some(tag => lower.includes(tag.toLowerCase()))) {
        score += 3
        matchedBy.push('tag')
      }
      if (skill.metadata.triggers?.some(trigger => lower.includes(trigger.toLowerCase()))) {
        score += 6
        matchedBy.push('trigger')
      }

      if (score > 0) {
        matches.push({ skill, score, matchedBy })
      }
    }

    return matches
      .sort((a, b) => b.score - a.score || a.skill.metadata.name.localeCompare(b.skill.metadata.name))
      .slice(0, limit)
  }

  /** 按标签搜索技能 */
  findSkillsByTag(tag: string): Skill[] {
    const lower = tag.toLowerCase()
    return Array.from(this.skills.values()).filter(s =>
      s.metadata.tags?.some(t => t.toLowerCase().includes(lower))
    )
  }

  /** 搜索技能（模糊匹配名称/描述） */
  searchSkills(query: string): Skill[] {
    const lower = query.toLowerCase()
    return Array.from(this.skills.values()).filter(
      s =>
        s.metadata.name.toLowerCase().includes(lower) ||
        s.metadata.description.toLowerCase().includes(lower) ||
        s.metadata.tags?.some(t => t.toLowerCase().includes(lower))
    )
  }

  /** 执行技能 */
  async executeSkill(params: SkillCallParams): Promise<SkillExecutionResult> {
    const start = Date.now()
    const skill = this.skills.get(params.skillName)

    if (!skill) {
      return {
        success: false,
        output: '',
        skillName: params.skillName,
        params: params.params ?? {},
        latencyMs: Date.now() - start,
        error: `Skill '${params.skillName}' not found`,
      }
    }

    try {
      // 替换参数占位符
      let output = skill.content
      if (params.params) {
        for (const [key, value] of Object.entries(params.params)) {
          output = output.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
        }
      }

      // 记录执行
      const latencyMs = Date.now() - start
      this.recordSkillOutcome(skill.metadata.name, true, latencyMs)
      const evaluation = this.evaluator.getEvaluation(skill.metadata.name)
      skill.metadata.usageCount = evaluation?.callCount ?? skill.metadata.usageCount + 1
      skill.metadata.successRate = evaluation && evaluation.callCount > 0
        ? evaluation.successCount / evaluation.callCount
        : 1
      skill.metadata.avgLatencyMs = evaluation?.avgLatencyMs

      if (this.config.autoSaveStats) {
        await this.saveSkill(skill)
        await this.persistLifecycleState()
      }

      return {
        success: true,
        output,
        skillName: skill.metadata.name,
        params: params.params ?? {},
        latencyMs,
      }
    } catch (error) {
      const latencyMs = Date.now() - start
      this.recordSkillOutcome(skill.metadata.name, false, latencyMs)
      this.suggestPatch(skill.metadata.name, error instanceof Error ? error.message : String(error), {
        severity: 'medium',
      })
      if (this.config.autoSaveStats) {
        await this.persistLifecycleState()
      }

      return {
        success: false,
        output: '',
        skillName: skill.metadata.name,
        params: params.params ?? {},
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 获取所有技能 */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values())
  }

  /** 获取技能列表（仅元数据） */
  getSkillList(): SkillMetadata[] {
    return Array.from(this.skills.values()).map(s => s.metadata)
  }

  /** 获取评估器 */
  getEvaluator(): SkillEvaluator {
    return this.evaluator
  }

  /** 获取生成器 */
  getGenerator(): SkillGenerator {
    return this.generator
  }

  recordSkillOutcome(skillName: string, success: boolean, latencyMs: number): void {
    this.evaluator.recordCall(skillName, success, latencyMs)
    const evaluation = this.evaluator.getEvaluation(skillName)
    const skill = this.skills.get(skillName)
    if (skill && evaluation) {
      skill.metadata.usageCount = evaluation.callCount
      skill.metadata.successRate = evaluation.callCount > 0
        ? evaluation.successCount / evaluation.callCount
        : 1
      skill.metadata.avgLatencyMs = evaluation.avgLatencyMs
      this.dirty = true
    }
  }

  suggestPatch(
    skillName: string,
    reason: string,
    options: {
      severity?: SkillPatchSuggestion['severity']
      examples?: string[]
    } = {},
  ): SkillPatchSuggestion {
    const suggestion: SkillPatchSuggestion = {
      id: randomUUID(),
      skillName,
      reason,
      createdAt: Date.now(),
      severity: options.severity ?? 'medium',
      examples: options.examples,
      status: 'open',
    }

    this.patchSuggestions.push(suggestion)
    this.dirty = true
    return suggestion
  }

  getPatchSuggestions(skillName?: string): SkillPatchSuggestion[] {
    return this.patchSuggestions.filter(suggestion =>
      suggestion.status === 'open' && (!skillName || suggestion.skillName === skillName),
    )
  }

  markPatchSuggestion(id: string, status: 'applied' | 'dismissed'): void {
    const suggestion = this.patchSuggestions.find(item => item.id === id)
    if (!suggestion) return
    suggestion.status = status
    this.dirty = true
  }

  /** 运行进化周期 */
  async evolve(): Promise<{
    created: string[]
    improved: string[]
    retired: string[]
  }> {
    const created: string[] = []
    const improved: string[] = []
    const retired: string[] = []

    // Step 1: 淘汰低使用率技能
    const forRetirement = this.evaluator.getSkillsForRetirement(this.config.evolutionThreshold)
    for (const eval_ of forRetirement) {
      await this.deleteSkill(eval_.skillName)
      retired.push(eval_.skillName)
    }

    // Step 2: 标记需要改进的技能（暂不自动改进，需要人工审核）
    const forImprovement = this.evaluator.getSkillsNeedingEvolution(this.config.successRateThreshold)
    for (const eval_ of forImprovement) {
      console.log(`[SkillManager] Skill '${eval_.skillName}' needs improvement (success rate: ${(eval_.successCount / eval_.callCount * 100).toFixed(1)}%)`)
      if (!this.patchSuggestions.some(item => item.skillName === eval_.skillName && item.status === 'open')) {
        this.suggestPatch(
          eval_.skillName,
          `Skill success rate dropped to ${(eval_.successCount / eval_.callCount * 100).toFixed(1)}%`,
          { severity: 'high' },
        )
      }
    }

    if (this.config.autoSaveStats) {
      await this.persistLifecycleState()
    }

    return { created, improved, retired }
  }

  /** 导出技能为 JSON */
  exportSkills(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      skillCount: this.skills.size,
      skills: this.getAllSkills().map(s => ({
        metadata: s.metadata,
        contentPreview: s.content.substring(0, 200),
      })),
    }, null, 2)
  }

  async flushLifecycleState(): Promise<void> {
    await this.persistLifecycleState()
  }

  getLifecycleReport(): SkillLifecycleReport {
    return {
      generatedAt: new Date().toISOString(),
      totalSkills: this.skills.size,
      evaluations: this.evaluator.getAllEvaluations(),
      needsImprovement: this.evaluator.getSkillsNeedingEvolution(this.config.successRateThreshold),
      trendingSkills: this.evaluator.getTrendingSkills(),
      openPatchSuggestions: this.getPatchSuggestions(),
    }
  }
}

// =============================================================================
// 便捷函数
// =============================================================================

let defaultManager: SkillManager | null = null

/** 获取默认技能管理器（单例） */
export function getDefaultSkillManager(): SkillManager {
  if (!defaultManager) {
    defaultManager = new SkillManager()
  }
  return defaultManager
}

/** 重置默认技能管理器 */
export function resetDefaultSkillManager(): void {
  defaultManager = null
}

// =============================================================================
// 示例/测试
// =============================================================================

/*
// 基本用法：

import { SkillManager } from './skills/skillManager.js'

const manager = new SkillManager()
await manager.initialize()

// 创建技能
const skill = await manager.createSkill({
  name: 'code-review',
  description: '执行代码审查',
  triggerPhrases: ['review', '检查代码', '代码审查'],
  instructionTemplate: '请审查以下代码：\n{{code}}',
})

// 执行技能
const result = await manager.executeSkill({
  skillName: 'code-review',
  params: { code: 'function hello() { return 1 }' },
})

console.log(result.output)

// 搜索技能
const results = manager.searchSkills('review')
console.log(`Found ${results.length} skills`)

// 运行进化
const evolution = await manager.evolve()
console.log(`Retired ${evolution.retired.length} skills`)
*/
