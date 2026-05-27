import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { SkillManager } from '../src/skills/skillManager.js'

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `skill-lifecycle-test-${Date.now()}`)
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

section('Skill Lifecycle Tests')

async function testTriggerMatching() {
  console.log('\n1. 触发匹配...')
  const manager = new SkillManager({ skillsDir: TEST_DIR })
  await manager.initialize()

  await manager.createSkill({
    name: 'stock-analysis',
    description: '分析股票趋势',
    triggerPhrases: ['股票', '选股', 'stock'],
    instructionTemplate: 'analyze {{ticker}}',
  })

  const best = manager.findSkillByTrigger('帮我做股票分析和选股')
  assert(best?.metadata.name === 'stock-analysis', '触发词应命中 stock-analysis')

  const matches = manager.findTriggeredSkills('我要做 stock research', 3)
  assert(matches.length >= 1, '应返回至少一个匹配技能')
  assert(matches[0].matchedBy.includes('trigger'), '应标记 trigger 匹配来源')
}

async function testLifecyclePersistence() {
  console.log('\n2. 生命周期持久化...')
  const manager = new SkillManager({ skillsDir: TEST_DIR })
  await manager.initialize()

  const result = await manager.executeSkill({
    skillName: 'stock-analysis',
    params: { ticker: 'AAPL' },
  })
  assert(result.success, '技能执行应成功')

  manager.suggestPatch('stock-analysis', 'Need better fallback examples', {
    severity: 'medium',
    examples: ['AAPL', 'MSFT'],
  })
  await manager.flushLifecycleState()

  const reloaded = new SkillManager({ skillsDir: TEST_DIR })
  await reloaded.initialize()

  const report = reloaded.getLifecycleReport()
  assert(report.evaluations.some(item => item.skillName === 'stock-analysis' && item.callCount >= 1), '评估数据应被持久化')
  assert(report.openPatchSuggestions.some(item => item.skillName === 'stock-analysis'), 'patch suggestion 应被持久化')
}

async function testImproveSignals() {
  console.log('\n3. 退化信号...')
  const manager = new SkillManager({ skillsDir: TEST_DIR, successRateThreshold: 0.8 })
  await manager.initialize()

  manager.recordSkillOutcome('stock-analysis', false, 10)
  manager.recordSkillOutcome('stock-analysis', false, 12)
  manager.recordSkillOutcome('stock-analysis', false, 15)
  manager.recordSkillOutcome('stock-analysis', false, 11)
  manager.recordSkillOutcome('stock-analysis', false, 9)
  await manager.evolve()

  const report = manager.getLifecycleReport()
  assert(report.needsImprovement.some(item => item.skillName === 'stock-analysis'), '低成功率技能应进入 needsImprovement')
  assert(report.openPatchSuggestions.some(item => item.skillName === 'stock-analysis'), '低成功率技能应生成 patch suggestion')
}

async function main() {
  console.log('\n🚀 Skill Lifecycle Test Suite')
  console.log('='.repeat(60))

  try {
    await testTriggerMatching()
    await testLifecyclePersistence()
    await testImproveSignals()

    console.log('\n' + '='.repeat(60))
    console.log('🎉 All Skill Lifecycle tests passed!')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  } finally {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
      console.log(`\n🧹 Cleaned up skill test directory: ${TEST_DIR}`)
    }
  }
}

main()
