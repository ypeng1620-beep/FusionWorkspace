import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { TAORLoop, type Message, type ResponseChunk, type ToolDef } from '../src/agent/taorLoop.js'
import { SessionStore } from '../src/memory/sessionStore.js'
import { DefaultApprovalEventBus } from '../src/protocol/approvalEventBus.js'
import { DefaultLoopController } from '../src/protocol/loopController.js'
import { PermissionWorkflowStore } from '../src/permissions/permissionWorkflow.js'
import { ToolRegistry } from '../src/tools/toolExecutor.js'
import { PermissionPolicyEngine } from '../src/permissions/permissionPolicyEngine.js'

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `taor-reliability-test-${Date.now()}`)
if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true })
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
  console.log(`  OK ${message}`)
}

function section(name: string): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('='.repeat(60))
}

section('TAOR Reliability Tests')

const noopTools: ToolDef[] = []

async function testRetryAndAudit() {
  console.log('\n1. LLM retry and audit...')
  let attempts = 0
  const llmCaller = async function* (): AsyncGenerator<ResponseChunk, void, unknown> {
    attempts += 1
    if (attempts === 1) {
      throw new Error('transient failure')
    }

    yield {
      type: 'done',
      text: 'Recovered after retry',
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 6 },
    }
  }

  const loop = new TAORLoop({
    initialPrompt: 'retry me',
    tools: noopTools,
    llmCaller,
    llmRetryAttempts: 2,
    llmRetryBaseMs: 1,
    maxSteps: 2,
  })

  let resultText = ''
  for await (const event of loop.run()) {
    if (event.type === 'done') {
      resultText = event.result.finalText
      assert((event.result.runtimeAudit?.length ?? 0) >= 2, 'should generate runtime audit')
      assert((event.result.totalTokens?.input ?? 0) >= 12, 'should accumulate input tokens')
    }
  }

  assert(attempts === 2, 'should retry once after transient failure')
  assert(resultText === 'Recovered after retry', 'should return the recovered result after retry')
}

async function testBudgetAndSessionPersistence() {
  console.log('\n2. budget control and session persistence...')
  const sessionStore = new SessionStore({ rootDir: TEST_DIR })
  const registry = new ToolRegistry('bypass', { cwd: TEST_DIR })

  const llmCaller = async function* (): AsyncGenerator<ResponseChunk, void, unknown> {
    yield {
      type: 'done',
      text: 'x'.repeat(120),
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 80 },
    }
  }

  const loop = new TAORLoop({
    initialPrompt: 'persist me',
    tools: noopTools,
    llmCaller,
    sessionId: 'session-budget',
    sessionStore,
    toolRegistry: registry,
    maxOutputTokens: 20,
  })

  let resultStopReason = ''
  for await (const event of loop.run()) {
    if (event.type === 'done') {
      resultStopReason = event.result.stopReason ?? ''
      assert((event.result.runtimeAudit ?? []).some(item => item.phase === 'budget'), 'should record budget audit entry')
    }
  }

  const snapshot = await sessionStore.getSnapshot('session-budget')
  assert(resultStopReason === 'end_turn', 'should warn on output budget but still keep final result')
  assert(snapshot !== null, 'should persist session snapshot')
  assert((snapshot?.runtimeAudit?.length ?? 0) > 0, 'snapshot should preserve runtime audit')
  assert((snapshot?.totalTokens?.output ?? 0) >= 80, 'snapshot should preserve token usage')
}

async function testEventModeApprovalResume() {
  console.log('\n3. event approval resume flow...')
  const workflow = new PermissionWorkflowStore({
    rootDir: join(TEST_DIR, 'permissions'),
  })
  const registry = new ToolRegistry('default', { cwd: TEST_DIR }, workflow)
  const approvalBus = new DefaultApprovalEventBus()
  const loopController = new DefaultLoopController()
  const seenRequests: string[] = []

  approvalBus.onApprovalNeeded((event) => {
    seenRequests.push(event.requestId)
    setTimeout(() => {
      loopController.resume(event.requestId, true)
      approvalBus.emitApprovalResolved({
        requestId: event.requestId,
        approved: true,
        sessionId: event.sessionId,
        timestamp: Date.now(),
      })
    }, 5)
  })

  const llmCaller = async function* (messages: Message[]): AsyncGenerator<ResponseChunk, void, unknown> {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage?.role === 'user' &&
      typeof lastMessage.content === 'object' &&
      !Array.isArray(lastMessage.content) &&
      'type' in lastMessage.content &&
      lastMessage.content.type === 'tool_result'
    ) {
      yield {
        type: 'done',
        text: 'Approval flow recovered',
        stop_reason: 'end_turn',
      }
      return
    }

    yield {
      type: 'content_block',
      content: {
        type: 'tool_use',
        id: 'tool-approval-test',
        name: 'write_file',
        input: {
          path: join(TEST_DIR, 'event-mode.txt'),
          content: 'approved write',
        },
      },
    }
  }

  const loop = new TAORLoop({
    initialPrompt: 'write after approval',
    tools: [
      {
        name: 'write_file',
        description: 'Write file content',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
    ],
    llmCaller,
    toolRegistry: registry,
    approvalMode: 'event',
    approvalEventBus: approvalBus,
    loopController,
    sessionId: 'session-event-approval',
    maxSteps: 2,
  })

  let sawConfirmationNeeded = false
  let finalText = ''
  for await (const event of loop.run()) {
    if (event.type === 'confirmation_needed') {
      sawConfirmationNeeded = true
    }
    if (event.type === 'done') {
      finalText = event.result.finalText
    }
  }

  assert(sawConfirmationNeeded, 'event mode should emit confirmation_needed')
  assert(seenRequests.length === 1, 'approval bus should receive exactly one approval request')
  assert(finalText === 'Approval flow recovered', 'approved event flow should resume and complete the turn')
}

async function testToolRegistryReceivesLoopIdentityForPolicy() {
  console.log('\n4. tool registry receives loop identity for policy...')
  const policyEngine = new PermissionPolicyEngine()
  policyEngine.registerUserPolicy({
    userId: 'blocked-user',
    role: 'editor',
    extraAllowedTools: [],
    extraBlockedTools: ['write_file'],
    trustedDirectories: [],
    trustLevel: 0.2,
  })
  const deniedPath = join(TEST_DIR, 'taor-policy-denied.txt')
  const registry = new ToolRegistry('bypass', {
    cwd: TEST_DIR,
    channel: 'websocket',
  }, null, policyEngine)

  const llmCaller = async function* (messages: Message[]): AsyncGenerator<ResponseChunk, void, unknown> {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage?.role === 'user' &&
      typeof lastMessage.content === 'object' &&
      !Array.isArray(lastMessage.content) &&
      'type' in lastMessage.content &&
      lastMessage.content.type === 'tool_result'
    ) {
      yield {
        type: 'done',
        text: 'policy checked',
        stop_reason: 'end_turn',
      }
      return
    }

    yield {
      type: 'content_block',
      content: {
        type: 'tool_use',
        id: 'tool-policy-test',
        name: 'write_file',
        input: {
          path: deniedPath,
          content: 'must not be written',
        },
      },
    }
  }

  const loop = new TAORLoop({
    initialPrompt: 'try policy denied write',
    tools: [{
      name: 'write_file',
      description: 'Write file content',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    }],
    llmCaller,
    toolRegistry: registry,
    sessionId: 'session-policy-taor',
    userId: 'blocked-user',
    channel: 'websocket',
    maxSteps: 2,
  })

  let finalText = ''
  for await (const event of loop.run()) {
    if (event.type === 'done') {
      finalText = event.result.finalText
    }
  }

  assert(finalText === 'policy checked', 'loop should continue after policy-denied tool result')
  assert(!existsSync(deniedPath), 'policy denied write should not create file')
}

async function testSharedToolRegistryKeepsLoopIdentityIsolated() {
  console.log('\n5. shared tool registry keeps loop identity isolated...')
  const policyEngine = new PermissionPolicyEngine()
  policyEngine.registerUserPolicy({
    userId: 'blocked-shared-user',
    role: 'editor',
    extraAllowedTools: [],
    extraBlockedTools: ['write_file'],
    trustedDirectories: [],
    trustLevel: 0.2,
  })

  const deniedPath = join(TEST_DIR, 'shared-registry-denied.txt')
  const registry = new ToolRegistry('bypass', {
    cwd: TEST_DIR,
    channel: 'websocket',
  }, null, policyEngine)

  const makeCaller = (toolId: string, path: string) => async function* (messages: Message[]): AsyncGenerator<ResponseChunk, void, unknown> {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage?.role === 'user' &&
      typeof lastMessage.content === 'object' &&
      !Array.isArray(lastMessage.content) &&
      'type' in lastMessage.content &&
      lastMessage.content.type === 'tool_result'
    ) {
      yield {
        type: 'done',
        text: 'tool completed',
        stop_reason: 'end_turn',
      }
      return
    }

    yield {
      type: 'content_block',
      content: {
        type: 'tool_use',
        id: toolId,
        name: 'write_file',
        input: {
          path,
          content: 'must not be written by blocked user',
        },
      },
    }
  }

  const blockedLoop = new TAORLoop({
    initialPrompt: 'blocked user attempts write',
    tools: [{
      name: 'write_file',
      description: 'Write file content',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    }],
    llmCaller: makeCaller('tool-shared-blocked', deniedPath),
    toolRegistry: registry,
    sessionId: 'session-shared-blocked',
    userId: 'blocked-shared-user',
    channel: 'websocket',
    maxSteps: 2,
  })

  new TAORLoop({
    initialPrompt: 'allowed user created after blocked loop',
    tools: [],
    llmCaller: async function* (): AsyncGenerator<ResponseChunk, void, unknown> {
      yield { type: 'done', text: 'idle', stop_reason: 'end_turn' }
    },
    toolRegistry: registry,
    sessionId: 'session-shared-allowed',
    userId: 'allowed-shared-user',
    channel: 'websocket',
    maxSteps: 1,
  })

  for await (const event of blockedLoop.run()) {
    if (event.type === 'done') {
      assert(event.result.finalText === 'tool completed', 'blocked loop should complete after denied tool result')
    }
  }

  assert(!existsSync(deniedPath), 'shared registry should not let a later loop overwrite blocked user identity')
}

async function main() {
  console.log('\nTAOR Reliability Test Suite')
  console.log('='.repeat(60))

  try {
    await testRetryAndAudit()
    await testBudgetAndSessionPersistence()
    await testEventModeApprovalResume()
    await testToolRegistryReceivesLoopIdentityForPolicy()
    await testSharedToolRegistryKeepsLoopIdentityIsolated()
    console.log('\n' + '='.repeat(60))
    console.log('All TAOR Reliability tests passed!')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  } finally {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
      console.log(`\nCleaned up TAOR test directory: ${TEST_DIR}`)
    }
  }
}

main()
