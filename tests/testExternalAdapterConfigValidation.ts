import {
  assertExternalAdapterConfigReady,
  validateExternalAdapterConfig,
} from '../src/gateway/externalAdapterConfigValidation.js'
import type { ExternalChannelConfig } from '../src/gateway/externalChannel.js'
import { WeChatChannel } from '../src/gateway/wechatChannel.js'

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

section('External Adapter Config Validation Tests')

async function testStrictModeFailsFastForUnsafeRealAdapterConfig(): Promise<void> {
  console.log('\n1. strict mode fail-fast...')
  const config: ExternalChannelConfig = {
    type: 'wechat',
  }

  const result = validateExternalAdapterConfig(config, { strict: true })

  assert(result.status === 'unavailable', 'strict validation marks unsafe config unavailable')
  assert(result.errors.includes('ingressGuard is required'), 'missing ingressGuard is an error')
  assert(result.errors.includes('ingressGuard.requireSignature must be true'), 'missing signature requirement is an error')
  assert(result.errors.includes('ingressGuard.secret is required'), 'missing signature secret is an error')
  assert(result.errors.includes('ingressGuard.rateLimit is required'), 'missing rate limit is an error')
  assert(result.errors.includes('ingressAuditLogPath is required'), 'missing audit path is an error')

  let failed = false
  try {
    assertExternalAdapterConfigReady(config, { strict: true })
  } catch (error) {
    failed = true
    assert((error as Error).message.includes('External adapter config is not production-ready'), 'fail-fast error is explicit')
  }
  assert(failed, 'strict validation throws before real adapter start')
}

async function testNonStrictModeReturnsDegradedDiagnostics(): Promise<void> {
  console.log('\n2. non-strict diagnostics...')
  const config: ExternalChannelConfig = {
    type: 'feishu',
    ingressGuard: {
      requireSignature: false,
      secret: '',
      rateLimit: {
        maxMessages: 0,
        windowMs: 0,
      },
    },
  }

  const result = validateExternalAdapterConfig(config, { strict: false })

  assert(result.status === 'degraded', 'non-strict validation returns degraded diagnostics')
  assert(result.errors.length === 0, 'non-strict validation does not convert issues to errors')
  assert(result.warnings.includes('ingressGuard.requireSignature should be true'), 'non-strict warns about signature requirement')
  assert(result.warnings.includes('ingressGuard.secret should be set'), 'non-strict warns about missing secret')
  assert(result.warnings.includes('ingressGuard.rateLimit.maxMessages should be > 0'), 'non-strict warns about invalid max messages')
  assert(result.warnings.includes('ingressGuard.rateLimit.windowMs should be > 0'), 'non-strict warns about invalid window')
  assert(result.warnings.includes('ingressAuditLogPath should be set'), 'non-strict warns about missing audit path')
}

async function testProductionReadyConfigPasses(): Promise<void> {
  console.log('\n3. production-ready config...')
  const config: ExternalChannelConfig = {
    type: 'wechat',
    ingressGuard: {
      requireSignature: true,
      secret: 'secret-1',
      rateLimit: {
        maxMessages: 60,
        windowMs: 60_000,
      },
    },
    ingressAuditLogPath: '.fusion-runtime/external-ingress/wechat.jsonl',
    ingressAuditMaxBytes: 1024 * 1024,
  }

  const result = validateExternalAdapterConfig(config, { strict: true })

  assert(result.status === 'ok', 'production-ready config validates ok')
  assert(result.errors.length === 0, 'production-ready config has no errors')
  assert(result.warnings.length === 0, 'production-ready config has no warnings')
  assertExternalAdapterConfigReady(config, { strict: true })
  assert(true, 'production-ready config does not throw')
}

async function testRealAdapterStartFailsFastWhenProductionReadyRequired(): Promise<void> {
  console.log('\n4. real adapter start fail-fast...')
  const channel = new WeChatChannel({
    type: 'wechat',
    requireProductionReady: true,
    adapterOptions: {
      appId: 'app-1',
      appSecret: 'app-secret-1',
      token: 'token-1',
      port: 0,
    },
  })

  let failed = false
  try {
    await channel.start()
  } catch (error) {
    failed = true
    assert((error as Error).message.includes('External adapter config is not production-ready'), 'real adapter start reports production readiness failure')
  }

  assert(failed, 'real adapter start fails before external network setup')
}

async function main(): Promise<void> {
  console.log('\nExternal Adapter Config Validation Test Suite')
  console.log('='.repeat(60))

  try {
    await testStrictModeFailsFastForUnsafeRealAdapterConfig()
    await testNonStrictModeReturnsDegradedDiagnostics()
    await testProductionReadyConfigPasses()
    await testRealAdapterStartFailsFastWhenProductionReadyRequired()
    console.log('\n' + '='.repeat(60))
    console.log('All External Adapter Config Validation tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
