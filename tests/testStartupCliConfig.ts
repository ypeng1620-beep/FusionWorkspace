import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildFusionWorkspaceConfigFromCliArgs } from '../src/start.js'

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

function assertThrows(fn: () => void, expectedMessage: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error)
    assert(actual.includes(expectedMessage), message)
    return
  }
  throw new Error(`ASSERTION FAILED: ${message}`)
}

section('Startup CLI Config Tests')

async function testExternalAdapterCliFlagsMapToWorkspaceConfig(): Promise<void> {
  console.log('\n1. external adapter CLI flags...')
  const config = buildFusionWorkspaceConfigFromCliArgs({
    mode: 'agent',
    cwd: 'D:/runtime',
    'external-adapter-config': 'D:/runtime/external-adapters.json',
    'external-adapter-auto-register': true,
  })

  assert(config.mode === 'agent', 'CLI config preserves startup mode')
  assert(config.cwd === 'D:/runtime', 'CLI config preserves cwd')
  assert(config.externalAdapterConfigPath === 'D:/runtime/external-adapters.json', 'CLI config maps external adapter config path')
  assert(config.externalAdapterAutoRegister === true, 'CLI config maps external adapter auto-register flag')
}

async function testExternalAdapterAutoRegisterDefaultsOff(): Promise<void> {
  console.log('\n2. external adapter auto-register default...')
  const config = buildFusionWorkspaceConfigFromCliArgs({
    mode: 'agent',
    'external-adapter-config': 'D:/runtime/external-adapters.json',
  })

  assert(config.externalAdapterConfigPath === 'D:/runtime/external-adapters.json', 'CLI config can load adapter path without auto-register')
  assert(config.externalAdapterAutoRegister === false, 'external adapter auto-register defaults off')
}

async function testCliHealthCheckModeMapsToWorkspaceConfig(): Promise<void> {
  console.log('\n3. startup health check CLI flag...')
  const config = buildFusionWorkspaceConfigFromCliArgs({
    mode: 'agent',
    check: true,
  } as Record<string, unknown>)

  assert(config.mode === 'agent', 'CLI health check preserves agent startup mode')
  assert(config.startupHealthCheckOnly === true, 'CLI health check exits after runtime health report')
}

async function testCliMemoryBackendJsonMode(): Promise<void> {
  console.log('\n4. startup memory backend CLI flag...')
  const config = buildFusionWorkspaceConfigFromCliArgs({
    mode: 'agent',
    'memory-backend': 'json',
  } as Record<string, unknown>)

  assert(config.memoryRequiredBackend === 'json', 'CLI memory backend json requires json backend')
  assert(config.memoryForceFallback === true, 'CLI memory backend json intentionally enables json fallback')
}

async function testCliLoadsRuntimeConfigFile(): Promise<void> {
  console.log('\n5. runtime config file loading...')
  const dir = mkdtempSync(join(tmpdir(), 'fusion-runtime-config-'))
  const configPath = join(dir, 'runtime.json')

  try {
    writeFileSync(configPath, JSON.stringify({
      mode: 'server',
      port: 18080,
      memoryBackend: 'json',
      permissionMode: 'restricted',
      phoenixSnapshotOnStop: true,
      phoenixRestoreLatestSnapshot: true,
      externalAdapterConfigPath: 'config/external-adapters.production.template.json',
      externalAdapterAutoRegister: false,
    }))

    const config = buildFusionWorkspaceConfigFromCliArgs({
      config: configPath,
    } as Record<string, unknown>)

    assert(config.mode === 'server', 'runtime config file sets startup mode')
    assert(config.port === 18080, 'runtime config file sets port')
    assert(config.memoryRequiredBackend === 'json', 'runtime config file maps memoryBackend json')
    assert(config.memoryForceFallback === true, 'runtime config file enables json memory fallback')
    assert(config.permissionMode === 'restricted', 'runtime config file sets permission mode')
    assert(config.phoenixSnapshotOnStop === true, 'runtime config file enables stop snapshots')
    assert(config.phoenixRestoreLatestSnapshot === true, 'runtime config file enables latest snapshot restore')
    assert(config.externalAdapterConfigPath === 'config/external-adapters.production.template.json', 'runtime config file sets adapter config path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testCliFlagsOverrideRuntimeConfigFile(): Promise<void> {
  console.log('\n6. runtime config CLI override precedence...')
  const dir = mkdtempSync(join(tmpdir(), 'fusion-runtime-config-'))
  const configPath = join(dir, 'runtime.json')

  try {
    writeFileSync(configPath, JSON.stringify({
      mode: 'server',
      port: 18080,
      memoryBackend: 'json',
      permissionMode: 'restricted',
    }))

    const config = buildFusionWorkspaceConfigFromCliArgs({
      config: configPath,
      mode: 'agent',
      port: 19090,
      permission: 'bypass',
      'memory-backend': 'sqlite',
    } as Record<string, unknown>)

    assert(config.mode === 'agent', 'CLI mode overrides runtime config file')
    assert(config.port === 19090, 'CLI port overrides runtime config file')
    assert(config.permissionMode === 'bypass', 'CLI permission overrides runtime config file')
    assert(config.memoryRequiredBackend === 'sqlite', 'CLI memory backend overrides runtime config file')
    assert(config.memoryForceFallback === false, 'CLI sqlite backend disables json fallback from config file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testRuntimeConfigRejectsInvalidMode(): Promise<void> {
  console.log('\n7. runtime config invalid mode...')
  const dir = mkdtempSync(join(tmpdir(), 'fusion-runtime-config-'))
  const configPath = join(dir, 'runtime.json')

  try {
    writeFileSync(configPath, JSON.stringify({
      mode: 'daemon',
      memoryBackend: 'json',
    }))

    assertThrows(
      () => buildFusionWorkspaceConfigFromCliArgs({ config: configPath } as Record<string, unknown>),
      'Invalid runtime config mode',
      'runtime config rejects invalid mode',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testRuntimeConfigRejectsInvalidMemoryBackend(): Promise<void> {
  console.log('\n8. runtime config invalid memory backend...')
  const dir = mkdtempSync(join(tmpdir(), 'fusion-runtime-config-'))
  const configPath = join(dir, 'runtime.json')

  try {
    writeFileSync(configPath, JSON.stringify({
      mode: 'server',
      memoryBackend: 'ephemeral',
    }))

    assertThrows(
      () => buildFusionWorkspaceConfigFromCliArgs({ config: configPath } as Record<string, unknown>),
      'Invalid runtime config memoryBackend',
      'runtime config rejects invalid memory backend',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  console.log('\nStartup CLI Config Test Suite')
  console.log('='.repeat(60))

  try {
    await testExternalAdapterCliFlagsMapToWorkspaceConfig()
    await testExternalAdapterAutoRegisterDefaultsOff()
    await testCliHealthCheckModeMapsToWorkspaceConfig()
    await testCliMemoryBackendJsonMode()
    await testCliLoadsRuntimeConfigFile()
    await testCliFlagsOverrideRuntimeConfigFile()
    await testRuntimeConfigRejectsInvalidMode()
    await testRuntimeConfigRejectsInvalidMemoryBackend()
    console.log('\n' + '='.repeat(60))
    console.log('All Startup CLI Config tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
