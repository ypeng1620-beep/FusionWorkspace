import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
  console.log(`  ok ${message}`)
}

function section(name: string): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('='.repeat(60))
}

section('Phoenix Runtime Documentation Tests')

async function testRuntimeDocumentExistsAndPinsBoundaries() {
  console.log('\n1. Phoenix runtime document...')
  const docPath = join(process.cwd(), 'docs', 'PHOENIX_RUNTIME.md')

  assert(existsSync(docPath), 'Phoenix runtime document exists')

  const doc = readFileSync(docPath, 'utf8')
  const requiredTerms = [
    'advisory_only',
    'PHOENIX_BOUNDARY_CONTRACT_VERSION',
    'canApprovePermission: false',
    'canExecuteTool: false',
    'canExecuteSkill: false',
    'canWriteMemory: false',
    'canDeleteMemory: false',
    'canRetryAutomatically: false',
    'hideOriginalError: false',
    'PhoenixAuditStore.exportReplaySnapshot',
    'PhoenixAuditStore.fromReplaySnapshot',
    'PhoenixAuditSnapshotStore',
    'savePhoenixAuditSnapshot',
    'phoenixSnapshotDir',
    'phoenixRestoreSnapshotId',
    'phoenixRestoreLatestSnapshot',
    'phoenixSnapshotOnStop',
    'phoenixSnapshotOnStopId',
    'FusionWorkspace.start is single-flight while startup is in progress',
    'FusionWorkspace.start waits for in-progress shutdown before restarting',
    'Workspace start failed',
    'workspace.start retries initialize after failed attempt',
    'workspace.start closes initialized memory after failed startup',
    'runtime lifecycle reports start attempts',
    'runtime lifecycle reports failed start attempts',
    'runtime lifecycle reports last successful start timestamp',
    'runtime lifecycle reports last state change timestamp',
    'runtime health metadata reports start attempts',
    'runtime health metadata reports last state change timestamp',
    'runtime health check degrades after workspace start failure',
    'FusionWorkspace.stop is idempotent after stopped',
    'FusionWorkspace.stop is single-flight while shutdown is in progress',
    'FusionWorkspace.stop waits for in-progress startup before shutting down',
    'Memory manager close failed',
    'runtime lifecycle reports completed stop attempts',
    'runtime lifecycle reports last stopped timestamp',
    'runtime lifecycle reports last stop error',
    'runtime lifecycle clears stale stop error after clean stop',
    'npm run check',
    'npm run check:config',
    'npm run check:serve',
    'npm run check:supervisor',
    'npm run check:production',
    'supervisor.production.template.json',
    '--check',
    '--validate-config',
    '/api/live',
    '/api/ready',
    '/api/health',
    '--memory-backend json',
    '--memory-backend sqlite',
    'explicit json memory backend is healthy',
    'PermissionPolicyEngine',
    'permissionPolicyFixturePath',
    'permission-policy-fixture-0.1.0',
    'reloadPermissionPolicyFixture',
    'last good policy',
    'ExternalIngressGuard',
    'normalizeWeChatInbound',
    'normalizeFeishuInbound',
    'replayExternalAdapterFixtures',
    'offline replay',
    'ingressRejections',
    'ExternalIngressAuditEvent',
    'external_ingress_rejected',
    'recentIngressAudits',
    'ingressAuditLogPath',
    'ingressAuditMaxBytes',
    'external_ingress',
    'totalRejected',
    'auditPersistence',
    'validateExternalAdapterConfig',
    'assertExternalAdapterConfigReady',
    'AdapterFactory.validateDefinitions',
    'AdapterFactory.registerAll',
    'Gateway.start must fail fast',
    'Gateway.start is idempotent when already running',
    'Gateway.start is single-flight while startup is in progress',
    'Gateway.start waits for in-progress shutdown before restarting',
    'gateway startup failure rolls back started channels',
    'rollback cleanup failure is counted',
    'lastCleanupError',
    'Gateway.getStats exposes running',
    'health report must expose gateway stats',
    'gateway health degrades when errors are present',
    'gateway health prioritizes cleanup error detail',
    'gateway health degrades when workspace is running but gateway is stopped',
    'lastError must preserve the failing channel',
    'Gateway.stop must continue stopping later channels',
    'Gateway.stop is idempotent when already stopped',
    'Gateway.stop is single-flight while shutdown is in progress',
    'Gateway.stop waits for in-progress startup before shutting down',
    'Gateway.stop does not propagate failed in-progress startup',
    'lastError must preserve the failing stop channel',
    'before adapter registration',
    'adapter start failures must not be swallowed',
    'failed adapter must be removed from the gateway registry',
    'batch failure removes all adapters registered by the batch',
    'external_adapter_readiness',
    'externalAdapters',
    'externalAdapterConfigPath',
    'externalAdapterAutoRegister',
    '--external-adapter-config',
    '--external-adapter-auto-register',
    'configuration file -> readiness health -> fail-fast registration',
    'strict validation for required adapters',
    'createWeChatProductionAdapterTemplate',
    'createFeishuProductionAdapterTemplate',
    'external-adapters.production.template.json',
    '${WECHAT_INGRESS_SECRET}',
    '${FEISHU_INGRESS_SECRET}',
    'requireProductionReady',
    'production-ready',
    'JSONL',
    'must not include message content',
    'provider metadata',
    'signature check must run before deduplication',
    'channel-scoped idempotencyKey',
    'rate_limited',
    'invalid_signature',
    'maxSnapshots',
    'External channels are not allowed to bypass internal permissions',
  ]

  for (const term of requiredTerms) {
    assert(doc.includes(term), `document pins ${term}`)
  }
}

async function main() {
  console.log('\nPhoenix Runtime Documentation Test Suite')
  console.log('='.repeat(60))

  try {
    await testRuntimeDocumentExistsAndPinsBoundaries()
    console.log('\n' + '='.repeat(60))
    console.log('All Phoenix Runtime Documentation tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
