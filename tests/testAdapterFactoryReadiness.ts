import { AdapterFactory, type AdapterDefinition } from '../src/gateway/adapterFactory.js'
import { Gateway } from '../src/gateway/gateway.js'

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

section('Adapter Factory Readiness Tests')

async function testRegisterAllFailsFastBeforeRegisteringUnsafeProductionAdapter(): Promise<void> {
  console.log('\n1. registerAll fail-fast...')
  const gateway = new Gateway()
  const definitions: AdapterDefinition[] = [
    {
      type: 'wechat',
      instanceId: 'wechat-prod',
      requireProductionReady: true,
      adapterOptions: {
        appId: 'app-1',
        appSecret: 'app-secret-1',
        token: 'token-1',
        port: 0,
      },
    } as AdapterDefinition,
  ]

  let failed = false
  try {
    await AdapterFactory.registerAll(gateway, definitions)
  } catch (error) {
    failed = true
    assert((error as Error).message.includes('External adapter config is not production-ready'), 'registerAll reports production readiness failure')
  }

  assert(failed, 'registerAll throws for unsafe production adapter')
  assert(Object.keys(gateway.getChannelStats()).length === 0, 'unsafe adapter is not registered before validation passes')
}

async function testReadinessDiagnosticsExposeUnsafeNonStrictAdapters(): Promise<void> {
  console.log('\n2. readiness diagnostics...')
  const definitions: AdapterDefinition[] = [
    {
      type: 'feishu',
      instanceId: 'feishu-diagnostics',
      ingressGuard: {
        requireSignature: false,
        secret: '',
        rateLimit: {
          maxMessages: 0,
          windowMs: 0,
        },
      },
    } as AdapterDefinition,
  ]

  const results = AdapterFactory.validateDefinitions(definitions)

  assert(results.length === 1, 'readiness diagnostics include each adapter definition')
  assert(results[0].instanceId === 'feishu-diagnostics', 'readiness diagnostics preserve instance id')
  assert(results[0].type === 'feishu', 'readiness diagnostics preserve adapter type')
  assert(results[0].validation.status === 'degraded', 'non-strict diagnostics mark unsafe adapter degraded')
  assert(results[0].validation.warnings.includes('ingressGuard.requireSignature should be true'), 'diagnostics include signature warning')
  assert(results[0].validation.warnings.includes('ingressAuditLogPath should be set'), 'diagnostics include audit persistence warning')
}

async function testRegisterAllPropagatesAdapterStartFailures(): Promise<void> {
  console.log('\n3. registerAll start failure...')
  const gateway = new Gateway()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ code: 0, msg: 'mocked token failure' }),
  })) as typeof fetch

  const definitions: AdapterDefinition[] = [
    {
      type: 'feishu',
      instanceId: 'feishu-bad-port',
      adapterOptions: {
        appId: 'app-1',
        appSecret: 'app-secret-1',
        port: -1,
      },
    } as AdapterDefinition,
  ]

  let failed = false
  try {
    await AdapterFactory.registerAll(gateway, definitions)
  } catch (error) {
    failed = true
    assert((error as Error).message.includes('Failed to start adapter feishu-bad-port'), 'registerAll reports adapter start failure')
  } finally {
    globalThis.fetch = originalFetch
    await gateway.stop()
  }

  assert(failed, 'registerAll throws when adapter start fails')
  assert(Object.keys(gateway.getChannelStats()).length === 0, 'failed adapter start is removed from gateway registry')
}

async function testRegisterAllRollsBackStartedAdaptersWhenBatchFails(): Promise<void> {
  console.log('\n4. registerAll batch rollback...')
  const gateway = new Gateway()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ access_token: 'mock-token', expires_in: 7200 }),
  })) as typeof fetch

  const definitions: AdapterDefinition[] = [
    {
      type: 'wechat',
      instanceId: 'wechat-started-before-failure',
      adapterOptions: {
        appId: 'app-1',
        appSecret: 'app-secret-1',
        token: 'token-1',
        port: 0,
      },
    } as AdapterDefinition,
    {
      type: 'feishu',
      instanceId: 'feishu-bad-port-after-wechat',
      adapterOptions: {
        appId: 'app-2',
        appSecret: 'app-secret-2',
        port: -1,
      },
    } as AdapterDefinition,
  ]

  let failed = false
  try {
    await AdapterFactory.registerAll(gateway, definitions)
  } catch (error) {
    failed = true
    assert((error as Error).message.includes('Failed to start adapter feishu-bad-port-after-wechat'), 'registerAll reports the failing adapter in a batch')
  } finally {
    globalThis.fetch = originalFetch
    await gateway.stop()
  }

  assert(failed, 'registerAll throws when any adapter in the batch fails')
  assert(Object.keys(gateway.getChannelStats()).length === 0, 'batch failure removes all adapters registered by the batch')
}

async function main(): Promise<void> {
  console.log('\nAdapter Factory Readiness Test Suite')
  console.log('='.repeat(60))

  try {
    await testRegisterAllFailsFastBeforeRegisteringUnsafeProductionAdapter()
    await testReadinessDiagnosticsExposeUnsafeNonStrictAdapters()
    await testRegisterAllPropagatesAdapterStartFailures()
    await testRegisterAllRollsBackStartedAdaptersWhenBatchFails()
    console.log('\n' + '='.repeat(60))
    console.log('All Adapter Factory Readiness tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
