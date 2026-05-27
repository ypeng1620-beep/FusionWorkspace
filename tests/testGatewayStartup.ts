import { Gateway, type ChannelMessage, type ChannelType, type IChannel, type Session } from '../src/gateway/gateway.js'
import { DEFAULT_CAPABILITIES, type AdapterCapabilities } from '../src/protocol/adapterSchema.js'

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

class TestChannel implements IChannel {
  started = false
  stopped = false
  startCount = 0
  stopCount = 0

  constructor(
    private readonly type: ChannelType,
    private readonly shouldFailStart = false,
    private readonly shouldFailStop = false,
    private readonly startDelayMs = 0,
    private readonly stopDelayMs = 0,
  ) {}

  async start(): Promise<void> {
    if (this.startDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.startDelayMs))
    }
    if (this.shouldFailStart) {
      throw new Error(`${this.type} start failed`)
    }
    this.startCount++
    this.started = true
  }

  async stop(): Promise<void> {
    if (this.shouldFailStop) {
      throw new Error(`${this.type} stop failed`)
    }
    if (this.stopDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.stopDelayMs))
    }
    this.stopCount++
    this.stopped = true
    this.started = false
  }

  async send(_message: ChannelMessage, _session?: Session): Promise<void> {}

  async broadcast(_message: Omit<ChannelMessage, 'id' | 'timestamp'>): Promise<void> {}

  getType(): ChannelType {
    return this.type
  }

  getStats(): Record<string, unknown> {
    return {
      type: this.type,
      started: this.started,
      stopped: this.stopped,
    }
  }

  getCapabilities(): AdapterCapabilities {
    return DEFAULT_CAPABILITIES
  }
}

section('Gateway Startup Tests')

async function testGatewayStartFailsFastAndRollsBackStartedChannels(): Promise<void> {
  console.log('\n1. fail-fast startup rollback...')
  const gateway = new Gateway()
  const startedChannel = new TestChannel('stable-channel')
  const failingChannel = new TestChannel('failing-channel', true)

  gateway.addChannel(startedChannel, 'stable-channel')
  gateway.addChannel(failingChannel, 'failing-channel')

  let failed = false
  try {
    await gateway.start()
  } catch (error) {
    failed = true
    assert((error as Error).message.includes("Failed to start channel 'failing-channel'"), 'gateway surfaces the failing channel')
  }

  assert(failed, 'gateway.start throws when any channel fails to start')
  assert(startedChannel.stopped, 'gateway stops channels already started by the failed startup')
  assert(!gateway.isRunning(), 'gateway remains not running after failed startup')
  const stats = gateway.getStats() as ReturnType<Gateway['getStats']> & { running?: boolean }
  assert(stats.running === false, 'gateway stats expose not-running state after failed startup')
  assert(stats.errors === 1, 'gateway stats count startup failure')
  assert(stats.lastError?.includes("Failed to start channel 'failing-channel'") === true, 'gateway stats preserve failing channel in lastError')
}

async function testGatewayStartRollbackReportsCleanupFailures(): Promise<void> {
  console.log('\n1a. startup rollback cleanup observability...')
  const gateway = new Gateway()
  const cleanupFailingChannel = new TestChannel('rollback-cleanup-channel', false, true)
  const failingChannel = new TestChannel('rollback-start-failing-channel', true)

  gateway.addChannel(cleanupFailingChannel, 'rollback-cleanup-channel')
  gateway.addChannel(failingChannel, 'rollback-start-failing-channel')

  let failed = false
  try {
    await gateway.start()
  } catch {
    failed = true
  }

  const stats = gateway.getStats() as ReturnType<Gateway['getStats']> & { lastCleanupError?: string }
  assert(failed, 'gateway.start throws when rollback cleanup also fails')
  assert(!gateway.isRunning(), 'gateway remains not running when rollback cleanup fails')
  assert(stats.errors === 2, 'gateway stats count startup failure and rollback cleanup failure')
  assert(stats.lastError?.includes("Failed to start channel 'rollback-start-failing-channel'") === true, 'gateway stats preserve startup failure as lastError')
  assert(stats.lastCleanupError?.includes("Failed to stop channel 'rollback-cleanup-channel' after startup failure") === true, 'gateway stats expose rollback cleanup failure')
}

async function testGatewayStopRecordsFailuresAndContinuesStopping(): Promise<void> {
  console.log('\n2. stop failure observability...')
  const gateway = new Gateway()
  const failingStopChannel = new TestChannel('stop-failing-channel', false, true)
  const stableChannel = new TestChannel('stop-stable-channel')

  gateway.addChannel(failingStopChannel, 'stop-failing-channel')
  gateway.addChannel(stableChannel, 'stop-stable-channel')

  await gateway.start()
  await gateway.stop()

  const stats = gateway.getStats()
  assert(stableChannel.stopped, 'gateway continues stopping later channels after one stop failure')
  assert(!gateway.isRunning(), 'gateway is not running after stop completes with channel errors')
  assert(stats.running === false, 'gateway stats expose not-running state after stop failure')
  assert(stats.errors === 1, 'gateway stats count stop failure')
  assert(stats.lastError?.includes("Failed to stop channel 'stop-failing-channel'") === true, 'gateway stats preserve failing stop channel in lastError')
}

async function testGatewayStartIsIdempotentWhenAlreadyRunning(): Promise<void> {
  console.log('\n3. idempotent start...')
  const gateway = new Gateway()
  const channel = new TestChannel('idempotent-channel')

  gateway.addChannel(channel, 'idempotent-channel')

  await gateway.start()
  await gateway.start()

  const stats = gateway.getStats()
  assert(channel.startCount === 1, 'gateway.start does not restart channels when already running')
  assert(gateway.isRunning(), 'gateway remains running after idempotent start')
  assert(stats.running === true, 'gateway stats remain running after idempotent start')

  await gateway.stop()
}

async function testGatewayStopIsIdempotentWhenAlreadyStopped(): Promise<void> {
  console.log('\n4. idempotent stop...')
  const gateway = new Gateway()
  const channel = new TestChannel('idempotent-stop-channel')

  gateway.addChannel(channel, 'idempotent-stop-channel')

  await gateway.start()
  await gateway.stop()
  await gateway.stop()

  const stats = gateway.getStats()
  assert(channel.stopCount === 1, 'gateway.stop does not stop channels again when already stopped')
  assert(!gateway.isRunning(), 'gateway remains stopped after idempotent stop')
  assert(stats.running === false, 'gateway stats remain stopped after idempotent stop')
}

async function testGatewayStartIsSingleFlightWhenConcurrent(): Promise<void> {
  console.log('\n5. concurrent start single-flight...')
  const gateway = new Gateway()
  const channel = new TestChannel('concurrent-start-channel', false, false, 20)

  gateway.addChannel(channel, 'concurrent-start-channel')

  await Promise.all([
    gateway.start(),
    gateway.start(),
  ])

  const stats = gateway.getStats()
  assert(channel.startCount === 1, 'concurrent gateway.start calls start channels only once')
  assert(gateway.isRunning(), 'gateway is running after concurrent start')
  assert(stats.running === true, 'gateway stats are running after concurrent start')

  await gateway.stop()
}

async function testGatewayStopIsSingleFlightWhenConcurrent(): Promise<void> {
  console.log('\n6. concurrent stop single-flight...')
  const gateway = new Gateway()
  const channel = new TestChannel('concurrent-stop-channel', false, false, 0, 20)

  gateway.addChannel(channel, 'concurrent-stop-channel')

  await gateway.start()
  await Promise.all([
    gateway.stop(),
    gateway.stop(),
  ])

  const stats = gateway.getStats()
  assert(channel.stopCount === 1, 'concurrent gateway.stop calls stop channels only once')
  assert(!gateway.isRunning(), 'gateway is stopped after concurrent stop')
  assert(stats.running === false, 'gateway stats are stopped after concurrent stop')
}

async function testGatewayStartWaitsForInProgressStopBeforeRestarting(): Promise<void> {
  console.log('\n7. start during stop restart...')
  const gateway = new Gateway()
  const channel = new TestChannel('restart-during-stop-channel', false, false, 0, 20)

  gateway.addChannel(channel, 'restart-during-stop-channel')

  await gateway.start()
  const stopPromise = gateway.stop()
  await gateway.start()
  await stopPromise

  const stats = gateway.getStats()
  assert(channel.stopCount === 1, 'gateway.start during stop waits for the active shutdown')
  assert(channel.startCount === 2, 'gateway.start during stop restarts channels after shutdown')
  assert(gateway.isRunning(), 'gateway is running after start waits for stop')
  assert(stats.running === true, 'gateway stats are running after start waits for stop')

  await gateway.stop()
}

async function testGatewayStopWaitsForInProgressStartBeforeStopping(): Promise<void> {
  console.log('\n8. stop during start shutdown...')
  const gateway = new Gateway()
  const channel = new TestChannel('stop-during-start-channel', false, false, 20, 0)

  gateway.addChannel(channel, 'stop-during-start-channel')

  const startPromise = gateway.start()
  await gateway.stop()
  await startPromise

  const stats = gateway.getStats()
  assert(channel.startCount === 1, 'gateway.stop during start waits for the active startup')
  assert(channel.stopCount === 1, 'gateway.stop during start stops channels after startup')
  assert(!gateway.isRunning(), 'gateway is stopped after stop waits for start')
  assert(stats.running === false, 'gateway stats are stopped after stop waits for start')
}

async function testGatewayStopDoesNotPropagateFailedInProgressStart(): Promise<void> {
  console.log('\n9. stop during failed start...')
  const gateway = new Gateway()
  const channel = new TestChannel('failed-start-during-stop-channel', true, false, 20, 0)

  gateway.addChannel(channel, 'failed-start-during-stop-channel')

  const startPromise = gateway.start()
  let stopFailed = false
  try {
    await gateway.stop()
  } catch {
    stopFailed = true
  }

  let startFailed = false
  try {
    await startPromise
  } catch {
    startFailed = true
  }

  const stats = gateway.getStats()
  assert(startFailed, 'gateway.start still reports the startup failure')
  assert(!stopFailed, 'gateway.stop does not propagate failed in-progress startup')
  assert(!gateway.isRunning(), 'gateway remains stopped after failed start and stop')
  assert(stats.running === false, 'gateway stats remain stopped after failed start and stop')
  assert(stats.lastError?.includes("Failed to start channel 'failed-start-during-stop-channel'") === true, 'gateway stats preserve failed startup lastError')
}

async function main(): Promise<void> {
  console.log('\nGateway Startup Test Suite')
  console.log('='.repeat(60))

  try {
    await testGatewayStartFailsFastAndRollsBackStartedChannels()
    await testGatewayStartRollbackReportsCleanupFailures()
    await testGatewayStopRecordsFailuresAndContinuesStopping()
    await testGatewayStartIsIdempotentWhenAlreadyRunning()
    await testGatewayStopIsIdempotentWhenAlreadyStopped()
    await testGatewayStartIsSingleFlightWhenConcurrent()
    await testGatewayStopIsSingleFlightWhenConcurrent()
    await testGatewayStartWaitsForInProgressStopBeforeRestarting()
    await testGatewayStopWaitsForInProgressStartBeforeStopping()
    await testGatewayStopDoesNotPropagateFailedInProgressStart()
    console.log('\n' + '='.repeat(60))
    console.log('All Gateway Startup tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
