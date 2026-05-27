# DuoAgent Collaboration Protocol

Version: 0.1.0
Status: binding for Phoenix EML-HCO implementation

This document defines how FusionWorkspace uses external model agents during
implementation. It is intentionally key-free. Real API keys must never be
stored in this repository.

## 1. Purpose

DuoAgent mode means one local implementation agent and one external review
agent cooperate on a bounded engineering task.

The local implementation agent owns:
- Reading and changing the repository.
- Applying patches.
- Running build and tests.
- Rejecting unsafe or incoherent external suggestions.
- Producing the final implementation.

The external review agent owns:
- Reviewing architecture boundaries.
- Finding implementation risks.
- Challenging assumptions.
- Proposing test cases.
- Producing review notes only.

External agents do not directly modify files.

## 2. Allowed External Models

The following model roles are allowed:

| Role | Model family | Use |
| --- | --- | --- |
| Architecture reviewer | Gemini | Module boundaries, phased design, over-coupling checks |
| Implementation reviewer | MiniMax | TypeScript interfaces, runtime flow, test coverage |
| Adversarial reviewer | OpenRouter / Nemotron | Risk review, over-design review, permission and memory abuse checks |

Only one external reviewer should be active for a task unless a written
escalation reason is recorded.

## 3. Secret Handling

Required rules:

1. API keys must only be passed through process environment variables.
2. API keys must not be written into source code, tests, docs, JSON config, or runtime logs.
3. API keys must not be committed.
4. Any generated report must redact provider credentials.
5. If an API key appears in a prompt, it must be treated as exposed and rotated after use.

Allowed environment variable names:

```text
GEMINI_API_KEY
MINIMAX_API_KEY
OPENROUTER_API_KEY
```

No `.env` file containing real credentials may be created by default.

## 4. Review Payload Boundaries

External reviewers may receive:
- High-level architecture summaries.
- Redacted interface definitions.
- Redacted test failures.
- Small code excerpts needed for review.
- Explicit design questions.

External reviewers must not receive:
- API keys or secrets.
- Private runtime data.
- Full memory databases.
- User messages unrelated to the reviewed implementation.
- Large code dumps without a specific review objective.

## 5. Decision Authority

External reviewers are advisory only.

A suggestion may be accepted only if:
- It preserves existing FusionWorkspace boundaries.
- It does not bypass `PermissionGate`.
- It does not bypass `ToolRegistry`.
- It does not make memory deletion irreversible.
- It can be covered by tests or runtime audit.

A suggestion must be rejected or deferred if:
- It requires hidden global state.
- It introduces automatic self-modification.
- It couples external channels to core orchestration.
- It gives an antibody rule immediate production authority.
- It cannot be explained in runtime audit.

## 6. Operating Loop

Each DuoAgent task follows this loop:

1. Local agent defines the task scope and constraints.
2. Local agent gathers repository context.
3. External reviewer receives a bounded, redacted question.
4. Local agent evaluates reviewer output.
5. Local agent implements accepted changes.
6. Local agent runs verification.
7. Local agent records final result and residual risks.

No external review may replace local verification.

## 7. Verification Gate

Before a task is considered complete:

```text
npm run build
npm test
```

must pass unless the task is explicitly documentation-only.

For documentation-only tasks, changed documents must be readable and must not
contain credentials.

## 8. Audit Requirements

For every DuoAgent-assisted implementation task, the final note should include:
- Which external reviewer role was used, if any.
- What advice was accepted.
- What advice was rejected or deferred.
- What verification was run.
- Any remaining risk.

## 9. Hard Prohibitions

The following are forbidden:

- Storing real API keys in the repository.
- Allowing an external model to choose production code without local review.
- Letting external model output bypass tests.
- Auto-applying antibody rules.
- Auto-deleting unique memory records.
- Using external channel details as core orchestration logic.
- Weakening permission checks to make a test pass.
