import { runProductionTemplateServerProbe, withRuntimeLogsOnStderr } from './runtimeCheckUtils.js'

async function main(): Promise<void> {
  const result = await withRuntimeLogsOnStderr(() => runProductionTemplateServerProbe())

  console.log(JSON.stringify({
    status: 'ok',
    port: result.port,
    probes: {
      live: result.live,
      ready: result.ready,
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
