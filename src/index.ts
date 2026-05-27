// FusionWorkspace — AI Agent 融合架构
// 融合 Hermes + Claude Code + OpenClaw 的核心设计

export { TAORLoop, runTAOR } from './agent/taorLoop.js'
export { FTS5MemoryStore, embed, getDefaultStore } from './memory/fts5Memory.js'
export { MemoryManager, getDefaultManager } from './memory/memoryManager.js'
export {
  getEmbeddingProvider,
  setEmbeddingProvider,
  embedBatch,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  DeterministicEmbeddingProvider,
} from './memory/embeddingService.js'
export type { EmbeddingProvider } from './memory/embeddingService.js'
export { MemoryPolicy } from './memory/memoryPolicy.js'
export { SessionStore } from './memory/sessionStore.js'
export { MemoryWritePolicy } from './memory/memoryWritePolicy.js'
export { EmlScorer } from './memory/emlScoring.js'
export type {
  EmlScoreAction,
  EmlScoreDecision,
  EmlScoreInput,
  EmlScorerConfig,
  EmlSignalType,
  EmlThresholds,
} from './memory/emlScoring.js'
export { TrajectoryCompressor } from './memory/trajectoryCompression.js'
export { MemoryInjector, sanitizeRecallContext } from './memory/memoryInjection.js'
export {
  LayeredMemoryManager,
  ProfileMemory,
  SessionMemory,
  KnowledgeMemory,
  EpisodicMemory,
} from './memory/layeredMemory.js'
export type {
  ProfileEntry,
  SessionEntry,
  KnowledgeEntry,
  EpisodicEntry,
  MemoryScope,
  MemorySource,
  LayeredMemoryConfig,
} from './memory/layeredMemory.js'
export { ToolRegistry, createToolCall } from './tools/toolExecutor.js'
export { PermissionWorkflowStore, createToolFingerprint } from './permissions/permissionWorkflow.js'
export { ApprovalService } from './permissions/approvalService.js'
export { PermissionGate } from './permissions/permissionGate.js'
export { PermissionPolicyEngine } from './permissions/permissionPolicyEngine.js'
export { PermissionAuditStore } from './permissions/permissionAudit.js'
export type {
  ChannelPolicy,
  UserPolicy,
  GroupPolicy,
  IdentityContext,
  PolicyDecision,
  ChannelId,
  UserRole,
  ToolCategory,
} from './permissions/permissionPolicyEngine.js'
export type {
  AuditEntry,
  AuditQuery,
  AuditStats,
} from './permissions/permissionAudit.js'
export { Gateway, WebSocketChannel, StdioChannel, WebhookChannel } from './gateway/gateway.js'
export { ExternalChannel, MessageDeduplicator } from './gateway/externalChannel.js'
export { WeChatChannel, WECHAT_CAPABILITIES } from './gateway/wechatChannel.js'
export { FeishuChannel, FEISHU_CAPABILITIES } from './gateway/feishuChannel.js'
export { AdapterFactory, loadAdapterConfig } from './gateway/adapterFactory.js'
export type {
  AdapterEvents,
  ExternalChannelConfig,
} from './gateway/externalChannel.js'
export type { WeChatAdapterConfig, WeChatMessage } from './gateway/wechatChannel.js'
export type { FeishuAdapterConfig, FeishuMessage, FeishuEvent } from './gateway/feishuChannel.js'
export type { AdapterDefinition, AdapterRegistryConfig } from './gateway/adapterFactory.js'
export { SkillManager, SkillEvaluator, SkillGenerator, getDefaultSkillManager } from './skills/skillManager.js'
export {
  SkillDiscoverer,
  SkillContractManager,
  SkillEvaluator as SkillLifecycleEvaluator,
  SkillForge,
  SkillPatchManager,
} from './skills/skillLifecycle.js'
export type {
  SkillDiscoveryContext,
  SkillDiscoveryResult,
  SkillExecutionContract,
  SkillExecutionRecord,
  SkillEvaluationReport,
  SkillPatchProposal,
  SkillForgeRequest,
  SkillDraft,
} from './skills/skillLifecycle.js'
export { DuoAgent } from './agent/duoAgent.js'
export type { DuoAgentConfig, DuoAgentSession } from './agent/duoAgent.js'
export {
  ExternalReviewer,
  buildReviewContext,
} from './agent/externalReviewer.js'
export type {
  ReviewContext,
  ReviewResult,
  ReviewSuggestion,
  ReviewAuditEntry,
  ExternalReviewerOptions,
} from './agent/externalReviewer.js'
export { FusionWorkspace, start } from './start.js'
export { RuntimeMonitor } from './runtime/runtimeMonitor.js'
export { createMetricsExporter } from './runtime/metricsExporter.js'
export type { MetricSnapshot, MetricsExporter } from './runtime/metricsExporter.js'
export { createStructuredLogger, getLogger, setLogger } from './runtime/structuredLogger.js'
export type { StructuredLogger, StructuredLoggerConfig, LogLevel } from './runtime/structuredLogger.js'
export { createSecretStore, getDefaultSecretStore, setDefaultSecretStore } from './runtime/secretStore.js'
export type { SecretStore, EncryptedBlob } from './runtime/secretStore.js'
export { createAlertEngine } from './runtime/alerting.js'
export type { Alert, AlertRule, AlertHandler, AlertEngine } from './runtime/alerting.js'
export { createMockProvider, collectChatResult } from './llm/llmProvider.js'
export { ProviderRegistry, getDefaultProviderRegistry, loadProvidersFromConfig } from './llm/providerRegistry.js'
export { PhoenixAuditSnapshotStore, PhoenixAuditStore } from './orchestrator/phoenixAudit.js'
export { PhoenixCore } from './orchestrator/phoenixCore.js'
export {
  PHOENIX_BOUNDARY_CONTRACT_VERSION,
  assertPhoenixBoundaryDecision,
  getPhoenixBoundaryContract,
} from './orchestrator/phoenixBoundaries.js'
export { FlameBreaker } from './reliability/flameBreaker.js'
export { AntibodyRepository } from './antibody/antibodyRepository.js'
export { AntibodyPolicy } from './antibody/antibodyPolicy.js'
export type {
  PhoenixAuditEntry,
  PhoenixAuditLevel,
  PhoenixAuditReplaySnapshot,
  PhoenixAuditSnapshotFile,
  PhoenixAuditSnapshotListItem,
  PhoenixAuditSnapshotSaveInput,
  PhoenixAuditSnapshotStoreConfig,
  PhoenixAuditStage,
  PhoenixAuditStoreConfig,
} from './orchestrator/phoenixAudit.js'
export type {
  PhoenixFallbackPath,
  PhoenixFallbackPathDecision,
  PhoenixFallbackPathInput,
  PhoenixCoreConfig,
  PhoenixGovernanceAction,
  PhoenixGovernanceDecision,
  PhoenixGovernanceInput,
  PhoenixGovernanceMode,
  PhoenixMemoryRecallDecision,
  PhoenixMemoryRecallInput,
  PhoenixSkillLookupDecision,
  PhoenixSkillLookupInput,
} from './orchestrator/phoenixCore.js'
export type { PhoenixBoundaryContract } from './orchestrator/phoenixBoundaries.js'
export type {
  FallbackRecommendation,
  FlameBreakerAction,
  FlameBreakerAuditEntry,
  FlameBreakerConfig,
  FlameBreakerDecision,
  FlameBreakerFailure,
  FlameBreakerKey,
  FlameBreakerState,
} from './reliability/flameBreaker.js'
export type {
  AntibodyEvaluation,
  AntibodyRepositoryConfig,
  AntibodyRule,
  AntibodyRuleProposal,
  AntibodyRuleStatus,
} from './antibody/antibodyRepository.js'
export type {
  AntibodyPolicyAction,
  AntibodyPolicyConfig,
  AntibodyPolicyObservation,
  AntibodyPolicyResult,
} from './antibody/antibodyPolicy.js'

// TAOR 可靠性模块
export {
  CheckpointManager,
  ToolTransactionLog,
  RetryExecutor,
  SessionIsolationManager,
} from './agent/taorReliability.js'
export type {
  CheckpointState,
  ToolTransactionEntry,
  RetryStrategy,
  RetryResult,
  SessionContext,
} from './agent/taorReliability.js'

// 协议模块
export {
  buildOutboundMessage,
  parseInboundMessage,
} from './protocol/messageTypes.js'
export type {
  MessageType,
  OutboundMessageType,
  InboundMessageType,
  WelcomePayload,
  ConfirmationRequiredPayload,
  ApprovalAckPayload,
  ApprovalExpiredPayload,
  AssistantResponsePayload,
  ToolResultPayload,
  ProgressUpdatePayload,
  ErrorPayload,
  UserMessagePayload,
  ApprovalResponsePayload,
  CancelRequestPayload,
  SessionContextRestorePayload,
  RichMessagePayload,
} from './protocol/messageTypes.js'

export {
  DEFAULT_CAPABILITIES,
  WEBSOCKET_CAPABILITIES,
  STDIO_CAPABILITIES,
} from './protocol/adapterSchema.js'
export type {
  AdapterCapabilities,
  AdapterConfig,
  AdapterStatus,
} from './protocol/adapterSchema.js'

export {
  DefaultApprovalEventBus,
  ApprovalWaitManager,
} from './protocol/approvalEventBus.js'
export type {
  ApprovalEventBus,
  ApprovalNeededEvent,
  ApprovalResolvedEvent,
  ApprovalExpiredEvent,
} from './protocol/approvalEventBus.js'

export {
  DefaultLoopController,
} from './protocol/loopController.js'
export type {
  LoopController,
  LoopPausedState,
} from './protocol/loopController.js'

export type { LlmProvider, LlmFeature, LlmCapabilities, LlmChatOptions, ChatResult } from './llm/llmProvider.js'
export type { LlmConfig, LlmConfigEntry, ProviderRegistrySnapshot } from './llm/providerRegistry.js'

export const VERSION = '0.14.0'
