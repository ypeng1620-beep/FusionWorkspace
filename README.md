# FusionWorkspace

AI Agent 融合运行时 — 结合 Claude Code、Hermes、OpenClaw 三家核心设计的生产级 Agent 服务基座。

**Version:** 0.14.0 | **Node:** >=22.14.0 | **Language:** TypeScript (ESM)

---

## 项目背景

本项目对三套主流 AI Agent 系统进行了深入的架构对比研究：

| 系统 | 核心特色 | 借鉴设计 |
|------|----------|----------|
| **Claude Code** | QueryEngine 主循环、7 模式权限门、Agent 工具编排 | TAOR Loop、PermissionGate |
| **Hermes** | 技能生命周期、FTS5 向量混合搜索、网关路由 | SkillManager、Memory 系统、Gateway |
| **OpenClaw** | Phoenix 治理层、FlameBreaker 熔断器、外部通道适配器 | PhoenixGovernance、FlameBreaker、外部通道 |

FusionWorkspace 将三者最优秀的基因融合为一个统一的生产级运行时。

---

## 核心模块

### TAOR Loop — 主循环引擎
Think → Act → Observe → Reflect 四阶段 generator 模式循环，支持流式 LLM 输出、工具调用、上下文窗口管理、多轮会话。

### Memory System — 分层记忆
- **FTS5 全文搜索** + SQLite 持久化
- **LRU 缓存** + EML 评分淘汰策略
- **EmbeddingService** — 向量嵌入（Ollama / OpenAI / Deterministic）
- **LayeredMemory** — Profile / Session / Knowledge / Episodic 四层记忆
- **TrajectoryCompressor** — 轨迹压缩与摘要
- **MemoryInjection** — 上下文注入策略 + prompt injection 安全防护

### Permission System — 七模式权限门
`bypass` | `plan` | `default` | `auto` | `interactive` | `sandbox` | `restricted`

- 工具风险评分（10 级）
- 策略引擎（Channel / User / Group 三级策略）
- 审批双模（同步确认 + 异步等待）
- 完整的审计日志

### Phoenix Governance — 治理与审计
- `advisory_only` 模式 — 建议不执行
- 边界合约（9 条硬边界，不可升级）
- 审计存储 + HMAC 链完整性保护
- 决策推荐引擎

### Gateway — 多通道网关
- **WebSocket** — 全双工实时通道，支持 Dashboard
- **Stdio** — 命令行集成
- **Webhook** — HTTP 回调通道（含重试队列，最多 3 次）
- **ExternalChannel** — 外部通道基类（去重、持久化审计）
- **WeChat** / **Feishu** — 生产就绪适配器（XML 解析、AES 加解密、Token 刷新、Webhook 验证）

### LLM Provider Layer — 多模型抽象
- Claude API（Anthropic SDK，streaming + thinking + prompt caching）
- OpenAI-Compatible 提供商（MiniMax、DeepSeek、Groq、Ollama）
- 运行时注册与热切换
- Mock Provider 用于测试

### DuoAgent — 双智能体协作
本地 Agent（读写执行） + 外部 Review Agent（只读审查），Phoenix 边界过滤建议，完整审查审计追踪。

### FlameBreaker + Antibody — 可靠性
- **FlameBreaker** — 熔断器状态机（CLOSED → OPEN → HALF_OPEN）
- **Antibody** — 自愈规则库（自动匹配故障模式 → 建议修复策略）

### Skill Lifecycle — 技能闭环
发现 → 锻造 → 评估 → 补丁，完整的技能生命周期管理。

### Security — 安全加固
- **SecretStore** — AES-256-GCM 加密存储（PBKDF2 60 万次迭代）
- **审计链完整性** — HMAC-SHA256 链式哈希防篡改
- **Prompt 注入防护** — 11 种注入模式检测与过滤
- **输入验证** — Gateway 层拒绝超长/畸形消息

### Observability — 可观测性
- **RuntimeMonitor** — 内存态事件监控 + ring buffer
- **MetricsExporter** — Prometheus 格式指标导出
- **StructuredLogger** — JSON 结构化日志
- **AlertEngine** — 阈值告警（连续启动失败、熔断器持续 OPEN、审批超时堆积）

### Dashboard — Web 仪表盘
纯静态 HTML + WebSocket 客户端，实时展示：子系统状态、FlameBreaker 状态、运行指标、Phoenix 审计流、Agent 对话终端。

---

## 项目结构

```
FusionWorkspace/
├── src/
│   ├── agent/           # TAOR Loop, DuoAgent, ExternalReviewer, 可靠性模块
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
├── tests/               # 测试套件 (33 个文件全覆盖)
├── Dockerfile           # 多阶段 Node.js 22 Alpine 构建
├── docker-compose.yml   # 本地开发编排
├── ecosystem.config.cjs # PM2 集群配置
└── .github/workflows/   # CI/CD
```

---

## 快速开始

```powershell
npm install
npm run build
npm test
npm run check
```

### 本地冒烟测试

```powershell
npm run check              # Agent 模式, JSON 后端, 健康报告
npm run check:config       # 验证运行时配置模板
npm run check:serve        # 启动服务 → 验证探针 → 关闭
npm run check:supervisor   # 验证 Supervisor 模板
npm run check:production   # 生产就绪全流程检查
```

### 启动 Server 模式

```powershell
npm run serve              # 加载 config/runtime.production.template.json
# 或手动:
npm start -- --mode server --memory-backend json
```

Runtime 探针端点：

```
http://localhost:8080/api/live     # 存活探针
http://localhost:8080/api/ready    # 就绪探针
http://localhost:8080/api/health   # 健康详情
```

### 启动 Stdio 模式

```powershell
npm start -- --mode stdio --memory-backend json
```

### SQLite 模式

使用 SQLite 持久化后端（需安装 `better-sqlite3` 原生绑定）：

```powershell
npm start -- --mode server --memory-backend sqlite
```

若 SQLite 不可用但显式要求，启动会快速失败而非静默降级。

### Dashboard

启用 Dashboard 后访问 `http://localhost:8080/dashboard`，通过 WebSocket 实时查看运行时状态和 Phoenix 审计流。

---

## 架构决策记录 (ADR)

| ADR | 主题 | 摘要 |
|-----|------|------|
| [001](docs/ADR/001-why-taor-not-langgraph.md) | 为何不用 LangGraph | 零依赖、generator 原生取消、Phoenix 单点治理、更简单的可观测性 |
| [002](docs/ADR/002-why-phoenix-advisory-only.md) | Phoenix 为何 advisory_only | 安全性通过可见性实现、regex 误报风险、社交契约优于技术强制 |
| [003](docs/ADR/003-secret-key-management.md) | 密钥管理 | 环境变量 + AES-256-GCM 双层方案，所有输出边界脱敏 |

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
        "model": "claude-sonnet-4-6",
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

## 生产运维

运维手册和监督者配置：

```
docs/OPERATIONS.md
config/supervisor.production.template.json
```

`npm run serve` 加载：

```
config/runtime.production.template.json
```

`npm run check:supervisor` 验证 `config/supervisor.production.template.json` 的预启动检查、探针、关闭信号、重启策略和外部通道边界。

---

## 验证

```powershell
npm run build    # TypeScript 编译
npm test         # 全量测试套件
npm run check    # 运行时冒烟测试
```
