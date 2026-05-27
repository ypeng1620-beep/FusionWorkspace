/**
 * Prometheus Metrics Exporter — runtime observability for FusionWorkspace.
 *
 * Exposes a `/metrics` endpoint in Prometheus text format. No external
 * dependencies — the format is simple enough to hand-write.
 */

export interface MetricSnapshot {
  /** TAOR loop steps executed */
  taorTotalSteps: number
  /** TAOR loop token consumption */
  taorTotalInputTokens: number
  taorTotalOutputTokens: number
  /** Tool call count */
  taorToolCalls: number
  /** Memory system stats */
  memoryCacheHits: number
  memoryCacheMisses: number
  memoryTotalEntries: number
  /** Gateway stats */
  gatewayActiveSessions: number
  gatewayTotalMessages: number
  gatewayErrors: number
  /** FlameBreaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN) */
  flameBreakerState: number
  /** Skill lifecycle */
  skillTotalCount: number
  skillActiveCount: number
  /** Approval stats */
  approvalPending: number
  approvalResolved: number
}

export interface MetricsExporter {
  /** Update current metric values. */
  update(snapshot: Partial<MetricSnapshot>): void
  /** Get the full snapshot. */
  snapshot(): MetricSnapshot
  /** Render Prometheus text format. */
  render(): string
}

export function createMetricsExporter(): MetricsExporter {
  let state: MetricSnapshot = {
    taorTotalSteps: 0,
    taorTotalInputTokens: 0,
    taorTotalOutputTokens: 0,
    taorToolCalls: 0,
    memoryCacheHits: 0,
    memoryCacheMisses: 0,
    memoryTotalEntries: 0,
    gatewayActiveSessions: 0,
    gatewayTotalMessages: 0,
    gatewayErrors: 0,
    flameBreakerState: 0,
    skillTotalCount: 0,
    skillActiveCount: 0,
    approvalPending: 0,
    approvalResolved: 0,
  }

  return {
    update(snapshot) {
      Object.assign(state, snapshot)
    },
    snapshot() {
      return { ...state }
    },
    render() {
      const lines = [
        '# HELP fusion_taor_steps_total Total TAOR loop steps executed',
        '# TYPE fusion_taor_steps_total counter',
        `fusion_taor_steps_total ${state.taorTotalSteps}`,
        '',
        '# HELP fusion_taor_input_tokens_total Total input tokens consumed',
        '# TYPE fusion_taor_input_tokens_total counter',
        `fusion_taor_input_tokens_total ${state.taorTotalInputTokens}`,
        '',
        '# HELP fusion_taor_output_tokens_total Total output tokens generated',
        '# TYPE fusion_taor_output_tokens_total counter',
        `fusion_taor_output_tokens_total ${state.taorTotalOutputTokens}`,
        '',
        '# HELP fusion_taor_tool_calls_total Total tool calls executed',
        '# TYPE fusion_taor_tool_calls_total counter',
        `fusion_taor_tool_calls_total ${state.taorToolCalls}`,
        '',
        '# HELP fusion_memory_cache_hits Memory cache hits',
        '# TYPE fusion_memory_cache_hits counter',
        `fusion_memory_cache_hits ${state.memoryCacheHits}`,
        '',
        '# HELP fusion_memory_cache_misses Memory cache misses',
        '# TYPE fusion_memory_cache_misses counter',
        `fusion_memory_cache_misses ${state.memoryCacheMisses}`,
        '',
        '# HELP fusion_memory_total_entries Total memory entries',
        '# TYPE fusion_memory_total_entries gauge',
        `fusion_memory_total_entries ${state.memoryTotalEntries}`,
        '',
        '# HELP fusion_gateway_active_sessions Active gateway sessions',
        '# TYPE fusion_gateway_active_sessions gauge',
        `fusion_gateway_active_sessions ${state.gatewayActiveSessions}`,
        '',
        '# HELP fusion_gateway_messages_total Total gateway messages',
        '# TYPE fusion_gateway_messages_total counter',
        `fusion_gateway_messages_total ${state.gatewayTotalMessages}`,
        '',
        '# HELP fusion_gateway_errors_total Total gateway errors',
        '# TYPE fusion_gateway_errors_total counter',
        `fusion_gateway_errors_total ${state.gatewayErrors}`,
        '',
        '# HELP fusion_flamebreaker_state FlameBreaker state (0=CLOSED 1=OPEN 2=HALF_OPEN)',
        '# TYPE fusion_flamebreaker_state gauge',
        `fusion_flamebreaker_state ${state.flameBreakerState}`,
        '',
        '# HELP fusion_skill_total_count Total registered skills',
        '# TYPE fusion_skill_total_count gauge',
        `fusion_skill_total_count ${state.skillTotalCount}`,
        '',
        '# HELP fusion_skill_active_count Active skills',
        '# TYPE fusion_skill_active_count gauge',
        `fusion_skill_active_count ${state.skillActiveCount}`,
        '',
        '# HELP fusion_approval_pending Pending approval requests',
        '# TYPE fusion_approval_pending gauge',
        `fusion_approval_pending ${state.approvalPending}`,
        '',
        '# HELP fusion_approval_resolved_total Total resolved approval requests',
        '# TYPE fusion_approval_resolved_total counter',
        `fusion_approval_resolved_total ${state.approvalResolved}`,
        '',
      ]
      return lines.join('\n')
    },
  }
}
