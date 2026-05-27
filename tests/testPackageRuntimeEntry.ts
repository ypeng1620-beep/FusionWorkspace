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

section('Package Runtime Entry Tests')

async function testPackageScriptsStartRuntimeEntry(): Promise<void> {
  console.log('\n1. package runtime scripts...')
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }

  assert(pkg.scripts?.start === 'tsx src/start.ts', 'npm start runs the FusionWorkspace runtime entry')
  assert(pkg.scripts?.dev === 'tsx watch src/start.ts', 'npm run dev watches the FusionWorkspace runtime entry')
  assert(pkg.scripts?.check === 'tsx src/start.ts --mode agent --memory-backend json --check', 'npm run check performs a runtime startup health check')
  assert(pkg.scripts?.serve === 'tsx src/start.ts --config config/runtime.production.template.json', 'npm run serve starts from runtime config file')
  assert(pkg.scripts?.['check:config'] === 'tsx src/start.ts --config config/runtime.production.template.json --validate-config', 'npm run check:config validates runtime config without starting')
  assert(pkg.scripts?.['check:serve'] === 'tsx scripts/checkRuntimeServer.ts', 'npm run check:serve validates server probes with production config')
  assert(pkg.scripts?.['check:supervisor'] === 'tsx scripts/checkSupervisorTemplate.ts', 'npm run check:supervisor validates supervisor template')
  assert(pkg.scripts?.['check:production'] === 'tsx scripts/checkProductionReadiness.ts', 'npm run check:production runs production readiness gate')
  assert(existsSync(join(process.cwd(), 'config', 'runtime.production.template.json')), 'runtime production template config exists')
  assert(pkg.scripts?.build === 'tsc', 'npm run build remains the TypeScript health check')
}

async function testLibraryIndexHasNoImportSideEffects(): Promise<void> {
  console.log('\n2. library index side effects...')
  const index = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')

  assert(!index.includes('console.log(`FusionWorkspace'), 'library index does not log during import')
  assert(index.includes("export { FusionWorkspace, start } from './start.js'"), 'library index still exports runtime APIs')
}

async function testReadmeDocumentsRuntimeCommands(): Promise<void> {
  console.log('\n3. README runtime commands...')
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')

  assert(readme.includes('npm run check'), 'README documents startup health check')
  assert(readme.includes('npm run check:config'), 'README documents runtime config validation')
  assert(readme.includes('npm run check:serve'), 'README documents runtime server probe validation')
  assert(readme.includes('npm run check:supervisor'), 'README documents supervisor template validation')
  assert(readme.includes('npm run check:production'), 'README documents production readiness validation')
  assert(readme.includes('npm run serve'), 'README documents production template server startup')
  assert(readme.includes('docs/OPERATIONS.md'), 'README links production operations runbook')
  assert(readme.includes('config/supervisor.production.template.json'), 'README documents supervisor production template')
  assert(readme.includes('config/runtime.production.template.json'), 'README documents runtime production template config')
  assert(readme.includes('npm start -- --mode server --memory-backend json'), 'README documents long-running server startup')
  assert(readme.includes('--memory-backend sqlite'), 'README documents strict sqlite backend mode')
  assert(readme.includes('http://localhost:8080/api/health'), 'README documents HTTP health endpoint')
  assert(readme.includes('http://localhost:8080/api/live'), 'README documents HTTP live endpoint')
  assert(readme.includes('http://localhost:8080/api/ready'), 'README documents HTTP ready endpoint')
}

async function main(): Promise<void> {
  console.log('\nPackage Runtime Entry Test Suite')
  console.log('='.repeat(60))

  try {
    await testPackageScriptsStartRuntimeEntry()
    await testLibraryIndexHasNoImportSideEffects()
    await testReadmeDocumentsRuntimeCommands()
    console.log('\n' + '='.repeat(60))
    console.log('All Package Runtime Entry tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
