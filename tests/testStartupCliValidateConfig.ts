import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

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

section('Startup CLI Validate Config Tests')

function runValidateConfig(configPath: string) {
  const command = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', `npx tsx src/start.ts --config ${configPath} --validate-config`]]
    : ['npx', ['tsx', 'src/start.ts', '--config', configPath, '--validate-config']]

  return spawnSync(command[0] as string, command[1] as string[], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

async function testValidateConfigPrintsNormalizedConfigWithoutStartingRuntime(): Promise<void> {
  console.log('\n1. validate config command...')
  const dir = mkdtempSync(join(tmpdir(), 'fusion-runtime-config-'))
  const configPath = join(dir, 'runtime.json')

  try {
    writeFileSync(configPath, JSON.stringify({
      mode: 'server',
      port: 18082,
      memoryBackend: 'json',
      permissionMode: 'restricted',
      phoenixSnapshotOnStop: true,
    }))

    const result = runValidateConfig(configPath)

    assert(result.status === 0, 'validate config exits successfully')
    assert(!result.stdout.includes('[FusionWorkspace] Initializing'), 'validate config does not start runtime')

    const parsed = JSON.parse(result.stdout) as {
      valid?: boolean
      config?: {
        mode?: string
        port?: number
        memoryRequiredBackend?: string
        memoryForceFallback?: boolean
        permissionMode?: string
        phoenixSnapshotOnStop?: boolean
      }
    }

    assert(parsed.valid === true, 'validate config reports valid true')
    assert(parsed.config?.mode === 'server', 'validate config preserves mode')
    assert(parsed.config?.port === 18082, 'validate config preserves port')
    assert(parsed.config?.memoryRequiredBackend === 'json', 'validate config normalizes memory backend')
    assert(parsed.config?.memoryForceFallback === true, 'validate config normalizes json fallback')
    assert(parsed.config?.permissionMode === 'restricted', 'validate config preserves permission mode')
    assert(parsed.config?.phoenixSnapshotOnStop === true, 'validate config preserves stop snapshot setting')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testValidateConfigReturnsNonZeroForInvalidConfig(): Promise<void> {
  console.log('\n2. invalid config exit code...')
  const dir = mkdtempSync(join(tmpdir(), 'fusion-runtime-config-'))
  const configPath = join(dir, 'runtime.json')

  try {
    writeFileSync(configPath, JSON.stringify({
      mode: 'daemon',
      memoryBackend: 'json',
    }))

    const result = runValidateConfig(configPath)

    assert(result.status !== 0, 'validate config returns non-zero exit code for invalid config')
    assert(result.stderr.includes('Invalid runtime config mode'), 'validate config reports invalid mode on stderr')
    assert(!result.stdout.includes('"valid": true'), 'invalid config does not report valid true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  console.log('\nStartup CLI Validate Config Test Suite')
  console.log('='.repeat(60))

  try {
    await testValidateConfigPrintsNormalizedConfigWithoutStartingRuntime()
    await testValidateConfigReturnsNonZeroForInvalidConfig()
    console.log('\n' + '='.repeat(60))
    console.log('All Startup CLI Validate Config tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
