import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { PhoenixAuditSnapshotStore, PhoenixAuditStore } from '../src/orchestrator/phoenixAudit.js'

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `phoenix-audit-snapshots-${Date.now()}`)
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

section('Phoenix Audit Snapshot Store Tests')

async function testSnapshotPersistenceAndRestore() {
  console.log('\n1. Snapshot persistence and restore...')
  const audit = new PhoenixAuditStore({ maxEntries: 10, version: 'test-audit-version' })
  audit.recordIntentRoute({ prompt: 'persist this audit', sessionId: 's1' })
  audit.recordMemoryScorePlaceholder({ sessionId: 's1', memoryEnabled: true, recallInjected: false })

  const store = new PhoenixAuditSnapshotStore({
    directory: TEST_DIR,
    maxSnapshots: 3,
    now: () => 1_000,
  })

  const saved = store.save(audit, {
    snapshotId: 'snapshot-a',
    reason: 'unit-test',
  })
  const listed = store.list()
  const restored = store.restore('snapshot-a')
  const restoredStats = restored.getStats()

  assert(existsSync(saved.path), 'snapshot file is written')
  assert(saved.snapshot.snapshotId === 'snapshot-a', 'saved snapshot id is stable')
  assert(saved.snapshot.reason === 'unit-test', 'saved snapshot reason is stable')
  assert(listed.length === 1, 'snapshot store lists one snapshot')
  assert(listed[0].snapshotId === 'snapshot-a', 'listed snapshot id is visible')
  assert(listed[0].entries === 2, 'listed snapshot entry count is visible')
  assert(restoredStats.totalEntries === 2, 'restored audit preserves entries')
  assert((restoredStats.policyVersions as Record<string, string>).audit === 'test-audit-version', 'restored audit preserves policy version')
}

async function testSnapshotRotationKeepsNewestFiles() {
  console.log('\n2. Snapshot rotation...')
  let now = 2_000
  const audit = new PhoenixAuditStore({ maxEntries: 10, version: 'test-audit-version' })
  audit.recordIntentRoute({ prompt: 'rotate this audit' })
  const store = new PhoenixAuditSnapshotStore({
    directory: TEST_DIR,
    maxSnapshots: 2,
    now: () => now,
  })

  store.save(audit, { snapshotId: 'snapshot-1', reason: 'rotation-test' })
  now = 3_000
  store.save(audit, { snapshotId: 'snapshot-2', reason: 'rotation-test' })
  now = 4_000
  store.save(audit, { snapshotId: 'snapshot-3', reason: 'rotation-test' })

  const listed = store.list()
  const files = readdirSync(TEST_DIR).filter(file => file.endsWith('.json'))

  assert(listed.length === 2, 'rotation keeps configured snapshot count')
  assert(listed[0].snapshotId === 'snapshot-3', 'newest snapshot is listed first')
  assert(listed[1].snapshotId === 'snapshot-2', 'second newest snapshot is retained')
  assert(!files.some(file => file.includes('snapshot-1')), 'oldest snapshot file is removed')
}

async function main() {
  console.log('\nPhoenix Audit Snapshot Store Test Suite')
  console.log('='.repeat(60))

  try {
    await testSnapshotPersistenceAndRestore()
    await testSnapshotRotationKeepsNewestFiles()
    console.log('\n' + '='.repeat(60))
    console.log('All Phoenix Audit Snapshot Store tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  } finally {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
      console.log(`\nCleaned up Phoenix audit snapshot test directory: ${TEST_DIR}`)
    }
  }
}

main()
