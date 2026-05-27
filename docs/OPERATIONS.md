# FusionWorkspace Production Runbook

This runbook is the operator path for running FusionWorkspace as a long-running
internal agent service. Keep external provider traffic disconnected until the
internal runtime checks are green.

## Production Config

The checked-in production baseline is:

```text
config/runtime.production.template.json
config/supervisor.production.template.json
```

`config/supervisor.production.template.json` is the machine-readable service
manager handoff. It pins `npm run check:production` as the pre-start gate,
`npm run serve` as the start command, `SIGTERM` as the shutdown signal, and
live/ready/health probes for process managers.

The baseline intentionally keeps:

```text
externalAdapterAutoRegister: false
```

Do not connect WeChat or Feishu provider traffic until `npm run check:config`,
`npm run check:serve`, and `npm run check` pass with the intended production
configuration.

No real secrets belong in committed config, docs, fixtures, tests, audit files,
or logs. Use environment variables or a deployment secret manager for provider
credentials.

## Pre-Start Checks

Run the full local gate before attaching traffic:

```powershell
npm run build
npm test
npm run check:config
npm run check:serve
npm run check:supervisor
npm run check:production
npm run check
```

`npm run check:config` validates and prints the normalized runtime config
without starting listeners. A config error must return a Non-zero exit code.

`npm run check:serve` starts the production-template server on a temporary port,
checks liveness and readiness, then stops the runtime. Override the temporary
port when needed:

```powershell
$env:FUSION_RUNTIME_CHECK_PORT = "19182"
npm run check:serve
```

`npm run check:supervisor` validates
`config/supervisor.production.template.json` before handoff to a service
manager.

`npm run check:production` is the single production-readiness gate for
automation. It validates config, starts the server, verifies live/ready probes,
prints machine-readable JSON, and stops the runtime.

## Start

Start the production-template server:

```powershell
npm run serve
```

The default HTTP/WebSocket port is `8080`.

## Probes

Use these endpoints for process managers, reverse proxies, and manual checks:

```text
http://localhost:8080/api/live
http://localhost:8080/api/ready
http://localhost:8080/api/health
```

`/api/live` means the HTTP/WebSocket process is alive. `/api/ready` and
`/api/health` mean the internal runtime readiness report is available.

## Stop

For local foreground operation, use:

```text
CTRL+C
```

For service managers, send `SIGTERM` and allow the runtime to call
`FusionWorkspace.stop()` so gateway channels, memory resources, and Phoenix
stop snapshots can close cleanly.

## Failure Triage

If startup exits with a Non-zero exit code, treat the deployment as failed and
inspect stderr first.

If Readiness degraded appears in `/api/ready` or `/api/health`, do not attach
external traffic. Inspect the named check in the health report before retrying.

If SQLite required but unavailable appears, either install the native SQLite
binding for the target Node.js runtime or use the explicit JSON backend for the
deployment profile.

If an external adapter readiness check is unavailable, keep WeChat and Feishu
traffic disconnected. Required adapters must be production-ready before
`externalAdapterAutoRegister` is enabled.
