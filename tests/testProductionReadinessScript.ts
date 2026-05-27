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

section('Production Readiness Script Tests')

async function testProductionReadinessScriptRunsConfigAndServerChecks(): Promise<void> {
  console.log('\n1. production readiness script...')
  const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx tsx scripts/checkProductionReadiness.ts']
    : ['tsx', 'scripts/checkProductionReadiness.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      FUSION_RUNTIME_CHECK_PORT: '19183',
    },
  })

  assert(result.status === 0, 'production readiness script exits successfully')

  const parsed = JSON.parse(result.stdout) as {
    status?: string
    checks?: {
      config?: string
      supervisor?: string
      server?: string
    }
    port?: number
  }

  assert(parsed.status === 'ok', 'production readiness script reports ok')
  assert(parsed.checks?.config === 'ok', 'production readiness script verifies config check')
  assert(parsed.checks?.supervisor === 'ok', 'production readiness script verifies supervisor template check')
  assert(parsed.checks?.server === 'ok', 'production readiness script verifies server check')
  assert(parsed.port === 19183, 'production readiness script reports check port')
}

async function main(): Promise<void> {
  console.log('\nProduction Readiness Script Test Suite')
  console.log('='.repeat(60))

  try {
    await testProductionReadinessScriptRunsConfigAndServerChecks()
    console.log('\n' + '='.repeat(60))
    console.log('All Production Readiness Script tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
