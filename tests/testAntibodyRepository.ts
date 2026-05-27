import { AntibodyRepository } from '../src/antibody/antibodyRepository.js'

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

section('Antibody Repository Tests')

async function testNewRulesStartProposed() {
  console.log('\n1. New rules start proposed...')
  const repo = new AntibodyRepository({ now: () => 1_000 })
  const rule = repo.proposeRule({
    pattern: 'llm:timeout',
    recommendation: 'switch_to_smaller_context',
    sourceFailure: 'chat.complete timed out 5 times',
    operationKey: 'chat.complete',
    subsystem: 'llm',
    reviewAfterMs: 60_000,
  })

  assert(rule.status === 'proposed', 'new rule starts proposed')
  assert(rule.version === 'antibody-rule-0.1.0', 'rule version is recorded')
  assert(rule.reviewAfter === 61_000, 'review metadata is recorded')
  assert(repo.evaluate({ pattern: 'llm:timeout' }).matchedActiveRules.length === 0, 'proposed rule does not affect evaluation')
}

async function testExplicitActivation() {
  console.log('\n2. Explicit activation...')
  const repo = new AntibodyRepository({ now: () => 1_000 })
  const rule = repo.proposeRule({
    pattern: 'tool:http_429',
    recommendation: 'slow_down_requests',
    sourceFailure: 'http_request returned 429 repeatedly',
    operationKey: 'http_request',
    subsystem: 'tool',
    expiresAfterMs: 120_000,
  })

  repo.approveRule(rule.id)
  repo.activateRule(rule.id)

  const evaluation = repo.evaluate({ pattern: 'tool:http_429' })
  assert(evaluation.matchedActiveRules.length === 1, 'approved active rule can match')
  assert(evaluation.matchedActiveRules[0].status === 'active', 'matched rule is active')
  assert(evaluation.canAffectExecution === false, 'repository evaluation remains advisory only')
}

async function testConflictingActiveRuleRejected() {
  console.log('\n3. Conflict detection...')
  const repo = new AntibodyRepository({ now: () => 1_000 })
  const first = repo.proposeRule({
    pattern: 'memory:search_error',
    recommendation: 'fallback_to_keyword_search',
    sourceFailure: 'vector search failed',
    operationKey: 'vectorSearch',
    subsystem: 'memory',
  })
  repo.approveRule(first.id)
  repo.activateRule(first.id)

  const second = repo.proposeRule({
    pattern: 'memory:search_error',
    recommendation: 'disable_memory',
    sourceFailure: 'another memory failure',
    operationKey: 'vectorSearch',
    subsystem: 'memory',
  })
  repo.approveRule(second.id)
  const activated = repo.activateRule(second.id)

  assert(activated.status === 'rejected', 'conflicting active rule is rejected')
  assert(activated.conflictsWith?.includes(first.id) === true, 'conflict points to existing active rule')
}

async function testExpiration() {
  console.log('\n4. Expiration...')
  let now = 1_000
  const repo = new AntibodyRepository({ now: () => now })
  const rule = repo.proposeRule({
    pattern: 'gateway:temporary_error',
    recommendation: 'retry_later',
    sourceFailure: 'temporary gateway failure',
    operationKey: 'send',
    subsystem: 'gateway',
    expiresAfterMs: 10_000,
  })
  repo.approveRule(rule.id)
  repo.activateRule(rule.id)

  now = 12_000
  const expired = repo.expireDueRules()
  const stats = repo.getStats()

  assert(expired === 1, 'one rule expires')
  assert((stats.byStatus as Record<string, number>).expired === 1, 'expired status is counted')
  assert(repo.evaluate({ pattern: 'gateway:temporary_error' }).matchedActiveRules.length === 0, 'expired rule does not match')
}

async function main() {
  console.log('\nAntibody Repository Test Suite')
  console.log('='.repeat(60))

  try {
    await testNewRulesStartProposed()
    await testExplicitActivation()
    await testConflictingActiveRuleRejected()
    await testExpiration()
    console.log('\n' + '='.repeat(60))
    console.log('All Antibody Repository tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
