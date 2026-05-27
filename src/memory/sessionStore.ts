/**
 * Session Store — 轻量级会话恢复层
 *
 * 为长期在线服务保留最近一次可靠运行快照，
 * 让会话断开或进程重启后能恢复关键上下文。
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import type { Message } from '../agent/taorLoop.js'

export interface SessionSnapshot {
  sessionId: string
  updatedAt: number
  userId?: string
  channel?: string
  initialPrompt: string
  finalResponse: string
  stopReason: string | null
  stepCount: number
  toolCallCount: number
  compactSummary: string
  recentMessages: Message[]
  totalTokens?: { input: number; output: number }
  runtimeAudit?: Array<{
    step: number
    phase: string
    status: 'info' | 'warn' | 'error'
    detail: string
    timestamp: number
  }>
}

export interface SessionStoreConfig {
  rootDir?: string
  maxRecentMessages?: number
}

export class SessionStore {
  private rootDir: string
  private maxRecentMessages: number

  constructor(config: SessionStoreConfig = {}) {
    const baseDir = config.rootDir
      ?? join(process.cwd(), '.fusion-runtime', 'sessions')

    this.rootDir = resolve(baseDir)
    this.maxRecentMessages = config.maxRecentMessages ?? 8
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const filePath = this.getSnapshotPath(sessionId)
    if (!existsSync(filePath)) {
      return null
    }

    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as SessionSnapshot
  }

  /**
   * 按对话 ID 查找快照（适用于微信/飞书等多轮对话场景）
   * 遍历所有快照文件，匹配 conversationId 字段
   */
  async getByConversationId(conversationId: string): Promise<SessionSnapshot | null> {
    if (!existsSync(this.rootDir)) {
      return null
    }

    const { readdir } = await import('fs/promises')
    const files = await readdir(this.rootDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = join(this.rootDir, file)
      try {
        const raw = await readFile(filePath, 'utf-8')
        const snapshot = JSON.parse(raw) as SessionSnapshot & { conversationId?: string }
        if (snapshot.conversationId === conversationId) {
          return snapshot
        }
      } catch {
        // 跳过损坏的文件
      }
    }
    return null
  }

  async saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const normalized: SessionSnapshot = {
      ...snapshot,
      recentMessages: snapshot.recentMessages.slice(-this.maxRecentMessages),
    }
    await writeFile(
      this.getSnapshotPath(snapshot.sessionId),
      JSON.stringify(normalized, null, 2),
      'utf-8',
    )
  }

  buildCompactSummary(snapshot: Pick<SessionSnapshot, 'initialPrompt' | 'finalResponse' | 'stopReason' | 'toolCallCount' | 'stepCount'>): string {
    const response = snapshot.finalResponse.length > 240
      ? `${snapshot.finalResponse.slice(0, 240)}...`
      : snapshot.finalResponse

    return [
      `Previous request: ${snapshot.initialPrompt}`,
      `Last response: ${response || '[empty]'}`,
      `Steps: ${snapshot.stepCount}, tool calls: ${snapshot.toolCallCount}`,
      `Stop reason: ${snapshot.stopReason ?? 'unknown'}`,
    ].join('\n')
  }

  private getSnapshotPath(sessionId: string): string {
    return join(this.rootDir, `${sessionId}.json`)
  }
}
