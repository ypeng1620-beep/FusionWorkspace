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

section('Supervisor Template Validation Tests')

async function testSupervisorTemplateValidationCommand(): Promise<void> {
  console.log('\n1. supervisor template validation command...')
  const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx tsx scripts/checkSupervisorTemplate.ts']
    : ['tsx', 'scripts/checkSupervisorTemplate.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })

  assert(result.status === 0, 'supervisor template validation exits successfully')

  const parsed = JSON.parse(result.stdout) as {
    valid?: boolean
    template?: string
    service?: string
    checks?: {
      preStart?: string
      probes?: string
      externalAdapters?: string
    }
  }

  assert(parsed.valid === true, 'supervisor template validation reports valid true')
  assert(parsed.template === 'config/supervisor.production.template.json', 'supervisor template validation reports template path')
  assert(parsed.service === 'fusion-workspace', 'supervisor template validation reports service name')
  assert(parsed.checks?.preStart === 'ok', 'supervisor template validation verifies pre-start checks')
  assert(parsed.checks?.probes === 'ok', 'supervisor template validation verifies probes')
  assert(parsed.checks?.externalAdapters === 'ok', 'supervisor template validation verifies external adapter boundary')
}

async function main(): Promise<void> {
  console.log('\nSupervisor Template Validation Test Suite')
  console.log('='.repeat(60))

  try {
    await testSupervisorTemplateValidationCommand()
    console.log('\n' + '='.repeat(60))
    console.log('All Supervisor Template Validation tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
