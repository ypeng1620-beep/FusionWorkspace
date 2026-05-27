# ADR-001: Why TAOR Loop instead of LangGraph

**Date:** 2025-05-26
**Status:** Accepted

## Context

We needed a core agent loop that coordinates thinking, tool execution, observation, and reflection. Two approaches were considered:

1. **LangGraph** — LangChain's state-graph framework with built-in checkpointing, streaming, and tool routing.
2. **TAOR (Think→Act→Observe→Reflect)** — A custom async generator loop with minimal dependencies.

## Decision

We chose TAOR, a custom `AsyncGenerator`-based loop.

## Rationale (4 reasons)

1. **Zero-framework dependency.** TAOR is ~250 lines of TypeScript with no runtime dependencies. LangGraph requires `langgraph`, `langchain-core`, `langgraph-sdk`, and `langgraph-checkpoint` — ~2MB of transitive JS dependencies that add supply-chain risk and version churn.

2. **Generator-native cancellation.** JavaScript `AsyncGenerator` gives us built-in pause/resume/abort via `generator.return()`. LangGraph's node-based state machine requires explicit interrupt handling through `interrupt()` and `Command` objects — more surface area for edge-case bugs.

3. **Phoenix governance requires a single choke point.** All decisions (memory recall, tool permission, skill lookup) pass through Phoenix precisely once per iteration. A graph-based approach would scatter governance across nodes, making audit consistency harder to guarantee.

4. **Observability is simpler.** A single loop with `.next()` yields a natural metric boundary (iteration count, step latency). LangGraph requires tracing instrumentation across graph edges.

## Consequences

- We lose LangGraph's built-in persistence. We compensate with `CheckpointManager` and `ToolTransactionLog` in `taorReliability.ts`.
- We lose visual graph editing. TAOR's linear structure is less flexible but easier to reason about for an advisory governance system.
- Adding branching logic requires explicit conditionals in the loop body rather than graph edges.

## Alternatives considered

- **LangChain AgentExecutor** — deprecated in favor of LangGraph, same dependency concerns.
- **Custom state machine** (XState) — overkill; TAOR's 4-phase cycle is simple enough for a generator.
- **Event-driven loop** (RxJS) — adds dependency, harder to test deterministically than an async generator.
