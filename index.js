/**
 * Host half of the DeepSeek Harness <-> Android WebView bridge.
 *
 * The Android app can only reach the page, so this half owns everything the
 * page needs on the Host side:
 *
 * - Three authenticated `/api` POST routes the Client half calls:
 *   `android-bridge.config`, `android-bridge.poll` (long poll), and
 *   `android-bridge.inbound` (Android -> DeepSeek Harness).
 * - A bounded outbound queue of `{ seq, name, payload }` events with a
 *   monotonic sequence so a Client can resume without duplicates.
 * - Cordis integration so other Host plugins participate and the model can
 *   push an event:
 *   `ctx.on('android-bridge/send', (name, payload) => ...)` enqueues.
 *   `ctx.on('android-bridge/event', (name, payload) => ...)` observes inbound
 *   Android events. The `android_bridge_send` model tool enqueues too.
 *
 * Forwarded Host events default to the Session run-progress signals
 * `api-session/status` and `api-session/activity`.
 *
 * @module @local/dsh-android-webview-bridge
 */

/** Host events forwarded to Android by default: Session run-progress signals. */
const DEFAULT_FORWARDED_HOST_EVENTS = [
  'api-session/status',
  'api-session/activity',
  'api-session/added',
]

/** Client-side events the Client half forwards by default. */
const DEFAULT_FORWARDED_CLIENT_EVENTS = ['connection/reset', 'theme/change', 'locale/change']

const DEFAULT_BRIDGE_OBJECT_NAME = 'DSHAndroidBridge'
const DEFAULT_RECEIVE_FUNCTION_NAME = 'DSHAndroidBridgeReceive'
const DEFAULT_POLL_TIMEOUT_MS = 25_000
const MIN_POLL_TIMEOUT_MS = 1_000
const MAX_POLL_TIMEOUT_MS = 120_000
const MAX_RETAINED_EVENTS = 500
const MAX_BATCH_EVENTS = 100

/** Fully-qualified bridge endpoints on the shared `/api` RPC channel. */
const ENDPOINT_CONFIG = 'android-bridge.config'
const ENDPOINT_INBOUND = 'android-bridge.inbound'
const ENDPOINT_POLL = 'android-bridge.poll'

/** Cordis plugin name. */
export const name = 'dsh-android-webview-bridge'

/** The bridge rides the Host Connection carrier. */
export const inject = ['connection']

/**
 * Named projections for forwarded events whose positional arguments are worth
 * naming on the wire. Anything unlisted is forwarded as its argument array.
 */
const EVENT_PROJECTORS = {
  'api-session/status': (args) => ({ sessionId: args[0], running: args[1] }),
  'api-session/activity': (args) => ({ sessionId: args[0], updatedAt: args[1] }),
  // A SessionSummary carries no title, so the app must not treat this as a
  // "new answer" notification; it only refreshes list-level state.
  'api-session/added': (args) => {
    const summary = args[0] ?? {}
    return {
      sessionId: summary.sessionId,
      running: summary.running,
      agentAvailable: summary.agentAvailable,
      updatedAt: summary.updatedAt,
      cwd: summary.cwd,
      blank: summary.blank,
      parentSessionId: summary.parentSessionId,
      origin: summary.origin,
    }
  },
}

/** Semantic Session updates built here from the raw Session log feed. */
const EVENT_SESSION_UPDATE = 'android-bridge/session-update'

/** Conversation title the projection already derives for the session list. */
const EVENT_SESSION_TITLE = 'android-bridge/session-title'

/** Whether the user owes an answer: a pending question or an approval card. */
const EVENT_SESSION_INPUT = 'android-bridge/session-input'

/** Longest assistant summary put on the wire. */
const MAX_SUMMARY_CHARS = 240

/** How many committed Session events are remembered for de-duplication. */
const MAX_SESSION_DEDUPE = 500

/**
 * Register the bridge: the RPC endpoints, the outbound queue, Host event
 * forwarding, and the model tool.
 *
 * @param ctx - context providing `connection` and, optionally, `tools`.
 * @param config - the Loader row's `config` mapping.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)

  /** Retained outbound events, oldest first. */
  const queue = []
  /** Sequence of the most recently enqueued event; 0 means none yet. */
  let head = 0
  /** Resolvers for long polls that are currently suspended. */
  const waiters = new Set()

  const warn = (message, error) => {
    const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`${message}${detail}`)
    else console.warn(`[android-bridge] ${message}${detail}`)
  }

  /**
   * Append one event for delivery to Android.
   *
   * @param eventName - wire event name.
   * @param payload - JSON-safe payload.
   * @returns the assigned sequence number.
   */
  function enqueue(eventName, payload) {
    head += 1
    queue.push({ seq: head, name: eventName, payload: toJsonSafe(payload) })
    if (queue.length > MAX_RETAINED_EVENTS) {
      queue.splice(0, queue.length - MAX_RETAINED_EVENTS)
    }
    for (const waiter of [...waiters]) {
      try {
        waiter()
      } catch {
        // A waiter never throws by contract; isolate a broken one anyway.
      }
    }
    return head
  }

  /** Events strictly newer than `after`, oldest first. */
  function pendingAfter(after) {
    return queue.filter((event) => event.seq > after)
  }

  /** Sequence of the oldest event still retained. */
  function oldestSeq() {
    return queue.length === 0 ? head + 1 : queue[0].seq
  }

  /**
   * Suspend until an event newer than `after` exists, the poll times out, or
   * the caller disconnects.
   */
  function waitForNewer(after, signal, timeoutMs) {
    if (pendingAfter(after).length > 0) return Promise.resolve()
    return new Promise((resolve) => {
      let timer = null
      function finish() {
        waiters.delete(wake)
        if (timer !== null) clearTimeout(timer)
        signal?.removeEventListener?.('abort', finish)
        resolve()
      }
      function wake() {
        if (pendingAfter(after).length > 0) finish()
      }
      waiters.add(wake)
      timer = setTimeout(finish, timeoutMs)
      signal?.addEventListener?.('abort', finish, { once: true })
    })
  }

  /** Report one successful RPC result. */
  const ok = (value) => ({ ok: true, value })

  /** Report one failed RPC result with a stable bridge code. */
  const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })

  /** Handle every `android-bridge.*` endpoint on the shared `/api` channel. */
  async function handleRpc(endpoint, payload, signal) {
    try {
      if (endpoint === ENDPOINT_CONFIG) {
        return ok({
          bridgeObjectName: settings.bridgeObjectName,
          receiveFunctionName: settings.receiveFunctionName,
          forwardedClientEvents: settings.forwardedClientEvents,
          forwardedHostEvents: settings.forwardedHostEvents,
          pollTimeoutMs: settings.pollTimeoutMs,
          head,
        })
      }

      if (endpoint === ENDPOINT_INBOUND) {
        const eventName = typeof payload?.name === 'string' ? payload.name.trim() : ''
        if (eventName === '') {
          return fail('android-bridge/invalid-request', 'inbound requires a non-empty string "name"')
        }
        const data = toJsonSafe(payload?.payload ?? null)
        ctx.emit('android-bridge/event', eventName, data)
        return ok({ accepted: true, name: eventName, head })
      }

      if (endpoint === ENDPOINT_POLL) {
        const after = normalizeSeq(payload?.after)
        if (pendingAfter(after).length === 0) {
          await waitForNewer(after, signal, settings.pollTimeoutMs)
        }
        const events = pendingAfter(after).slice(0, MAX_BATCH_EVENTS)
        const next = events.length > 0 ? events[events.length - 1].seq : after
        return ok({ events, next, head, oldestSeq: oldestSeq() })
      }

      return fail('android-bridge/unknown-endpoint', `unknown android bridge endpoint ${JSON.stringify(endpoint)}`)
    } catch (error) {
      return fail('android-bridge/internal', error instanceof Error ? error.message : String(error))
    }
  }

  // 1. One exact authenticated POST route per bridge endpoint. Connection owns
  // Host/Origin and browser-session checks, so the page needs no extra token.
  for (const endpoint of [ENDPOINT_CONFIG, ENDPOINT_INBOUND, ENDPOINT_POLL]) {
    ctx.effect(() => ctx.connection.fetch.register(createRoute(endpoint)))
  }

  /** Build the exact Fetch route that answers one bridge endpoint. */
  function createRoute(endpoint) {
    return {
      path: `/api/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const payload = await readJsonBody(request)
        const result = await handleRpc(endpoint, payload, request.signal)
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      },
    }
  }

  // 2. Other Host plugins may push an event to Android without a tool call.
  ctx.on('android-bridge/send', (eventName, payload) => {
    if (typeof eventName !== 'string' || eventName.trim() === '') return
    enqueue(eventName.trim(), payload ?? null)
  })

  // 3. Forward the configured Host events.
  for (const eventName of settings.forwardedHostEvents) {
    ctx.on(eventName, (...args) => {
      enqueue(eventName, projectEvent(eventName, args))
    })
  }

  // 4. Semantic Session updates derived from the committed log: one final
  // assistant answer and one turn end, with no raw log objects on the wire.
  if (settings.forwardAssistantMessages) {
    const seenEvents = new Set()

    /** Report true exactly once per committed Session event. */
    const rememberOnce = (key) => {
      if (seenEvents.has(key)) return false
      seenEvents.add(key)
      if (seenEvents.size > MAX_SESSION_DEDUPE) {
        const oldest = seenEvents.values().next().value
        if (oldest !== undefined) seenEvents.delete(oldest)
      }
      return true
    }

    ctx.on('session/event', (session, event) => {
      try {
        // Delegated child Sessions would otherwise notify once per subagent.
        if (session?.header?.parentSession !== undefined) return
        if (session?.header?.origin === 'subagent') return
        if (event === null || typeof event !== 'object') return
        const sessionId = session?.id ?? session?.header?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (typeof event.seq !== 'number') return
        if (!rememberOnce(`${sessionId}:${event.seq}`)) return

        // The turn opened: the app can show a running indicator from this point
        // on, not only once the first answer lands.
        if (event.type === 'turn/start') {
          const data = event.data ?? {}
          enqueue(EVENT_SESSION_UPDATE, {
            sessionId,
            kind: 'turn-start',
            turn: data.turn,
            time: event.time,
          })
          return
        }

        if (event.type === 'assistant/message') {
          const data = event.data ?? {}
          const text = summarizeText(extractAssistantText(data.message))
          if (text === '') return
          enqueue(EVENT_SESSION_UPDATE, {
            sessionId,
            kind: 'assistant-message',
            turn: data.turn,
            step: data.step,
            time: event.time,
            text,
            interrupted: data.interrupted === true,
          })
          return
        }

        // Only the tool name travels: arguments can carry credentials and would
        // be far too long for a notification.
        if (event.type === 'tool/call') {
          const data = event.data ?? {}
          enqueue(EVENT_SESSION_UPDATE, {
            sessionId,
            kind: 'tool-start',
            turn: data.turn,
            callId: typeof data.callId === 'string' ? data.callId : null,
            toolName: typeof data.name === 'string' ? data.name : '',
            time: event.time,
          })
          return
        }

        if (event.type === 'tool/result') {
          const data = event.data ?? {}
          const callId = data?.message?.source?.callId ?? data?.message?.toolCallId ?? null
          enqueue(EVENT_SESSION_UPDATE, {
            sessionId,
            kind: 'tool-end',
            turn: data.turn,
            callId: typeof callId === 'string' ? callId : null,
            time: event.time,
          })
          return
        }

        if (event.type === 'approval/asked') {
          const data = event.data ?? {}
          enqueue(EVENT_SESSION_UPDATE, {
            sessionId,
            kind: 'approval',
            pending: true,
            requestId: data.id === undefined ? '' : String(data.id),
            toolName: typeof data.toolName === 'string' ? data.toolName : '',
            callId: typeof data.callId === 'string' ? data.callId : null,
            reason: summarizeText(typeof data.reason === 'string' ? data.reason : ''),
            time: event.time,
          })
          return
        }

        if (event.type === 'approval/decided') {
          const data = event.data ?? {}
          enqueue(EVENT_SESSION_UPDATE, {
            sessionId,
            kind: 'approval',
            pending: false,
            requestId: data.id === undefined ? '' : String(data.id),
            outcome: typeof data.outcome === 'string' ? data.outcome : '',
            time: event.time,
          })
          return
        }

        if (event.type === 'turn/end') {
          const data = event.data ?? {}
          enqueue(EVENT_SESSION_UPDATE, {
            sessionId,
            kind: 'turn-end',
            turn: data.turn,
            time: event.time,
            reason: data.reason ?? null,
          })
        }
      } catch (error) {
        warn('session update projection failed', error)
      }
    })
  }

  // 4b. Two things the app needs for a useful notification already exist as
  // Session projections, so they are read from there rather than re-derived:
  // the conversation title, and whether the user currently owes an answer.
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined && typeof projections.onChanged === 'function') {
    try {
      ctx.effect(() => projections.onChanged((session, key, value) => {
        try {
          if (session?.header?.parentSession !== undefined) return
          if (session?.header?.origin === 'subagent') return
          const sessionId = session?.id ?? session?.header?.id
          if (typeof sessionId !== 'string' || sessionId === '') return

          if (key === 'title') {
            enqueue(EVENT_SESSION_TITLE, {
              sessionId,
              title: summarizeText(typeof value === 'string' ? value : ''),
            })
            return
          }

          if (key === 'userQuestions') {
            enqueuePendingQuestion(sessionId, value)
          }
        } catch (error) {
          warn('session projection forwarding failed', error)
        }
      }))
    } catch (error) {
      // A deployment without the projection registry simply loses titles and
      // pending questions; every other bridge feature keeps working.
      warn('session projections are unavailable', error)
    }
  }

  /** Report the oldest still-open question, or clear the pending marker. */
  function enqueuePendingQuestion(sessionId, value) {
    const active = Array.isArray(value?.active) ? value.active : []
    if (active.length === 0) {
      enqueue(EVENT_SESSION_INPUT, { sessionId, pending: false })
      return
    }
    const first = active[0] ?? {}
    const questions = Array.isArray(first.questions) ? first.questions : []
    const question = questions[0] ?? {}
    enqueue(EVENT_SESSION_INPUT, {
      sessionId,
      pending: true,
      count: active.length,
      callId: typeof first.callId === 'string' ? first.callId : null,
      question: summarizeText(typeof question.question === 'string' ? question.question : ''),
      intentKind: typeof question?.intent?.kind === 'string' ? question.intent.kind : null,
    })
  }

  // 5. Let the model push an event to the Android app.
  const tools = ctx.get('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    try {
      ctx.effect(() => tools.register({
        name: 'android_bridge_send',
        description: [
          'Send one event from DeepSeek Harness to the Android host application that is',
          'displaying this session in a WebView. Use it to notify the app about something it',
          'should react to (for example "open_settings" or "sync_done"). The event is queued',
          'and delivered on the page\'s next poll; it is not a chat message and does not',
          'interrupt the turn.',
        ].join(' '),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              description: 'Event name the Android app switches on, for example "sync_done".',
            },
            payload: {
              type: 'object',
              additionalProperties: true,
              description: 'Optional JSON object carried with the event.',
            },
          },
          required: ['name'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              queued: { type: 'boolean', required: true, description: 'Whether the event entered the outbound queue.' },
              seq: { type: 'number', required: true, description: 'Queue sequence number of the event.' },
              connected: { type: 'boolean', required: true, description: 'Whether a page was waiting for events when it was queued.' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.connected
              ? `Queued android bridge event #${String(value.seq)}; the page is connected.`
              : `Queued android bridge event #${String(value.seq)}; no page is polling yet, so it is retained.`,
          }],
        },
        async execute(args) {
          const eventName = typeof args?.name === 'string' ? args.name.trim() : ''
          if (eventName === '') throw new Error('android_bridge_send requires a non-empty "name"')
          const seq = enqueue(eventName, args?.payload ?? null)
          return { queued: true, seq, connected: waiters.size > 0 }
        },
      }))
    } catch (error) {
      warn('android_bridge_send tool is unavailable', error)
    }
  }
}

/**
 * Normalize the Loader row's config into complete, validated settings.
 *
 * @param config - raw row config.
 * @returns resolved bridge settings.
 */
function resolveSettings(config) {
  return {
    forwardedHostEvents: normalizeNames(config?.forwardedHostEvents, DEFAULT_FORWARDED_HOST_EVENTS),
    forwardedClientEvents: normalizeNames(config?.forwardedClientEvents, DEFAULT_FORWARDED_CLIENT_EVENTS),
    bridgeObjectName: normalizeIdentifier(config?.bridgeObjectName, DEFAULT_BRIDGE_OBJECT_NAME),
    receiveFunctionName: normalizeIdentifier(config?.receiveFunctionName, DEFAULT_RECEIVE_FUNCTION_NAME),
    pollTimeoutMs: normalizeTimeout(config?.pollTimeoutMs),
    forwardAssistantMessages: config?.forwardAssistantMessages !== false,
  }
}

/** Pull the visible text out of one assistant message's content blocks. */
function extractAssistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Collapse whitespace and bound a summary for a notification body. */
function summarizeText(text) {
  if (typeof text !== 'string') return ''
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_SUMMARY_CHARS) return collapsed
  return `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

/**
 * Deduplicate a configured name list. An explicit empty list disables the
 * category; a missing or non-array value falls back to the defaults.
 */
function normalizeNames(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const seen = new Set()
  const result = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/** Accept a JS identifier used as a `window` property name; otherwise default. */
function normalizeIdentifier(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed) ? trimmed : fallback
}

/** Clamp the long-poll hold time into a sane range. */
function normalizeTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POLL_TIMEOUT_MS
  return Math.min(MAX_POLL_TIMEOUT_MS, Math.max(MIN_POLL_TIMEOUT_MS, Math.floor(value)))
}

/** Read a JSON object body, tolerating an absent or malformed one. */
async function readJsonBody(request) {
  try {
    const text = await request.text()
    if (typeof text !== 'string' || text.trim() === '') return {}
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Read a non-negative integer sequence, defaulting to 0. */
function normalizeSeq(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/** Project one forwarded event's positional arguments onto the wire payload. */
function projectEvent(eventName, args) {
  const projector = EVENT_PROJECTORS[eventName]
  if (projector !== undefined) return toJsonSafe(projector(args))
  if (args.length === 1) return toJsonSafe(args[0])
  return toJsonSafe(args)
}

/**
 * Convert a value into something `JSON.stringify` can always serialize, so one
 * unusual event payload can never break the bridge for every later event.
 *
 * @param value - arbitrary event payload.
 * @returns a JSON-safe projection.
 */
function toJsonSafe(value) {
  const ancestors = new Set()

  const normalize = (input) => {
    if (input === null) return null
    const kind = typeof input
    if (kind === 'string' || kind === 'boolean') return input
    if (kind === 'number') return Number.isFinite(input) ? input : String(input)
    if (kind === 'bigint') return input.toString()
    if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return undefined
    if (input instanceof Error) return { name: input.name, message: input.message }

    if (ancestors.has(input)) return '[circular]'
    ancestors.add(input)
    try {
      if (Array.isArray(input)) {
        return input.map((item) => {
          const normalized = normalize(item)
          return normalized === undefined ? null : normalized
        })
      }
      const result = {}
      for (const key of Object.keys(input)) {
        const normalized = normalize(input[key])
        if (normalized !== undefined) result[key] = normalized
      }
      return result
    } finally {
      ancestors.delete(input)
    }
  }

  try {
    const normalized = normalize(value)
    if (normalized === undefined) return null
    // Round-trip once so a self-referencing projection cannot leak a cycle.
    return JSON.parse(JSON.stringify(normalized))
  } catch {
    return String(value)
  }
}
