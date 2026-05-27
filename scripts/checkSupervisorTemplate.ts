import { readFileSync } from 'fs'

const TEMPLATE_PATH = 'config/supervisor.production.template.json'

type SupervisorTemplate = {
  schemaVersion?: string
  service?: {
    name?: string
    startCommand?: string
    preStartChecks?: string[]
    stopSignal?: string
    probes?: {
      live?: { url?: string }
      ready?: { url?: string }
      health?: { url?: string }
    }
    externalAdapters?: {
      autoRegister?: boolean
      attachProviderTraffic?: boolean
    }
  }
}

function assertTemplate(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

export function validateSupervisorTemplate(): void {
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as SupervisorTemplate
  const service = template.service

  assertTemplate(template.schemaVersion === 'fusion-supervisor-template-0.1.0', 'Invalid supervisor template schemaVersion')
  assertTemplate(service?.name === 'fusion-workspace', 'Invalid supervisor service name')
  assertTemplate(service?.startCommand === 'npm run serve', 'Invalid supervisor start command')
  assertTemplate(service?.preStartChecks?.includes('npm run check:production') === true, 'Supervisor template must run npm run check:production before start')
  assertTemplate(service?.stopSignal === 'SIGTERM', 'Supervisor template must stop with SIGTERM')
  assertTemplate(service?.probes?.live?.url === 'http://localhost:8080/api/live', 'Invalid live probe')
  assertTemplate(service?.probes?.ready?.url === 'http://localhost:8080/api/ready', 'Invalid ready probe')
  assertTemplate(service?.probes?.health?.url === 'http://localhost:8080/api/health', 'Invalid health probe')
  assertTemplate(service?.externalAdapters?.autoRegister === false, 'Supervisor template must keep external adapter auto-register off')
  assertTemplate(service?.externalAdapters?.attachProviderTraffic === false, 'Supervisor template must keep provider traffic detached')
}

function main(): void {
  validateSupervisorTemplate()
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as SupervisorTemplate
  const service = template.service

  console.log(JSON.stringify({
    valid: true,
    template: TEMPLATE_PATH,
    service: service.name,
    checks: {
      preStart: 'ok',
      probes: 'ok',
      externalAdapters: 'ok',
    },
  }, null, 2))
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
