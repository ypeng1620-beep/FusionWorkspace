/**
 * Permission Gate 测试
 */

import { 
  PermissionGate, 
  RiskScorer, 
  PermissionError, 
  NeedConfirmationError,
  assessRisk,
  quickCheck,
} from '../src/permissions/permissionGate.js'
import { PermissionWorkflowStore } from '../src/permissions/permissionWorkflow.js'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'

// =============================================================================
// 测试工具函数
// =============================================================================

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

const WORKFLOW_TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `permission-workflow-test-${Date.now()}`)
if (!existsSync(WORKFLOW_TEST_DIR)) {
  mkdirSync(WORKFLOW_TEST_DIR, { recursive: true })
}

// =============================================================================
// RiskScorer 测试
// =============================================================================

section('RiskScorer Tests')

async function testRiskScorerBaselines() {
  console.log('\n1. 基础风险等级...')
  const scorer = new RiskScorer()

  // 读取文件应该是低风险
  const readRisk = scorer.assess({ name: 'read_file', params: { path: '/etc/passwd' } })
  assert(readRisk.level === 1, `read_file 基础风险应为 1, 实际 ${readRisk.level}`)
  assert(!readRisk.isDangerous, 'read_file 不应被标记为危险')

  // 写入文件应该是中等风险
  const writeRisk = scorer.assess({ name: 'write_file', params: { path: '/tmp/test.txt' } })
  assert(writeRisk.level === 3, `write_file 基础风险应为 3, 实际 ${writeRisk.level}`)

  // Shell 执行应该是较高风险
  const shellRisk = scorer.assess({ name: 'execute_command', params: { command: 'ls' } })
  assert(shellRisk.level >= 5, `execute_command 基础风险应 >= 5, 实际 ${shellRisk.level}`)
}

async function testDangerousPatterns() {
  console.log('\n2. 危险模式检测...')
  const scorer = new RiskScorer()

  // rm -rf / 应该被检测为最高风险
  const rmRfRoot = scorer.assess({ 
    name: 'execute_command', 
    params: { command: 'rm -rf /' } 
  })
  assert(rmRfRoot.level === 10, `rm -rf / 风险应为 10, 实际 ${rmRfRoot.level}`)
  assert(rmRfRoot.isDangerous, 'rm -rf / 应被标记为危险')
  assert(rmRfRoot.factors.some(f => f.includes('删除根目录')), '应包含"删除根目录"因素')

  // rm -rf /tmp 应该是较高风险
  const rmRfTmp = scorer.assess({ 
    name: 'execute_command', 
    params: { command: 'rm -rf /tmp/*' } 
  })
  assert(rmRfTmp.level >= 7, `rm -rf /tmp/* 风险应 >= 7, 实际 ${rmRfTmp.level}`)

  // chmod 777 应该是中高风险
  const chmod777 = scorer.assess({ 
    name: 'execute_command', 
    params: { command: 'chmod -R 777 /shared' } 
  })
  assert(chmod777.level >= 7, `chmod -R 777 风险应 >= 7, 实际 ${chmod777.level}`)
}

async function testModeratePatterns() {
  console.log('\n3. 中等风险模式检测...')
  const scorer = new RiskScorer()

  // git push 应该是中等风险
  const gitPush = scorer.assess({ 
    name: 'execute_command', 
    params: { command: 'git push origin main' } 
  })
  assert(gitPush.level >= 5, `git push 风险应 >= 5, 实际 ${gitPush.level}`)

  // curl POST 应该是中等风险
  const curlPost = scorer.assess({ 
    name: 'execute_command', 
    params: { command: "curl -X POST -d 'data' https://api.example.com" } 
  })
  assert(curlPost.level >= 4, `curl POST 风险应 >= 4, 实际 ${curlPost.level}`)
}

async function testNetworkRisk() {
  console.log('\n4. 网络请求风险...')
  const scorer = new RiskScorer()

  // 外部网络请求应该是中高风险
  const externalReq = scorer.assess({ 
    name: 'http_request', 
    params: { url: 'https://api.github.com/users' } 
  })
  assert(externalReq.level >= 4, `外部 HTTP 请求风险应 >= 4, 实际 ${externalReq.level}`)

  // localhost 请求应该是低风险
  const localReq = scorer.assess({ 
    name: 'http_request', 
    params: { url: 'http://localhost:3000/api' } 
  })
  assert(localReq.level < 5, `localhost 请求风险应 < 5, 实际 ${localReq.level}`)
}

async function testRiskScorerFunctions() {
  await testRiskScorerBaselines()
  await testDangerousPatterns()
  await testModeratePatterns()
  await testNetworkRisk()
}

// =============================================================================
// PermissionGate 模式测试
// =============================================================================

section('PermissionGate Mode Tests')

async function testBypassMode() {
  console.log('\n1. bypass 模式...')
  const gate = new PermissionGate('bypass')

  // 所有操作都应被批准
  const readResult = gate.check({ name: 'read_file', params: { path: '/etc/passwd' } })
  assert(readResult.approved, 'bypass 模式下 read_file 应被批准')

  const writeResult = gate.check({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
  assert(writeResult.approved, 'bypass 模式下 write_file 应被批准')

  const shellResult = gate.check({ name: 'execute_command', params: { command: 'rm -rf /' } })
  assert(shellResult.approved, 'bypass 模式下危险命令也应被批准（不推荐）')
  assert(shellResult.reason.includes('bypass'), '原因应说明 bypass 模式')
}

async function testPlanMode() {
  console.log('\n2. plan 模式...')
  const gate = new PermissionGate('plan')

  // 读取应被批准
  const readResult = gate.check({ name: 'read_file', params: { path: '/etc/passwd' } })
  assert(readResult.approved, 'plan 模式下 read_file 应被批准')

  // 写入应被拒绝
  const writeResult = gate.check({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
  assert(!writeResult.approved, 'plan 模式下 write_file 应被拒绝')

  // Shell 应被拒绝
  const shellResult = gate.check({ name: 'execute_command', params: { command: 'ls' } })
  assert(!shellResult.approved, 'plan 模式下 execute_command 应被拒绝')
  assert(shellResult.reason.includes('plan'), '原因应说明 plan 模式')

  // plan 模式中 http_request(GET) 视为读取操作，允许；其他网络操作（POST/PUT/DELETE）应拒绝
  // 注：严格来说，所有网络请求都涉及数据流出，但 GET 是最安全的
  const httpResult = gate.check({ name: 'http_request', params: { url: 'https://api.example.com' } })
  assert(httpResult.approved, 'plan 模式下 http_request(GET) 应允许（读取操作）')
}

async function testDefaultMode() {
  console.log('\n3. default 模式...')
  const gate = new PermissionGate('default')

  // 读取自动批准
  const readResult = gate.check({ name: 'read_file', params: { path: '/etc/passwd' } })
  assert(readResult.approved, 'default 模式下 read_file 应被批准')

  // 写入需要确认
  const writeResult = gate.check({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
  assert(!writeResult.approved, 'default 模式下 write_file 应需要确认')
  assert(writeResult.requiresConfirmation, 'write_result 应需要确认')

  // Shell 需要确认
  const shellResult = gate.check({ name: 'execute_command', params: { command: 'ls' } })
  assert(!shellResult.approved, 'default 模式下 execute_command 应需要确认')
  assert(shellResult.requiresConfirmation, 'shell 结果应需要确认')

  // 危险 Shell 命令应被拒绝（不是需要确认）
  const dangerousShell = gate.check({ name: 'execute_command', params: { command: 'rm -rf /' } })
  assert(!dangerousShell.approved, '危险命令应被拒绝')
  assert(!dangerousShell.requiresConfirmation, '危险命令应直接拒绝，不需要确认')
}

async function testAutoMode() {
  console.log('\n4. auto 模式...')
  const gate = new PermissionGate('auto')

  // 低风险操作自动批准
  const lowRisk = gate.check({ name: 'read_file', params: { path: '/tmp/test.txt' } })
  assert(lowRisk.approved, 'auto 模式下低风险操作应自动批准')
  assert(lowRisk.reason.includes('auto'), '原因应说明 auto 模式')
  assert(lowRisk.riskLevel === 1, 'read_file 风险等级应为 1')

  // 中等风险需要确认
  const mediumRisk = gate.check({ name: 'http_request', params: { url: 'https://api.example.com' } })
  assert(!mediumRisk.approved, 'auto 模式下中等风险需要确认')
  assert(mediumRisk.requiresConfirmation, '中等风险应需要确认')

  // 高风险自动拒绝
  const highRisk = gate.check({ name: 'execute_command', params: { command: 'rm -rf /' } })
  assert(!highRisk.approved, 'auto 模式下高风险应自动拒绝')
  assert(!highRisk.requiresConfirmation, '高风险应直接拒绝')
}

async function testInteractiveMode() {
  console.log('\n5. interactive 模式...')
  const gate = new PermissionGate('interactive')

  // 所有操作都需要确认
  const readResult = gate.check({ name: 'read_file', params: { path: '/tmp/test.txt' } })
  assert(!readResult.approved, 'interactive 模式下 read_file 应需要确认')
  assert(readResult.requiresConfirmation, 'interactive 模式下所有操作都需要确认')

  const writeResult = gate.check({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
  assert(!writeResult.approved, 'interactive 模式下 write_file 应需要确认')

  const shellResult = gate.check({ name: 'execute_command', params: { command: 'ls' } })
  assert(!shellResult.approved, 'interactive 模式下 execute_command 应需要确认')
}

async function testSandboxMode() {
  console.log('\n6. sandbox 模式...')
  const gate = new PermissionGate('sandbox')

  // 设置信任目录
  gate.addTrustedDirectory('/project')
  gate.setContext({ cwd: '/project' })

  // 读取允许
  const readResult = gate.check({ name: 'read_file', params: { path: '/project/test.txt' } })
  assert(readResult.approved, 'sandbox 模式下读取信任目录应允许')

  // 写入拒绝
  const writeResult = gate.check({ name: 'write_file', params: { path: '/project/test.txt', content: 'test' } })
  assert(!writeResult.approved, 'sandbox 模式下写入应拒绝')

  // 安全 Shell 命令允许
  const safeShell = gate.check({ name: 'execute_command', params: { command: 'ls -la' } })
  assert(safeShell.approved, 'sandbox 模式下 ls 命令应允许')

  // 危险 Shell 拒绝
  const dangerousShell = gate.check({ name: 'execute_command', params: { command: 'rm -rf /' } })
  assert(!dangerousShell.approved, 'sandbox 模式下危险命令应拒绝')

  // 非安全命令拒绝
  const unsafeShell = gate.check({ name: 'execute_command', params: { command: 'git push' } })
  assert(!unsafeShell.approved, 'sandbox 模式下 git push 应拒绝')
}

async function testRestrictedMode() {
  console.log('\n7. restricted 模式...')
  const gate = new PermissionGate('restricted')

  // 设置白名单
  gate.setWhitelist(['read_file', 'grep'])

  // 白名单工具允许
  const readResult = gate.check({ name: 'read_file', params: { path: '/tmp/test.txt' } })
  assert(readResult.approved, 'restricted 模式下白名单工具应允许')
  assert(readResult.reason.includes('白名单'), '原因应说明白名单')

  // 非白名单拒绝
  const writeResult = gate.check({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
  assert(!writeResult.approved, 'restricted 模式下非白名单工具应拒绝')

  // 空白名单全部拒绝
  gate.setWhitelist([])
  const emptyResult = gate.check({ name: 'read_file', params: { path: '/tmp/test.txt' } })
  assert(!emptyResult.approved, '空白名单模式下所有工具应拒绝')
}

async function testPermissionGateModes() {
  await testBypassMode()
  await testPlanMode()
  await testDefaultMode()
  await testAutoMode()
  await testInteractiveMode()
  await testSandboxMode()
  await testRestrictedMode()
}

// =============================================================================
// checkAsync 测试
// =============================================================================

section('checkAsync Tests')

async function testCheckAsync() {
  console.log('\n1. checkAsync 高风险自动拒绝...')
  const gate = new PermissionGate('default')

  // 危险命令应该被 checkAsync 直接拒绝
  try {
    await gate.checkAsync({ name: 'execute_command', params: { command: 'rm -rf /' } })
    assert(false, 'checkAsync 应该抛出 PermissionError')
  } catch (error) {
    assert(error instanceof PermissionError, '应抛出 PermissionError')
    assert(error.riskLevel === 10, '风险等级应为 10')
    console.log(`  ✅ 正确拒绝: ${(error as PermissionError).message}`)
  }

  console.log('\n2. checkAsync 需要确认...')
  try {
    await gate.checkAsync({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
    assert(false, 'checkAsync 应该抛出 NeedConfirmationError')
  } catch (error) {
    assert(error instanceof NeedConfirmationError, '应抛出 NeedConfirmationError')
    console.log(`  ✅ 正确请求确认: ${(error as NeedConfirmationError).message}`)
  }
}

// =============================================================================
// 便捷函数测试
// =============================================================================

section('Convenience Function Tests')

async function testConvenienceFunctions() {
  console.log('\n1. quickCheck...')
  const result = quickCheck({ name: 'read_file', params: { path: '/tmp/test.txt' } }, 'default')
  assert(result.approved, 'quickCheck 应批准 read_file')

  console.log('\n2. assessRisk...')
  const risk = assessRisk({ name: 'execute_command', params: { command: 'rm -rf /' } })
  assert(risk.level === 10, 'assessRisk 应返回正确风险等级')
  assert(risk.isDangerous, 'assessRisk 应正确识别危险操作')
}

// =============================================================================
// 模式切换测试
// =============================================================================

section('Mode Switching Tests')

async function testModeSwitching() {
  console.log('\n1. setMode 动态切换...')
  const gate = new PermissionGate('default')
  
  assert(gate.getMode() === 'default', '初始模式应为 default')
  
  gate.setMode('plan')
  assert(gate.getMode() === 'plan', '切换后模式应为 plan')

  const planResult = gate.check({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
  assert(!planResult.approved, 'plan 模式下写入应被拒绝')

  gate.setMode('bypass')
  const bypassResult = gate.check({ name: 'write_file', params: { path: '/tmp/test.txt', content: 'test' } })
  assert(bypassResult.approved, 'bypass 模式下写入应被批准')

  console.log('\n2. setContext 动态更新...')
  gate.setMode('sandbox')
  gate.addTrustedDirectory('/safe')
  gate.setContext({ cwd: '/safe' })
  
  const sandboxResult = gate.check({ name: 'read_file', params: { path: '/safe/test.txt' } })
  assert(sandboxResult.approved, 'sandbox 模式下信任目录读取应允许')
}

async function testApprovalWorkflow() {
  console.log('\n3. 审批工作流...')
  const workflow = new PermissionWorkflowStore({ rootDir: WORKFLOW_TEST_DIR })
  const gate = new PermissionGate('default', {
    sessionId: 'session-1',
    userId: 'user-1',
  }, workflow)

  try {
    await gate.checkAsync({ name: 'write_file', params: { path: '/tmp/approved.txt', content: 'ok' } })
    assert(false, '首次 write_file 应触发确认')
  } catch (error) {
    assert(error instanceof NeedConfirmationError, '首次应抛出 NeedConfirmationError')
    assert(Boolean(error.requestId), '应创建 pending request')
    gate.resolvePendingRequest(error.requestId!, true)
    gate.registerApproval(error.toolCall, { scope: 'once', remainingUses: 1 })
  }

  const approved = gate.check({ name: 'write_file', params: { path: '/tmp/approved.txt', content: 'ok' } })
  assert(approved.approved, '登记后同一调用应被批准')

  const auditLog = workflow.getAuditLog()
  assert(auditLog.length >= 2, '应记录审计日志')
}

// =============================================================================
// 主测试函数
// =============================================================================

async function main() {
  console.log('\n🚀 Permission Gate Test Suite')
  console.log('='.repeat(60))

  try {
    await testRiskScorerFunctions()
    await testPermissionGateModes()
    await testCheckAsync()
    await testConvenienceFunctions()
    await testModeSwitching()
    await testApprovalWorkflow()

    console.log('\n' + '='.repeat(60))
    console.log('🎉 All Permission Gate tests passed!')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  }
}

main()

process.on('exit', () => {
  if (existsSync(WORKFLOW_TEST_DIR)) {
    rmSync(WORKFLOW_TEST_DIR, { recursive: true, force: true })
  }
})
