import { FusionWorkspace, buildFusionWorkspaceConfigFromCliArgs } from '../src/start.js'

export interface RuntimeServerProbeResult {
  port: number
  live: 'ok'
  ready: 'ok'
}

async function fetchProbe(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Probe failed ${url}: HTTP ${response.status}`)
  }
  return await response.json() as Record<string, unknown>
}

export async function withRuntimeLogsOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log
  const originalWarn = console.warn

  console.log = (...args: unknown[]) => console.error(...args)
  console.warn = (...args: unknown[]) => console.error(...args)

  try {
    return await fn()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
}

export async function runProductionTemplateServerProbe(options: {
  configPath?: string
  port?: number
} = {}): Promise<RuntimeServerProbeResult> {
  const configPath = options.configPath ?? process.env.FUSION_RUNTIME_CHECK_CONFIG ?? 'config/runtime.production.template.json'
  const port = options.port ?? Number(process.env.FUSION_RUNTIME_CHECK_PORT ?? 18088)
  const config = buildFusionWorkspaceConfigFromCliArgs({
    config: configPath,
    mode: 'server',
    port,
  } as Record<string, unknown>)
  const workspace = new FusionWorkspace(config)

  await workspace.start()
  try {
    const live = await fetchProbe(`http://127.0.0.1:${port}/api/live`)
    const ready = await fetchProbe(`http://127.0.0.1:${port}/api/ready`)

    if (live.status !== 'ok' || live.live !== true) {
      throw new Error('Live probe did not report ok')
    }
    if (ready.status !== 'ok') {
      throw new Error(`Ready probe did not report ok: ${String(ready.status ?? 'missing')}`)
    }
  } finally {
    await workspace.stop()
  }

  return {
    port,
    live: 'ok',
    ready: 'ok',
  }
}
