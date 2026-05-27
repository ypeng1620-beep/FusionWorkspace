import { runProductionTemplateServerProbe, withRuntimeLogsOnStderr } from './runtimeCheckUtils.js'
import { validateSupervisorTemplate } from './checkSupervisorTemplate.js'

async function main(): Promise<void> {
  const port = Number(process.env.FUSION_RUNTIME_CHECK_PORT ?? 18089)
  validateSupervisorTemplate()
  const result = await withRuntimeLogsOnStderr(() => runProductionTemplateServerProbe({ port }))

  console.log(JSON.stringify({
    status: 'ok',
    port: result.port,
    checks: {
      config: 'ok',
      supervisor: 'ok',
      server: 'ok',
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
