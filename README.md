<p align="center">
  <h1 align="center">FusionWorkspace</h1>
  <p align="center">
    <strong>AI Agent 融合运行时</strong> — 借鉴三家顶级开源系统核心设计的生产级 Agent 服务基座
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.14.0-blue" alt="Version 0.14.0">
  <img src="https://img.shields.io/badge/node-%3E%3D22.14.0-brightgreen" alt="Node >=22.14.0">
  <img src="https://img.shields.io/badge/language-TypeScript%20(ESM)-3178C6" alt="TypeScript ESM">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License MIT">
  <img src="https://img.shields.io/badge/tests-38%2F38%20passed-success" alt="38/38 tests passed">
</p>

---

## 项目背景

FusionWorkspace 源自对三套主流 AI Agent 系统的深入架构对比研究。每个系统在不同维度上代表了行业最佳实践：

| 参考系统 | 核心创新 | 融合到 FusionWorkspace 的设计 |
|----------|----------|-------------------------------|
| **Claude Code** (Anthropic) | QueryEngine 异步主循环、7 模式权限门、Agent 工具编排 | TAOR Loop 四阶段 generator 循环、PermissionGate 风险评分体系 |
| **Hermes Agent** (NousResearch) | 技能闭环学习、FTS5 混合搜索、18+ 提供商网关 | SkillManager 生命周期、Memory 全文搜索系统、Gateway 多通道路由 |
| **OpenClaw** (社区) | Phoenix 治理层、FlameBreaker 熔断器、24 通道外部适配器 | PhoenixGovernance 审计治理、FlameBreaker 状态机、外部通道适配器工厂 |

FusionWorkspace **不是简单的代码拼接**，而是在三个系统的设计理念之上进行架构融合和重新实现，形成统一的运行时基座。

---

## 设计哲学

### 与其他框架的本质区别

大多数 AI Agent 框架采用「工具 + 提示词 + LLM 调用」的简单管线模式。FusionWorkspace 的不同之处在于：

| 维度 | 主流框架 (LangGraph / CrewAI / AutoGen) | FusionWorkspace |
|------|----------------------------------------|-----------------|
| **生命周期** | 请求-响应，无状态 | 长生命周期，状态持久化 |
| **记忆** | 向量数据库键值存储 | FTS5 全文搜索 + 分层记忆 + EML 评分淘汰 + 轨迹压缩 |
| **权限** | 无或简单的 allow/deny | 7 模式权限门 + 10 级风险评分 + 策略引擎 + 审批双模 |
| **治理** | 无 | Phoenix advisory_only 模式 + HMAC 审计链完整性 |
| **可靠性** | 异常即失败 | FlameBreaker 熔断器 + Antibody 自愈规则库 |
| **可观测性** | 基础日志 | Prometheus 指标 + 结构化 JSON 日志 + 阈值告警引擎 |
| **安全性** | 环境变量存储密钥 | AES-256-GCM 密钥加密 + Prompt 注入检测 (11 种模式) + 输入验证 |

FusionWorkspace 定位于需要**生产级可靠性、完整审计追踪、严格权限控制**的场景，而非快速原型验证。

---

## 核心模块

### TAOR Loop — 异步主循环引擎

```
Think ──→ Act ──→ Observe ──→ Reflect
   ↑                              │
   └──────────────────────────────┘
```

Generator 模式四阶段异步循环，支持流式 LLM 输出、工具调用、上下文窗口管理和多轮会话。每次迭代产出可审计的状态记录，与 Phoenix 治理层深度集成。

```typescript
// TAOR Loop 核心接口
interface TaorLoop {
  think(): AsyncGenerator<ThinkEvent>;    // 推理阶段
  act(tool: ToolCall): Promise<ActionResult>;  // 执行阶段
  observe(result: ActionResult): ObservedState; // 观察阶段
  reflect(state: ObservedState): Promise<Reflection>; // 反思阶段
}
```

### Memory System — 分层记忆架构

```
┌──────────────────────────────────────┐
│  MemoryInjection (context assembly)   │
│  ┌────────┬────────┬────────┬──────┐ │
│  │Profile │Session │Knowledge│Episodic│  ← 四层记忆
│  └────────┴────────┴────────┴──────┘ │
│  ┌──────────────────────────────────┐ │
│  │  FTS5 全文搜索 + LRU 缓存       │ │  ← 存储引擎
│  │  EML 评分淘汰策略               │ │
│  │  轨迹压缩 (TrajectoryCompressor) │ │
│  └──────────────────────────────────┘ │
│  ┌──────────────────────────────────┐ │
│  │  EmbeddingService                │ │  ← 向量嵌入 (可选)
│  │  (Ollama / OpenAI / Deterministic)│ │
│  └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

支持 SQLite (FTS5) 和 JSON 双后端。SQLite 不可用时自动降级到 JSON fallback，当显式要求 SQLite 但不可用时快速失败而非静默降级。

### Permission System — 七模式权限门

```
bypass → plan → default → auto → interactive → sandbox → restricted
  │        │       │        │         │           │           │
  全放     只读    需确认   自动分级   全交互     沙箱隔离     全拒绝
```

- **10 级风险评分**：基于模式匹配和命令特征分析（`rm -rf /` → 10, `read_file` → 1）
- **三级策略引擎**：Channel → User → Group 层层覆盖
- **审批双模**：同步确认 + 异步等待（支持 Slack/飞书/微信卡片审批）
- **完整审计**：每次权限判断产出可追溯的审计记录

### Phoenix Governance — 治理与审计

OpenClaw 原创的核心治理概念，FusionWorkspace 进行了完整的 TypeScript 重新实现：

- **advisory_only 模式**：Phoenix 建议但不强制执行，安全性通过可见性实现
- **9 条硬边界合约**：不可升级，不可绕过（如「不得删除审计日志」、「不得修改权限门配置」）
- **HMAC-SHA256 审计链**：每条审计记录包含前一条的哈希，形成不可篡改的链式结构
- **决策推荐引擎**：基于历史审计数据推荐操作策略
- **快照持久化**：定期快照 + 停止时快照 + 启动时可恢复

### Gateway — 多通道网关

```
                   ┌─────────────┐
                   │   Gateway   │
                   │ (control plane)│
                   └──┬──┬──┬──┬──┘
                      │  │  │  │
          ┌───────────┘  │  │  └───────────┐
          │              │  │              │
     WebSocket       Stdio  Webhook    ExternalChannel
    (Dashboard,    (CLI集成) (HTTP回调)  (基类)
     实时通信)
          │                              ┌──┴──┐
          │                         WeChat    Feishu
          │                        (XML+AES)  (HMAC+v2)
```

外部通道适配器通过 AdapterFactory 统一注册，支持批量启动、失败回滚、健康检查。所有外部通道经过 Phoenix 边界合约过滤，无法绕过内部权限和审计。

### LLM Provider Layer — 多模型抽象

| 提供商 | 类型 | 特性 |
|--------|------|------|
| Claude (Anthropic SDK) | 原生 | streaming + thinking + prompt caching |
| OpenAI-Compatible | 通用 | MiniMax, DeepSeek, Groq, Ollama, 任何兼容端点 |
| Mock | 测试 | 无 API 调用的测试专用提供者 |

运行时注册与热切换，环境变量注入 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。

### DuoAgent — 双智能体协作

- **本地 Agent**：读写执行，处理常规开发任务
- **外部 Review Agent**：只读审查，提供独立的安全和代码质量建议
- **Phoenix 边界过滤**：Review 建议首先经过边界合约检查
- **审查审计追踪**：接受/拒绝/延迟的建议 + 原因说明

### FlameBreaker + Antibody — 可靠性体系

```
     ┌──────────┐  5次连续失败  ┌──────────┐
     │  CLOSED  │ ────────────→ │   OPEN   │
     └──────────┘               └──────────┘
           ↑                    │        │
           │    3次成功探测     │  探测失败 │
           │     ┌──────────────┘        │
           │     ↓                       │
     ┌──────────────┐                   │
     │  HALF_OPEN   │ ←─────────────────┘
     └──────────────┘   冷却时间后
```

- **FlameBreaker**：CLOSED → OPEN → HALF_OPEN 标准熔断器状态机
- **Antibody**：自愈规则库 — 自动匹配故障模式 → 建议修复策略，新规则需审批激活
- **故障审计**：每次状态转换记录前状态、新状态、操作标识、转换原因

### 安全加固

| 组件 | 功能 |
|------|------|
| SecretStore | AES-256-GCM 加密存储 (PBKDF2 60 万次迭代) |
| 审计链完整性 | HMAC-SHA256 链式哈希防篡改 |
| Prompt 注入防护 | 11 种注入模式检测与过滤 |
| 输入验证 | Gateway 层拒绝超长/畸形消息 |

### 可观测性

- **RuntimeMonitor**：内存态事件监控 + 可配置 ring buffer
- **MetricsExporter**：Prometheus 格式指标导出 (`/metrics` 端点)
- **StructuredLogger**：JSON 结构化日志，级别过滤，可选文件输出
- **AlertEngine**：阈值告警（连续启动失败、熔断器持续 OPEN、审批超时堆积）

### Dashboard — Web 仪表盘

纯静态 HTML + WebSocket 客户端，零依赖前端框架：
- 子系统状态面板
- Phoenix 审计流实时展示
- FlameBreaker 状态可视化
- Agent 对话终端

---

## 与其他开源框架的全面对比

> 以下对比基于各项目 2025-2026 年度公开的文档、代码库和社区信息。评估力求公正专业，欢迎通过 Issue 提出修正。

### 基础信息

| | FusionWorkspace | OpenClaw | Hermes Agent | Cline | LangGraph | CrewAI |
|---|---|---|---|---|---|---|
| **语言** | TypeScript (ESM) | TypeScript/Node.js | Python | TypeScript | Python | Python |
| **许可证** | MIT | MIT | MIT | Apache 2.0 | MIT | MIT |
| **首次发布** | 2025 Q2 | 2024 | 2025 Q1 | 2024 | 2023 | 2023 |
| **代码规模** | ~35K 行 | ~465K 行 | ~120K 行 | ~300K 行* | ~80K 行 | ~60K 行 |
| **定位** | 生产级运行时基座 | 个人 AI 助手平台 | 自我进化的 Agent | IDE 编码助手 | Agent 编排框架 | 多 Agent 协作 |

> *Cline 含 SDK、CLI、VS Code 扩展、JetBrains 插件等子项目；FusionWorkspace 仅统计 `src/` + `tests/`。

### 架构设计

| | FusionWorkspace | OpenClaw | Hermes Agent | Cline | LangGraph | CrewAI |
|---|---|---|---|---|---|---|
| **主循环模式** | TAOR Loop (generator 异步) | Gateway 事件驱动 | 同步 Agent 循环 | Plan-Act 双模 | 图/状态机 DAG | 顺序/层次任务 |
| **多 Agent 协作** | DuoAgent (双智能体) | Agent 路由 + 隔离 | Sub-agent 委派 | Coordinator + 专家 | 原生图编排 | 角色驱动 Crew |
| **记忆系统** | FTS5 + 分层记忆 + EML 评分 + 轨迹压缩 | 混合关键词+向量搜索 | SQLite+FTS5 冷搜索 + 热记忆 | 上下文窗口管理 | 短时记忆 (Checkpointer) | 短时记忆 |
| **权限模型** | 7 模式 + 10 级风险评分 + 策略引擎 | DM 配对 + 沙箱 | 无独立权限系统 | 审批模式 + auto-approve | 无 | 无 |
| **治理/审计** | Phoenix (advisory_only + HMAC 审计链) | 审计追踪 | 无 | Checkpoints (回滚) | 无 | 无 |
| **熔断/自愈** | FlameBreaker + Antibody | 无 | 无 | 无 | 无 | 无 |

### 通道与集成

| | FusionWorkspace | OpenClaw | Hermes Agent | Cline | LangGraph | CrewAI |
|---|---|---|---|---|---|---|
| **通道类型** | WebSocket / Stdio / Webhook / 外部适配器基类 | 24 原生通道 + 32 扩展 | 12+ 平台 (Telegram/Discord/Slack 等) | VS Code / JetBrains / CLI / Kanban | LangServe API | CLI / API |
| **微信适配器** | 完整 XML 解析 + AES 加解密 + Token 刷新 | 基础支持 | 飞书/钉钉集成 | 不支持 | 不支持 | 不支持 |
| **飞书适配器** | HMAC-SHA256 + 事件 v2 + 卡片审批 | 基础支持 | 基础支持 | 不支持 | 不支持 | 不支持 |
| **MCP 支持** | 计划中 | 插件系统 | 原生支持 | 完整 MCP | 通过 LangChain | 无 |
| **移动端** | Web Dashboard | iOS/Android 伴侣应用 | 无 | 无 | 无 | 无 |

### 安全能力

| | FusionWorkspace | OpenClaw | Hermes Agent | Cline | LangGraph | CrewAI |
|---|---|---|---|---|---|---|
| **密钥加密存储** | AES-256-GCM + PBKDF2 60万次迭代 | 无 | 环境变量 | 环境变量 | 环境变量 | 环境变量 |
| **审计链完整性** | HMAC-SHA256 链式哈希 | 基础审计 | 无 | Checkpoint 快照 | 无 | 无 |
| **Prompt 注入防护** | 11 种注入模式检测 | 无 | 5 层深度防御 | 无 | 无 | 无 |
| **输入验证** | Gateway 层拒绝超长/畸形 | 无 | 有 | IDE 沙箱 | 无 | 无 |
| **已知 CVE** | 无 | CVE-2026-25253 (CVSS 8.8) | 无 | 无 | 无 | 无 |

### 可观测性

| | FusionWorkspace | OpenClaw | Hermes Agent | Cline | LangGraph | CrewAI |
|---|---|---|---|---|---|---|
| **Prometheus 指标** | 原生 `/metrics` 端点 | 无 | 无 | 无 | 通过 LangSmith | 无 |
| **结构化日志** | JSON 格式 + 级别过滤 | 有 | 有 | 有 | 有 | 有 |
| **告警引擎** | 阈值触发 (熔断器/启动失败/审批超时) | 无 | 无 | 无 | 通过 LangSmith | 无 |
| **健康探针** | `/api/live` + `/api/ready` + `/api/health` | 有 | 有 | 无 | 无 | 无 |

### 部署运维

| | FusionWorkspace | OpenClaw | Hermes Agent | Cline | LangGraph | CrewAI |
|---|---|---|---|---|---|---|
| **Docker 支持** | 多阶段 Node 22 Alpine | 支持 | 支持 | 支持 | 支持 | 支持 |
| **Supervisor 配置** | 预启动检查 + 探针 + 重启策略 | 无 | 无 | 无 | 无 | 无 |
| **CI/CD** | GitHub Actions (build + test + Docker 发布) | 有 | 有 | 有 | 有 | 有 |
| **PM2 集群** | ecosystem.config.cjs | 无 | 无 | 无 | 无 | 无 |

### 总结：何时选择 FusionWorkspace

| 场景 | 推荐方案 | 理由 |
|------|----------|------|
| **企业内网部署，需要完整审计** | **FusionWorkspace** | Phoenix 审计链 + 7 模式权限是独有能力 |
| **微信/飞书生态深度集成** | **FusionWorkspace** | 唯一提供完整加解密和 Token 刷新的开源方案 |
| **需要熔断器和自愈能力** | **FusionWorkspace** | FlameBreaker + Antibody 是独有设计 |
| **连接最多消息平台** | OpenClaw | 24 原生通道 + 32 扩展 |
| **Agent 自我进化** | Hermes Agent | 闭环学习循环 |
| **IDE 编码辅助** | Cline | VS Code + JetBrains 深度集成 |
| **复杂多 Agent 工作流编排** | LangGraph | 图/状态机原生支持 |
| **快速多角色 Agent 原型** | CrewAI | 最低学习曲线 |
| **资源受限部署 (<10MB)** | ZeptoClaw | Rust 单二进制 4MB |

---

## 快速开始

### 环境要求

- **Node.js** >= 22.14.0
- **包管理器** npm（推荐）或 pnpm

### 安装和验证

```powershell
git clone https://github.com/ypeng1620-beep/FusionWorkspace.git
cd FusionWorkspace
npm install
npm run build
npm test
```

### 一键冒烟检查

```powershell
npm run check              # Agent 模式健康报告
npm run check:config       # 验证运行时配置模板
npm run check:serve        # 启动服务 → 验证探针 → 关闭
npm run check:supervisor   # 验证 Supervisor 模板
npm run check:production   # 生产就绪全流程检查
```

### 启动 Server 模式

```powershell
npm run serve              # 加载 config/runtime.production.template.json
npm start -- --mode server --memory-backend json   # 手动指定 JSON 后端
```

Runtime 探针端点：

```
http://localhost:8080/api/live     # 存活探针
http://localhost:8080/api/ready    # 就绪探针 (含完整健康报告)
http://localhost:8080/api/health   # 健康详情
http://localhost:8080/metrics      # Prometheus 指标
```

### 启动 Stdio 模式

```powershell
npm start -- --mode stdio --memory-backend json
```

### SQLite 模式

```powershell
npm start -- --mode server --memory-backend sqlite
```

### Dashboard

启用 Dashboard 后访问 `http://localhost:8080/dashboard`，通过 WebSocket 实时查看运行时状态和 Phoenix 审计流。

---

## LLM 提供商配置

在 `config/runtime.production.template.json` 中配置 `llm` 段：

```json
{
  "llm": {
    "providers": [
      {
        "name": "claude",
        "provider": "anthropic",
        "model": "claude-sonnet-4-6-20250514",
        "apiKey": "${ANTHROPIC_API_KEY}"
      },
      {
        "name": "minimax",
        "provider": "openai-compat",
        "model": "MiniMax-M2.7",
        "baseURL": "https://api.minimax.io/v1",
        "apiKey": "${MINIMAX_API_KEY}"
      }
    ],
    "default": "claude"
  }
}
```

---

## 外部通道配置

```powershell
npm start -- --mode server \
  --external-adapter-config config/external-adapters.production.template.json \
  --external-adapter-auto-register
```

外部通道受 Phoenix 边界约束，不能绕过内部权限、记忆策略、审计。

---

## 项目结构

```
FusionWorkspace/
├── src/
│   ├── agent/           # TAOR Loop, DuoAgent, ExternalReviewer, 可靠性
│   ├── memory/          # FTS5 记忆, 分层记忆, 嵌入服务, 轨迹压缩, 注入策略
│   ├── permissions/     # 权限门, 策略引擎, 审批服务, 审计
│   ├── orchestrator/    # Phoenix 核心, 审计存储, 边界合约
│   ├── gateway/         # WebSocket/Stdio/Webhook 通道, 外部适配器
│   ├── llm/             # LLM 提供商抽象层
│   ├── skills/          # 技能生命周期管理
│   ├── reliability/     # FlameBreaker 熔断器
│   ├── antibody/        # Antibody 自愈规则
│   ├── runtime/         # 运行时监控, 指标导出, 日志, 告警, 密钥存储
│   ├── protocol/        # 消息类型, 适配器模式, 审批事件总线, 循环控制器
│   ├── start.ts         # 主入口 (FusionWorkspace + CLI)
│   └── index.ts         # 公共 API 导出
├── dashboard/           # Web 仪表盘 (HTML + JS + CSS)
├── config/              # 运行时配置模板, Supervisor 模板
├── docs/                # 文档
│   ├── ADR/             # 架构决策记录
│   ├── OPERATIONS.md    # 运维手册
│   └── PHOENIX_RUNTIME.md
├── scripts/             # 运维脚本 (健康检查, Supervisor 验证)
├── tests/               # 38 测试套件全覆盖
├── Dockerfile           # 多阶段 Node.js 22 Alpine 构建
├── docker-compose.yml   # 本地开发编排
├── ecosystem.config.cjs # PM2 集群配置
└── .github/workflows/   # CI/CD
```

---

## 架构决策记录 (ADR)

| ADR | 主题 | 决策摘要 |
|-----|------|----------|
| [001](docs/ADR/001-why-taor-not-langgraph.md) | 为何不用 LangGraph | 零依赖、generator 原生取消语义、Phoenix 单点治理、更简单的可观测性 |
| [002](docs/ADR/002-why-phoenix-advisory-only.md) | Phoenix 为何 advisory_only | 安全性通过可见性实现、regex 误报风险、社交契约优于技术强制 |
| [003](docs/ADR/003-secret-key-management.md) | 密钥管理策略 | 环境变量 + AES-256-GCM 双层方案，所有输出边界脱敏 |

---

## 生产运维

```powershell
npm run serve                    # 加载 runtime.production.template.json
npm run check:supervisor         # 验证 Supervisor 模板
npm run check:production         # 生产就绪全流程检查
```

运维手册和监督者配置：
- `docs/OPERATIONS.md`
- `config/supervisor.production.template.json`

---

## 验证结果

> **测试时间：** 2026-05-27 | **环境：** Node.js v24.14.0, Windows 11 | **版本：** v0.14.0

### 全量测试套件：38/38 通过

```
✅ Permission Gate          ✅ Runtime Status            ✅ External Adapter Contract
✅ Permission Policy Engine ✅ Package Runtime Entry     ✅ External Adapter Replay
✅ Tool Executor            ✅ Runtime Server Smoke      ✅ External Adapter Config Validation
✅ Skill Lifecycle          ✅ Gateway Startup           ✅ External Adapter Config Templates
✅ TAOR Reliability         ✅ Startup CLI Config        ✅ Adapter Factory Readiness
✅ DuoAgent                 ✅ Startup CLI Validate Config✅ Memory Fallback
✅ Flame Breaker            ✅ Runtime Server Check Script✅ Approval Service
✅ Antibody Repository      ✅ Runtime Operations Docs   ✅ Phoenix Audit
✅ Antibody Policy          ✅ Production Readiness Script✅ Phoenix Audit Snapshots
✅ WeChat Channel           ✅ Supervisor Template       ✅ Phoenix Core
✅ Feishu Channel           ✅ Supervisor Template Validation✅ Phoenix Boundaries
✅ External Ingress Guard   ✅ EML Scoring               ✅ Phoenix Runtime Docs
✅ Memory Manager EML Audit ✅ Memory Write Policy
```

### 编译验证

```
npx tsc --noEmit    # 0 errors
```

### 运行时冒烟

| 命令 | 结果 |
|------|------|
| `npm run check` | `{ status: "ok", checks: { runtime, tools, permissions, memory, skills, phoenix, llm, gateway, external_adapter_readiness, external_ingress } }` |
| `npm run check:config` | `{ valid: true }` |
| `npm run check:serve` | `{ status: "ok", probes: { live: "ok", ready: "ok" } }` |
| `npm run check:supervisor` | `{ valid: true, checks: { preStart: "ok", probes: "ok", externalAdapters: "ok" } }` |
| `npm run check:production` | `{ status: "ok", checks: { config: "ok", supervisor: "ok", server: "ok" } }` |

---

## 贡献

本项目是个人研究项目，欢迎通过 Issue 提出建议和讨论。

## 许可证

MIT License — 详见 [LICENSE](LICENSE) 文件。
