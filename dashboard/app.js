/**
 * FusionWorkspace Dashboard — WebSocket-based runtime monitor and agent terminal.
 *
 * Connects to the Gateway WebSocket endpoint. All rendering is client-side;
 * no build step required.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws?channel=dashboard`
})()

const RECONNECT_DELAY_MS = 2000
const MAX_AUDIT_ENTRIES = 100

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null
let reconnectTimer = null

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => document.querySelectorAll(sel)

const connDot = $('#conn-dot')
const connLabel = $('#conn-label')
const fwVersion = $('#fw-version')
const circuitState = $('#circuit-state')
const circuitDetail = $('#circuit-detail')
const auditStream = $('#audit-stream')
const termOutput = $('#term-output')
const termInput = $('#term-input')

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    connDot.className = 'dot connected'
    connLabel.textContent = 'Connected'
    termAppend('system', `Connected to ${WS_URL}`)
    // Request initial state snapshot
    send({ type: 'fw:status:request', payload: {} })
  }

  ws.onclose = (ev) => {
    connDot.className = 'dot disconnected'
    connLabel.textContent = `Disconnected (${ev.code || '—'})`
    scheduleReconnect()
  }

  ws.onerror = () => {
    connDot.className = 'dot disconnected'
    connLabel.textContent = 'Error — reconnecting…'
  }

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      handleMessage(msg)
    } catch {
      // Non-JSON messages are ignored by the dashboard
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, RECONNECT_DELAY_MS)
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj))
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  switch (msg.type) {
    // Phoenix audit events
    case 'phoenix:audit':
      appendAudit(msg.payload)
      break

    // Runtime status snapshot
    case 'fw:status:snapshot':
      renderStatus(msg.payload)
      break

    // Subsystem status delta
    case 'fw:subsystem':
      updateSubsystem(msg.payload)
      break

    // FlameBreaker state change
    case 'fw:flamebreaker':
      renderFlameBreaker(msg.payload)
      break

    // Metrics snapshot
    case 'fw:metrics':
      renderMetrics(msg.payload)
      break

    // Agent response in chat terminal
    case 'assistant:response':
    case 'fw:agent:response':
      termAppend('agent', msg.payload?.text ?? msg.payload?.message ?? JSON.stringify(msg.payload))
      break

    // Tool result
    case 'fw:tool:result':
    case 'tool:result':
      termAppend('tool', msg.payload?.summary ?? msg.payload?.result ?? 'Tool executed')
      break

    // Generic text event
    case 'fw:event':
      if (msg.payload?.message) termAppend('system', msg.payload.message)
      break

    // Welcome / handshake
    case 'welcome':
      if (msg.payload?.version) fwVersion.textContent = `v${msg.payload.version}`
      termAppend('system', msg.payload?.message ?? 'Handshake complete')
      break

    // Unknown — log as system message
    default:
      if (msg.type && msg.type.startsWith('fw:')) {
        termAppend('system', `[${msg.type}] ${JSON.stringify(msg.payload ?? {})}`)
      }
  }
}

// ---------------------------------------------------------------------------
// Status rendering
// ---------------------------------------------------------------------------

function renderStatus(payload) {
  if (!payload) return

  if (payload.version) fwVersion.textContent = `v${payload.version}`

  if (payload.subsystems) {
    for (const [name, status] of Object.entries(payload.subsystems)) {
      updateSubsystem({ name, ...status })
    }
  }

  if (payload.flameBreakerState !== undefined) {
    renderFlameBreaker({ state: payload.flameBreakerState })
  }

  if (payload.metrics) {
    renderMetrics(payload.metrics)
  }
}

function updateSubsystem(payload) {
  const el = $(`#status-${payload.name}`)
  const detail = $(`#detail-${payload.name}`)
  if (!el) return

  el.textContent = payload.status ?? payload.state ?? '—'
  el.className = `tile-status ${statusClass(payload.status ?? payload.state ?? '')}`

  if (detail) {
    detail.textContent = payload.detail ?? payload.message ?? ''
  }
}

function statusClass(status) {
  const s = (status ?? '').toLowerCase()
  if (s === 'ok' || s === 'healthy' || s === 'connected') return 'ok'
  if (s === 'warn' || s === 'degraded') return 'warn'
  if (s === 'error' || s === 'unavailable' || s === 'disconnected') return 'error'
  return ''
}

function renderFlameBreaker(payload) {
  const state = typeof payload.state === 'number'
    ? ['CLOSED', 'OPEN', 'HALF_OPEN'][payload.state]
    : (payload.state ?? payload.status ?? 'CLOSED')

  circuitState.textContent = state
  circuitState.className = `circuit-state ${state.toLowerCase().replace('_', '-')}`

  const details = []
  if (payload.reason) details.push(payload.reason)
  if (payload.failureCount !== undefined) details.push(`${payload.failureCount} failure(s)`)
  if (payload.lastFailure) details.push(`Last: ${new Date(payload.lastFailure).toLocaleTimeString()}`)
  circuitDetail.textContent = details.length > 0 ? details.join(' • ') : 'All circuits operational'
}

function renderMetrics(payload) {
  const sets = [
    ['m-steps', payload.steps ?? payload.taorSteps ?? '—'],
    ['m-toolCalls', payload.toolCalls ?? payload.totalToolCalls ?? '—'],
    ['m-sessions', payload.sessions ?? payload.activeSessions ?? '—'],
    ['m-msgTotal', payload.msgTotal ?? payload.totalMessages ?? '—'],
    ['m-cacheHit', payload.cacheHit ?? payload.memoryCacheHitRate ?? '—'],
    ['m-pending', payload.pending ?? payload.approvalPending ?? '—'],
  ]
  for (const [id, val] of sets) {
    const el = $('#' + id)
    if (el) el.textContent = typeof val === 'number' ? val.toLocaleString() : val
  }
}

// ---------------------------------------------------------------------------
// Audit stream
// ---------------------------------------------------------------------------

function appendAudit(entry) {
  if (!entry) return

  // Remove placeholder
  const placeholder = auditStream.querySelector('em')
  if (placeholder) placeholder.remove()

  const div = document.createElement('div')
  div.className = 'audit-entry'

  const level = (entry.level ?? 'info').toLowerCase()
  div.innerHTML = [
    `<span class="audit-level ${level}">${level.toUpperCase()}</span>`,
    `<span class="audit-stage">${esc(entry.stage ?? entry.eventType ?? '—')}</span>`,
    `<span class="audit-decision">${esc(entry.decision ?? entry.message ?? '—')}</span>`,
    `<span class="audit-time">${new Date(entry.timestamp ?? Date.now()).toLocaleTimeString()}</span>`,
  ].join('')

  auditStream.appendChild(div)
  auditStream.scrollTop = auditStream.scrollHeight

  // Trim old entries
  while (auditStream.children.length > MAX_AUDIT_ENTRIES) {
    auditStream.firstChild.remove()
  }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

function termAppend(cls, text) {
  const div = document.createElement('div')
  div.className = `msg-${cls}`
  div.textContent = text
  termOutput.appendChild(div)
  termOutput.scrollTop = termOutput.scrollHeight

  // Trim old output
  while (termOutput.children.length > 500) {
    termOutput.firstChild.remove()
  }
}

termInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && termInput.value.trim()) {
    const text = termInput.value.trim()
    termAppend('user', '> ' + text)
    send({ type: 'user:message', payload: { text } })
    termInput.value = ''
  }
})

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function esc(str) {
  if (typeof str !== 'string') return String(str ?? '')
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

connect()
