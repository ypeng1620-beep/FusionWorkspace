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

section('Runtime Server Check Script Tests')

async function testServerCheckScriptStartsProbesAndStopsRuntime(): Promise<void> {
  console.log('\n1. server check script...')
  const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx tsx scripts/checkRuntimeServer.ts']
    : ['tsx', 'scripts/checkRuntimeServer.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      FUSION_RUNTIME_CHECK_PORT: '19182',
    },
  })

  assert(result.status === 0, 'server check script exits successfully')

  const parsed = JSON.parse(result.stdout) as {
    status?: string
    port?: number
    probes?: {
      live?: string
      ready?: string
    }
  }

  assert(parsed.status === 'ok', 'server check script reports ok')
  assert(parsed.port === 19182, 'server check script uses configured check port')
  assert(parsed.probes?.live === 'ok', 'server check script verifies live probe')
  assert(parsed.probes?.ready === 'ok', 'server check script verifies ready probe')
}

async function main(): Promise<void> {
  console.log('\nRuntime Server Check Script Test Suite')
  console.log('='.repeat(60))

  try {
    await testServerCheckScriptStartsProbesAndStopsRuntime()
    console.log('\n' + '='.repeat(60))
    console.log('All Runtime Server Check Script tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
