/**
 * DuoAgent integration tests — covers coordinator session lifecycle,
 * external reviewer context building, suggestion filtering, audit trails,
 * and the full review→filter→apply cycle.
 */

import { DuoAgent } from '../src/agent/duoAgent.js'
import { ExternalReviewer, buildReviewContext } from '../src/agent/externalReviewer.js'
import { createMockProvider } from '../src/llm/llmProvider.js'
import { PhoenixCore } from '../src/orchestrator/phoenixCore.js'
import { PhoenixAuditStore } from '../src/orchestrator/phoenixAudit.js'
import type { ReviewContext, ReviewSuggestion } from '../src/agent/externalReviewer.js'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
  console.log(`  ok ${message}`)
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message ?? 'equality check'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
  console.log(`  ok ${message ?? 'equality check'}`)
}

function section(name: string): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('='.repeat(60))
}

function makeDuoAgent(opts?: { phoenixCore?: PhoenixCore; auditStore?: PhoenixAuditStore; autoApply?: boolean }) {
  const local = createMockProvider({ name: 'local-mock' })
  const review = createMockProvider({ name: 'review-mock', model: 'review-model-1' })
  return new DuoAgent({
    localProvider: local,
    reviewProvider: review,
    phoenixCore: opts?.phoenixCore,
    auditStore: opts?.auditStore,
    autoApply: opts?.autoApply,
  })
}

function makeMock(name: string, model?: string) {
  return createMockProvider({ name, model })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

section('DuoAgent Tests')

// === buildReviewContext ===

console.log('\n1. buildReviewContext redaction...')

{
  const ctx = buildReviewContext({
    task: 'Use api_key=sk-1234567890abcdef to access',
    architectureSummary: 'Standard three-tier',
    changedFiles: [],
  })
  assert(ctx.task.includes('[REDACTED_API_KEY]'), 'API key should be redacted')
  assert(!ctx.task.includes('sk-1234567890abcdef'), 'raw key must not appear')
}

{
  const ctx = buildReviewContext({
    task: 'Refactor auth',
    architectureSummary: 'secret=supersecretvalue embedded in config',
    changedFiles: [],
  })
  assert(ctx.architectureSummary.includes('[REDACTED_SECRET]'), 'secret should be redacted')
}

{
  const ctx = buildReviewContext({
    task: 'token=ghp_abc123def456ghi789jkl',
    architectureSummary: 'Standard',
    changedFiles: [],
  })
  assert(ctx.task.includes('[REDACTED_TOKEN]'), 'token should be redacted')
}

{
  const ctx = buildReviewContext({
    task: 'Deploy config',
    architectureSummary: 'Service layout',
    changedFiles: [{ path: '/home/alice/.ssh/id_rsa', summary: 'SSH key' }],
  })
  const fp = ctx.changedFiles[0]!.path
  assert(fp.includes('[user]'), 'home user should be redacted')
  assert(!fp.includes('alice'), 'username must not appear')
}

{
  const ctx = buildReviewContext({
    task: 'Test',
    architectureSummary: 'Test',
    changedFiles: [],
  })
  assertEqual(ctx.boundaryContractVersion, '1.0.0', 'default boundary contract version is 1.0.0')
}

// === Session lifecycle ===

console.log('\n2. Session lifecycle...')

{
  const duo = makeDuoAgent()
  const session = duo.startSession('Refactor auth module', 'Monolithic to microservices')
  assert(session.id.startsWith('duo-'), 'session id has duo prefix')
  assertEqual(session.task, 'Refactor auth module', 'session stores task')
  assertEqual(session.reviewHistory.length, 0, 'session starts with empty review history')
  assertEqual(session.auditTrail.length, 0, 'session starts with empty audit trail')
  assert(session.startedAt > 0, 'startedAt is set')
}

{
  const duo = makeDuoAgent()
  const session = duo.startSession('Task A', 'Summary A')
  const found = duo.getSession(session.id)
  assert(found !== undefined, 'getSession returns session')
  assertEqual(found!.id, session.id, 'session id matches')
}

{
  const duo = makeDuoAgent()
  assert(duo.getSession('nonexistent') === undefined, 'unknown session returns undefined')
}

{
  const duo = makeDuoAgent()
  duo.startSession('Task 1', 'Arch 1')
  duo.startSession('Task 2', 'Arch 2')
  assertEqual(duo.getSessions().length, 2, 'getSessions lists both sessions')
}

{
  const duo = makeDuoAgent()
  const session = duo.startSession('Task', 'Arch')
  duo.closeSession(session.id)
  assert(duo.getSession(session.id) === undefined, 'closed session is removed')
}

// === acceptSuggestion / deferSuggestion ===

console.log('\n3. Suggestion disposition...')

{
  const duo = makeDuoAgent()
  const session = duo.startSession('Task', 'Arch')
  duo.acceptSuggestion(session.id, 'sug-1', 'Looks good')
  const s = duo.getSession(session.id)!
  assertEqual(s.auditTrail.length, 1, 'accept creates one audit entry')
  assertEqual(s.auditTrail[0]!.suggestionId, 'sug-1', 'entry has correct suggestion id')
  assertEqual(s.auditTrail[0]!.action, 'accepted', 'entry action is accepted')
}

{
  const duo = makeDuoAgent()
  const session = duo.startSession('Task', 'Arch')
  duo.deferSuggestion(session.id, 'sug-2', 'Need more context')
  const s = duo.getSession(session.id)!
  assertEqual(s.auditTrail.length, 1, 'defer creates one audit entry')
  assertEqual(s.auditTrail[0]!.action, 'deferred', 'entry action is deferred')
}

{
  const duo = makeDuoAgent()
  duo.acceptSuggestion('nonexistent', 'sug-1', 'ok')
  console.log('  ok accept on unknown session is a no-op')
}

// === ExternalReviewer with mock provider ===

console.log('\n4. ExternalReviewer with mock provider...')

{
  const mock = makeMock('ext-reviewer', 'ext-model-1')
  const reviewer = new ExternalReviewer({ provider: mock })
  const ctx: ReviewContext = {
    task: 'Refactor auth',
    architectureSummary: 'Express middleware',
    changedFiles: [{ path: 'src/auth.ts', summary: 'JWT helpers' }],
    testFailures: [],
    boundaryContractVersion: '1.0.0',
  }
  const result = await reviewer.review(ctx)
  assertEqual(typeof result.overallAssessment, 'string', 'result has overall assessment')
  assert(Array.isArray(result.suggestions), 'suggestions is an array')
  assertEqual(result.reviewerModel, 'ext-model-1', 'model matches provider')
  assert(result.timestamp > 0, 'timestamp is set')
}

// === filterSuggestions ===

console.log('\n5. filterSuggestions...')

{
  const mock = makeMock('filter-test')
  const reviewer = new ExternalReviewer({ provider: mock })
  const suggestions: ReviewSuggestion[] = [
    { id: 's1', category: 'correctness', severity: 'warning', summary: 'Fix null check', detail: '' },
    { id: 's2', category: 'style', severity: 'info', summary: 'Use const', detail: '' },
  ]
  const { allowed, rejected } = reviewer.filterSuggestions(suggestions)
  assertEqual(allowed.length, 2, 'all suggestions allowed without Phoenix')
  assertEqual(rejected.length, 0, 'no rejected suggestions without Phoenix')
}

{
  const phoenix = new PhoenixCore({ mode: 'enforce' })
  const mock = makeMock('filter-enforce')
  const reviewer = new ExternalReviewer({ provider: mock, phoenixCore: phoenix })
  const suggestions: ReviewSuggestion[] = [
    { id: 's1', category: 'security', severity: 'critical', summary: 'Bypass permission gate', detail: 'Remove auth' },
    { id: 's2', category: 'style', severity: 'info', summary: 'Use const', detail: '' },
  ]
  const { allowed, rejected } = reviewer.filterSuggestions(suggestions)
  assert(rejected.length > 0, 'bypass suggestion is rejected by Phoenix')
  assert(allowed.some(s => s.id === 's2'), 'harmless suggestion is allowed')
}

{
  const mock = makeMock('filter-empty')
  const reviewer = new ExternalReviewer({ provider: mock })
  const { allowed, rejected } = reviewer.filterSuggestions([])
  assertEqual(allowed.length, 0, 'empty suggestions produce empty allowed')
  assertEqual(rejected.length, 0, 'empty suggestions produce empty rejected')
}

// === Audit trail ===

console.log('\n6. Audit trail...')

{
  const mock = makeMock('audit-reviewer')
  const reviewer = new ExternalReviewer({ provider: mock })
  reviewer.recordAudit({
    reviewId: 'r1',
    suggestionId: 's1',
    action: 'accepted',
    reason: 'Correct fix',
    timestamp: Date.now(),
  })
  const trail = reviewer.getAuditTrail()
  assertEqual(trail.length, 1, 'audit trail has one entry')
  assertEqual(trail[0]!.action, 'accepted', 'entry records accepted action')
}

{
  const store = new PhoenixAuditStore()
  const local = makeMock('local-audit')
  const review = makeMock('review-audit')
  const duo = new DuoAgent({
    localProvider: local,
    reviewProvider: review,
    auditStore: store,
  })
  const session = duo.startSession('Task', 'Arch')
  duo.acceptSuggestion(session.id, 'sug-audit', 'Good suggestion')
  const trail = duo.getAuditTrail()
  assert(trail.length >= 1, 'reviewer audit trail has entry from acceptSuggestion')
}

// === runCycle ===

console.log('\n7. DuoAgent runCycle...')

{
  const duo = makeDuoAgent()
  const session = duo.startSession('Test task', 'Test arch')
  const gen = duo.runCycle(session.id, [{ path: 'src/test.ts', summary: 'Added test' }])
  const first = await gen.next()
  assert(!first.done, 'runCycle yields at least one iteration')
  assert(first.value!.iteration >= 1, 'iteration is positive')
  assert(Array.isArray(first.value!.allowed), 'allowed is an array')
  assert(Array.isArray(first.value!.rejected), 'rejected is an array')
  console.log(`  ok runCycle assessment: ${first.value!.result.overallAssessment}`)
}

console.log(`\n${'='.repeat(60)}`)
console.log('  All DuoAgent tests passed')
console.log('='.repeat(60))
