# FusionWorkspace 消息协议文档

> 版本: 0.3.0 | 最后更新: 2026-04-22

本文档定义 FusionWorkspace 内核与外部通道适配器（微信、飞书、WebSocket 等）之间的消息协议。

---

## 1. 协议总览

```
┌─────────────┐    入站消息     ┌──────────────────┐
│  Adapter    │ ──────────────→ │  FusionWorkspace  │
│ (微信/飞书)  │                │     内核          │
│             │ ←────────────── │                  │
└─────────────┘    出站消息     └──────────────────┘
```

### 消息流向

| 方向 | 消息类型 | 说明 |
|------|---------|------|
| adapter → core | `user_message` | 用户文本消息 |
| adapter → core | `approval_response` | 审批响应 |
| adapter → core | `cancel_request` | 取消正在运行的循环 |
| adapter → core | `session_context_restore` | 请求恢复上下文 |
| adapter → core | `rich_message` | 富文本消息（图片/文件/卡片） |
| core → adapter | `welcome` | 连接成功 |
| core → adapter | `confirmation_required` | 需要用户审批工具调用 |
| core → adapter | `approval_ack` | 审批确认回执 |
| core → adapter | `approval_expired` | 审批超时通知 |
| core → adapter | `assistant_response` | TAOR 最终回复 |
| core → adapter | `tool_result` | 工具执行中间结果 |
| core → adapter | `progress_update` | 思考/步骤进度 |
| core → adapter | `error` | 错误通知 |

---

## 2. ChannelMessage 结构

所有消息都通过 `ChannelMessage` 接口传递：

```typescript
interface ChannelMessage {
  id: string                          // 消息唯一 ID（UUID）
  type?: MessageType                  // 消息类型（结构化协议字段，优先使用）
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string                     // 消息内容（JSON 字符串 fallback）
  payload?: Record<string, unknown>   // 结构化 payload（与 type 配套）
  timestamp: number                   // Unix 毫秒时间戳
  metadata?: Record<string, unknown>  // 扩展元数据
  channel?: string                    // 通道类型（如 'wechat', 'websocket'）
  sessionId?: string                  // 会话 ID
  userId?: string                     // 用户 ID
  conversationId?: string             // 对话 ID（多轮对话场景）
}
```

### 双格式兼容

- **新适配器**：同时设置 `type` + `payload` + `content`（content 为 JSON 字符串 fallback）
- **旧适配器**：仅设置 `content`（JSON 字符串，包含 type 字段）
- 内核优先从 `type` + `payload` 解析，fallback 解析 `content` 字符串

---

## 3. 出站消息 Schema

### 3.1 welcome

连接成功时发送。

```json
{
  "type": "welcome",
  "role": "system",
  "payload": {
    "sessionId": "abc-123",
    "skills": ["code-review", "stock-analysis"],
    "version": "1.0.0"
  }
}
```

### 3.2 confirmation_required

工具执行需要用户审批时发送。

```json
{
  "type": "confirmation_required",
  "role": "system",
  "payload": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "toolName": "write_file",
    "params": { "path": "test.txt", "content": "hello" },
    "riskLevel": 3,
    "message": "Confirm execution of write_file?"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| requestId | UUID | 审批请求唯一 ID |
| toolName | string | 需要审批的工具名 |
| params | object | 工具参数 |
| riskLevel | number (1-10) | 风险等级 |
| message | string | 提示信息 |

### 3.3 approval_ack

审批结果确认回执。

```json
{
  "type": "approval_ack",
  "role": "system",
  "payload": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "approved": true,
    "resolved": true
  }
}
```

### 3.4 approval_expired

审批请求超时。

```json
{
  "type": "approval_expired",
  "role": "system",
  "payload": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "toolName": "write_file",
    "message": "Approval request expired"
  }
}
```

### 3.5 assistant_response

TAOR 循环完成后的最终回复。

```json
{
  "type": "assistant_response",
  "role": "assistant",
  "payload": {
    "text": "任务已完成...",
    "steps": 5,
    "toolCalls": 3,
    "stopReason": "done"
  }
}
```

### 3.6 tool_result

工具执行中间结果。

```json
{
  "type": "tool_result",
  "role": "system",
  "payload": {
    "toolName": "execute_command",
    "success": true,
    "output": "ls output...",
    "error": null
  }
}
```

### 3.7 progress_update

思考/步骤进度更新。

```json
{
  "type": "progress_update",
  "role": "system",
  "payload": {
    "phase": "thinking",
    "message": "Analyzing request...",
    "step": 1
  }
}
```

phase 可选值：`thinking` | `tool_call` | `step_start` | `step_end`

### 3.8 error

错误通知。

```json
{
  "type": "error",
  "role": "system",
  "payload": {
    "code": "LLM_TIMEOUT",
    "message": "LLM API timeout",
    "recoverable": true,
    "suggestion": "Please try again."
  }
}
```

---

## 4. 入站消息 Schema

### 4.1 user_message

用户发送的文本消息。

```json
{
  "type": "user_message",
  "role": "user",
  "payload": {
    "text": "帮我分析一下这只股票"
  }
}
```

### 4.2 approval_response

用户对审批请求的响应。

```json
{
  "type": "approval_response",
  "role": "user",
  "payload": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "approved": true,
    "note": "确认执行"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| requestId | UUID | 是 | 对应的审批请求 ID |
| approved | boolean | 是 | 是否批准 |
| note | string | 否 | 备注 |

**文本格式兼容**（fallback）：
- `approve <requestId>` — 批准
- `reject <requestId>` — 拒绝

### 4.3 cancel_request

用户取消正在运行的 TAOR 循环。

```json
{
  "type": "cancel_request",
  "role": "user",
  "payload": {
    "sessionId": "abc-123",
    "reason": "user_cancelled"
  }
}
```

### 4.4 session_context_restore

请求恢复之前的会话上下文。

```json
{
  "type": "session_context_restore",
  "role": "user",
  "payload": {
    "sessionId": "abc-123",
    "conversationId": "wechat-user123"
  }
}
```

### 4.5 rich_message

富文本消息（图片/文件/卡片等）。

```json
{
  "type": "rich_message",
  "role": "user",
  "payload": {
    "contentType": "image",
    "content": { "url": "https://...", "width": 800, "height": 600 },
    "metadata": { "source": "wechat" }
  }
}
```

---

## 5. 审批协议

### 5.1 Promise 模式（默认）

适用于 WebSocket/Stdio 等实时连接通道。

```
Adapter                    Core (TAOR Loop)
   │                           │
   │  user_message             │
   │──────────────────────────→│
   │                           │ 执行工具...
   │                           │ 需要审批 → 阻塞等待
   │  confirmation_required    │
   │←──────────────────────────│
   │                           │
   │  approval_response        │
   │──────────────────────────→│
   │                           │ 恢复执行
   │  assistant_response       │
   │←──────────────────────────│
```

- 超时：默认 5 分钟（ApprovalService.waitForDecision）
- 审批请求过期：默认 15 分钟（PermissionWorkflowStore）

### 5.2 Event 模式

适用于微信/飞书等 Webhook 通道。

```
Adapter                    Core (TAOR Loop)
   │                           │
   │  user_message             │
   │──────────────────────────→│
   │                           │ 执行工具...
   │                           │ 需要审批 → emit ApprovalNeededEvent
   │  confirmation_required    │
   │←──────────────────────────│ 暂停循环
   │                           │
   │  ...（用户稍后响应）       │
   │                           │
   │  approval_response        │
   │──────────────────────────→│ ApprovalEventBus.onApprovalResolved
   │                           │ 恢复循环
   │  assistant_response       │
   │←──────────────────────────│
```

配置方式：
```typescript
const workspace = new FusionWorkspace({
  mode: 'server',
  approvalMode: 'event',  // 启用事件模式
  pendingRequestExpiryMs: 2 * 60 * 60 * 1000,  // 2 小时过期
})
```

---

## 6. 适配器接入指南

### 6.1 实现 IChannel 接口

```typescript
import { IChannel, ChannelMessage, Session, AdapterCapabilities } from 'fusion-workspace'

class WeChatChannel implements IChannel {
  async start(): Promise<void> { /* 启动微信服务 */ }
  async stop(): Promise<void> { /* 停止服务 */ }
  async send(message: ChannelMessage, session?: Session): Promise<void> {
    // 通过微信 API 发送消息
  }
  async broadcast(message: Omit<ChannelMessage, 'id' | 'timestamp'>): Promise<void> {
    // 广播（微信通常不支持广播）
  }
  getType(): string { return 'wechat' }
  getStats(): Record<string, unknown> {
    return { type: 'wechat', activeUsers: this.userCount }
  }
  getCapabilities(): AdapterCapabilities {
    return {
      richMessages: true,
      fileUpload: true,
      typingIndicator: false,
      groupChat: true,
      approvalButtons: true,
      maxMessageLength: 2048,
      supportsStreaming: false,
      supportedContentTypes: ['text', 'image', 'file', 'link'],
    }
  }
}
```

### 6.2 注册通道

```typescript
const gateway = new Gateway({ onMessage: handleMessage })
gateway.addChannel(new WeChatChannel(), 'wechat-main')
await gateway.start()
```

### 6.3 适配器配置

```typescript
const config: AdapterConfig = {
  type: 'wechat',
  instanceId: 'wechat-cs-1',
  capabilities: { /* ... */ },
  adapterOptions: {
    appId: 'wx...',
    appSecret: '...',
    token: '...',
    encodingAESKey: '...',
  },
}
```

### 6.4 适配器工厂

```typescript
import { AdapterFactory, loadAdapterConfig } from 'fusion-workspace'

// 从配置文件加载
const config = await loadAdapterConfig('./adapters.json')

// 批量注册到 Gateway
await AdapterFactory.registerAll(gateway, config.adapters)
```

`adapters.json` 示例：
```json
{
  "adapters": [
    {
      "type": "wechat",
      "instanceId": "wechat-main",
      "adapterOptions": {
        "appId": "wx...",
        "appSecret": "...",
        "token": "...",
        "port": 8081,
        "path": "/wechat"
      }
    },
    {
      "type": "feishu",
      "instanceId": "feishu-ops",
      "adapterOptions": {
        "appId": "cli_...",
        "appSecret": "...",
        "verificationToken": "...",
        "port": 8082,
        "path": "/feishu"
      }
    }
  ]
}
```

### 6.5 消息去重

外部渠道（尤其是微信）可能重复推送同一条消息。`ExternalChannel` 内置去重器：

- 默认窗口：5 秒
- 基于 `messageId` 去重
- 可配置 `dedupWindowMs`

---

## 7. Session / Conversation 管理

| 概念 | 说明 | 示例 |
|------|------|------|
| sessionId | 单次连接/交互的 ID | UUID |
| conversationId | 多轮对话的 ID（跨 session） | 微信 openId、飞书 chatId |
| userId | 用户唯一标识 | 微信 unionId |

对于 WebSocket/Stdio 等实时通道，sessionId 和 conversationId 通常相同。
对于微信/飞书等 Webhook 通道，每个用户消息使用相同的 conversationId，但每次交互生成新的 sessionId。

---

## 8. 运行时状态查询

通过 Gateway 的 health check 端点获取：

```
GET /api/health
```

响应：
```json
{
  "status": "running",
  "uptimeMs": 3600000,
  "activeSessions": 5,
  "totalTurns": 120,
  "subsystems": {
    "gateway": { "websocket": { "activeSessions": 3 } },
    "memory": { "backend": "sqlite", "cacheSize": 45 },
    "skills": { "totalSkills": 12 },
    "permissions": { "pendingRequests": 1 },
    "tools": { "totalTools": 4, "mode": "default" },
    "adapters": { "wechat-main": { "type": "wechat", "activeSessions": 2 } }
  }
}
```

---

## 9. 版本与兼容性

| 版本 | 变更 |
|------|------|
| 0.6.0 | 微信/飞书适配器、适配器工厂、消息去重器 |
| 0.5.0 | 技能生命周期闭环 + TAOR 可靠性（checkpoint/事务日志/重试/隔离） |
| 0.4.0 | 分层记忆模型 + 轨迹压缩 + 记忆注入/写入策略 + 权限策略引擎 + 审计回放 |
| 0.3.0 | 引入 MessageType/Payload 结构化协议、审批双模、ChannelType 开放化 |
| 0.2.0 | 审批闭环、异步审批服务 |
| 0.1.0 | 初始版本 |

### 向后兼容

- 旧适配器仅发送 `content`（JSON 字符串）仍然有效
- 新适配器应同时设置 `type` + `payload` + `content`
- `ChannelMessage.role` 和 `ChannelMessage.content` 始终存在
