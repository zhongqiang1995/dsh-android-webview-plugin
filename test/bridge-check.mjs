/**
 * Local verification harness for the Android WebView bridge package.
 * Drives the Host half's registered fetch routes and the Client half's page
 * contract without a browser or an Android device.
 *
 * Run: node check.mjs
 */

const HOST_ENTRY = 'file:///F:/project/dsh/dsh-android-webview-plugin/index.js'
const CLIENT_ENTRY = 'file:///F:/project/dsh/dsh-android-webview-plugin/client.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- Host half ---

const host = await import(HOST_ENTRY)
const routes = new Map()
const hostListeners = new Map()
const hostEmitted = []
const hostTools = []

let projectionListener
const hostCtx = {
  logger: { warn: (message) => console.log(`   [warn] ${message}`) },
  effect: (factory) => factory(),
  on: (eventName, listener) => {
    const list = hostListeners.get(eventName) ?? []
    list.push(listener)
    hostListeners.set(eventName, list)
    return () => {}
  },
  get: (key) => {
    if (key === 'tools') {
      return { register: (definition) => { hostTools.push(definition); return () => {} } }
    }
    if (key === 'sessionProjections') {
      return {
        onChanged: (listener) => {
          projectionListener = listener
          return () => {}
        },
      }
    }
    return undefined
  },
  emit: (...args) => hostEmitted.push(args),
  connection: {
    fetch: {
      register: (route) => { routes.set(route.path, route); return () => {} },
    },
  },
}

host.apply(hostCtx, { pollTimeoutMs: 1000 })

check('host: exports inject=connection', JSON.stringify(host.inject) === '["connection"]', host.inject)
check('host: registers 3 exact POST routes', routes.size === 3, [...routes.keys()])
check('host: routes are POST/buffered', [...routes.values()].every(
  (route) => route.methods?.length === 1 && route.methods[0] === 'POST' && route.requestBody === 'buffered',
))
check('host: forwards api-session/status', hostListeners.has('api-session/status'))
check('host: forwards api-session/activity', hostListeners.has('api-session/activity'))
check('host: listens for android-bridge/send', hostListeners.has('android-bridge/send'))
check('host: registers android_bridge_send tool', hostTools.length === 1 && hostTools[0].name === 'android_bridge_send')

async function post(endpoint, body) {
  const route = routes.get(`/api/${endpoint}`)
  if (route === undefined) throw new Error(`missing route ${endpoint}`)
  const response = await route.fetch(new Request(`http://host/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }))
  return { status: response.status, body: await response.json() }
}

// config
const config = await post('android-bridge.config', {})
check('config: status 200', config.status === 200)
check('config: default object name', config.body.value?.bridgeObjectName === 'DSHAndroidBridge', config.body.value)
check('config: default receive function', config.body.value?.receiveFunctionName === 'DSHAndroidBridgeReceive', config.body.value)
check('config: default client events',
  JSON.stringify(config.body.value?.forwardedClientEvents) === '["connection/reset","theme/change","locale/change"]',
  config.body.value?.forwardedClientEvents)
check('config: default host events',
  JSON.stringify(config.body.value?.forwardedHostEvents)
    === '["api-session/status","api-session/activity","api-session/added"]',
  config.body.value?.forwardedHostEvents)

// forwarded host event -> queue projection
hostListeners.get('api-session/status')[0]('session-1', true)
const poll1 = await post('android-bridge.poll', { after: 0 })
check('poll: delivers the forwarded event', poll1.body.value?.events?.length === 1, poll1.body.value)
check('poll: api-session/status payload is named',
  JSON.stringify(poll1.body.value?.events?.[0]?.payload) === '{"sessionId":"session-1","running":true}',
  poll1.body.value?.events?.[0]?.payload)
check('poll: event name preserved', poll1.body.value?.events?.[0]?.name === 'api-session/status')
const afterFirst = poll1.body.value.next
check('poll: next advances', afterFirst === 1, afterFirst)

// no new events -> holds for the configured timeout
const holdStart = Date.now()
const held = await post('android-bridge.poll', { after: afterFirst })
const holdMs = Date.now() - holdStart
check('poll: empty round returns no events', held.body.value?.events?.length === 0, held.body.value)
check('poll: holds roughly pollTimeoutMs (>=900ms)', holdMs >= 900, holdMs)
check('poll: hold stops at the timeout (<3000ms)', holdMs < 3000, holdMs)

// a queued event wakes a suspended poll immediately
const wakeStart = Date.now()
const pendingPoll = post('android-bridge.poll', { after: afterFirst })
await sleep(120)
hostListeners.get('api-session/activity')[0]('session-1', 1731000000000)
const woken = await pendingPoll
const wakeMs = Date.now() - wakeStart
check('poll: a new event wakes the suspended poll', woken.body.value?.events?.length === 1, woken.body.value)
check('poll: wake is prompt (<900ms)', wakeMs < 900, wakeMs)
check('poll: activity payload is named',
  JSON.stringify(woken.body.value?.events?.[0]?.payload) === '{"sessionId":"session-1","updatedAt":1731000000000}',
  woken.body.value?.events?.[0]?.payload)
const afterSecond = woken.body.value.next

// inbound: Android -> Host
const inbound = await post('android-bridge.inbound', { name: 'app.resume', payload: { reason: 'foreground' } })
check('inbound: accepted', inbound.body.value?.accepted === true, inbound.body)
check('inbound: emits android-bridge/event', hostEmitted.length === 1 && hostEmitted[0][0] === 'android-bridge/event', hostEmitted)
check('inbound: carries name', hostEmitted[0]?.[1] === 'app.resume', hostEmitted[0])
check('inbound: carries payload', JSON.stringify(hostEmitted[0]?.[2]) === '{"reason":"foreground"}', hostEmitted[0]?.[2])

const emptyInbound = await post('android-bridge.inbound', { name: '   ' })
check('inbound: rejects an empty name', emptyInbound.body.ok === false && emptyInbound.body.error?.code === 'android-bridge/invalid-request', emptyInbound.body)

// the model tool enqueues
const toolResult = await hostTools[0].execute({ name: 'sync_done', payload: { files: 3 } })
check('tool: reports queued', toolResult?.queued === true && typeof toolResult.seq === 'number', toolResult)
check('tool: connected=false without a waiting poll', toolResult?.connected === false, toolResult)

const poll3 = await post('android-bridge.poll', { after: afterSecond })
check('poll: delivers the tool event', poll3.body.value?.events?.length === 1, poll3.body.value)
check('poll: tool event name', poll3.body.value?.events?.[0]?.name === 'sync_done', poll3.body.value?.events?.[0])
check('poll: tool event payload', JSON.stringify(poll3.body.value?.events?.[0]?.payload) === '{"files":3}', poll3.body.value?.events?.[0]?.payload)

// another plugin pushes through the Cordis event
hostListeners.get('android-bridge/send')[0]('external.push', [1, 2])
const poll4 = await post('android-bridge.poll', { after: poll3.body.value.next })
check('send event: enqueues', poll4.body.value?.events?.[0]?.name === 'external.push', poll4.body.value)

// non-serializable payload must not break the queue
hostListeners.get('android-bridge/send')[0]('weird', { when: () => {}, node: null })
const poll5 = await post('android-bridge.poll', { after: poll4.body.value.next })
check('non-serializable payload is projected', poll5.body.value?.events?.[0]?.name === 'weird'
  && JSON.stringify(poll5.body.value.events[0].payload) === '{"node":null}', poll5.body.value)
let cursor = poll5.body.value.next

// api-session/added -> summary projection (no title, no raw Session objects)
hostListeners.get('api-session/added')[0]({
  sessionId: 'session-2',
  running: false,
  agentAvailable: true,
  updatedAt: 1731000001000,
  blank: true,
  cwd: '/work',
  projections: { kind: 'cached', asOfSeq: 3, values: {} },
})
const poll6 = await post('android-bridge.poll', { after: cursor })
const addedPayload = poll6.body.value?.events?.[0]?.payload
check('api-session/added: enqueued', poll6.body.value?.events?.[0]?.name === 'api-session/added', poll6.body.value)
check('api-session/added: named projection',
  JSON.stringify(addedPayload) === '{"sessionId":"session-2","running":false,"agentAvailable":true,"updatedAt":1731000001000,"cwd":"/work","blank":true}',
  addedPayload)
check('api-session/added: drops internal projections',
  addedPayload !== undefined && !('projections' in addedPayload), addedPayload)
cursor = poll6.body.value.next

// session/event -> semantic session update
check('session/event: listener registered', hostListeners.has('session/event'))
const emitSessionEvent = hostListeners.get('session/event')[0]
const sessionStub = { id: 'session-2', header: { id: 'session-2' } }
emitSessionEvent(sessionStub, {
  type: 'assistant/message',
  seq: 11,
  time: 1731000002000,
  data: {
    turn: 2,
    step: 1,
    interrupted: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'internal thinking' },
        { type: 'text', text: '  Done.\n\nThe build passes.  ' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
      ],
    },
  },
})
const poll7 = await post('android-bridge.poll', { after: cursor })
const updatePayload = poll7.body.value?.events?.[0]?.payload
check('session-update: event name', poll7.body.value?.events?.[0]?.name === 'android-bridge/session-update', poll7.body.value)
check('session-update: assistant summary is text only',
  updatePayload?.kind === 'assistant-message' && updatePayload?.text === 'Done. The build passes.', updatePayload)
check('session-update: carries session and turn',
  updatePayload?.sessionId === 'session-2' && updatePayload?.turn === 2 && updatePayload?.step === 1, updatePayload)
check('session-update: never leaks message objects',
  updatePayload !== undefined && !('message' in updatePayload) && !('content' in updatePayload), updatePayload)
cursor = poll7.body.value.next

// the same committed event must not notify twice
emitSessionEvent(sessionStub, {
  type: 'assistant/message',
  seq: 11,
  time: 1731000002000,
  data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
})
const poll8 = await post('android-bridge.poll', { after: cursor })
check('session-update: duplicate seq is dropped', poll8.body.value?.events?.length === 0, poll8.body.value)

// turn/end carries the reason and is also de-duplicated
emitSessionEvent(sessionStub, {
  type: 'turn/end',
  seq: 12,
  time: 1731000003000,
  data: { turn: 2, reason: { kind: 'completed' } },
})
const poll9 = await post('android-bridge.poll', { after: cursor })
const turnEndPayload = poll9.body.value?.events?.[0]?.payload
check('session-update: turn-end kind', turnEndPayload?.kind === 'turn-end', turnEndPayload)
check('session-update: turn-end reason', turnEndPayload?.reason?.kind === 'completed', turnEndPayload)
cursor = poll9.body.value.next

emitSessionEvent(sessionStub, {
  type: 'turn/end',
  seq: 12,
  time: 1731000003000,
  data: { turn: 2, reason: { kind: 'completed' } },
})
const poll10 = await post('android-bridge.poll', { after: cursor })
check('session-update: duplicate turn-end is dropped', poll10.body.value?.events?.length === 0, poll10.body.value)

// a turn opening is reported so the app can show a running indicator early
emitSessionEvent(sessionStub, { type: 'turn/start', seq: 20, time: 1731000004000, data: { turn: 3 } })
const pollTurnStart = await post('android-bridge.poll', { after: cursor })
const turnStartPayload = pollTurnStart.body.value?.events?.[0]?.payload
check('session-update: turn-start kind', turnStartPayload?.kind === 'turn-start', turnStartPayload)
check('session-update: turn-start carries session and turn',
  turnStartPayload?.sessionId === 'session-2' && turnStartPayload?.turn === 3, turnStartPayload)
cursor = pollTurnStart.body.value.next

// tool calls and results become a coarse "what is it doing" phase
emitSessionEvent(sessionStub, {
  type: 'tool/call',
  seq: 21,
  time: 1731000005000,
  data: { turn: 3, step: 1, callId: 'call-1', name: 'pwsh', arguments: '{"command":"secret"}' },
})
const pollToolStart = await post('android-bridge.poll', { after: cursor })
const toolStart = pollToolStart.body.value?.events?.[0]?.payload
check('session-update: tool-start kind', toolStart?.kind === 'tool-start', toolStart)
check('session-update: tool-start names the tool only',
  toolStart?.toolName === 'pwsh' && !('arguments' in toolStart), toolStart)
cursor = pollToolStart.body.value.next

emitSessionEvent(sessionStub, {
  type: 'tool/result',
  seq: 22,
  time: 1731000006000,
  data: {
    turn: 3,
    step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [] },
  },
})
const pollToolEnd = await post('android-bridge.poll', { after: cursor })
const toolEnd = pollToolEnd.body.value?.events?.[0]?.payload
check('session-update: tool-end carries the call id',
  toolEnd?.kind === 'tool-end' && toolEnd?.callId === 'call-1', toolEnd)
cursor = pollToolEnd.body.value.next

// approvals: asked opens the wait, decided closes exactly that request
emitSessionEvent(sessionStub, {
  type: 'approval/asked',
  seq: 23,
  time: 1731000007000,
  data: { id: 'approval-1', toolName: 'pwsh', callId: 'call-2', reason: '  needs  network\naccess ' },
})
const pollAsked = await post('android-bridge.poll', { after: cursor })
const asked = pollAsked.body.value?.events?.[0]?.payload
check('session-update: approval asked is pending',
  asked?.kind === 'approval' && asked?.pending === true && asked?.requestId === 'approval-1', asked)
check('session-update: approval carries tool and collapsed reason',
  asked?.toolName === 'pwsh' && asked?.reason === 'needs network access', asked)
cursor = pollAsked.body.value.next

emitSessionEvent(sessionStub, {
  type: 'approval/decided',
  seq: 24,
  time: 1731000008000,
  data: { id: 'approval-1', outcome: 'allowed-once' },
})
const pollDecided = await post('android-bridge.poll', { after: cursor })
const decided = pollDecided.body.value?.events?.[0]?.payload
check('session-update: approval decided closes it',
  decided?.kind === 'approval' && decided?.pending === false
    && decided?.requestId === 'approval-1' && decided?.outcome === 'allowed-once', decided)
cursor = pollDecided.body.value.next

// the title projection drives the human-readable task name
check('session-projections: subscribed', typeof projectionListener === 'function')
projectionListener(sessionStub, 'title', '  修复登录页\n校验  ')
const pollTitle = await post('android-bridge.poll', { after: cursor })
const titlePayload = pollTitle.body.value?.events?.[0]?.payload
check('session-title: event name',
  pollTitle.body.value?.events?.[0]?.name === 'android-bridge/session-title', pollTitle.body.value)
check('session-title: collapsed title',
  titlePayload?.sessionId === 'session-2' && titlePayload?.title === '修复登录页 校验', titlePayload)
cursor = pollTitle.body.value.next

// a pending question becomes an explicit input request
projectionListener(sessionStub, 'userQuestions', {
  active: [{
    callId: 'call-3',
    state: 'open',
    questions: [{ id: 'q1', question: '是否覆盖现有配置？', intent: { kind: 'approval', approve: '覆盖', reject: '跳过' } }],
  }],
  settled: [],
})
const pollQuestion = await post('android-bridge.poll', { after: cursor })
const questionPayload = pollQuestion.body.value?.events?.[0]?.payload
check('session-input: pending question',
  questionPayload?.pending === true && questionPayload?.question === '是否覆盖现有配置？', questionPayload)
check('session-input: carries intent and count',
  questionPayload?.intentKind === 'approval' && questionPayload?.count === 1, questionPayload)
cursor = pollQuestion.body.value.next

projectionListener(sessionStub, 'userQuestions', { active: [], settled: [] })
const pollQuestionCleared = await post('android-bridge.poll', { after: cursor })
check('session-input: cleared when nothing is pending',
  pollQuestionCleared.body.value?.events?.[0]?.payload?.pending === false, pollQuestionCleared.body.value)
cursor = pollQuestionCleared.body.value.next

// unrelated event types and subagent sessions stay off the wire
emitSessionEvent(sessionStub, { type: 'step/start', seq: 13, time: 1, data: { turn: 2, step: 2 } })
emitSessionEvent(
  { id: 'child-1', header: { id: 'child-1', parentSession: 'session-2' } },
  {
    type: 'assistant/message',
    seq: 1,
    time: 1,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } },
  },
)
const poll11 = await post('android-bridge.poll', { after: cursor })
check('session-update: ignores other log events and subagent sessions',
  poll11.body.value?.events?.length === 0, poll11.body.value)

// -------------------------------------------------------------- Client half ---

const posts = []
const delivered = []
const domEvents = []

globalThis.window = globalThis
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}
globalThis.fetch = async (url, init) => {
  await sleep(40)
  posts.push({ url, body: init?.body })
  return new Response(JSON.stringify({
    ok: true,
    value: {
      bridgeObjectName: 'DSHAndroidBridge',
      receiveFunctionName: 'DSHAndroidBridgeReceive',
      forwardedClientEvents: ['theme/change'],
      forwardedHostEvents: [],
      pollTimeoutMs: 1000,
      head: 7,
      events: [],
      next: 7,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
globalThis.postMessage = (message) => delivered.push(message)
/** Stand-in for the page's EventTarget surface. */
const pageListeners = new Map()
globalThis.addEventListener = (type, listener) => {
  const list = pageListeners.get(type) ?? []
  list.push(listener)
  pageListeners.set(type, list)
}
globalThis.removeEventListener = (type, listener) => {
  const list = pageListeners.get(type) ?? []
  const index = list.indexOf(listener)
  if (index >= 0) list.splice(index, 1)
}
globalThis.DSHAndroidBridge = { onEvent: (name, payloadJson) => delivered.push({ via: 'interface', name, payloadJson }) }
globalThis.dispatchEvent = (event) => { domEvents.push(event); return true }

// --- Shell surface stand-in ------------------------------------------------
// The page half reads the frame's data attributes to know which surface is
// showing, and drives `ctx.layout` to return to the Conversation.
const shellSurface = {
  globalPanel: false,
  drawerMode: false,
  drawerCollapsed: true,
  frameMounted: false,
}
const frameStub = {
  hasAttribute: (name) => {
    if (name === 'data-sidebar-drawer') return shellSurface.drawerMode
    if (name === 'data-sidebar-collapsed') return shellSurface.drawerCollapsed
    return false
  },
}
const viewObservers = []
globalThis.MutationObserver = class MutationObserver {
  constructor(callback) { this.callback = callback }
  observe() { viewObservers.push(this) }
  disconnect() {
    const index = viewObservers.indexOf(this)
    if (index >= 0) viewObservers.splice(index, 1)
  }
}
const fireViewChange = () => {
  for (const observer of viewObservers.slice()) observer.callback([])
}
globalThis.document = {
  documentElement: {},
  querySelector: (selector) => {
    if (selector === '[data-global-panel]') return shellSurface.globalPanel ? {} : null
    if (selector === '[data-rightbar-col]') {
      return shellSurface.frameMounted ? { parentElement: frameStub } : null
    }
    return null
  },
}
/** Manual animation frames, so the paint boundary is observable in a test. */
const frameCallbacks = []
globalThis.requestAnimationFrame = (callback) => {
  frameCallbacks.push(callback)
  return frameCallbacks.length
}
const runFrame = () => {
  for (const callback of frameCallbacks.splice(0)) callback(0)
}
const layoutCalls = []
const layoutStub = {
  selectPanel: (panelId) => layoutCalls.push(['selectPanel', panelId]),
  toggleSidebar: () => layoutCalls.push(['toggleSidebar']),
}

const loaded = []
globalThis.__ModuleLoader__ = { load: (definition) => loaded.push(definition) }

await import(CLIENT_ENTRY)
check('client: registers one module factory', loaded.length === 1)
check('client: module id matches the package', loaded[0].id === '@local/dsh-android-webview-bridge', loaded[0].id)

const plugin = loaded[0].factory()
const clientListeners = new Map()
const disposers = []
const clientCtx = {
  get: (name) => (name === 'layout' ? layoutStub : undefined),
  on: (eventName, listener) => {
    const list = clientListeners.get(eventName) ?? []
    list.push(listener)
    clientListeners.set(eventName, list)
  },
  effect: (factory) => { disposers.push(factory()) },
}
plugin.apply(clientCtx)

check('client: installs the receive function immediately',
  typeof globalThis.DSHAndroidBridgeReceive === 'function')

await sleep(150)
check('client: calls the config endpoint', posts.some((entry) => entry.url === 'api/android-bridge.config'), posts.map((p) => p.url))
check('client: starts polling at the host head',
  posts.some((entry) => entry.url === 'api/android-bridge.poll' && entry.body === JSON.stringify({ after: 7 })),
  posts.map((entry) => [entry.url, entry.body]))
check('client: announces bridge readiness',
  delivered.some((message) => message.via === 'interface' && message.name === 'dsh:bridge-ready'),
  delivered)
check('client: subscribes to forwarded client events', clientListeners.has('theme/change'), [...clientListeners.keys()])

// Android -> DSH through the page function
const beforeInbound = posts.length
globalThis.DSHAndroidBridgeReceive('app.resume', { reason: 'foreground' })
await sleep(120)
const inboundPost = posts.slice(beforeInbound).find((entry) => entry.url === 'api/android-bridge.inbound')
check('client: receive function POSTs inbound', inboundPost !== undefined, posts.slice(beforeInbound))
check('client: inbound body carries name and payload',
  inboundPost?.body === JSON.stringify({ name: 'app.resume', payload: { reason: 'foreground' } }),
  inboundPost?.body)
check('client: inbound dispatches a DOM event', domEvents.length === 1 && domEvents[0]?.detail?.name === 'app.resume', domEvents)

// postMessage fallback for inbound, and foreign messages are ignored
const beforeMessage = posts.length
for (const listener of pageListeners.get('message') ?? []) {
  listener({ data: { source: 'dsh-android-webview-bridge', name: 'from.message', payload: 1 } })
  listener({ data: { source: 'somebody-else', name: 'ignored', payload: 2 } })
}
await sleep(150)
const inboundFromMessage = posts.slice(beforeMessage).filter((entry) => entry.url === 'api/android-bridge.inbound')
check('client: postMessage inbound is forwarded',
  inboundFromMessage.length === 1
    && inboundFromMessage[0].body === JSON.stringify({ name: 'from.message', payload: 1 }),
  inboundFromMessage)

// ------------------------------------------------- Back navigation contract ---

const lastViewState = () => {
  const messages = delivered.filter((message) => message.name === 'android/ui-state')
  const last = messages[messages.length - 1]
  return last === undefined ? undefined : JSON.parse(last.payloadJson)
}

check('ui-state: reported once the bridge is ready',
  lastViewState()?.conversation === true, lastViewState())

// First paint: a blank page must never claim it is ready to be revealed.
check('ui-state: a page without a mounted layout reports no paint',
  lastViewState()?.shellMounted === false && lastViewState()?.painted === false, lastViewState())

shellSurface.frameMounted = true
fireViewChange()
await sleep(300)
check('ui-state: a mounted layout is reported before it paints',
  lastViewState()?.shellMounted === true && lastViewState()?.painted === false, lastViewState())
check('ui-state: the paint boundary is waited for, not assumed',
  frameCallbacks.length === 1, frameCallbacks.length)

runFrame()
await sleep(50)
check('ui-state: one frame is not a paint', lastViewState()?.painted === false, lastViewState())

runFrame()
await sleep(80)
check('ui-state: two frames report the paint', lastViewState()?.painted === true, lastViewState())

// A surface change never re-claims a paint it already reported.
shellSurface.globalPanel = true
fireViewChange()
await sleep(300)
check('ui-state: later surface changes keep the paint flag',
  lastViewState()?.painted === true && lastViewState()?.panel === true, lastViewState())
shellSurface.globalPanel = false
fireViewChange()
await sleep(300)

// A global panel (Settings / Plugins) is open: Back returns to the Conversation.
shellSurface.globalPanel = true
fireViewChange()
await sleep(300)
check('ui-state: a global panel is not the conversation',
  lastViewState()?.conversation === false && lastViewState()?.panel === true, lastViewState())

layoutCalls.length = 0
const beforeBack = posts.length
globalThis.DSHAndroidBridgeReceive('android/navigation/back', { source: 'system-back' })
await sleep(150)
check('navigation back: deselects the global panel',
  layoutCalls.length === 1 && layoutCalls[0][0] === 'selectPanel' && layoutCalls[0][1] === null,
  layoutCalls)
check('navigation back: still reaches the host as an inbound event',
  posts.slice(beforeBack).some((entry) => entry.url === 'api/android-bridge.inbound'
    && entry.body === JSON.stringify({ name: 'android/navigation/back', payload: { source: 'system-back' } })),
  posts.slice(beforeBack).map((entry) => [entry.url, entry.body]))
check('navigation back: still dispatches the page custom event',
  domEvents.some((event) => event?.detail?.name === 'android/navigation/back'),
  domEvents.map((event) => event?.detail?.name))

// Back on the selection the panel change actually produces reports the Conversation.
shellSurface.globalPanel = false
fireViewChange()
await sleep(300)
check('ui-state: back on the conversation again',
  lastViewState()?.conversation === true && lastViewState()?.panel === false, lastViewState())

// An open drawer is absorbed first: the panel stays selected.
shellSurface.globalPanel = true
shellSurface.drawerMode = true
shellSurface.drawerCollapsed = false
fireViewChange()
await sleep(300)
check('ui-state: an open drawer is not the conversation',
  lastViewState()?.conversation === false && lastViewState()?.drawer === true, lastViewState())

layoutCalls.length = 0
globalThis.DSHAndroidBridgeReceive('android/navigation/back', null)
await sleep(150)
check('navigation back: closes the drawer before anything else',
  layoutCalls.length === 1 && layoutCalls[0][0] === 'toggleSidebar', layoutCalls)

// The conversation itself is left alone, so the app may leave on that press.
shellSurface.globalPanel = false
shellSurface.drawerCollapsed = true
fireViewChange()
await sleep(300)
layoutCalls.length = 0
globalThis.DSHAndroidBridgeReceive('android/navigation/back', null)
await sleep(150)
check('navigation back: never navigates away from the conversation',
  layoutCalls.length === 0, layoutCalls)

// Repeating a state that the app was never told otherwise is the bug this
// guards: every report must differ from the one before it, so the cover can
// never be re-raised by an unchanged message.
check('ui-state: unchanged surfaces are not re-sent',
  (() => {
    const signatures = delivered
      .filter((message) => message.name === 'android/ui-state')
      .map((message) => {
        const value = JSON.parse(message.payloadJson)
        return [value.conversation, value.panel, value.drawer, value.shellMounted, value.painted].join('|')
      })
    return signatures.every((value, index) => index === 0 || value !== signatures[index - 1])
  })(),
  delivered.filter((message) => message.name === 'android/ui-state').map((message) => message.payloadJson))

check('ui-state: revision increases with every change',
  (() => {
    const revisions = delivered
      .filter((message) => message.name === 'android/ui-state')
      .map((message) => JSON.parse(message.payloadJson).revision)
    return revisions.every((value, index) => index === 0 || value > revisions[index - 1])
  })(),
  delivered.filter((message) => message.name === 'android/ui-state').map((message) => message.payloadJson))

// dispose must remove the page surface
for (const dispose of disposers) {
  if (typeof dispose === 'function') dispose()
}
check('client: dispose removes the receive function',
  globalThis.DSHAndroidBridgeReceive === undefined,
  typeof globalThis.DSHAndroidBridgeReceive)
check('client: dispose stops observing the shell surface',
  viewObservers.length === 0, viewObservers.length)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
