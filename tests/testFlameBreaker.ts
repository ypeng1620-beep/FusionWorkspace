import { FlameBreaker } from '../src/reliability/flameBreaker.js'

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

section('Flame Breaker Tests')

async function testFailureThresholdOpensBreaker() {
  console.log('\n1. Failure threshold opens breaker...')
  const breaker = new FlameBreaker({ now: () => 1_000 })

  for (let i = 0; i < 4; i += 1) {
    const decision = breaker.recordFailure({
      subsystem: 'llm',
      operationKey: 'chat.complete',
      error: new Error(`failure ${i}`),
    })
    assert(decision.state === 'closed', `failure ${i + 1} keeps breaker closed`)
  }

  const opened = breaker.recordFailure({
    subsystem: 'llm',
    operationKey: 'chat.complete',
    error: new Error('fifth failure'),
  })

  assert(opened.state === 'open', 'fifth consecutive failure opens breaker')
  assert(opened.recommendation.action === 'fallback', 'open breaker recommends fallback')
  assert(opened.recommendation.originalError === 'fifth failure', 'fallback preserves original error')
}

async function testCooldownMovesToHalfOpenAndSuccessCloses() {
  console.log('\n2. Cooldown and half-open recovery...')
  let now = 1_000
  const breaker = new FlameBreaker({ now: () => now, cooldownMs: 60_000 })

  for (let i = 0; i < 5; i += 1) {
    breaker.recordFailure({ subsystem: 'memory', operationKey: 'search', error: `failure ${i}` })
  }

  assert(breaker.evaluate({ subsystem: 'memory', operationKey: 'search' }).state === 'open', 'breaker is open before cooldown')
  now += 60_001
  assert(breaker.evaluate({ subsystem: 'memory', operationKey: 'search' }).state === 'half_open', 'cooldown enables half-open probing')

  breaker.recordSuccess({ subsystem: 'memory', operationKey: 'search' })
  breaker.recordSuccess({ subsystem: 'memory', operationKey: 'search' })
  const closed = breaker.recordSuccess({ subsystem: 'memory', operationKey: 'search' })

  assert(closed.state === 'closed', 'three half-open successes close breaker')
  assert(closed.recommendation.action === 'allow', 'closed breaker allows operation')
}

async function testHalfOpenFailureReopens() {
  console.log('\n3. Half-open failure reopens...')
  let now = 1_000
  const breaker = new FlameBreaker({ now: () => now, cooldownMs: 60_000 })

  for (let i = 0; i < 5; i += 1) {
    breaker.recordFailure({ subsystem: 'tool', operationKey: 'http_request', error: `failure ${i}` })
  }

  now += 60_001
  breaker.evaluate({ subsystem: 'tool', operationKey: 'http_request' })
  const reopened = breaker.recordFailure({
    subsystem: 'tool',
    operationKey: 'http_request',
    error: 'probe failed',
  })

  assert(reopened.state === 'open', 'one half-open failure reopens breaker')
  assert(reopened.recommendation.originalError === 'probe failed', 'reopened fallback preserves probe error')
}

async function testDestructiveFallbackBoundary() {
  console.log('\n4. Destructive fallback boundary...')
  const breaker = new FlameBreaker({ now: () => 1_000 })

  for (let i = 0; i < 5; i += 1) {
    breaker.recordFailure({
      subsystem: 'tool',
      operationKey: 'execute_command',
      error: 'rm failed',
      destructive: true,
    })
  }

  const decision = breaker.evaluate({
    subsystem: 'tool',
    operationKey: 'execute_command',
    destructive: true,
  })

  assert(decision.recommendation.action === 'fallback', 'destructive tool still receives fallback recommendation')
  assert(decision.recommendation.canRetryAutomatically === false, 'destructive fallback cannot auto-retry')
  assert(decision.recommendation.canBypassPermission === false, 'fallback cannot bypass permissions')
  assert(decision.recommendation.hideOriginalError === false, 'fallback cannot hide original error')
}

async function testTransitionsAreAuditable() {
  console.log('\n5. Auditable transitions...')
  const breaker = new FlameBreaker({ now: () => 1_000 })
  for (let i = 0; i < 5; i += 1) {
    breaker.recordFailure({ subsystem: 'llm', operationKey: 'chat.complete', error: `failure ${i}` })
  }

  const audit = breaker.getAuditLog()
  const last = audit[audit.length - 1]
  assert(last.from === 'closed', 'audit records previous state')
  assert(last.to === 'open', 'audit records new state')
  assert(last.operationKey === 'chat.complete', 'audit records operation key')
  assert(last.reason === 'failure_threshold_exceeded', 'audit records transition reason')
}

async function main() {
  console.log('\nFlame Breaker Test Suite')
  console.log('='.repeat(60))

  try {
    await testFailureThresholdOpensBreaker()
    await testCooldownMovesToHalfOpenAndSuccessCloses()
    await testHalfOpenFailureReopens()
    await testDestructiveFallbackBoundary()
    await testTransitionsAreAuditable()
    console.log('\n' + '='.repeat(60))
    console.log('All Flame Breaker tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
