# Phoenix Runtime Contract

This document pins the implemented runtime contract for FusionWorkspace Phoenix,
EML, FlameBreaker, and Antibody modules. It is intentionally strict: internal
capabilities must be stable before external channels are connected.

## Runtime Position

Phoenix is an internal governance and diagnosis layer. Its execution mode is
`advisory_only` unless an explicit caller chooses to enforce a governance
decision outside Phoenix. Phoenix itself does not perform side effects.

Current contract anchor:

- `PHOENIX_BOUNDARY_CONTRACT_VERSION`
- `advisory_only`
- `PhoenixCore`
- `PhoenixAuditStore`
- `EmlScorer`
- `FlameBreaker`
- `AntibodyRepository`
- `AntibodyPolicy`

## Hard Boundaries

The following fields are fixed as non-escalating boundaries. A Phoenix decision
or Phoenix audit entry must not set any of them to `true`.

- `canApprovePermission: false`
- `canExecuteTool: false`
- `canExecuteSkill: false`
- `canWriteMemory: false`
- `canDeleteMemory: false`
- `canRetryAutomatically: false`
- `canBypassPermission: false`
- `hideOriginalError: false`
- `canAffectExecution: false`

Boundary checks are enforced in two places:

- Decision-level methods such as governance, memory recall, skill lookup,
  fallback path, reliability, and antibody audit writers.
- Raw audit ingestion and replay restore, including `PhoenixAuditStore.record`
  and `PhoenixAuditStore.fromReplaySnapshot`.

## Implemented Flow

The current long-running agent loop uses Phoenix as a preflight and audit layer.

1. Intent route is recorded as observe-only audit.
2. Phoenix governance evaluates the prompt and records recommended vs effective
   action.
3. Phoenix memory recall recommendation can adjust recall depth within bounded
   limits, but cannot write or delete memory.
4. EML scoring attaches memory-write policy metadata and can recommend promote,
   store, ignore, distill, or archive. Archive requires preserving a copy and
   must not become hard delete.
5. Phoenix skill lookup can recommend lookup query and max result count, but
   cannot execute a skill.
6. FlameBreaker tracks subsystem failures and recommends fallback when a breaker
   opens, while preserving original errors.
7. AntibodyPolicy can propose rules from repeated failures. Proposed rules do
   not affect execution. Active antibody matches remain advisory.
8. Phoenix fallback path can recommend retry-later or reduced-context paths, but
   cannot retry automatically, bypass permission, execute tools, or hide the
   original error.

## Replay And Audit

Phoenix audit is replayable for regression analysis and long-running service
diagnosis.

- `PhoenixAuditStore.exportReplaySnapshot` exports schema version, snapshot id,
  reason, policy versions, and audit entries.
- `PhoenixAuditStore.fromReplaySnapshot` restores a store from a snapshot and
  rejects unsupported schemas or entries that violate boundary fields.
- `PhoenixAuditSnapshotStore` persists replay snapshots as JSON files and uses
  `maxSnapshots` rotation to keep disk usage bounded for long-running services.
- `FusionWorkspace.savePhoenixAuditSnapshot` exposes a runtime-level manual
  checkpoint. The default directory is `.fusion-runtime/phoenix-snapshots`, and
  deployments can override it with `phoenixSnapshotDir`.
- `phoenixRestoreSnapshotId` restores a named Phoenix audit snapshot during
  workspace initialization. Restore validates schema and boundary fields before
  the audit store becomes visible to runtime status.
- `phoenixRestoreLatestSnapshot` restores the newest available snapshot when no
  explicit snapshot id is supplied. Named restore takes precedence over latest
  restore to keep recovery deterministic.
- `phoenixSnapshotOnStop` writes a final Phoenix audit checkpoint during
  `FusionWorkspace.stop`. This is for controlled shutdown durability only; a
  failed stop snapshot is recorded as a runtime error and must not block the
  shutdown path.
- `phoenixSnapshotOnStopId` can pin a deterministic stop snapshot id for tests
  and supervised operations. If omitted, the runtime generates a `stop-*`
  snapshot id.
- `FusionWorkspace.start is single-flight while startup is in progress`:
  concurrent start calls must share one initialization and gateway startup
  attempt instead of racing duplicate control-plane construction.
- `FusionWorkspace.start waits for in-progress shutdown before restarting` so a
  restart request arriving during shutdown is honored after cleanup instead of
  being swallowed by the still-running flag.
- Startup failure must be observable. `Workspace start failed` is recorded as a
  runtime degraded event with the original error text, while `start()` still
  rejects so supervisors can decide whether to retry or abort.
- Startup failure must also be recoverable and leak-resistant:
  `workspace.start retries initialize after failed attempt` and
  `workspace.start closes initialized memory after failed startup` keep
  supervisor retry loops from inheriting stale memory resources.
- Runtime lifecycle telemetry is part of the stable operations contract:
  `runtime lifecycle reports start attempts`,
  `runtime lifecycle reports failed start attempts`,
  `runtime lifecycle reports last successful start timestamp`, and
  `runtime lifecycle reports last state change timestamp`. The runtime health
  check mirrors the same lifecycle metadata, including
  `runtime health metadata reports start attempts` and
  `runtime health metadata reports last state change timestamp`, so readiness
  consumers do not need private workspace fields.
- The workspace health report includes a runtime check, and the
  `runtime health check degrades after workspace start failure` contract means
  readiness probes cannot report healthy while the runtime monitor is degraded.
- `FusionWorkspace.stop is idempotent after stopped`: repeated stop calls after
  the first completed shutdown must not write additional stop snapshots or close
  resources again.
- `FusionWorkspace.stop is single-flight while shutdown is in progress`:
  concurrent stop calls must share one shutdown attempt so stop snapshots and
  resource cleanup are not duplicated.
- `FusionWorkspace.stop waits for in-progress startup before shutting down` so
  a shutdown request arriving during startup is not lost as an already-stopped
  no-op.
- Memory close is also a cleanup boundary, not a process-killing boundary. If
  the memory manager close step throws, shutdown must still mark the workspace
  stopped and record a runtime error event with `Memory manager close failed`.
- Stop lifecycle telemetry must remain precise for supervised long-running
  workers: `runtime lifecycle reports completed stop attempts`,
  `runtime lifecycle reports last stopped timestamp`, and
  `runtime lifecycle reports last stop error`. A later clean shutdown must also
  satisfy `runtime lifecycle clears stale stop error after clean stop`, so old
  cleanup failures do not poison a recovered worker.
- `npm run check` is the standard local runtime smoke test. It starts
  FusionWorkspace in agent mode, prints the health report, and shuts down
  cleanly through `--check`.
- `npm run check:config` is the standard pre-start runtime configuration gate.
  It calls `--validate-config`, prints the normalized runtime config, and exits
  without starting gateway listeners, provider adapters, memory managers, or
  other long-running resources. Invalid runtime config must return a non-zero
  process exit code so supervisors and deployment scripts can fail fast before
  traffic is attached.
- `npm run check:serve` is the standard production-template server probe gate.
  It starts the runtime from the checked-in production template, verifies
  `/api/live` and `/api/ready`, then shuts the runtime down. The command must
  emit machine-readable JSON on stdout so deployment scripts can consume it.
- `npm run check:supervisor` validates the checked-in supervisor handoff
  template, including pre-start checks, probe URLs, shutdown signal, restart
  limits, and the disabled external-provider traffic boundary.
- `npm run check:production` is the single production-readiness gate. It must
  validate the checked-in runtime config, start the production-template server,
  verify live and ready probes, emit machine-readable JSON, and stop the
  runtime before exiting.
- `config/supervisor.production.template.json` is the machine-readable
  supervisor handoff. It must keep `npm run check:production` as the pre-start
  gate, `npm run serve` as the start command, `SIGTERM` as the shutdown signal,
  bounded restart policy, and live/ready/health probes. External adapter
  auto-registration and provider traffic attachment remain disabled in the
  template.
- Long-running HTTP server mode exposes stable probe endpoints. `/api/live`
  is a lightweight liveness probe for the HTTP/WebSocket process and must not
  require all internal readiness checks to pass. `/api/ready` exposes
  `FusionWorkspace.getHealthReport()` readiness for supervisors and reverse
  proxies. `/api/health` remains a compatibility readiness endpoint with the
  same health report payload.
- Memory backend intent must be explicit in deploy scripts.
  `--memory-backend json` selects the JSON backend as an intentional stable
  mode and `explicit json memory backend is healthy`;
  `--memory-backend sqlite` keeps SQLite as a required backend and fails fast
  if the native binding is not usable.
- Runtime status exposes Phoenix policy versions, recent audit entries,
  reliability state, antibody state, snapshot metadata, and the boundary
  contract.

## External Channel Boundary

External channels are deliberately out of scope for the current internal
stabilization phase.

External channels are not allowed to bypass internal permissions. WeChat,
Feishu, webhook, stdio, or websocket adapters must enter the same permission
workflow, audit workflow, memory policy, Phoenix boundary checks, and runtime
monitoring as local agent calls.

`ExternalIngressGuard` is the standard inbound guard for real external
adapters. Before an adapter dispatches a user message into `ExternalChannel`
callbacks, the guard must normalize the decision into an explicit accept or
reject result.

Provider-specific adapters must first convert raw payloads into the shared
inbound contract:

- `normalizeWeChatInbound` maps WeChat message id, sender open id, content,
  signature, and `provider metadata` into a stable internal shape.
- `normalizeFeishuInbound` maps Feishu event/message id, sender open id, chat
  id, parsed text content, signature, and `provider metadata` into the same
  internal shape.
- Adapter mocks and future real adapters must exercise these normalizers before
  they call `ExternalChannel.handleInboundMessage`.

`replayExternalAdapterFixtures` is the supported `offline replay` harness for
adapter contract tests. It replays fixed WeChat and Feishu fixtures through the
same normalizers and caller-supplied channel dispatch function. It must not open
network listeners, call provider APIs, mint access tokens, or bypass
`ExternalIngressGuard`.

The fixed ingress order is:

1. Channel identity must match the configured adapter channel.
2. `signature check must run before deduplication`.
3. Accepted messages receive a `channel-scoped idempotencyKey`.
4. Duplicate messages are rejected as `duplicate`.
5. Over-quota messages are rejected as `rate_limited`.
6. Bad signatures are rejected as `invalid_signature`.

Rejected external messages must not enter TAOR, tool execution, permission
approval, memory write, Phoenix recommendation, or skill lookup flows. A failed
signature check must also not poison the deduplication cache, so a later valid
retry for the same provider message id can still be accepted.

`ExternalChannel.getStats()` must expose `ingressRejections` by reason so
long-running services can see invalid signatures, duplicates, and rate-limit
pressure without inspecting provider logs.

Rejected ingress must also emit an `ExternalIngressAuditEvent` with event type
`external_ingress_rejected`. The audit event records provider, channel, reason,
message id, channel-scoped idempotency key, external user id, and timestamp.
`recentIngressAudits` exposes the newest bounded set through channel stats.
Ingress audit records `must not include message content`; rejected user text,
attachments, and provider payload bodies remain outside the audit event.

Deployments can persist rejected ingress audit records by setting
`ingressAuditLogPath`. The file format is append-only `JSONL`, one
`ExternalIngressAuditEvent` per line. `ingressAuditMaxBytes` enables simple
single-file rotation to `<path>.1` before the next audit line is appended. The
same privacy boundary applies to persisted audit files: they must not include
message content.

`FusionWorkspace.getHealthReport()` exposes an `external_ingress` check for
long-running services. It aggregates guarded external channel stats, including
`totalRejected`, per-channel `ingressRejections`, recent audit metadata, and
`auditPersistence` configuration. The check is `disabled` when no guarded
external channels are registered, `ok` when guarded channels have no rejections,
and `degraded` when any external ingress rejection has been observed.

Before connecting real provider traffic, adapters must pass production readiness
validation. `validateExternalAdapterConfig` returns either `ok`, `degraded`, or
`unavailable` diagnostics for ingress guard, signature secret, rate limit, and
audit persistence settings. `assertExternalAdapterConfigReady` is the fail-fast
entry point. When `requireProductionReady` is enabled on WeChat or Feishu
adapters, `start()` must call the fail-fast validator before opening listeners,
refreshing provider tokens, or making external network calls. A
`production-ready` adapter has signature verification enabled, a non-empty
secret, positive rate-limit settings, and an ingress audit log path.

`AdapterFactory.validateDefinitions` is the non-strict diagnostics entry point
for config files that contain multiple adapters. It must preserve adapter type
and instance id while reporting readiness status, warnings, and errors without
starting network listeners. `AdapterFactory.registerAll` must run
`assertExternalAdapterConfigReady` for any adapter with `requireProductionReady`
before adapter registration, before `Gateway.addChannel`, and before adapter
`start()`. An unsafe production adapter must fail the batch without leaving a
partially registered external channel behind.

For long-running services, `adapter start failures must not be swallowed`.
`AdapterFactory.registerAll` must surface listener, token bootstrap, port, or
provider initialization failures to the caller instead of logging and
continuing as if the channel were healthy. When start fails, the `failed adapter must be removed from the gateway registry`
so runtime health and routing do not retain a dead channel. For multi-adapter
startup, `batch failure removes all adapters registered by the batch`; a later
adapter failure must roll back earlier adapters started by the same registration
call instead of leaving a partially online external surface.

The core gateway has the same startup boundary. `Gateway.start must fail fast`
when any registered channel cannot start. `Gateway.start is idempotent when already running`
so supervisors and retry loops can call startup safely without duplicating
channel listeners. `Gateway.start is single-flight while startup is in progress`
so concurrent startup calls share the same startup attempt instead of racing
channel listener creation. `Gateway.start waits for in-progress shutdown before restarting`
so a restart request arriving during shutdown is not lost as an already-running
no-op. A `gateway startup failure rolls back started channels` by stopping
channels already started in that call and leaving the gateway in a not-running
state instead of reporting successful startup with a degraded channel set.
If rollback cleanup also fails, the `rollback cleanup failure is counted` and
reported through `lastCleanupError` while `lastError` continues to preserve the
original startup failure.
`Gateway.getStats exposes running` so supervisors can distinguish
not-started, failed-start, and running states without private fields. The
`health report must expose gateway stats` on the `gateway` check metadata,
including running state, error count, and last error when present. The `gateway health degrades when errors are present`
so workspace-level health cannot report `ok` after the gateway has recorded
channel startup, shutdown, or runtime errors. When rollback cleanup fails,
`gateway health prioritizes cleanup error detail` so `lastCleanupError` is
visible in health metadata and reflected by a cleanup-specific degraded detail.
The `gateway health degrades when workspace is running but gateway is stopped`
so an unexpectedly stopped gateway cannot be hidden by otherwise healthy
subsystems. On startup failure, `lastError must preserve the failing channel`
using the same stable channel-scoped error text returned to the caller.

Shutdown must prefer cleanup completion over early abort. `Gateway.stop must continue stopping later channels`
when one channel fails to stop, then expose `running: false`, increment the
gateway error count, and `lastError must preserve the failing stop channel` so
supervisors can distinguish a clean stop from a stop with cleanup errors.
`Gateway.stop is idempotent when already stopped` so duplicate shutdown hooks
or supervisor retries do not close the same channel twice. `Gateway.stop is single-flight while shutdown is in progress`
so concurrent shutdown calls share one cleanup attempt instead of racing
channel teardown. `Gateway.stop waits for in-progress startup before shutting down`
so a stop request arriving during startup is not lost as an already-stopped
no-op. `Gateway.stop does not propagate failed in-progress startup` so
shutdown remains a stable cleanup path while the original startup caller still
receives the startup failure and `lastError`.

`FusionWorkspace.getHealthReport()` exposes `external_adapter_readiness` for
configured `externalAdapters`. The check must run
`strict validation for required adapters` when `requireProductionReady` is enabled, and non-strict
diagnostics for adapters that are present but not yet required for production.
The check reports adapter type, instance id, required flag, readiness status,
warnings, and errors before any external provider traffic is connected.

Deployments can load adapter definitions from `externalAdapterConfigPath`. The
loaded definitions are appended to explicit `externalAdapters` and become
visible through the same `external_adapter_readiness` check. If
`externalAdapterAutoRegister` is enabled, initialization must follow the chain
`configuration file -> readiness health -> fail-fast registration`: load the
configuration file, expose readiness diagnostics, and call
`AdapterFactory.registerAll` so unsafe production adapters fail before partial
registration or provider traffic.

The CLI exposes the same path through `--external-adapter-config` and the same
registration switch through `--external-adapter-auto-register`. Auto-register
must remain opt-in so operators can run readiness diagnostics against a config
file before opening listeners or attaching provider traffic.

Production deployment templates are fixed in code and in a checked-in fixture.
`createWeChatProductionAdapterTemplate` and
`createFeishuProductionAdapterTemplate` return the baseline WeChat and Feishu
adapter configs. `config/external-adapters.production.template.json` mirrors
those defaults for operator handoff. These templates must keep
`requireProductionReady` enabled, use `${WECHAT_INGRESS_SECRET}` and
`${FEISHU_INGRESS_SECRET}` placeholders for guard secrets, use provider app
secret placeholders instead of real credentials, and validate through
`validateExternalAdapterConfig` in strict mode before real traffic is attached.
Real provider secrets must be supplied by deployment environment or secret
manager only; they must not be committed into code, docs, fixtures, tests, or
audit files.

`PermissionPolicyEngine` is the internal channel and identity policy layer.
Deployments can load a controlled JSON fixture through
`permissionPolicyFixturePath`. The only supported fixture schema is
`permission-policy-fixture-0.1.0`; unsupported schemas must fail during loading
instead of silently falling back to permissive defaults. Runtime status must
expose policy engine stats and whether a fixture was loaded.

`reloadPermissionPolicyFixture` is the only supported runtime policy reload
entry point. A valid fixture is applied atomically to both the workspace policy
engine and the `ToolRegistry`; an invalid fixture must return a failure result
and keep the last good policy active.

No external adapter may:

- approve permissions on behalf of Phoenix;
- run a tool because Phoenix recommended a path;
- activate antibody rules automatically;
- write or delete memory outside MemoryWritePolicy;
- hide original errors from runtime audit;
- bypass replay/audit validation.

## Next Stable Modules

Before external channel connection becomes the primary workstream, the next
internal modules should remain focused on service durability:

- persisted runtime audit snapshots with rotation;
- explicit permission policy fixtures per channel identity;
- memory compaction and restore tests;
- antibody review workflow instead of automatic activation;
- operational health checks for long-running workers.
