import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { ApprovalService } from '../src/permissions/approvalService.js'
import { PermissionWorkflowStore } from '../src/permissions/permissionWorkflow.js'

const TEST_DIR = join(process.env.TEMP || process.env.TMP || '/tmp', `approval-service-test-${Date.now()}`)
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

section('Approval Service Tests')

async function testWaitAndResolve() {
  console.log('\n1. wait/resolve...')
  const workflow = new PermissionWorkflowStore({ rootDir: TEST_DIR })
  const service = new ApprovalService(workflow)
  const request = workflow.createPendingRequest(
    { name: 'write_file', params: { path: '/tmp/x', content: 'x' } },
    { sessionId: 's1', userId: 'u1', riskLevel: 3, reason: 'needs confirmation' },
  )

  const waiting = service.waitForDecision(request.id, 1000)
  setTimeout(() => {
    service.resolve(request.id, true)
  }, 20)

  const approved = await waiting
  assert(approved, 'resolve(true) 后 waitForDecision 应返回 true')
}

async function testTimeoutDenies() {
  console.log('\n2. timeout deny...')
  const workflow = new PermissionWorkflowStore({ rootDir: TEST_DIR })
  const service = new ApprovalService(workflow)
  const request = workflow.createPendingRequest(
    { name: 'execute_command', params: { command: 'git push' } },
    { sessionId: 's2', userId: 'u2', riskLevel: 6, reason: 'needs confirmation' },
  )

  const approved = await service.waitForDecision(request.id, 10)
  assert(!approved, '超时后应返回 false')
}

async function main() {
  console.log('\n🚀 Approval Service Test Suite')
  console.log('='.repeat(60))

  try {
    await testWaitAndResolve()
    await testTimeoutDenies()
    console.log('\n' + '='.repeat(60))
    console.log('🎉 All Approval Service tests passed!')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  } finally {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
      console.log(`\n🧹 Cleaned up approval service test directory: ${TEST_DIR}`)
    }
  }
}

main()
