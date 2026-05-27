import assert from 'assert'
import { AntibodyPolicy } from '../src/antibody/antibodyPolicy.js'
import { AntibodyRepository } from '../src/antibody/antibodyRepository.js'
import { FlameBreaker } from '../src/reliability/flameBreaker.js'

function ok(condition: unknown, message: string): void {
  assert(condition, message)
  console.log(`  ok ${message}`)
}

async function testOpenBreakerProposesRule(): Promise<void> {
  console.log('\n1. Open breaker proposes antibody rule...')
  const repository = new AntibodyRepository({ now: () => 1_000 })
  const policy = new AntibodyPolicy({
    repository,
    reviewAfterMs: 60_000,
    expiresAfterMs: 3_600_000,
  })
  const breaker = new FlameBreaker({
    failureThreshold: 2,
    onTransition: (decision, transition) => {
      policy.observeReliabilityTransition({ decision, transition })
    },
  })

  breaker.recordFailure({ subsystem: 'llm', operationKey: 'chat.complete', error: new Error('timeout') })
  breaker.recordFailure({ subsystem: 'llm', operationKey: 'chat.complete', error: new Error('timeout') })

  const stats = repository.getStats() as {
    totalRules: number
    proposedCount: number
    recent: Array<{ status: string; pattern: string; recommendation: string; reviewAfter?: number; expiresAt?: number }>
  }
  const evaluation = repository.evaluate({ pattern: 'llm:chat.complete:failure_threshold_exceeded' })

  ok(stats.totalRules === 1, 'one proposed rule is created')
  ok(stats.proposedCount === 1, 'rule starts proposed')
  ok(stats.recent[0]?.status === 'proposed', 'recent rule is proposed')
  ok(stats.recent[0]?.pattern === 'llm:chat.complete:failure_threshold_exceeded', 'rule pattern is stable')
  ok(stats.recent[0]?.recommendation === 'fallback:breaker_open', 'rule recommendation is advisory fallback')
  ok(stats.recent[0]?.reviewAfter === 61_000, 'review metadata is attached')
  ok(stats.recent[0]?.expiresAt === 3_601_000, 'expiration metadata is attached')
  ok(evaluation.canAffectExecution === false, 'proposed antibody remains non-executing')
  ok(evaluation.matchedActiveRules.length === 0, 'proposed antibody does not match active evaluation')
}

async function testDuplicateProposalsAreSuppressed(): Promise<void> {
  console.log('\n2. Duplicate proposal suppression...')
  const repository = new AntibodyRepository({ now: () => 2_000 })
  const policy = new AntibodyPolicy({ repository })
  const first = policy.observeReliabilityTransition({
    decision: {
      state: 'open',
      subsystem: 'tool',
      operationKey: 'http_request',
      recommendation: {
        action: 'fallback',
        reason: 'breaker_open',
        originalError: 'ECONNRESET',
        canRetryAutomatically: false,
        canBypassPermission: false,
        hideOriginalError: false,
      },
    },
    transition: {
      timestamp: 2_000,
      subsystem: 'tool',
      operationKey: 'http_request',
      from: 'closed',
      to: 'open',
      reason: 'failure_threshold_exceeded',
      originalError: 'ECONNRESET',
    },
  })
  const duplicate = policy.observeReliabilityTransition({
    decision: first.decision,
    transition: first.transition,
  })

  const stats = repository.getStats() as { totalRules: number; proposedCount: number }

  ok(first.action === 'proposed', 'first observation proposes a rule')
  ok(duplicate.action === 'duplicate', 'duplicate observation is suppressed')
  ok(stats.totalRules === 1, 'duplicate rule is not stored')
  ok(stats.proposedCount === 1, 'only one proposed rule remains')
}

async function testNonOpenTransitionIsIgnored(): Promise<void> {
  console.log('\n3. Non-open transition ignored...')
  const repository = new AntibodyRepository()
  const policy = new AntibodyPolicy({ repository })

  const result = policy.observeReliabilityTransition({
    decision: {
      state: 'closed',
      subsystem: 'llm',
      operationKey: 'chat.complete',
      recommendation: {
        action: 'allow',
        reason: 'breaker_closed',
        canRetryAutomatically: false,
        canBypassPermission: false,
        hideOriginalError: false,
      },
    },
    transition: {
      timestamp: Date.now(),
      subsystem: 'llm',
      operationKey: 'chat.complete',
      from: 'half_open',
      to: 'closed',
      reason: 'half_open_success_threshold_met',
    },
  })
  const stats = repository.getStats() as { totalRules: number }

  ok(result.action === 'ignored', 'closed transition is ignored')
  ok(stats.totalRules === 0, 'ignored transition creates no rule')
}

async function main(): Promise<void> {
  console.log('\n============================================================')
  console.log('  Antibody Policy Tests')
  console.log('============================================================')
  console.log('\nAntibody Policy Test Suite')
  console.log('============================================================')

  await testOpenBreakerProposesRule()
  await testDuplicateProposalsAreSuppressed()
  await testNonOpenTransitionIsIgnored()

  console.log('\n============================================================')
  console.log('All Antibody Policy tests passed')
  console.log('============================================================')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
