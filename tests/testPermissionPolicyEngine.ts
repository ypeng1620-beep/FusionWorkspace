import { PermissionPolicyEngine } from '../src/permissions/permissionPolicyEngine.js'
import { loadPermissionPolicyEngineFromFixture } from '../src/permissions/permissionPolicyFixtures.js'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `permission-policy-engine-${Date.now()}`)
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

section('Permission Policy Engine Tests')

async function testUserExtraBlockedToolsOverrideChannelAllow(): Promise<void> {
  console.log('\n1. user-level block overrides channel allow...')
  const engine = new PermissionPolicyEngine()
  engine.registerUserPolicy({
    userId: 'operator-1',
    role: 'editor',
    extraAllowedTools: [],
    extraBlockedTools: ['write_file'],
    trustedDirectories: [],
    trustLevel: 0.8,
  })

  const decision = engine.evaluate({
    userId: 'operator-1',
    channel: 'websocket',
    role: 'editor',
    isFirstInteraction: false,
    trustLevel: 0.8,
  }, 'write_file', 'write', 3)

  assert(decision.allowed === false, 'user-level blocked tool is denied even when channel allows writes')
  assert(decision.appliedPolicy === 'user:operator-1', 'decision identifies user policy as applied policy')
  assert(decision.requiresApproval === false, 'blocked tool does not become an approval request')
}

async function testUnknownChannelDefaultsToReadOnly(): Promise<void> {
  console.log('\n2. unknown channel defaults to read-only...')
  const engine = new PermissionPolicyEngine()

  const readDecision = engine.evaluate({
    userId: 'guest-1',
    channel: 'unknown-chat',
    role: 'guest',
    isFirstInteraction: true,
    trustLevel: 0,
  }, 'read_file', 'read', 1)

  const writeDecision = engine.evaluate({
    userId: 'guest-1',
    channel: 'unknown-chat',
    role: 'guest',
    isFirstInteraction: true,
    trustLevel: 0,
  }, 'write_file', 'write', 3)

  assert(readDecision.allowed === true, 'unknown channel can read')
  assert(writeDecision.allowed === false, 'unknown channel cannot write')
  assert(writeDecision.mode === 'auto', 'unknown channel uses conservative auto mode')
}

async function testPolicyFixtureLoadsPolicies(): Promise<void> {
  console.log('\n3. policy fixture loads channel and user policies...')
  const fixturePath = join(TEST_DIR, 'policy-fixture.json')
  writeFileSync(fixturePath, JSON.stringify({
    schemaVersion: 'permission-policy-fixture-0.1.0',
    channelPolicies: [{
      channelId: 'wechat',
      defaultMode: 'restricted',
      allowedCategories: ['read', 'write'],
      blockedTools: ['execute_command'],
      maxToolCallsPerTurn: 3,
      approvalThreshold: 2,
      allowFileOperations: true,
      allowShellCommands: false,
      maxMessageLength: 1024,
      dailyCallLimit: 20,
    }],
    userPolicies: [{
      userId: 'wechat-operator',
      role: 'viewer',
      overrideMode: 'restricted',
      extraAllowedTools: ['read_file'],
      extraBlockedTools: ['write_file'],
      trustedDirectories: [],
      trustLevel: 0.4,
    }],
    groupPolicies: [],
  }, null, 2), 'utf8')

  const engine = loadPermissionPolicyEngineFromFixture(fixturePath)
  const writeDecision = engine.evaluate({
    userId: 'wechat-operator',
    channel: 'wechat',
    role: 'viewer',
    isFirstInteraction: false,
    trustLevel: 0.4,
  }, 'write_file', 'write', 3)
  const shellDecision = engine.evaluate({
    userId: 'other-user',
    channel: 'wechat',
    role: 'guest',
    isFirstInteraction: true,
    trustLevel: 0,
  }, 'execute_command', 'execute', 6)

  assert(writeDecision.allowed === false, 'fixture user policy blocks write_file')
  assert(writeDecision.appliedPolicy === 'user:wechat-operator', 'fixture decision uses user policy')
  assert(shellDecision.allowed === false, 'fixture channel policy blocks shell command')
  assert(shellDecision.mode === 'restricted', 'fixture channel policy sets effective mode')
}

async function testPolicyFixtureRejectsUnsupportedSchema(): Promise<void> {
  console.log('\n4. policy fixture rejects unsupported schema...')
  const fixturePath = join(TEST_DIR, 'bad-policy-fixture.json')
  writeFileSync(fixturePath, JSON.stringify({
    schemaVersion: 'permission-policy-fixture-9.9.9',
    channelPolicies: [],
    userPolicies: [],
    groupPolicies: [],
  }, null, 2), 'utf8')

  try {
    loadPermissionPolicyEngineFromFixture(fixturePath)
    assert(false, 'unsupported fixture schema should be rejected')
  } catch (error) {
    assert(error instanceof Error, 'unsupported fixture schema throws Error')
    assert(error.message.includes('Unsupported permission policy fixture schema'), 'schema error is explicit')
  }
}

async function main(): Promise<void> {
  console.log('\nPermission Policy Engine Test Suite')
  console.log('='.repeat(60))

  try {
    await testUserExtraBlockedToolsOverrideChannelAllow()
    await testUnknownChannelDefaultsToReadOnly()
    await testPolicyFixtureLoadsPolicies()
    await testPolicyFixtureRejectsUnsupportedSchema()
    console.log('\n' + '='.repeat(60))
    console.log('All Permission Policy Engine tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()

process.on('exit', () => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})
