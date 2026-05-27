import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { MemoryManager } from '../src/memory/memoryManager.js'
import { PhoenixAuditStore } from '../src/orchestrator/phoenixAudit.js'

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `memory-manager-eml-audit-test-${Date.now()}`)
if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true })
}

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

section('Memory Manager EML Audit Tests')

async function testStoredInteractionEmitsEmlAudit() {
  console.log('\n1. Stored interaction emits EML audit...')
  const audit = new PhoenixAuditStore({ maxEntries: 10, version: 'test' })
  const manager = new MemoryManager({
    dbPath: join(TEST_DIR, 'stored.db'),
    autoCleanupIntervalMs: 0,
    phoenixAudit: audit,
  })

  try {
    const memory = await manager.addInteractionMemory({
      prompt: 'Remember I prefer short Chinese answers',
      response: 'I will keep that preference in mind.',
      toolNames: [],
      sessionId: 's1',
      userId: 'u1',
    })

    const recent = audit.getRecent(1)[0]
    assert(Boolean(memory), 'interaction is still stored')
    assert(recent.stage === 'memory_score', 'memory score audit is emitted')
    assert(recent.sessionId === 's1', 'session id is preserved')
    assert(recent.userId === 'u1', 'user id is preserved')
    assert(recent.metadata?.source === 'memory_manager.addInteractionMemory', 'audit source identifies MemoryManager')
    assert(recent.metadata?.thresholdVersion === 'eml-thresholds-0.1.0', 'threshold version is visible')
  } finally {
    manager.close()
  }
}

async function testSkippedInteractionStillEmitsEmlAudit() {
  console.log('\n2. Skipped interaction emits EML audit...')
  const audit = new PhoenixAuditStore({ maxEntries: 10, version: 'test' })
  const manager = new MemoryManager({
    dbPath: join(TEST_DIR, 'skipped.db'),
    autoCleanupIntervalMs: 0,
    phoenixAudit: audit,
  })

  try {
    const memory = await manager.addInteractionMemory({
      prompt: '',
      response: 'empty prompt should not store',
      toolNames: [],
      sessionId: 's2',
      userId: 'u2',
    })

    const recent = audit.getRecent(1)[0]
    assert(memory === null, 'interaction remains skipped')
    assert(recent.stage === 'memory_score', 'skipped interaction is still audited')
    assert(recent.decision === 'ignore', 'skipped interaction receives ignore audit action')
    assert(recent.metadata?.policyReason === 'empty_prompt_or_response', 'policy reason is visible')
  } finally {
    manager.close()
  }
}

async function main() {
  console.log('\nMemory Manager EML Audit Test Suite')
  console.log('='.repeat(60))

  try {
    await testStoredInteractionEmitsEmlAudit()
    await testSkippedInteractionStillEmitsEmlAudit()
    console.log('\n' + '='.repeat(60))
    console.log('All Memory Manager EML Audit tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  } finally {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
      console.log(`\nCleaned up memory manager EML audit test directory: ${TEST_DIR}`)
    }
  }
}

main()
