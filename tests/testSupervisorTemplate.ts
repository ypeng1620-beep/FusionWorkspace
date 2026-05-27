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

section('Supervisor Template Tests')

async function testSupervisorTemplatePinsLongRunningServiceContract(): Promise<void> {
  console.log('\n1. supervisor production template...')
  const templatePath = join(process.cwd(), 'config', 'supervisor.production.template.json')

  assert(existsSync(templatePath), 'supervisor production template exists')

  const template = JSON.parse(readFileSync(templatePath, 'utf8')) as {
    schemaVersion?: string
    service?: {
      name?: string
      startCommand?: string
      preStartChecks?: string[]
      stopSignal?: string
      gracefulShutdownMs?: number
      restart?: {
        policy?: string
        maxRestarts?: number
        backoffMs?: number
      }
      probes?: {
        live?: { url?: string }
        ready?: { url?: string }
        health?: { url?: string }
      }
      environment?: Record<string, string | boolean | number>
      externalAdapters?: {
        autoRegister?: boolean
        attachProviderTraffic?: boolean
      }
    }
  }

  assert(template.schemaVersion === 'fusion-supervisor-template-0.1.0', 'supervisor template pins schema version')
  assert(template.service?.name === 'fusion-workspace', 'supervisor template names service')
  assert(template.service?.startCommand === 'npm run serve', 'supervisor template uses production serve command')
  assert(template.service?.preStartChecks?.includes('npm run check:production') === true, 'supervisor template runs production readiness gate before start')
  assert(template.service?.stopSignal === 'SIGTERM', 'supervisor template uses SIGTERM for shutdown')
  assert(template.service?.gracefulShutdownMs === 30000, 'supervisor template pins graceful shutdown window')
  assert(template.service?.restart?.policy === 'on-failure', 'supervisor template restarts only on failure')
  assert(template.service?.restart?.maxRestarts === 5, 'supervisor template caps restart attempts')
  assert(template.service?.restart?.backoffMs === 5000, 'supervisor template pins restart backoff')
  assert(template.service?.probes?.live?.url === 'http://localhost:8080/api/live', 'supervisor template pins live probe')
  assert(template.service?.probes?.ready?.url === 'http://localhost:8080/api/ready', 'supervisor template pins ready probe')
  assert(template.service?.probes?.health?.url === 'http://localhost:8080/api/health', 'supervisor template pins health probe')
  assert(template.service?.environment?.NODE_ENV === 'production', 'supervisor template pins NODE_ENV production')
  assert(template.service?.externalAdapters?.autoRegister === false, 'supervisor template keeps external adapter auto-register off')
  assert(template.service?.externalAdapters?.attachProviderTraffic === false, 'supervisor template keeps provider traffic detached')
}

async function main(): Promise<void> {
  console.log('\nSupervisor Template Test Suite')
  console.log('='.repeat(60))

  try {
    await testSupervisorTemplatePinsLongRunningServiceContract()
    console.log('\n' + '='.repeat(60))
    console.log('All Supervisor Template tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
