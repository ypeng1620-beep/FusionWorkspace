/**
 * Alerting Engine — rule-based alerting for runtime anomalies.
 *
 * Threshold-driven rules evaluate metric snapshots and emit alerts
 * through configurable handlers (console, webhook, callback).
 */

import type { MetricSnapshot } from './metricsExporter.js'

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface Alert {
  rule: string
  severity: AlertSeverity
  message: string
  value: number
  threshold: number
  timestamp: number
}

export interface AlertRule {
  name: string
  severity: AlertSeverity
  description: string
  /** Evaluate the rule against a metric snapshot. Returns Alert if triggered. */
  evaluate(snapshot: MetricSnapshot): Alert | null
}

export interface AlertHandler {
  (alert: Alert): void | Promise<void>
}

export interface AlertEngine {
  /** Register a new rule. */
  registerRule(rule: AlertRule): void
  /** Add an alert handler (can be called multiple times). */
  onAlert(handler: AlertHandler): void
  /** Evaluate all rules against a snapshot. */
  evaluate(snapshot: MetricSnapshot): Alert[]
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

function consecutiveStartupFailureRule(maxFailures: number): AlertRule {
  return {
    name: 'consecutive-startup-failures',
    severity: 'critical',
    description: `More than ${maxFailures} consecutive startup failures`,
    evaluate(snapshot) {
      // This rule requires startup failure count, which isn't in MetricSnapshot.
      // Implementation expects the caller to pass it via custom metadata.
      return null
    },
  }
}

function flameBreakerOpenRule(): AlertRule {
  return {
    name: 'flamebreaker-open',
    severity: 'critical',
    description: 'FlameBreaker circuit breaker is OPEN',
    evaluate(snapshot) {
      if (snapshot.flameBreakerState === 1) {
        return {
          rule: 'flamebreaker-open',
          severity: 'critical',
          message: 'FlameBreaker circuit breaker is OPEN — all tool executions blocked',
          value: snapshot.flameBreakerState,
          threshold: 0,
          timestamp: Date.now(),
        }
      }
      return null
    },
  }
}

function approvalTimeoutRule(maxPending: number): AlertRule {
  return {
    name: 'approval-timeout',
    severity: 'warning',
    description: `More than ${maxPending} pending approval requests`,
    evaluate(snapshot) {
      if (snapshot.approvalPending > maxPending) {
        return {
          rule: 'approval-timeout',
          severity: 'warning',
          message: `${snapshot.approvalPending} pending approval requests (threshold: ${maxPending})`,
          value: snapshot.approvalPending,
          threshold: maxPending,
          timestamp: Date.now(),
        }
      }
      return null
    },
  }
}

function gatewayErrorRateRule(maxErrors: number): AlertRule {
  return {
    name: 'gateway-error-rate',
    severity: 'warning',
    description: `Gateway errors exceeded ${maxErrors}`,
    evaluate(snapshot) {
      if (snapshot.gatewayErrors > maxErrors) {
        return {
          rule: 'gateway-error-rate',
          severity: 'warning',
          message: `Gateway has ${snapshot.gatewayErrors} errors (threshold: ${maxErrors})`,
          value: snapshot.gatewayErrors,
          threshold: maxErrors,
          timestamp: Date.now(),
        }
      }
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAlertEngine(): AlertEngine {
  const rules: AlertRule[] = []
  const handlers: AlertHandler[] = []

  const engine: AlertEngine = {
    registerRule(rule) {
      rules.push(rule)
    },
    onAlert(handler) {
      handlers.push(handler)
    },
    evaluate(snapshot) {
      const alerts: Alert[] = []
      for (const rule of rules) {
        const alert = rule.evaluate(snapshot)
        if (alert) {
          alerts.push(alert)
          for (const handler of handlers) {
            try {
              const result = handler(alert)
              if (result instanceof Promise) {
                result.catch((err) => console.error('[AlertEngine] Handler error:', err))
              }
            } catch (err) {
              console.error('[AlertEngine] Handler error:', err)
            }
          }
        }
      }
      return alerts
    },
  }

  // Register default rules
  engine.registerRule(flameBreakerOpenRule())
  engine.registerRule(approvalTimeoutRule(10))
  engine.registerRule(gatewayErrorRateRule(50))

  return engine
}

export { consecutiveStartupFailureRule, flameBreakerOpenRule, approvalTimeoutRule, gatewayErrorRateRule }
