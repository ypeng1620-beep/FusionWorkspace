# ADR-002: Why Phoenix is advisory-only (observe_only by default)

**Date:** 2025-05-26
**Status:** Accepted

## Context

Phoenix is the governance layer that evaluates agent actions against boundary contracts. The core design question: should Phoenix be able to *block* actions, or only *advise*?

## Decision

Phoenix operates in `observe_only` mode by default. It recommends actions (`allow`, `flag`, `block`) but never enforces them — the calling agent always has the final say. An `enforce` mode exists but is opt-in.

## Rationale (5 reasons)

1. **Safety through visibility, not authority.** A blocked action that fails silently can mask a deeper architectural problem. By logging the violation *and* letting the action proceed, Phoenix creates an audit trail that reveals *why* a pattern is dangerous — without creating a production outage from a false positive.

2. **False positives are inevitable in pattern-based governance.** Phoenix uses regex patterns (`BLOCK_PATTERNS`, `FLAG_PATTERNS`) to flag risky prompts. These patterns will produce false positives. A blocked `rm -rf` command could also block a legitimate `rm -rf node_modules && npm ci`. Advisory mode ensures false positives are logged, not disruptive.

3. **The boundary contract is a social contract, not a technical one.** `PhoenixBoundaryContract` declares `canApprovePermissions: false`, `canExecuteTools: false`, etc. These are promises to upstream systems, not technical enforcement. Making them advisory-only forces integrators to read and honor the contract explicitly rather than relying on silent enforcement they may not understand.

4. **DuoAgent review filtering already provides strong enforcement.** When a review suggestion would violate Phoenix boundaries, `ExternalReviewer.filterSuggestions()` rejects it before the local agent sees it. This is the correct enforcement layer — close to the action, not at the governance abstraction.

5. **Audit-first architecture.** Every Phoenix evaluation produces an audit entry regardless of mode. This means `observe_only` still creates a complete decision record. Switching to `enforce` later doesn't change the data model, only the control flow.

## Consequences

- Agents must explicitly opt into enforcement (`mode: 'enforce'`). Most will use advisory mode.
- A malicious or buggy agent can ignore Phoenix recommendations. This is acceptable because Phoenix is not a sandbox — `PermissionGate` and `FlameBreaker` provide the actual enforcement layers.
- The audit trail remains complete regardless of mode, enabling post-hoc analysis of ignored warnings.

## When to use enforce mode

- CI/CD pipelines where false positives are acceptable costs
- High-security environments with well-tested pattern lists
- DuoAgent external review (where suggestions are filtered pre-emptively)
