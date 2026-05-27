# AI Agent 架构 — 核心模块路径表

> 三个系统的核心源码路径，供按需喂代码使用

---

## Hermes Agent（Python）

**源码根目录：** `D:\AI-Agent-Architecture\FusionWorkspace\hermes-agent-src\hermes-agent-main\`

### 核心入口
| 模块 | 路径 |
|------|------|
| CLI 入口 | `cli.py` |
| Agent 主逻辑 | `agent/` (dir) |
| Run Agent | `run_agent.py` |
| RL CLI | `rl_cli.py` |

### Memory & State
| 模块 | 路径 |
|------|------|
| 状态管理 | `hermes_state.py` |
| Trajectory 压缩 | `agent/trajectory.py` |

### Session & Tools
| 模块 | 路径 |
|------|------|
| ACP Session | `acp_adapter/session.py` |
| Gateway Session | `gateway/session.py` |
| Honcho Session | `plugins/memory/honcho/session.py` |
| Toolsets | `toolsets.py` |

---

## Claude Code（TypeScript）

**源码根目录：** `D:\Claude-Code-Src\src\`

### 核心入口
| 模块 | 路径 |
|------|------|
| CLI 入口 | `entrypoints/cli.tsx` |
| 主逻辑 | `commands.ts` |
| Tool 基类 | `Tool.ts` |
| QueryEngine | `QueryEngine.ts` |

### State & Context
| 模块 | 路径 |
|------|------|
| 全局状态 | `state/AppState.tsx` |
| 状态变更 | `state/onChangeAppState.ts` |
| 全局上下文 | `context.ts` |
| 工具上下文 | `utils/context.ts` |

### Permission System
| 模块 | 路径 |
|------|------|
| 权限类型 | `types/permissions.ts` |
| 权限工具 | `utils/permissions/permissions.ts` |
| Remote Bridge | `remote/remotePermissionBridge.ts` |
| Leader Bridge | `utils/swarm/leaderPermissionBridge.ts` |

### Coordinator & Bridge
| 模块 | 路径 |
|------|------|
| Coordinator 模式 | `coordinator/coordinatorMode.ts` |
| REPL Bridge | `bridge/replBridge.ts` |
| 初始化 Bridge | `bridge/initReplBridge.ts` |
| Mailbox Bridge | `hooks/useMailboxBridge.ts` |

### MCP & Bash
| 模块 | 路径 |
|------|------|
| MCP Tool | `tools/MCPTool/MCPTool.ts` |
| Bash Commands | `utils/bash/commands.ts` |

---

## OpenClaw（Workspace 源码）

**源码根目录：** `C:\Users\ypeng\.openclaw\workspace\`

### 核心入口（.agents / skills / tasks）
| 模块 | 路径 |
|------|------|
| Agent 配置 | `.agents/` |
| Gateway 管理脚本 | `scripts/gateway-manager.ps1` |
| Gateway 健康监控 | `scripts/gateway-health.js` |
| Cron 创建工具 | `tasks/create-cron-job.cjs` |

### 蒸馏文档（ distillation）
| 模块 | 路径 |
|------|------|
| OpenClaw 架构 | `distillation/openclaw/OPENCLAW_ARCHITECTURE_DISTILL.md` |
| 四大 Phase | `distillation/` |

### Skills（205 个技能）
| 模块 | 路径 |
|------|------|
| 自进化技能 | `skills/self-evolve-program/` |
| GStack | `skills/gstack/` |
| 搜索研究 | `skills/search.ts` / `skills/research.ts` |

---

## 快速定位规则

```
想找 Hermes 的记忆系统     → hermes_state.py / agent/trajectory.py
想找 Claude 的权限系统    → types/permissions.ts / utils/permissions/
想找 OpenClaw 的 Gateway  → scripts/gateway-*.js / .agents/
想找三者的 Session 管理   → Hermes: acp_adapter/session.py
                           Claude: state/AppState.tsx
                           OpenClaw: tasks/create-cron-job.cjs
```

---

*生成时间：2026-04-21 13:48*