import { FusionWorkspace } from '../src/start.js'

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

section('Runtime Server Smoke Tests')

async function testServerModeExposesHealthEndpoint(): Promise<void> {
  console.log('\n1. server mode health endpoint...')
  const port = 19180
  const workspace = new FusionWorkspace({
    mode: 'server',
    port,
    enableMemory: true,
    memoryForceFallback: true,
    memoryRequiredBackend: 'json',
  })

  await workspace.start()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    const health = await response.json() as {
      status?: string
      checks?: Array<{ name: string; status: string; metadata?: Record<string, unknown> }>
    }
    const gateway = health.checks?.find(check => check.name === 'gateway')
    const memory = health.checks?.find(check => check.name === 'memory')

    assert(response.status === 200, 'server health endpoint returns HTTP 200')
    assert(health.status === 'ok', 'server health endpoint reports ok')
    assert(gateway?.status === 'ok', 'server health endpoint reports gateway ok')
    assert(gateway?.metadata?.running === true, 'server health endpoint reports running gateway')
    assert(memory?.status === 'ok', 'server health endpoint reports explicit json memory ok')
  } finally {
    await workspace.stop()
  }
}

async function testServerModeExposesLiveAndReadyEndpoints(): Promise<void> {
  console.log('\n2. server mode live and ready endpoints...')
  const port = 19181
  const workspace = new FusionWorkspace({
    mode: 'server',
    port,
    enableMemory: true,
    memoryForceFallback: true,
    memoryRequiredBackend: 'json',
  })

  await workspace.start()
  try {
    const liveResponse = await fetch(`http://127.0.0.1:${port}/api/live`)
    const live = await liveResponse.json() as {
      status?: string
      live?: boolean
      channel?: string
    }
    const readyResponse = await fetch(`http://127.0.0.1:${port}/api/ready`)
    const ready = await readyResponse.json() as {
      status?: string
      checks?: Array<{ name: string; status: string; metadata?: Record<string, unknown> }>
    }
    const readyGateway = ready.checks?.find(check => check.name === 'gateway')

    assert(liveResponse.status === 200, 'server live endpoint returns HTTP 200')
    assert(live.status === 'ok', 'server live endpoint reports ok')
    assert(live.live === true, 'server live endpoint reports live true')
    assert(live.channel === 'websocket', 'server live endpoint reports websocket channel')
    assert(readyResponse.status === 200, 'server ready endpoint returns HTTP 200')
    assert(ready.status === 'ok', 'server ready endpoint reports readiness ok')
    assert(readyGateway?.metadata?.running === true, 'server ready endpoint reports running gateway')
  } finally {
    await workspace.stop()
  }
}

async function main(): Promise<void> {
  console.log('\nRuntime Server Smoke Test Suite')
  console.log('='.repeat(60))

  try {
    await testServerModeExposesHealthEndpoint()
    await testServerModeExposesLiveAndReadyEndpoints()
    console.log('\n' + '='.repeat(60))
    console.log('All Runtime Server Smoke tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
