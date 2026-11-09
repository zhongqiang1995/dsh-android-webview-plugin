# DSH Android WebView bridge

Bidirectional event bridge between **DeepSeek Harness (DSH)** and the **Android
app hosting it in a WebView**.

- **DSH → Android**: Host events are relayed to the page and handed to your
  Android code through a `JavascriptInterface` callback (with a
  `postMessage` fallback).
- **Android → DSH**: your Android code calls one page function; the event
  becomes the Cordis event `android-bridge/event` on the Host, where any plugin
  (or the agent) can observe it.

Everything rides DSH's already-authenticated page ↔ Host channel, so no extra
port, token, or CORS setup is involved.

---

## 1. What is forwarded by default

### Host events (`forwardedHostEvents`)

| Event | Payload sent to Android | Meaning |
|---|---|---|
| `api-session/status` | `{ sessionId, running }` | Session started or stopped running |
| `api-session/activity` | `{ sessionId, updatedAt }` | Session had new activity |

These are the Session run-progress signals: `running: true` when the agent
starts a turn, `false` when it goes idle, and `updatedAt` as an activity ping.

### Client events (`forwardedClientEvents`)

Delivered from the page directly, without a Host round trip:

| Event | Payload | Meaning |
|---|---|---|
| `connection/reset` | `[]` | Page reconnected to the Host |
| `theme/change` | `[snapshot]` | Light / dark / system theme changed |
| `locale/change` | `[snapshot]` | UI language changed |

### Bridge lifecycle

| Event | Payload | Meaning |
|---|---|---|
| `dsh:bridge-ready` | `{ bridgeObjectName, receiveFunctionName }` | The page bridge is installed and polling |
| `dsh:bridge-down` | `null` | The page bridge was torn down (reload / plugin disabled) |

### Shell surface (Back navigation)

The Web UI is a single page with no URL routing, so the page — not the WebView
history — is the only half that can walk back to the Conversation. It reports
which surface is showing and absorbs the system Back while one is open:

| Direction | Event | Payload | Meaning |
|---|---|---|---|
| page → Android | `android/ui-state` | `{ conversation, panel, drawer, shellMounted, painted, revision }` | Which surface is showing, and how far the page has rendered; `conversation: true` is the only state where Back leaves the app |
| Android → page | `android/navigation/back` | `{ … }` (free-form, unused) | Absorb Back: close the drawer, else deselect the global panel |

`conversation` is read from the shell's own frame attributes: `data-global-panel`
marks a selected global main panel (Settings, Plugins, Schedules, …), and
`data-sidebar-drawer` without `data-sidebar-collapsed` marks an open drawer.

`shellMounted` turns true once the shell layout exists in the DOM, and `painted`
once it has been presented — reported after two animation frames, so a native
loading cover can hand the screen over without showing an unstyled frame. An app
should keep its cover until `painted`, and fall back to its own timeout: a
document that finishes loading is not the same thing as a page that can be shown.

A report is sent when that state changes, and never twice for the same one, so an
app can rely on `revision` strictly increasing. The command is handled with
`ctx.get('layout')?.selectPanel(null)` / `toggleSidebar()`, and still reaches the
Host as a normal `android-bridge/event` for observability.

Any event name can be added to `forwardedHostEvents`. Forwarded payloads are
JSON-safe: functions and circular references are projected away, and a payload
that cannot be serialized degrades to a string instead of breaking the bridge.

---

## 2. Page contract

### DSH → Android

For each event the page tries, in order:

1. `window[bridgeObjectName].onEvent(name, payloadJson)`
   (`payloadJson` is a JSON **string**; default object name `DSHAndroidBridge`).
2. `window.postMessage({ source: 'dsh-android-webview-bridge', name, payload }, '*')`.

### Android → DSH

Either of these starts an inbound event:

1. `window[receiveFunctionName](name, payload)`
   (default function name `DSHAndroidBridgeReceive`), e.g. via
   `evaluateJavascript`.
2. `postWebMessage` with the body
   `{ source: 'dsh-android-webview-bridge', name, payload }`.

Every inbound event also dispatches a DOM event so page code can react:

```js
window.addEventListener('dsh-android-bridge', (event) => {
  console.log(event.detail.name, event.detail.payload)
})
```

The bundled Android shell (`DshWrapper`) replies to `dsh:bridge-ready` with the
inbound event `native:ready` carrying `{ platform: 'android', sdk: <int> }`, so a
DSH plugin can tell when the app attached:

```js
ctx.on('android-bridge/event', (name, payload) => {
  if (name === 'native:ready') appAttached = payload.sdk
})
```

---

## 3. Android integration

### 3.1 Inject the interface

```kotlin
class DshBridge(
    private val onEvent: (name: String, payloadJson: String) -> Unit,
) {
    @JavascriptInterface
    fun onEvent(name: String, payloadJson: String) {
        onEvent(name, payloadJson)
    }
}

webView.settings.javaScriptEnabled = true
webView.addJavascriptInterface(
    DshBridge { name, payloadJson -> runOnUiThread { handleDshEvent(name, payloadJson) } },
    "DSHAndroidBridge",
)
webView.loadUrl(dshUrl) // the tokenized "dsh web:" URL
```

`payloadJson` is a JSON string; parse it with your JSON library
(`JSONObject(payloadJson)`, `kotlinx.serialization`, Moshi, …).

`api-session/status` then arrives as:

```json
{ "sessionId": "…", "running": true }
```

### 3.2 Send an event to DSH

```kotlin
fun sendToDsh(name: String, payloadJson: String) {
    val script = "window.DSHAndroidBridgeReceive(" +
        JSONObject.quote(name) + "," + payloadJson + ")"
    webView.evaluateJavascript(script, null)
}

// e.g. from a native button:
sendToDsh("app.resume", """{"reason":"foreground"}""")
```

On the DSH side that becomes the Cordis event `android-bridge/event` with
`(name, payload)`.

### 3.3 Receiving inside the page/or a plugin

- Host plugin: `ctx.on('android-bridge/event', (name, payload) => …)`
- Any Host plugin can push an event back:
  `ctx.emit('android-bridge/send', 'sync_done', { at: Date.now() })`
- The agent can push an event with the `android_bridge_send` tool.

### 3.4 Lifecycle notes

- `DSHAndroidBridgeReceive` exists once the page's module graph has loaded the
  Client half, which is **after** `onPageFinished`. Wait for the page's
  `dsh:bridge-ready` event before sending anything back; the DshWrapper Android
  shell does exactly that (`native:ready` is the reply).
- `dsh:bridge-ready` carries `{ bridgeObjectName, receiveFunctionName }`, so a
  shell can confirm the names before it calls anything.
- The page starts delivering at the Host's current queue head, so a fresh page
  does not replay events that were queued while it was away. The Host retains
  the most recent 500 events for the poll cursor; a page that reconnects keeps
  its own cursor, so events that arrived during a short drop are still
  delivered.
- If `DSHAndroidBridge` is not injected, delivery falls back to `postMessage`.
  To use the fallback, enable it on the WebView:

  ```kotlin
  WebViewCompat.addWebMessageListener(
      webView, "dshBridge", setOf("*"),
      object : WebViewCompat.WebMessageListener {
          override fun onPostMessage(view, message, sourceOrigin, isMainFrame, replyProxy) {
              val data = JSONObject(message.data)
              if (data.optString("source") == "dsh-android-webview-bridge") {
                  handleDshEvent(data.getString("name"), data.opt("payload").toString())
              }
          }
      },
  )
  ```

---

## 4. Configuration

Set these in `cordis.patch.yml` (or through the plugin's config row):

| Field | Default | Meaning |
|---|---|---|
| `forwardedHostEvents` | `[api-session/status, api-session/activity]` | Host events relayed to Android. `[]` disables Host forwarding. |
| `forwardedClientEvents` | `[connection/reset, theme/change, locale/change]` | Page events relayed to Android. |
| `bridgeObjectName` | `DSHAndroidBridge` | `window` property of the injected Android interface. |
| `receiveFunctionName` | `DSHAndroidBridgeReceive` | `window` function Android calls to send events. |
| `pollTimeoutMs` | `25000` | Long-poll hold time (1000–120000). |
| `forwardAssistantMessages` | `true` | Emit `android-bridge/session-update` for each turn start, final answer and turn end. |

### Semantic Session updates

Instead of forwarding raw Session log objects, the Host folds the committed log
into one small event any shell can notify on:

| Event | Payload | When |
|---|---|---|
| `android-bridge/session-update` | `{ sessionId, kind: "turn-start", turn, time }` | A turn opened, before any answer exists — the earliest reliable "running" signal |
| `android-bridge/session-update` | `{ sessionId, kind: "assistant-message", turn, step, time, text, interrupted }` | A final assistant answer was committed |
| `android-bridge/session-update` | `{ sessionId, kind: "turn-end", turn, time, reason: { kind } }` | The turn ended (`completed`, `aborted`, `error`, …) |
| `android-bridge/session-update` | `{ sessionId, kind: "tool-start", turn, callId, toolName, time }` | A tool call began. Only the name travels: arguments can carry credentials |
| `android-bridge/session-update` | `{ sessionId, kind: "tool-end", turn, callId, time }` | That tool call finished |
| `android-bridge/session-update` | `{ sessionId, kind: "approval", pending: true, requestId, toolName, callId, reason, time }` | The agent is blocked until the user decides |
| `android-bridge/session-update` | `{ sessionId, kind: "approval", pending: false, requestId, outcome, time }` | That exact request was answered |
| `android-bridge/session-title` | `{ sessionId, title }` | The `title` projection changed: the human-readable task name |
| `android-bridge/session-input` | `{ sessionId, pending, count, callId, question, intentKind }` | The `userQuestions` projection changed: the user owes an answer |

The last two come from `ctx.get('sessionProjections')` rather than re-deriving
state from the log, so the app and the Web UI agree on titles and pending
questions. When that service is absent the bridge logs a warning and simply stops
emitting those two events; every other feature keeps working.

`text` is the answer's visible text only: reasoning, tool arguments, attachments
and system/developer messages are dropped, whitespace is collapsed, and the
result is capped at 240 characters. Events from delegated child Sessions are
skipped, and a committed log event is delivered at most once. Set
`forwardAssistantMessages: false` to stop these and rely on
`api-session/status` alone.

### Useful Host events to add

| Event | Add it when you want | Payload |
|---|---|---|
| `api-session/added` / `api-session/removed` | Keep the app's session list in sync | `[SessionSummary]` / `[sessionId]` |
| `api-session/error` | Surface failures in the app | `[sessionId, message]` |
| `agent-preset/selected` | React to preset changes | `[sessionId, agentPreset]` |

`api-session/added` is forwarded by default and is projected to
`{ sessionId, running, agentAvailable, updatedAt, cwd, blank, … }` — a
`SessionSummary` carries no title, so it must not be treated as a "new answer"
notification.

---

## 5. Architecture

```
Android app  ⇄  WebView page (Client half)  ⇄  Host half
   │                    │                        │
   │ addJavascriptInterface  DSHAndroidBridge     │  three exact POST routes
   │ evaluateJavascript      DSHAndroidBridgeReceive     outbound queue + inbound events
   └────────────────────┴────────────────────────┘
```

- **Host half** (`index.js`) registers three exact `POST` routes under `/api`,
  keeps a bounded queue with a monotonic `seq`, forwards configured Host events,
  and registers the `android_bridge_send` tool. (It cannot use
  `connection.rpc.intercept`: the shared `/api` RPC channel admits only one
  interceptor, which the Typert Gateway owns.)
- **Client half** (`client.js`) installs the `window` entry points, long-polls
  `android-bridge.poll`, and forwards each event to the Java/native side.

### Endpoints

Each endpoint is an exact `POST` route under `/api`, carrying a JSON body and
answering JSON. Connection applies its Host/Origin and browser-session checks
before the handler runs, so no extra token is needed.

| Endpoint | Request body | Result |
|---|---|---|
| `POST /api/android-bridge.config` | `{}` | `{ bridgeObjectName, receiveFunctionName, forwardedClientEvents, forwardedHostEvents, pollTimeoutMs, head }` |
| `POST /api/android-bridge.poll` | `{ after }` | `{ events: [{ seq, name, payload }], next, head, oldestSeq }` |
| `POST /api/android-bridge.inbound` | `{ name, payload }` | `{ accepted, name, head }` |

Results use `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`
with codes `android-bridge/invalid-request`, `android-bridge/unknown-endpoint`, and
`android-bridge/internal`.

---

## 6. Limitations

- Events are relayed, not persisted: a page that has not polled yet does not
  replay the queue on connect (it starts at the current head).
- Inbound Android events reach plugins through `android-bridge/event`; they are
  not injected into the agent conversation. A plugin that wants the model to
  react should call `agent.followup()` on its own authority.
- `agent/assistant-stream` (token-by-token output) is deliberately **not**
  forwarded; it is a high-frequency stream, not an event.
- The bridge requires the Web composition (`dsh --profile web` or Desktop): it
  needs a page and the `connection` service.

---

## 7. Verify locally

`test/bridge-check.mjs` drives both halves without a browser or a device: it
captures the Host's registered routes and Cordis listeners, round-trips config,
forwarded events, long polling (including wake-on-event and timeout), inbound
events, and the model tool, then loads the Client module against a stub page and
asserts the `window` contract, the poll cursor, and disposal.

```sh
node test/bridge-check.mjs
```

It exits 0 and prints `ALL CHECKS PASSED`.

A page-side smoke check after installing the plugin and reloading the Web GUI:

```js
// in the browser console
typeof window.DSHAndroidBridgeReceive            // "function"
window.DSHAndroidBridgeReceive('hello', { a: 1 })  // -> Promise { ok: true, … }
```

---

## 8. Install on another machine

The package is private (`@local/`), build-free ESM: no `postinstall`, no compiled
`dist`, nothing fetched from a registry. Install it with the `dsh plugin`
command, which forwards to pnpm inside the profile directory **and** appends the
bundle name to `dsh.profile.bundles` — no manifest hand-editing is needed.

### 8.1 From a tarball (recommended for a one-off copy)

```sh
npm pack
# -> local-dsh-android-webview-bridge-1.0.0.tgz  (8 files, ~18 kB)
```

Copy that `.tgz` to a stable path on the other machine, then:

```sh
dsh plugin --profile web add file:C:\path\to\local-dsh-android-webview-bridge-1.0.0.tgz
```

### 8.2 From a folder (`link:`, live edits)

```sh
dsh plugin --profile web add link:F:\project\dsh\dsh-android-webview-plugin
```

pnpm creates a junction to that folder, so source edits take effect on reload
with no reinstall. The folder has to stay at that exact path on that machine.

### 8.3 After installing

Restart `dsh web` (or let the profile's live patch reload), then reload the page.
Check with the page-side smoke test above, or:

```sh
curl -X POST http://127.0.0.1:<port>/api/android-bridge.config -d '{}'
```

### 8.4 Notes

- The profile must be the **Web** one: the bridge needs a page and the
  `connection` service, so `dsh --profile web` or Desktop.
- On the official Desktop app the `desktop` profile is owned by the in-process
  plugin manager: use **Settings → Plugins**, or ask the agent to install the
  same spec. `dsh plugin --profile desktop` is refused by design.
- Uninstall with `dsh plugin --profile web remove @local/dsh-android-webview-bridge`;
  it also withdraws the `dsh.profile.bundles` entry.
- `package.json` `files` decides what ships — add new runtime files there, or the
  tarball will silently miss them.
