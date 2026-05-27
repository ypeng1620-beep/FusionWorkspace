// FusionWorkspace Test Runner
// Each test module calls main() without await at top level.
// We add a small delay between imports to let each test complete
// before the next starts, preventing parallel execution.

const TESTS = [
  './testPermissions.js',
  './testPermissionPolicyEngine.js',
  './testToolExecutor.js',
  './testSkillLifecycle.js',
  './testTAORReliability.js',
  './testRuntimeStatus.js',
  './testPackageRuntimeEntry.js',
  './testRuntimeServerSmoke.js',
  './testGatewayStartup.js',
  './testStartupCliConfig.js',
  './testStartupCliValidateConfig.js',
  './testDuoAgent.js',
  './testRuntimeServerCheckScript.js',
  './testRuntimeOperationsDocs.js',
  './testProductionReadinessScript.js',
  './testSupervisorTemplate.js',
  './testSupervisorTemplateValidation.js',
  './testExternalIngressGuard.js',
  './testExternalAdapterContract.js',
  './testExternalAdapterReplay.js',
  './testExternalAdapterConfigValidation.js',
  './testExternalAdapterConfigTemplates.js',
  './testAdapterFactoryReadiness.js',
  './testMemoryFallback.js',
  './testApprovalService.js',
  './testPhoenixAudit.js',
  './testPhoenixAuditSnapshots.js',
  './testPhoenixCore.js',
  './testPhoenixBoundaries.js',
  './testPhoenixRuntimeDocs.js',
  './testEmlScoring.js',
  './testMemoryWritePolicy.js',
  './testMemoryManagerEmlAudit.js',
  './testFlameBreaker.js',
  './testAntibodyRepository.js',
  './testAntibodyPolicy.js',
  './testWeChatChannel.js',
  './testFeishuChannel.js',
]

for (const path of TESTS) {
  await import(path)
  // Allow the test's un-awaited main() to settle before loading the next module
  await new Promise(resolve => setTimeout(resolve, 300))
}
