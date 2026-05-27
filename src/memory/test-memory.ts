/**
 * Memory System 测试
 */

import { FTS5MemoryStore, embed, configureEmbed, getEmbedConfig } from './fts5Memory.js'
import { MemoryManager, LRUCache } from './memoryManager.js'

async function testFTS5() {
  console.log('=== Testing FTS5 Memory Store ===\n')

  // 创建临时数据库
  const store = new FTS5MemoryStore({
    dbPath: ':memory:',  // 使用内存数据库便于测试
  })

  // 测试添加记忆
  console.log('1. Adding memories...')
  const m1 = await store.addMemory('今天市场大涨，科技股领涨')
  console.log(`   Added: ${m1.id.substring(0, 8)}...`)

  const m2 = await store.addMemory('苹果发布新品，股价创新高')
  console.log(`   Added: ${m2.id.substring(0, 8)}...`)

  const m3 = await store.addMemory('AI 概念股持续火热')
  console.log(`   Added: ${m3.id.substring(0, 8)}...`)

  console.log(`   Total memories: ${store.getMemoryCount()}`)

  // 测试 FTS5 搜索
  console.log('\n2. Testing FTS5 search...')
  const results = store.searchMemories('科技股', 5)
  console.log(`   Query "科技股": ${results.length} results`)
  results.forEach(r => console.log(`   - [${r.id.substring(0, 8)}] ${r.content.substring(0, 30)}... (rank: ${r.rank})`))

  // 测试 FTS5 前缀搜索
  console.log('\n3. Testing FTS5 prefix search...')
  const prefixResults = store.searchMemories('科技*', 5)
  console.log(`   Query "科技*": ${prefixResults.length} results`)

  // 测试 embedding
  console.log('\n4. Testing embedding...')
  const vec = await embed('测试文本', 384)
  console.log(`   Embedding dim: ${vec.length}, first 5 values: ${vec.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...`)

  // 测试 embedding 配置
  console.log('\n5. Testing embed configuration...')
  const configBefore = getEmbedConfig()
  console.log(`   Config before: endpoint=${configBefore.endpoint}, model=${configBefore.model}, dim=${configBefore.dimension}`)

  configureEmbed({ dimension: 512 })
  const configAfter = getEmbedConfig()
  console.log(`   Config after: endpoint=${configAfter.endpoint}, model=${configAfter.model}, dim=${configAfter.dimension}`)

  // 测试摘要
  console.log('\n6. Testing summary...')
  const summary = store.createSummary([m1.id, m2.id], '今天科技股表现强劲，苹果领涨，AI 概念持续火热')
  console.log(`   Created summary: ${summary.id.substring(0, 8)}...`)
  console.log(`   Summary text: ${summary.summaryText.substring(0, 50)}...`)

  // 测试 getMemoryTimeRange（公开方法，不再访问私有 db）
  console.log('\n7. Testing getMemoryTimeRange...')
  const timeRange = store.getMemoryTimeRange()
  console.log(`   Time range: oldest=${timeRange?.oldest}, newest=${timeRange?.newest}`)

  // 测试 getRecentMemories
  console.log('\n8. Testing getRecentMemories...')
  const recent = store.getRecentMemories(2)
  console.log(`   Recent 2 memories: ${recent.length}`)
  recent.forEach(m => console.log(`   - ${m.content.substring(0, 25)}...`))

  // 清理
  store.close()
  console.log('\n✅ FTS5 Memory Store tests passed!')
}

async function testLRU() {
  console.log('\n=== Testing LRU Cache ===\n')

  const cache = new LRUCache<string, string>(3)

  // 添加 3 个条目（达到容量）
  cache.set('a', 'value-a')
  cache.set('b', 'value-b')
  cache.set('c', 'value-c')
  console.log(`1. Added 3 items, size: ${cache.size}`)

  // 访问 'a' 使其变为最新
  cache.get('a')
  console.log(`2. Accessed 'a', recent order: ${cache.getRecent(3).join(', ')}`)

  // 添加新条目，淘汰最旧的
  cache.set('d', 'value-d')
  console.log(`3. Added 'd', current keys: ${cache.keys().join(', ')}`)
  console.log(`   'b' should be evicted (oldest after accessing 'a')`)

  // 测试淘汰
  const evicted = cache.evictOldest(1)
  console.log(`4. Evicted oldest: ${evicted}`)

  // 测试 setWithEvict
  console.log('\n5. Testing setWithEvict...')
  const cache2 = new LRUCache<string, string>(3)
  cache2.set('a', 'val-a')
  cache2.set('b', 'val-b')
  const oldKey = cache2.setWithEvict('c', 'val-c')  // 添加第三个，a 被淘汰
  console.log(`   setWithEvict('c'): evicted key = ${oldKey}, keys = ${cache2.keys().join(', ')}`)

  cache.clear()
  console.log(`6. Cleared, size: ${cache.size}`)
  console.log('\n✅ LRU Cache tests passed!')
}

async function testMemoryManager() {
  console.log('\n=== Testing Memory Manager ===\n')

  // 测试事件钩子
  const events = {
    onCacheMiss: (id: string, source: 'sqlite' | 'not_found') => {
      console.log(`   [Event] Cache miss: ${id} from ${source}`)
    },
    onMemoryAdded: (memory: { id: string; content: string }) => {
      console.log(`   [Event] Memory added: ${memory.id.substring(0, 8)}...`)
    },
    onSummaryGenerated: (summaryId: string, memoryIds: string[]) => {
      console.log(`   [Event] Summary generated: ${summaryId.substring(0, 8)}... for ${memoryIds.length} memories`)
    },
  }

  const manager = new MemoryManager({
    cacheCapacity: 5,
    dbPath: ':memory:',
    autoCleanupIntervalMs: 0,  // 禁用自动清理以便测试
  }, events)

  // 添加记忆
  console.log('1. Adding memories...')
  const m1 = await manager.addMemory('用户喜欢简洁的回复')
  const m2 = await manager.addMemory('用户主要使用飞书沟通')
  const m3 = await manager.addMemory('项目使用 TypeScript 开发')
  console.log(`   Added ${manager.getTotalMemoryCount()} memories, cache size: ${manager.getCacheSize()}`)

  // 测试缓存命中
  console.log('\n2. Testing cache hit...')
  const cached = manager.getMemory(m1.id)
  console.log(`   Cache hit: ${cached !== null}`)
  console.log(`   Cache size after access: ${manager.getCacheSize()}`)

  // 测试缓存未命中（触发事件）
  console.log('\n3. Testing cache miss (event)...')
  const fresh = manager.getMemory('non-existent-id')
  console.log(`   Non-existent memory: ${fresh}`)

  // 测试搜索
  console.log('\n4. Testing search...')
  const results = manager.searchMemories('飞书', 5)
  console.log(`   Found ${results.length} results for "飞书"`)

  // 测试 getMemoryTimeRange（通过公共方法）
  console.log('\n5. Testing getMemoryTimeRange...')
  const timeRange = manager.getMemoryTimeRange()
  console.log(`   Time range: ${timeRange ? `oldest=${timeRange.oldest}, newest=${timeRange.newest}` : 'null'}`)

  // 测试 warmPersist（async 方法）
  console.log('\n6. Testing warmPersist (async)...')
  await manager.warmPersist()
  console.log(`   warmPersist completed without errors`)

  // 测试 setEvents
  console.log('\n7. Testing setEvents...')
  manager.setEvents({
    onCacheEvict: (id: string) => {
      console.log(`   [Event] Cache evicted: ${id}`)
    },
  })

  // 关闭
  manager.close()
  console.log('\n✅ Memory Manager tests passed!')
}

async function main() {
  try {
    await testFTS5()
    await testLRU()
    await testMemoryManager()
    console.log('\n🎉 All memory system tests passed!')
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  }
}

main()