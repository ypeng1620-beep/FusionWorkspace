import { MemoryWritePolicy } from '../src/memory/memoryWritePolicy.js'

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

section('Memory Write Policy Tests')

async function testEmlDecisionAttachedToWriteDecision() {
  console.log('\n1. EML decision attachment...')
  const policy = new MemoryWritePolicy()
  const decision = policy.evaluateForWrite({
    content: 'Remember I prefer concise Chinese responses',
    context: 'user preference',
  })

  assert(decision.shouldWrite === true, 'explicit preference should still be written')
  assert(decision.emlScore?.action === 'promote', 'explicit preference receives promote EML action')
  assert(decision.emlScore?.thresholdVersion === 'eml-thresholds-0.1.0', 'EML threshold version is attached')
}

async function testDuplicateLowValueNotPromoted() {
  console.log('\n2. Duplicate low-value policy decision...')
  const policy = new MemoryWritePolicy()
  const decision = policy.evaluateForWrite({
    content: 'ok ok ok ok',
    context: 'casual duplicate chat',
  })

  assert(decision.shouldWrite === false, 'low-value chat should not be written')
  assert(decision.emlScore?.action === 'ignore', 'low-value chat receives ignore EML action')
}

async function testArchiveRecommendationDoesNotDelete() {
  console.log('\n3. Archive recommendation boundary...')
  const policy = new MemoryWritePolicy()
  const decision = policy.evaluateForWrite({
    content: 'temporary config changed many times and is now obsolete',
    context: 'volatile duplicate old config',
    eml: {
      novelty: 0.2,
      importance: 0.3,
      volatility: 0.9,
      redundancy: 0.95,
      retrievalFrequency: 0,
      ageMs: 180 * 24 * 60 * 60 * 1000,
    },
  })

  assert(decision.emlScore?.action === 'archive', 'policy can recommend archive')
  assert(decision.emlScore?.requiresArchiveCopy === true, 'archive recommendation requires copy')
  assert(decision.shouldWrite === true, 'archive recommendation does not hard-delete or suppress source memory')
}

async function main() {
  console.log('\nMemory Write Policy Test Suite')
  console.log('='.repeat(60))

  try {
    await testEmlDecisionAttachedToWriteDecision()
    await testDuplicateLowValueNotPromoted()
    await testArchiveRecommendationDoesNotDelete()
    console.log('\n' + '='.repeat(60))
    console.log('All Memory Write Policy tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
