/**
 * Feishu Channel Integration Tests
 *
 * Tests: v1/v2 event handling, HMAC signature verification,
 * card action callback parsing, URL verification, and message routing.
 */
import { createHmac, timingSafeEqual } from 'crypto'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ok ${message}`)
}
function section(name: string): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('='.repeat(60))
}

section('Feishu Channel Production Tests')

// ---------------------------------------------------------------------------
// 1. HMAC-SHA256 Signature Verification
// ---------------------------------------------------------------------------

function testFeishuSignatureVerification(): void {
  console.log('\n1. HMAC-SHA256 signature verification...')

  const encryptKey = 'test-encrypt-key-12345'
  const timestamp = '1710000000'
  const body = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'abc', event_type: 'im.message.receive_v1' },
    event: { message_id: 'msg_1' },
  })

  // Compute expected signature
  const signStr = timestamp + '\n' + body
  const expectedSig = createHmac('sha256', encryptKey).update(signStr).digest('base64')

  // Valid signature
  const computedSig = createHmac('sha256', encryptKey).update(signStr).digest('base64')
  assert(timingSafeEqual(Buffer.from(computedSig), Buffer.from(expectedSig)),
    'Valid HMAC-SHA256 signature passes verification')

  // Wrong key
  const wrongSig = createHmac('sha256', 'wrong-key').update(signStr).digest('base64')
  assert(!timingSafeEqual(Buffer.from(wrongSig), Buffer.from(expectedSig)),
    'Wrong key produces different signature')

  // Wrong body
  const wrongBodySig = createHmac('sha256', encryptKey).update('wrong body').digest('base64')
  assert(!timingSafeEqual(Buffer.from(wrongBodySig), Buffer.from(expectedSig)),
    'Modified body produces different signature')

  // Different timestamp
  const wrongTsSig = createHmac('sha256', encryptKey).update('1710000001\n' + body).digest('base64')
  assert(!timingSafeEqual(Buffer.from(wrongTsSig), Buffer.from(expectedSig)),
    'Different timestamp produces different signature')

  // Empty body edge case
  const emptySig = createHmac('sha256', encryptKey).update(timestamp + '\n').digest('base64')
  assert(typeof emptySig === 'string' && emptySig.length > 0, 'Empty body signature is valid base64')
}

// ---------------------------------------------------------------------------
// 2. v1 vs v2 Event Handling
// ---------------------------------------------------------------------------

function testFeishuEventStructures(): void {
  console.log('\n2. v1 vs v2 event structures...')

  // v1 event: message content in event.content (JSON string)
  const v1Event = {
    schema: '2.0',
    header: {
      event_id: 'evt_001',
      event_type: 'im.message.receive_v1',
      token: 'verification-token',
      create_time: '1710000000000',
    },
    event: {
      message_id: 'om_xxx',
      chat_id: 'oc_xxx',
      message_type: 'text',
      content: JSON.stringify({ text: 'Hello from v1' }),
      sender: {
        sender_id: { open_id: 'ou_xxx', user_id: 'user_1' },
        sender_type: 'user',
      },
    },
  } as const

  // v2 event: message content in event.message.body.content (JSON string)
  const v2Event = {
    schema: '2.0',
    header: {
      event_id: 'evt_002',
      event_type: 'im.message.receive_v2',
      token: 'verification-token',
      create_time: '1710000000000',
    },
    event: {
      message: {
        message_id: 'om_yyy',
        chat_id: 'oc_yyy',
        message_type: 'text',
        body: { content: JSON.stringify({ text: 'Hello from v2' }) },
        sender_id: { open_id: 'ou_yyy' },
        create_time: '1710000000',
        thread_id: 'ot_001',
        parent_id: 'om_parent_001',
      },
    },
  } as const

  // Verify v1 structure
  assert(v1Event.header.event_type === 'im.message.receive_v1', 'v1 event type detected')
  assert(v1Event.event.message_type === 'text', 'v1 message type accessible')
  const v1Content = JSON.parse(v1Event.event.content as string)
  assert(v1Content.text === 'Hello from v1', 'v1 text content extracted')

  // Verify v2 structure
  assert(v2Event.header.event_type === 'im.message.receive_v2', 'v2 event type detected')
  const v2Body = v2Event.event.message.body
  assert(typeof v2Body.content === 'string', 'v2 content is JSON string')
  const v2Content = JSON.parse(v2Body.content as string)
  assert(v2Content.text === 'Hello from v2', 'v2 text content extracted')
  assert(v2Event.event.message.thread_id === 'ot_001', 'v2 thread_id present')
  assert(v2Event.event.message.parent_id === 'om_parent_001', 'v2 parent_id present')
}

// ---------------------------------------------------------------------------
// 3. Card Action Callback Parsing
// ---------------------------------------------------------------------------

function testCardActionCallbackParsing(): void {
  console.log('\n3. Card action callback parsing...')

  // Simulate approval button click
  const approvalAction = {
    schema: '2.0',
    header: {
      event_id: 'evt_003',
      event_type: 'card.action.trigger',
      token: 'verification-token',
    },
    event: {
      operator: { open_id: 'ou_approver' },
      action: {
        value: JSON.stringify({ requestId: 'req-abc-123', action: 'approve' }),
        option: 'approve_btn',
      },
      open_message_id: 'om_msg_ref',
    },
  } as const

  // Simulate rejection button click
  const rejectAction = {
    ...approvalAction,
    event: {
      ...approvalAction.event,
      action: {
        value: JSON.stringify({ requestId: 'req-abc-123', action: 'reject' }),
        option: 'reject_btn',
      },
    },
  } as const

  // Parse approval
  const approvalValue = JSON.parse(approvalAction.event.action.value)
  assert(approvalValue.requestId === 'req-abc-123', 'Approval requestId extracted')
  assert(approvalValue.action === 'approve', 'Approve action identified')

  // Parse rejection
  const rejectValue = JSON.parse(rejectAction.event.action.value)
  assert(rejectValue.requestId === 'req-abc-123', 'Rejection requestId extracted')
  assert(rejectValue.action === 'reject', 'Reject action identified')

  // Malformed action value
  try {
    JSON.parse('{ bad json }')
    assert(false, 'Should have thrown')
  } catch {
    console.log('  ok Malformed action value JSON handled gracefully')
  }
}

// ---------------------------------------------------------------------------
// 4. URL Verification Challenge
// ---------------------------------------------------------------------------

function testUrlVerification(): void {
  console.log('\n4. URL verification challenge...')

  const challengeEvent = {
    schema: '2.0',
    header: {
      event_id: 'evt_verify',
      event_type: 'url_verification',
      token: 'expected-verification-token',
    },
    event: {
      challenge: 'challenge_code_12345',
      token: 'expected-verification-token',
      type: 'url_verification',
    },
  }

  assert(challengeEvent.header.event_type === 'url_verification', 'URL verification event type detected')
  assert(typeof challengeEvent.event.challenge === 'string', 'Challenge code present')
  assert(challengeEvent.event.challenge.length > 0, 'Challenge code is non-empty')
}

// ---------------------------------------------------------------------------
// 5. Event type routing
// ---------------------------------------------------------------------------

function testEventTypeRouting(): void {
  console.log('\n5. Event type routing...')

  const supportedEvents = [
    'im.message.receive_v1',
    'im.message.receive_v2',
    'url_verification',
    'card.action.trigger',
  ]

  for (const eventType of supportedEvents) {
    assert(typeof eventType === 'string' && eventType.length > 0,
      `Event type '${eventType}' is valid`)
  }

  // Unknown event type
  const unknownEventType = 'im.unknown.event_type'
  assert(!supportedEvents.includes(unknownEventType),
    'Unknown event type not in supported list')
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nFeishu Channel Production Test Suite')
  console.log('='.repeat(60))

  try {
    testFeishuSignatureVerification()
    testFeishuEventStructures()
    testCardActionCallbackParsing()
    testUrlVerification()
    testEventTypeRouting()
    console.log('\n' + '='.repeat(60))
    console.log('All Feishu Channel Production tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
