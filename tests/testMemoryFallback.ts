import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { FTS5MemoryStore } from '../src/memory/fts5Memory.js'
import { MemoryManager } from '../src/memory/memoryManager.js'

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `memory-fallback-test-${Date.now()}`)
if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true })
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`❌ ASSERTION FAILED: ${message}`)
  }
  console.log(`  ✅ ${message}`)
}

function section(name: string): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('='.repeat(60))
}

section('Memory Fallback Tests')

async function testJsonFallbackStore() {
  console.log('\n1. JSON fallback store...')
  const dbPath = join(TEST_DIR, 'memory.db')
  const store = new FTS5MemoryStore({
    dbPath,
    forceFallback: true,
    enableVectorSearch: true,
  })

  assert(store.getBackend() === 'json', '应启用 json fallback backend')
  const memory = await store.addMemory('user prefers concise replies')
  assert(Boolean(memory.id), '应写入记忆')

  const results = store.searchMemories('concise replies', 5)
  assert(results.length >= 1, 'fallback store 应支持搜索')

  const vectorResults = await store.vectorSearch('concise', 5)
  assert(vectorResults.length >= 1, 'fallback store 应支持向量搜索')
}

async function testMemoryManagerBackendExposure() {
  console.log('\n2. MemoryManager backend exposure...')
  const manager = new MemoryManager({
    dbPath: join(TEST_DIR, 'manager.db'),
  })

  assert(['sqlite', 'json'].includes(manager.getBackend()), 'MemoryManager 应暴露 backend 类型')
  await manager.addInteractionMemory({
    prompt: 'Remember I like Chinese responses',
    response: 'I will remember that preference.',
    toolNames: [],
    sessionId: 'session-1',
    userId: 'user-1',
  })

  const context = manager.recallForPrompt('Chinese responses', 3)
  assert(context.includes('Relevant Memory'), '应能召回记忆上下文')
  manager.close()
}

async function testMemoryManagerCanRequireSqliteBackend() {
  console.log('\n3. MemoryManager required backend...')
  let failed = false
  try {
    new MemoryManager({
      dbPath: join(TEST_DIR, 'required-sqlite.db'),
      forceFallback: true,
      requiredBackend: 'sqlite',
      autoCleanupIntervalMs: 0,
    } as any)
  } catch (error) {
    failed = true
    assert((error as Error).message.includes('Required memory backend sqlite unavailable'), 'required sqlite backend failure should be explicit')
  }

  assert(failed, 'MemoryManager should fail fast when sqlite is required but unavailable')
}

async function main() {
  console.log('\n🚀 Memory Fallback Test Suite')
  console.log('='.repeat(60))

  try {
    await testJsonFallbackStore()
    await testMemoryManagerBackendExposure()
    await testMemoryManagerCanRequireSqliteBackend()
    console.log('\n' + '='.repeat(60))
    console.log('🎉 All Memory Fallback tests passed!')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  } finally {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
      console.log(`\n🧹 Cleaned up memory fallback test directory: ${TEST_DIR}`)
    }
  }
}

main()
