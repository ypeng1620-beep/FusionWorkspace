/**
 * 微信渠道适配器
 *
 * 对接微信公众号/企业微信/个人号（通过第三方框架如 wechaty）。
 * 实现 IChannel 接口，复用 Gateway 的消息路由。
 *
 * 特性：
 * - 消息去重（微信可能重复推送）
 * - 审批按钮支持（通过卡片消息）
 * - 富文本支持（图片、语音、文件）
 * - 群聊支持
 * - 用户标识映射（openId → userId）
 * - AES-256-CBC 消息加解密
 * - XML 安全解析（xml2js）
 * - 消息签名验证
 */

import { createServer, Server } from 'http'
import express, { Request, Response } from 'express'
import { createHash, createDecipheriv, randomUUID } from 'crypto'
import { parseStringPromise } from 'xml2js'
import { ExternalChannel, type ExternalChannelConfig } from './externalChannel.js'
import { assertExternalAdapterConfigReady } from './externalAdapterConfigValidation.js'
import type { Session, ChannelMessage } from '../gateway/gateway.js'
import type { AdapterCapabilities } from '../protocol/adapterSchema.js'

// =============================================================================
// 微信消息类型
// =============================================================================

export interface WeChatMessage {
  /** 消息 ID */
  MsgId: string
  /** 发送者 openId */
  FromUserName: string
  /** 接收者（机器人）openId */
  ToUserName: string
  /** 消息类型 */
  MsgType: 'text' | 'image' | 'voice' | 'video' | 'shortvideo' | 'location' | 'link' | 'event'
  /** 文本内容 */
  Content?: string
  /** 图片 URL */
  PicUrl?: string
  /** 媒体 ID */
  MediaId?: string
  /** 语音格式 */
  Format?: string
  /** 地理位置 */
  Location_X?: string
  Location_Y?: string
  /** 事件类型 */
  Event?: 'subscribe' | 'unsubscribe' | 'CLICK' | 'VIEW' | 'SCAN'
  /** 事件 Key */
  EventKey?: string
  /** 创建时间 */
  CreateTime: number
}

/** 微信配置 */
export interface WeChatAdapterConfig extends ExternalChannelConfig {
  adapterOptions: {
    /** 公众号 AppID */
    appId: string
    /** 公众号 AppSecret */
    appSecret: string
    /** Token（验证用） */
    token: string
    /** EncodingAESKey */
    encodingAESKey?: string
    /** 是否为企业微信 */
    isWork?: boolean
    /** 企业微信 CorpId */
    corpId?: string
    /** 服务器端口 */
    port?: number
    /** Webhook 路径 */
    path?: string
  }
}

/** 微信能力 */
export const WECHAT_CAPABILITIES: AdapterCapabilities = {
  richMessages: true,
  fileUpload: true,
  typingIndicator: false,
  groupChat: true,
  approvalButtons: true,
  maxMessageLength: 2048,
  supportsStreaming: false,
  supportedContentTypes: ['text', 'image', 'voice', 'link', 'location'],
}

// =============================================================================
// 微信渠道
// =============================================================================

export class WeChatChannel extends ExternalChannel {
  private server?: Server
  private accessToken: string | null = null
  private tokenExpiry: number = 0
  private wcConfig: WeChatAdapterConfig
  private wcCapabilities: AdapterCapabilities
  private tokenRefreshTimer?: NodeJS.Timeout

  constructor(config: WeChatAdapterConfig) {
    super({
      ...config,
      type: config.type ?? 'wechat',
      capabilities: config.capabilities ?? WECHAT_CAPABILITIES,
    })
    this.wcConfig = config
    this.wcCapabilities = config.capabilities ?? WECHAT_CAPABILITIES
  }

  async start(): Promise<void> {
    if (this.config.requireProductionReady) {
      assertExternalAdapterConfigReady(this.wcConfig, { strict: true })
    }

    const app = express()
    app.use(express.text({ type: 'text/xml' }))
    app.use(express.json())

    const path = this.wcConfig.adapterOptions.path ?? '/wechat'

    // GET: 微信服务器验证
    app.get(path, (req: Request, res: Response) => {
      const signature = req.query.signature as string
      const timestamp = req.query.timestamp as string
      const nonce = req.query.nonce as string
      const echostr = req.query.echostr as string

      if (this.verifySignature(this.wcConfig.adapterOptions.token, timestamp, nonce, signature)) {
        res.send(echostr)
        console.log('[WeChat] Server verification passed')
      } else {
        res.status(403).send('Invalid signature')
      }
    })

    // POST: 接收消息
    app.post(path, async (req: Request, res: Response) => {
      try {
        let body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)

        // 消息签名验证（加密模式下微信会传 msg_signature）
        const msgSignature = req.query.msg_signature as string | undefined
        const timestamp = req.query.timestamp as string | undefined
        const nonce = req.query.nonce as string | undefined

        if (msgSignature && timestamp && nonce && this.wcConfig.adapterOptions.token) {
          // 加密模式下需先提取 Encrypt 内容用于签名校验
          let encryptedForSig: string | undefined
          try {
            const parsed = await parseStringPromise(body)
            const encryptArr = parsed?.xml?.Encrypt
            if (Array.isArray(encryptArr) && encryptArr.length > 0) {
              encryptedForSig = encryptArr[0]
            }
          } catch {
            // 如果 XML 解析失败，尝试正则兜底提取 Encrypt 内容
            const encMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s)
            if (encMatch) {
              encryptedForSig = encMatch[1]
            } else {
              const encMatch2 = body.match(/<Encrypt>(.*?)<\/Encrypt>/s)
              encryptedForSig = encMatch2?.[1]?.trim()
            }
          }

          if (encryptedForSig) {
            const sigValid = this.verifyMsgSignature(
              this.wcConfig.adapterOptions.token,
              timestamp,
              nonce,
              encryptedForSig,
              msgSignature,
            )
            if (!sigValid) {
              console.warn('[WeChat] Message signature verification failed')
              res.status(403).send('Invalid signature')
              return
            }
          }
        }

        // 检查是否为加密消息，是则先解密
        if (body.includes('<Encrypt>') && this.wcConfig.adapterOptions.encodingAESKey) {
          body = this.decryptMessage(body)
        }

        const message = await this.parseWeChatMessage(body)

        if (!message) {
          res.send('success')
          return
        }

        // 处理事件
        if (message.MsgType === 'event') {
          await this.handleEvent(message)
          res.send('success')
          return
        }

        // 处理消息
        const content = message.Content ?? message.PicUrl ?? `[${message.MsgType} message]`
        const metadata: Record<string, unknown> = {
          msgType: message.MsgType,
          mediaId: message.MediaId,
          fromUserName: message.FromUserName,
        }

        await this.handleInboundMessage(
          message.MsgId || randomUUID(),
          message.FromUserName,
          content,
          metadata,
        )

        // 微信要求 5s 内响应
        res.send('success')
      } catch (error) {
        console.error('[WeChat] Error handling message:', error)
        res.send('success') // 仍然返回 success 避免微信重试
      }
    })

    // 获取 access token
    await this.refreshAccessToken()

    // 启动服务器
    const port = this.wcConfig.adapterOptions.port ?? 8081
    this.server = createServer(app)

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => {
        console.log(`[WeChat] Channel listening on port ${port}, path ${path}`)
        this.running = true
        resolve()
      })
      this.server!.on('error', reject)
    })

    // 定时刷新 token
    this.tokenRefreshTimer = setInterval(() => this.refreshAccessToken(), 7000 * 1000)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer)
      this.tokenRefreshTimer = undefined
    }
    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()))
      this.server = undefined
    }
    this.sessions.clear()
  }

  /** 发送消息给用户 */
  async send(message: ChannelMessage, session?: Session): Promise<void> {
    const openId = session?.metadata?.externalId as string | undefined
    if (!openId) {
      throw new Error('WeChat send: no openId in session metadata')
    }

    await this.sendWithRetry(async () => {
      await this.sendCustomerMessage(openId, message.content)
    })
  }

  /** 发送审批请求（卡片消息） */
  async sendApprovalRequest(
    openId: string,
    requestId: string,
    toolName: string,
    riskLevel: number,
  ): Promise<void> {
    // 微信卡片消息格式
    const cardContent = [
      `🔒 需要审批`,
      ``,
      `工具: ${toolName}`,
      `风险等级: ${riskLevel}/10`,
      `请求ID: ${requestId}`,
      ``,
      `回复以下任一指令:`,
      `approve ${requestId} — 批准`,
      `reject ${requestId} — 拒绝`,
    ].join('\n')

    await this.sendCustomerMessage(openId, cardContent)
  }

  /** 获取统计 */
  getStats(): Record<string, unknown> {
    return {
      ...super.getStats(),
      type: 'wechat',
      appId: this.wcConfig.adapterOptions.appId,
      tokenValid: Date.now() < this.tokenExpiry,
    }
  }

  getCapabilities(): AdapterCapabilities {
    return this.wcCapabilities
  }

  // =============================================================================
  // 私有方法
  // =============================================================================

  /**
   * SHA1 签名验证（服务器配置验证用）
   * 签名算法：sha1(sort(token, timestamp, nonce).join(''))
   */
  private verifySignature(token: string, timestamp: string, nonce: string, signature: string): boolean {
    const arr = [token, timestamp, nonce].sort()
    const str = arr.join('')
    const hash = createHash('sha1').update(str).digest('hex')
    return hash === signature
  }

  /**
   * 消息签名验证（接收加密消息时用）
   * 签名算法：sha1(sort(token, timestamp, nonce, encrypted).join(''))
   */
  private verifyMsgSignature(
    token: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
    signature: string,
  ): boolean {
    const arr = [token, timestamp, nonce, encrypted].sort()
    const str = arr.join('')
    const hash = createHash('sha1').update(str).digest('hex')
    return hash === signature
  }

  /**
   * 使用 xml2js 解析微信 XML 消息
   * xml2js 会将 CDATA 内容自动提取，并将标签值包装为数组。
   * 解析后形状：{ xml: { ToUserName: ['...'], FromUserName: ['...'], ... } }
   */
  private async parseWeChatMessage(xmlBody: string): Promise<WeChatMessage | null> {
    try {
      const result = await parseStringPromise(xmlBody, {
        explicitArray: true,
        mergeAttrs: true,
        trim: true,
      })

      const xml = result?.xml
      if (!xml) return null

      // xml2js 将每个子元素解析为数组，取首元素
      const first = (val: unknown): string | undefined => {
        if (Array.isArray(val) && val.length > 0) {
          return String(val[0] ?? '')
        }
        return undefined
      }

      const msgType = first(xml.MsgType)
      if (!msgType) return null

      return {
        MsgId: first(xml.MsgId) ?? randomUUID(),
        FromUserName: first(xml.FromUserName) ?? '',
        ToUserName: first(xml.ToUserName) ?? '',
        MsgType: msgType as WeChatMessage['MsgType'],
        Content: first(xml.Content),
        PicUrl: first(xml.PicUrl),
        MediaId: first(xml.MediaId),
        Format: first(xml.Format),
        Location_X: first(xml.Location_X),
        Location_Y: first(xml.Location_Y),
        Event: first(xml.Event) as WeChatMessage['Event'],
        EventKey: first(xml.EventKey),
        CreateTime: parseInt(first(xml.CreateTime) ?? '0', 10),
      }
    } catch (error) {
      console.error('[WeChat] XML parse error:', error)
      return null
    }
  }

  /**
   * 解密微信加密消息体
   *
   * 微信加密流程：
   *   明文 = 16字节随机前缀 + 4字节网络字节序消息长度 + 消息体 + appId
   *   对明文进行 PKCS#7 填充 → AES-256-CBC 加密 → Base64 编码 → 放入 <Encrypt> 标签
   *
   * 解密流程：
   *   提取 <Encrypt> → Base64 解码 → AES-256-CBC 解密 → PKCS#7 去填充
   *   → 跳过 16 字节随机前缀 → 读取 4 字节长度 → 提取消息 → 验证 appId
   */
  private decryptMessage(encryptedBody: string): string {
    const encodingAESKey = this.wcConfig.adapterOptions.encodingAESKey
    if (!encodingAESKey) {
      throw new Error('[WeChat] decryptMessage: encodingAESKey is not configured')
    }

    // 提取 <Encrypt> 标签内容
    let encryptedXml: string | null = null
    try {
      // 优先使用 xml2js，但这里只做简单提取（parseStringPromise 是异步的，这里同步正则兜底）
      const cdataMatch = encryptedBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s)
      if (cdataMatch) {
        encryptedXml = cdataMatch[1]
      } else {
        const tagMatch = encryptedBody.match(/<Encrypt>(.*?)<\/Encrypt>/s)
        if (tagMatch) {
          encryptedXml = tagMatch[1].trim()
        }
      }
    } catch {
      // 正则兜底
      const m = encryptedBody.match(/<Encrypt>(.*?)<\/Encrypt>/s)
      encryptedXml = m?.[1]?.trim() ?? null
    }

    if (!encryptedXml) {
      throw new Error('[WeChat] decryptMessage: no <Encrypt> tag found in body')
    }

    // Base64 解码 AES 密钥（encodingAESKey 通常为 43 字符，补 '=' 后为 44 字符标准 Base64）
    const aesKey = Buffer.from(encodingAESKey + '=', 'base64') // 32 bytes
    const iv = aesKey.subarray(0, 16) // IV 为密钥前 16 字节

    // Base64 解码密文
    const ciphertext = Buffer.from(encryptedXml, 'base64')

    // AES-256-CBC 解密
    const decipher = createDecipheriv('aes-256-cbc', aesKey, iv)
    decipher.setAutoPadding(true) // 自动 PKCS#7 去填充
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

    // 解析解密后的数据：
    // [0..15]   16 字节随机前缀
    // [16..19]  4 字节网络字节序消息长度
    // [20..]    消息体 + appId
    if (decrypted.length < 20) {
      throw new Error('[WeChat] decryptMessage: decrypted data too short')
    }

    const msgLen = decrypted.readUInt32BE(16) // 网络字节序（大端）
    const messageStart = 20
    const messageEnd = messageStart + msgLen

    if (decrypted.length < messageEnd) {
      throw new Error('[WeChat] decryptMessage: message length exceeds decrypted data')
    }

    const message = decrypted.toString('utf8', messageStart, messageEnd)

    // 可选：验证 appId（消息尾部）
    const appId = decrypted.toString('utf8', messageEnd)
    // 企业微信使用 corpId，公众号使用 appId
    const expectedAppId = this.wcConfig.adapterOptions.isWork
      ? this.wcConfig.adapterOptions.corpId
      : this.wcConfig.adapterOptions.appId
    if (expectedAppId && appId !== expectedAppId) {
      console.warn(`[WeChat] decryptMessage: appId mismatch. Expected "${expectedAppId}", got "${appId}"`)
    }

    return message
  }

  private async handleEvent(message: WeChatMessage): Promise<void> {
    const session = this.getOrCreateSession(message.FromUserName, {
      msgType: 'event',
      event: message.Event,
    })

    if (message.Event === 'subscribe') {
      // 关注事件：发送欢迎消息
      await this.sendCustomerMessage(message.FromUserName, '欢迎关注！我是 AI 助手，有什么可以帮您的？')
    } else if (message.Event === 'unsubscribe') {
      // 取消关注：清理会话
      this.removeSession(message.FromUserName, 'unsubscribed')
    } else if (message.Event === 'CLICK') {
      // 菜单点击：EventKey 可能包含审批指令
      await this.handleInboundMessage(
        randomUUID(),
        message.FromUserName,
        message.EventKey ?? '',
        { eventType: 'menu_click' },
      )
    }
  }

  /**
   * 刷新 Access Token（带超时和重试）
   * 重试策略：最多 3 次，指数退避（1s, 2s, 4s）
   */
  private async refreshAccessToken(): Promise<void> {
    const maxAttempts = 3
    let lastError: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const { appId, appSecret } = this.wcConfig.adapterOptions
        const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`

        const response = await fetch(url, {
          signal: AbortSignal.timeout(10000),
        })
        const data = await response.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }

        if (data.access_token) {
          this.accessToken = data.access_token
          // 提前 5 分钟过期，增加安全边界
          this.tokenExpiry = Date.now() + (data.expires_in ?? 7200) * 1000 - 5 * 60 * 1000
          console.log('[WeChat] Access token refreshed')
          return
        } else {
          console.warn(`[WeChat] Failed to refresh access token (attempt ${attempt + 1}/${maxAttempts}):`, data.errmsg)
          lastError = new Error(`WeChat token refresh error: ${data.errmsg ?? 'unknown error (errcode=' + (data.errcode ?? 'N/A') + ')'}`)
        }
      } catch (error) {
        console.warn(`[WeChat] Error refreshing access token (attempt ${attempt + 1}/${maxAttempts}):`, error)
        lastError = error
      }

      // 如果不是最后一次尝试，等待指数退避
      if (attempt < maxAttempts - 1) {
        const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    console.error('[WeChat] Failed to refresh access token after all retries:', lastError)
  }

  /**
   * 发送客服消息（token 过期时自动刷新并重试一次）
   */
  private async sendCustomerMessage(openId: string, content: string): Promise<void> {
    // 如果没有 token 或 token 已过期，先刷新
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      console.log('[WeChat] Token missing or expired, refreshing before send...')
      await this.refreshAccessToken()
    }

    if (!this.accessToken) {
      throw new Error('WeChat: no access token available after refresh')
    }

    let lastError: Error | undefined

    // 尝试发送，如果遇到 token 相关错误则刷新 token 后重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${this.accessToken}`
        const body = {
          touser: openId,
          msgtype: 'text',
          text: { content },
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        })

        const data = await response.json() as { errcode?: number; errmsg?: string }

        if (!data.errcode || data.errcode === 0) {
          return // 发送成功
        }

        // 42001: access_token expired, 40001: invalid credential, 40014: invalid access_token
        const isTokenError = data.errcode === 42001 || data.errcode === 40001 || data.errcode === 40014

        if (isTokenError && attempt === 0) {
          console.log(`[WeChat] Token error ${data.errcode}, refreshing and retrying...`)
          await this.refreshAccessToken()
          lastError = new Error(`WeChat send error (${data.errcode}): ${data.errmsg}`)
          continue
        }

        throw new Error(`WeChat send error (${data.errcode}): ${data.errmsg}`)
      } catch (error) {
        if (attempt === 0 && error instanceof Error) {
          // 网络错误也可以重试一次（可能是 token 已过期但未正确标记）
          console.log('[WeChat] Send failed, refreshing token and retrying...')
          await this.refreshAccessToken()
          lastError = error
          continue
        }
        throw error
      }
    }

    // 如果两次尝试都失败，抛出最后的错误
    throw lastError ?? new Error('WeChat: sendCustomerMessage failed after retry')
  }
}
