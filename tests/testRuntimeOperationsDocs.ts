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

section('Runtime Operations Documentation Tests')

async function testOperationsRunbookExistsAndPinsProductionFlow(): Promise<void> {
  console.log('\n1. operations runbook...')
  const docPath = join(process.cwd(), 'docs', 'OPERATIONS.md')

  assert(existsSync(docPath), 'operations runbook exists')

  const doc = readFileSync(docPath, 'utf8')
  const requiredTerms = [
    'Production Runbook',
    'config/runtime.production.template.json',
    'config/supervisor.production.template.json',
    'npm run check:config',
    'npm run check:serve',
    'npm run check:supervisor',
    'npm run check:production',
    'npm run serve',
    'http://localhost:8080/api/live',
    'http://localhost:8080/api/ready',
    'http://localhost:8080/api/health',
    'CTRL+C',
    'SIGTERM',
    'FUSION_RUNTIME_CHECK_PORT',
    'externalAdapterAutoRegister: false',
    'Do not connect WeChat or Feishu provider traffic until',
    'No real secrets',
    'Non-zero exit code',
    'Readiness degraded',
    'SQLite required but unavailable',
  ]

  for (const term of requiredTerms) {
    assert(doc.includes(term), `operations runbook pins ${term}`)
  }
}

async function main(): Promise<void> {
  console.log('\nRuntime Operations Documentation Test Suite')
  console.log('='.repeat(60))

  try {
    await testOperationsRunbookExistsAndPinsProductionFlow()
    console.log('\n' + '='.repeat(60))
    console.log('All Runtime Operations Documentation tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
