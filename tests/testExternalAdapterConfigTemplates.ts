import {
  createFeishuProductionAdapterTemplate,
  createWeChatProductionAdapterTemplate,
} from '../src/gateway/externalAdapterConfigTemplates.js'
import { validateExternalAdapterConfig } from '../src/gateway/externalAdapterConfigValidation.js'
import { readFile } from 'fs/promises'
import { join } from 'path'

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

section('External Adapter Config Template Tests')

async function testWeChatTemplateIsProductionReadyAndSecretSafe(): Promise<void> {
  console.log('\n1. wechat template...')
  const template = createWeChatProductionAdapterTemplate()
  const validation = validateExternalAdapterConfig(template, { strict: true })
  const serialized = JSON.stringify(template)

  assert(template.type === 'wechat', 'wechat template uses wechat channel')
  assert(template.requireProductionReady === true, 'wechat template enables production-ready fail-fast')
  assert(template.ingressGuard?.requireSignature === true, 'wechat template requires signatures')
  assert(template.ingressGuard?.rateLimit?.maxMessages === 60, 'wechat template includes default rate limit count')
  assert(template.ingressGuard?.rateLimit?.windowMs === 60_000, 'wechat template includes default rate limit window')
  assert(template.ingressAuditLogPath === '.fusion-runtime/external-ingress/wechat.jsonl', 'wechat template includes audit log path')
  assert(validation.status === 'ok', 'wechat template validates as production-ready')
  assert(!serialized.includes('appSecretValue'), 'wechat template does not contain real app secret')
  assert(serialized.includes('${WECHAT_APP_SECRET}'), 'wechat template uses app secret placeholder')
  assert(serialized.includes('${WECHAT_INGRESS_SECRET}'), 'wechat template uses ingress secret placeholder')
}

async function testFeishuTemplateIsProductionReadyAndSecretSafe(): Promise<void> {
  console.log('\n2. feishu template...')
  const template = createFeishuProductionAdapterTemplate()
  const validation = validateExternalAdapterConfig(template, { strict: true })
  const serialized = JSON.stringify(template)

  assert(template.type === 'feishu', 'feishu template uses feishu channel')
  assert(template.requireProductionReady === true, 'feishu template enables production-ready fail-fast')
  assert(template.ingressGuard?.requireSignature === true, 'feishu template requires signatures')
  assert(template.ingressGuard?.rateLimit?.maxMessages === 60, 'feishu template includes default rate limit count')
  assert(template.ingressGuard?.rateLimit?.windowMs === 60_000, 'feishu template includes default rate limit window')
  assert(template.ingressAuditLogPath === '.fusion-runtime/external-ingress/feishu.jsonl', 'feishu template includes audit log path')
  assert(validation.status === 'ok', 'feishu template validates as production-ready')
  assert(!serialized.includes('appSecretValue'), 'feishu template does not contain real app secret')
  assert(serialized.includes('${FEISHU_APP_SECRET}'), 'feishu template uses app secret placeholder')
  assert(serialized.includes('${FEISHU_INGRESS_SECRET}'), 'feishu template uses ingress secret placeholder')
}

async function testProductionTemplateFileIsSafeAndValid(): Promise<void> {
  console.log('\n3. production template file...')
  const templatePath = join(process.cwd(), 'config', 'external-adapters.production.template.json')
  const raw = await readFile(templatePath, 'utf8')
  const parsed = JSON.parse(raw) as { adapters: Array<ReturnType<typeof createWeChatProductionAdapterTemplate>> }

  assert(parsed.adapters.length === 2, 'production template file includes two adapters')
  for (const adapter of parsed.adapters) {
    const validation = validateExternalAdapterConfig(adapter, { strict: true })
    assert(validation.status === 'ok', `${adapter.type} file template validates as production-ready`)
    assert(adapter.requireProductionReady === true, `${adapter.type} file template enables production-ready fail-fast`)
  }
  assert(raw.includes('${WECHAT_APP_SECRET}'), 'production template file uses WeChat secret placeholder')
  assert(raw.includes('${FEISHU_APP_SECRET}'), 'production template file uses Feishu secret placeholder')
  assert(!raw.includes('AIza'), 'production template file does not include Gemini-style API keys')
  assert(!raw.includes('sk-'), 'production template file does not include secret key literals')
  assert(!raw.includes('sk-or-v1'), 'production template file does not include OpenRouter key literals')
}

async function main(): Promise<void> {
  console.log('\nExternal Adapter Config Template Test Suite')
  console.log('='.repeat(60))

  try {
    await testWeChatTemplateIsProductionReadyAndSecretSafe()
    await testFeishuTemplateIsProductionReadyAndSecretSafe()
    await testProductionTemplateFileIsSafeAndValid()
    console.log('\n' + '='.repeat(60))
    console.log('All External Adapter Config Template tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
