import { EmlScorer } from '../src/memory/emlScoring.js'

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

section('EML Scoring Tests')

async function testDeterministicAndClamped() {
  console.log('\n1. Deterministic clamped scoring...')
  const scorer = new EmlScorer()
  const input = {
    novelty: 2,
    importance: 1.5,
    volatility: -1,
    redundancy: 1.2,
    retrievalFrequency: 0.4,
    ageMs: -100,
  }

  const first = scorer.score(input)
  const second = scorer.score(input)

  assert(first.score >= 0 && first.score <= 1, 'score is clamped to 0..1')
  assert(first.score === second.score, 'same input produces same score')
  assert(first.action === second.action, 'same input produces same action')
  assert(first.thresholdVersion === 'eml-thresholds-0.1.0', 'threshold version is exposed')
}

async function testDuplicateLowValueNotPromoted() {
  console.log('\n2. Duplicate low-value memory...')
  const scorer = new EmlScorer()
  const decision = scorer.score({
    novelty: 0.1,
    importance: 0.2,
    volatility: 0.2,
    redundancy: 1,
    retrievalFrequency: 0,
    ageMs: 60_000,
  })

  assert(decision.action === 'ignore', 'duplicate low-value memory is ignored')
  assert(decision.reasons.includes('high_redundancy'), 'decision explains redundancy')
}

async function testHighValueSignalsCanPromote() {
  console.log('\n3. High-value signals...')
  const scorer = new EmlScorer()

  const preference = scorer.score({
    novelty: 0.8,
    importance: 1,
    volatility: 0.1,
    redundancy: 0,
    retrievalFrequency: 0.5,
    ageMs: 0,
    signalType: 'user_preference',
  })

  const projectFact = scorer.score({
    novelty: 0.7,
    importance: 0.9,
    volatility: 0.2,
    redundancy: 0.1,
    retrievalFrequency: 0.4,
    ageMs: 0,
    signalType: 'project_fact',
  })

  const failureSignal = scorer.score({
    novelty: 0.9,
    importance: 0.9,
    volatility: 0.3,
    redundancy: 0,
    retrievalFrequency: 0.8,
    ageMs: 0,
    signalType: 'failure_signal',
  })

  assert(preference.action === 'promote', 'high-value user preference can be promoted')
  assert(projectFact.action === 'promote', 'high-value project fact can be promoted')
  assert(failureSignal.action === 'distill_candidate', 'recurring failure signal can become distill candidate')
}

async function testArchiveRecommendationIsNonDestructive() {
  console.log('\n4. Archive recommendation...')
  const scorer = new EmlScorer()
  const decision = scorer.score({
    novelty: 0.2,
    importance: 0.3,
    volatility: 0.8,
    redundancy: 0.9,
    retrievalFrequency: 0,
    ageMs: 180 * 24 * 60 * 60 * 1000,
  })

  assert(decision.action === 'archive', 'stale volatile redundant memory is archive candidate')
  assert(decision.requiresArchiveCopy === true, 'archive action requires preserving a copy')
  assert(decision.reasons.includes('no_hard_delete'), 'decision explicitly forbids hard delete')
}

async function main() {
  console.log('\nEML Scoring Test Suite')
  console.log('='.repeat(60))

  try {
    await testDeterministicAndClamped()
    await testDuplicateLowValueNotPromoted()
    await testHighValueSignalsCanPromote()
    await testArchiveRecommendationIsNonDestructive()
    console.log('\n' + '='.repeat(60))
    console.log('All EML Scoring tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
