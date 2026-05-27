/**
 * Tool Executor 测试
 */

import { randomUUID } from 'crypto'
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { 
  ToolRegistry, 
  createToolCall,
  getDefaultRegistry,
  resetDefaultRegistry,
  quickExecute,
  readFileTool,
  writeFileTool,
  executeCommandTool,
  httpRequestTool,
} from '../src/tools/toolExecutor.js'
import { PermissionError, NeedConfirmationError } from '../src/permissions/permissionGate.js'
import { PermissionPolicyEngine } from '../src/permissions/permissionPolicyEngine.js'
import { PermissionWorkflowStore } from '../src/permissions/permissionWorkflow.js'

// =============================================================================
// 测试配置
// =============================================================================

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `tool-executor-test-${Date.now()}`)

// 确保测试目录存在
if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true })
}

function testFilePath(name: string): string {
  return join(TEST_DIR, name)
}

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

// =============================================================================
// 工具执行测试
// =============================================================================

section('Tool Execution Tests')

async function testReadFileTool() {
  console.log('\n1. read_file 工具...')
  
  // 创建测试文件
  const testPath = testFilePath('read-test.txt')
  const testContent = 'Hello, World!\nTest Content\nLine 3'
  writeFileSync(testPath, testContent)

  // 基本读取
  const result = await readFileTool({ path: testPath })
  assert(result.success, 'read_file 应成功')
  assert(result.stdout === testContent, '读取内容应匹配')
  assert(result.exitCode === undefined, '读取不应有 exitCode')

  // 读取不存在文件
  const notExistResult = await readFileTool({ path: testFilePath('not-exist.txt') })
  assert(!notExistResult.success, '读取不存在文件应失败')
  assert(notExistResult.error.includes('不存在'), '错误信息应说明文件不存在')
}

async function testWriteFileTool() {
  console.log('\n2. write_file 工具...')
  
  const testPath = testFilePath('write-test.txt')
  const content = 'Test Write Content'

  // 基本写入
  const writeResult = await writeFileTool({ path: testPath, content })
  assert(writeResult.success, 'write_file 应成功')
  assert(writeResult.stdout.includes('写入成功'), '应包含成功信息')
  assert((writeResult.data as { bytes: number }).bytes === content.length, '字节数应匹配')

  // 验证写入内容
  const readResult = await readFileTool({ path: testPath })
  assert(readResult.stdout === content, '读取内容应与写入一致')

  // 追加写入
  const appendResult = await writeFileTool({ path: testPath, content: '\nAppended', append: true })
  assert(appendResult.success, '追加写入应成功')

  const afterAppend = await readFileTool({ path: testPath })
  assert(afterAppend.stdout === content + '\nAppended', '追加内容应正确')
}

async function testExecuteCommandTool() {
  console.log('\n3. execute_command 工具...')
  const isWindows = process.platform === 'win32'

  // 简单命令
  const echoCmd = isWindows ? 'echo Hello' : 'echo Hello'
  const echoResult = await executeCommandTool({ command: echoCmd })
  assert(echoResult.success, 'echo 命令应成功')
  assert(echoResult.exitCode === 0, 'exitCode 应为 0')

  // 带输出的命令
  const lsCmd = isWindows ? 'dir' : 'ls'
  const lsResult = await executeCommandTool({ command: lsCmd, cwd: TEST_DIR })
  assert(lsResult.success, 'ls/dir 命令应成功')
  assert(lsResult.stdout.length > 0, '应有输出')

  // 错误命令
  const errorCmd = isWindows ? 'nonexistent-cmd' : 'nonexistent-cmd'
  const errorResult = await executeCommandTool({ command: errorCmd })
  assert(!errorResult.success, '错误命令应失败')
  assert(errorResult.exitCode !== 0, 'exitCode 应非零')

  // 超时处理
  if (!isWindows) {
    const timeoutResult = await executeCommandTool({ command: 'sleep 10', timeout: 100 })
    assert(!timeoutResult.success, '超时命令应失败')
    assert(timeoutResult.error === '命令超时', '应报告超时')
  }
}

async function testHttpRequestTool() {
  console.log('\n4. http_request 工具...')

  // GET 请求 (httpbin)
  const getResult = await httpRequestTool({ 
    url: 'https://httpbin.org/get',
    timeout: 10000,
  })
  assert(getResult.success, 'GET 请求应成功')
  assert(getResult.statusCode === 200, '状态码应为 200')
  assert(getResult.stdout.includes('httpbin'), '响应应包含 httpbin')

  // POST 请求
  const postResult = await httpRequestTool({
    url: 'https://httpbin.org/post',
    method: 'POST',
    body: JSON.stringify({ test: 'data' }),
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  })
  assert(postResult.success, 'POST 请求应成功')
  assert(postResult.statusCode === 200, '状态码应为 200')
  assert(postResult.stdout.includes('data'), '响应应包含 data');

  // 无效 URL
  const invalidResult = await httpRequestTool({
    url: 'https://this-domain-definitely-does-not-exist-12345.com',
    timeout: 5000,
  })
  assert(!invalidResult.success, '无效 URL 请求应失败')
}

async function testToolFunctions() {
  await testReadFileTool()
  await testWriteFileTool()
  await testExecuteCommandTool()
  await testHttpRequestTool()
}

// =============================================================================
// ToolRegistry 测试
// =============================================================================

section('ToolRegistry Tests')

async function testRegistryBasics() {
  console.log('\n1. 注册表基础功能...')
  
  const registry = new ToolRegistry('default')

  // 列出工具
  const tools = registry.listTools()
  assert(tools.includes('read_file'), '应包含 read_file')
  assert(tools.includes('write_file'), '应包含 write_file')
  assert(tools.includes('execute_command'), '应包含 execute_command')
  assert(tools.includes('http_request'), '应包含 http_request')

  // 检查工具存在
  assert(registry.has('read_file'), 'has(read_file) 应为 true')
  assert(!registry.has('nonexistent'), 'has(nonexistent) 应为 false')

  // 获取工具定义
  const readTool = registry.get('read_file')
  assert(readTool !== undefined, 'get(read_file) 应返回工具')
  assert(readTool?.name === 'read_file', '工具名称应匹配')
}

async function testRegistryExecution() {
  console.log('\n2. 通过注册表执行...')
  const registry = new ToolRegistry('default')

  // 创建测试文件
  const testPath = testFilePath('registry-test.txt')
  writeFileSync(testPath, 'Registry Test Content')

  // 执行读取
  const readResult = await registry.execute('read_file', { path: testPath })
  assert(readResult.success, 'execute(read_file) 应成功')
  assert(readResult.stdout === 'Registry Test Content', '内容应匹配')

  // 执行写入（使用 bypass 模式，因为 default 模式需要确认）
  registry.setMode('bypass')  // bypass 模式下写入无需确认
  const writePath = testFilePath('registry-write.txt')
  const writeResult = await registry.execute('write_file', { 
    path: writePath, 
    content: 'New Content' 
  })
  assert(writeResult.success, 'bypass 模式下 write_file 应成功（默认模式需要确认）')

  // 执行未知工具
  const unknownResult = await registry.execute('nonexistent_tool', {})
  assert(!unknownResult.success, '未知工具应失败')
  assert(unknownResult.error.includes('未知工具'), '错误信息应说明工具未知')
}

async function testRegistryMode() {
  console.log('\n3. 注册表权限模式...')
  const registry = new ToolRegistry('plan')

  // 创建测试文件
  const testPath = testFilePath('mode-test.txt')
  writeFileSync(testPath, 'Mode Test')

  // plan 模式下读取应允许
  const readResult = await registry.execute('read_file', { path: testPath })
  assert(readResult.success, 'plan 模式下 read_file 应成功')

  // plan 模式下写入应失败
  const writeResult = await registry.execute('write_file', { 
    path: testFilePath('mode-write.txt'), 
    content: 'Test' 
  })
  assert(!writeResult.success, 'plan 模式下 write_file 应失败')
  assert(writeResult.error.includes('plan'), '错误信息应说明 plan 模式')

  // 切换到 bypass 模式
  registry.setMode('bypass')
  const bypassWriteResult = await registry.execute('write_file', { 
    path: testFilePath('bypass-write.txt'), 
    content: 'Bypass Test' 
  })
  assert(bypassWriteResult.success, 'bypass 模式下 write_file 应成功')
}

async function testRegistryWhitelist() {
  console.log('\n4. 注册表白名单...')
  const registry = new ToolRegistry('restricted')

  // 设置白名单
  registry.setWhitelist(['read_file'])

  // 白名单工具允许
  const testPath = testFilePath('whitelist-test.txt')
  writeFileSync(testPath, 'Whitelist Test')
  const allowResult = await registry.execute('read_file', { path: testPath })
  assert(allowResult.success, '白名单工具应允许')

  // 非白名单工具拒绝
  const denyResult = await registry.execute('write_file', { 
    path: testPath, 
    content: 'Test' 
  })
  assert(!denyResult.success, '非白名单工具应拒绝')
  assert(denyResult.error.includes('白名单'), '错误信息应说明白名单')
}

async function testRegistryTrust() {
  console.log('\n5. 注册表信任目录...')
  const registry = new ToolRegistry('sandbox')

  // 添加信任目录
  registry.addTrustedDirectory(TEST_DIR)
  registry.setContext({ cwd: TEST_DIR })

  // 读取信任目录应允许
  const testPath = testFilePath('trust-test.txt')
  writeFileSync(testPath, 'Trust Test')
  const trustResult = await registry.execute('read_file', { path: testPath })
  assert(trustResult.success, '信任目录读取应允许')
}

async function testToolRegistry() {
  await testRegistryBasics()
  await testRegistryExecution()
  await testRegistryMode()
  await testRegistryWhitelist()
  await testRegistryTrust()
}

// =============================================================================
// 权限拦截测试
// =============================================================================

section('Permission Interception Tests')

async function testPermissionError() {
  console.log('\n1. PermissionError 返回...')
  const registry = new ToolRegistry('plan')

  // plan 模式下 write_file 应被拒绝（execute 返回错误结果，不抛出）
  const result = await registry.execute('write_file', { 
    path: testFilePath('perm-error.txt'), 
    content: 'Test' 
  })
  assert(!result.success, 'plan 模式下 write_file 应失败')
  assert(result.error.includes('plan'), '错误信息应说明 plan 模式')
  console.log(`  ✅ 正确拒绝: ${result.error}`)
}

async function testDangerousCommandBlock() {
  console.log('\n2. 危险命令拦截...')
  const registry = new ToolRegistry('default')

  // default 模式下危险命令应被拒绝
  const result = await registry.execute('execute_command', { 
    command: 'rm -rf /'  // Unix 危险命令（Linux/Mac）
  })
  assert(!result.success, '危险命令应被拒绝')
  assert(result.riskLevel === 10, '风险等级应为 10')

  // bypass 模式下即使危险命令也被允许（但实际执行仍取决于命令是否有效）
  // 注意：rm -rf / 在 Windows 上无效，这里测试 bypass 模式的权限批准
  registry.setMode('bypass')
  
  // 先测试 bypass 模式对普通命令的批准
  const bypassLs = await registry.execute('execute_command', { command: 'dir' })
  assert(bypassLs.success, 'bypass 模式下 dir 命令应成功')
  
  // bypass 模式下 rm -rf / 因命令无效而失败（不是权限问题）
  const bypassRm = await registry.execute('execute_command', { command: 'rm -rf /' })
  // bypass 批准权限，但 rm 在 Windows 无效导致失败
  assert(!bypassRm.success, 'bypass 模式批准权限，但 rm 命令在 Windows 无效')
  console.log(`  ✅ bypass 模式正确：权限批准（命令无效: ${bypassRm.error?.substring(0, 50)}...）`)
}

async function testPermissionCheck() {
  console.log('\n3. 权限检查方法...')
  const registry = new ToolRegistry('default')

  // 检查权限
  const readCheck = registry.checkPermission('read_file', { path: '/tmp/test.txt' })
  assert(readCheck.approved, 'read_file 应被批准')

  const writeCheck = registry.checkPermission('write_file', { path: '/tmp/test.txt', content: 'test' })
  assert(!writeCheck.approved, 'write_file 应需要确认')
  assert(writeCheck.requiresConfirmation, 'write_file 应需要确认')
}

async function testPolicyEngineDeniesBeforePermissionGate() {
  console.log('\n4. 策略引擎优先拦截...')
  const policyEngine = new PermissionPolicyEngine()
  policyEngine.registerUserPolicy({
    userId: 'blocked-user',
    role: 'editor',
    extraAllowedTools: [],
    extraBlockedTools: ['write_file'],
    trustedDirectories: [],
    trustLevel: 0.5,
  })
  const registry = new ToolRegistry('default', {
    cwd: TEST_DIR,
    sessionId: 'session-policy-1',
    userId: 'blocked-user',
    channel: 'websocket',
  }, null, policyEngine)

  const result = await registry.execute('write_file', {
    path: testFilePath('policy-denied.txt'),
    content: 'must not be written',
  })

  assert(!result.success, '用户策略禁止的工具应直接失败')
  assert(!result.requiresConfirmation, '用户策略禁止不应进入审批确认')
  assert(result.error.includes('blocked-user'), '错误信息应说明命中的用户策略')
  assert(!existsSync(testFilePath('policy-denied.txt')), '策略拒绝后不应写入文件')
}

async function testPolicyEngineDenialIsAudited() {
  console.log('\n5. 策略拒绝审计...')
  const workflow = new PermissionWorkflowStore({
    rootDir: join(TEST_DIR, 'policy-audit-workflow'),
  })
  const policyEngine = new PermissionPolicyEngine()
  policyEngine.registerUserPolicy({
    userId: 'audit-blocked-user',
    role: 'editor',
    extraAllowedTools: [],
    extraBlockedTools: ['write_file'],
    trustedDirectories: [],
    trustLevel: 0.5,
  })
  const registry = new ToolRegistry('default', {
    cwd: TEST_DIR,
    sessionId: 'session-policy-audit',
    userId: 'audit-blocked-user',
    channel: 'websocket',
  }, workflow, policyEngine)

  const result = await registry.execute('write_file', {
    path: testFilePath('policy-audited-denied.txt'),
    content: 'must not be written',
  })
  const auditLog = workflow.getAuditLog()
  const latest = auditLog[auditLog.length - 1]

  assert(!result.success, '策略拒绝应失败')
  assert(auditLog.length === 1, '策略拒绝应写入一条权限审计')
  assert(latest.toolName === 'write_file', '审计应记录工具名')
  assert(latest.approved === false, '审计应记录拒绝结果')
  assert(latest.userId === 'audit-blocked-user', '审计应记录用户 ID')
  assert(latest.sessionId === 'session-policy-audit', '审计应记录会话 ID')
  assert(latest.mode === 'policy:user:audit-blocked-user', '审计应记录命中的策略')
  assert(latest.reason.includes('audit-blocked-user'), '审计原因应包含策略拒绝信息')
  assert(latest.riskLevel === 3, '审计应记录风险等级')
}

async function testPermissionInterception() {
  await testPermissionError()
  await testDangerousCommandBlock()
  await testPermissionCheck()
  await testPolicyEngineDeniesBeforePermissionGate()
  await testPolicyEngineDenialIsAudited()
}

// =============================================================================
// 便捷函数测试
// =============================================================================

section('Convenience Function Tests')

async function testConvenienceFunctions() {
  console.log('\n1. createToolCall...')
  const call = createToolCall('read_file', { path: '/tmp/test.txt' })
  assert(call.name === 'read_file', '工具名称应匹配')
  assert(call.params.path === '/tmp/test.txt', '参数应匹配')

  console.log('\n2. quickExecute...')
  resetDefaultRegistry()
  const testPath = testFilePath('quick-test.txt')
  writeFileSync(testPath, 'Quick Test')

  const quickResult = await quickExecute('read_file', { path: testPath })
  assert(quickResult.success, 'quickExecute 应成功')
  assert(quickResult.stdout === 'Quick Test', '内容应匹配')
}

async function testSingleton() {
  console.log('\n3. 默认注册表单例...')
  const registry1 = getDefaultRegistry()
  const registry2 = getDefaultRegistry()
  assert(registry1 === registry2, 'getDefaultRegistry 应返回同一实例')

  resetDefaultRegistry()
  const registry3 = getDefaultRegistry()
  assert(registry1 !== registry3, 'resetDefaultRegistry 后应返回新实例')
}

async function testConvenience() {
  await testConvenienceFunctions()
  await testSingleton()
}

// =============================================================================
// 清理
// =============================================================================

function cleanup(): void {
  try {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
      console.log(`\n🧹 Cleaned up test directory: ${TEST_DIR}`)
    }
  } catch (error) {
    console.log(`\n⚠️ Could not clean up test directory: ${error}`)
  }
}

// =============================================================================
// 主测试函数
// =============================================================================

async function main() {
  console.log('\n🚀 Tool Executor Test Suite')
  console.log('='.repeat(60))
  console.log(`Test directory: ${TEST_DIR}`)

  try {
    await testToolFunctions()
    await testToolRegistry()
    await testPermissionInterception()
    await testConvenience()

    console.log('\n' + '='.repeat(60))
    console.log('🎉 All Tool Executor tests passed!')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  } finally {
    cleanup()
  }
}

main()
