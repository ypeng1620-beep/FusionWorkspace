# Phoenix EML-HCO Implementation Plan

Version: 0.1.0
Status: binding implementation plan

Phoenix EML-HCO is adopted as a governance layer for FusionWorkspace. It does
not replace the existing TAOR loop, memory manager, permission system, tool
registry, or gateway.

## 1. Non-Negotiable Boundary

Phoenix may recommend. Existing runtime modules execute.

This means:
- `Phoenix Core` may classify, score, route, and recommend.
- `TAORLoop` remains the execution loop.
- `ToolRegistry` remains the only tool execution entry.
- `PermissionGate` remains the final permission boundary.
- `MemoryManager` remains the memory persistence boundary.
- `Gateway` remains the channel boundary.

## 2. Target Module Layout

The implementation should add these modules only when each phase needs them:

```text
src/orchestrator/phoenixCore.ts
src/orchestrator/phoenixAudit.ts
src/memory/emlScoring.ts
src/reliability/flameBreaker.ts
src/reliability/fallbackPolicy.ts
src/antibody/antibodyRepository.ts
src/antibody/antibodyPolicy.ts
```

Tests should mirror the module boundaries:

```text
tests/testPhoenixAudit.ts
tests/testEmlScoring.ts
tests/testFlameBreaker.ts
tests/testAntibodyRepository.ts
tests/testPhoenixIntegration.ts
```

## 3. Phase 1: Governance Audit MVP

Goal: record Phoenix decisions without changing behavior.

Scope:
- Add Phoenix audit event types.
- Record intent classification placeholder.
- Record memory scoring placeholder.
- Record reliability decision placeholder.
- Expose Phoenix status through runtime status.

Allowed behavior:
- Logging and status reporting only.

Forbidden behavior:
- No tool routing changes.
- No memory deletion.
- No fallback changes.
- No antibody rule activation.

Acceptance criteria:
- `npm run build` passes.
- `npm test` passes.
- A TAOR turn can include Phoenix audit data.
- Existing tool behavior is unchanged.

## 4. Phase 2: EML Memory Scoring

Goal: make memory writes explainable and bounded.

Scope:
- Implement deterministic EML score calculation.
- Define score input fields.
- Add threshold classification.
- Connect scoring to memory write policy.
- Record scoring decisions in audit.

Minimum data model:

```typescript
interface EmlScoreInput {
  novelty: number
  importance: number
  volatility: number
  redundancy: number
  retrievalFrequency: number
  ageMs: number
}
```

Required output:

```typescript
interface EmlScoreDecision {
  score: number
  action: 'ignore' | 'short_term' | 'promote' | 'distill_candidate' | 'archive'
  reasons: string[]
}
```

Hard constraints:
- Scores must be clamped.
- Thresholds must be versioned.
- Unique source memories must not be hard-deleted without an archive copy.
- Scoring must be deterministic for the same input and config.

Acceptance criteria:
- Duplicate low-value memory is not promoted.
- High-value user preference, project fact, or failure signal can be promoted.
- Decision reasons are visible in audit.

## 5. Phase 3: Flame Breaker Reliability

Goal: add failure state tracking and controlled fallback.

Scope:
- Implement breaker state machine.
- Track failures by subsystem and operation key.
- Add cooldown and half-open probing.
- Return fallback recommendations.
- Record all transitions in runtime audit.

State model:

```text
CLOSED -> OPEN -> HALF_OPEN -> CLOSED
```

Default transition policy:
- 5 consecutive failures opens the breaker.
- 60 seconds cooldown moves to half-open.
- 3 consecutive half-open successes closes the breaker.
- 1 half-open failure reopens the breaker.

Hard constraints:
- Fallback must not hide the original error.
- Fallback must not bypass permission checks.
- Fallback must not retry destructive tools automatically.
- Every state transition must be auditable.

Acceptance criteria:
- Consecutive failures open the breaker.
- Cooldown enables half-open probing.
- Success closes the breaker.
- Failure reopens the breaker.
- Audit includes original operation key and reason.

## 6. Phase 4: Antibody Repository

Goal: store failure-derived rule proposals without automatic activation.

Scope:
- Capture recurring failure patterns.
- Generate antibody rule proposals.
- Store rule status and version.
- Detect simple conflicts.
- Expose proposal counts in runtime status.

Required rule states:

```text
proposed
approved
active
rejected
expired
```

Hard constraints:
- New rules start as `proposed`.
- Proposed rules cannot affect execution.
- Active rules must be explicitly approved.
- Rules must have expiration or review metadata.
- Conflicting active rules must be rejected or require manual resolution.

Acceptance criteria:
- A repeated failure creates a proposed rule.
- Proposed rules do not change runtime behavior.
- Approved rules can be marked active by explicit API or test setup.
- Conflict detection is test-covered.

## 7. Phase 5: Phoenix Core Integration

Goal: let Phoenix advise TAOR without taking over execution.

Scope:
- Add intent route decision.
- Add memory policy recommendation.
- Add reliability policy recommendation.
- Add antibody lookup recommendation.
- Attach Phoenix decisions to TAOR runtime audit.

Hard constraints:
- Phoenix Core cannot execute tools.
- Phoenix Core cannot approve permissions.
- Phoenix Core cannot delete memory.
- Phoenix Core cannot activate antibody rules.
- TAORLoop remains the runner.

Acceptance criteria:
- Phoenix can recommend memory recall depth.
- Phoenix can recommend a fallback path.
- Phoenix can recommend a skill lookup.
- All recommendations are auditable.
- Existing permission tests still pass.

## 8. Phase 6: Stabilization

Goal: make the governance layer maintainable.

Scope:
- Add replayable audit snapshots.
- Add policy version metadata.
- Add module-level docs.
- Add regression tests for boundary constraints.
- Add negative tests for forbidden behavior.

Acceptance criteria:
- Build and tests pass.
- Phoenix policy versions appear in runtime status.
- Forbidden behavior has explicit tests.
- Documentation matches implemented behavior.

## 9. Global Hard Constraints

These constraints apply to all phases:

1. Do not rewrite `TAORLoop` wholesale.
2. Do not replace `MemoryManager`.
3. Do not replace `PermissionGate`.
4. Do not replace `ToolRegistry`.
5. Do not couple WeChat or Feishu specifics to Phoenix Core.
6. Do not store external model API keys in the repository.
7. Do not auto-activate antibody rules.
8. Do not auto-delete unique source memory.
9. Do not allow Phoenix recommendations to bypass permission checks.
10. Do not accept external model advice without local verification.

## 10. Definition Of Done

A Phoenix implementation phase is done only when:

- The phase scope is implemented.
- Hard constraints remain true.
- `npm run build` passes.
- `npm test` passes.
- Runtime audit explains new decisions.
- Residual risk is documented.

Documentation-only changes are exempt from build and test only when no runtime
files were changed.
