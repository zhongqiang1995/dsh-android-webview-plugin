/**
 * Client half of the DeepSeek Harness <-> Android WebView bridge.
 *
 * Installs the page-side contract the Android app talks to and pumps Host
 * events into it:
 *
 * DeepSeek Harness -> Android
 *   1. `window[bridgeObjectName].onEvent(name, payloadJson)` when the app
 *      injected a JavascriptInterface (default name `DSHAndroidBridge`).
 *   2. Otherwise `window.postMessage({ source, name, payload }, '*')`, which an
 *      app using WebMessageListener / WebChromeClient.onMessage receives.
 *
 * Android -> DeepSeek Harness
 *   1. `window[receiveFunctionName](name, payload)` (default
 *      `DSHAndroidBridgeReceive`), called from `evaluateJavascript`.
 *   2. Or `postWebMessage` carrying `{ source, name, payload }`.
 *
 * Every inbound call also dispatches a `dsh-android-bridge` DOM CustomEvent so
 * page code can observe it, and reaches the Host as the
 * `android-bridge/event` Cordis event.
 *
 * Android's system Back is handled here too, because the shell has no URL
 * routing to walk back through: the page reports which surface is showing as
 * `android/ui-state`, and absorbs `android/navigation/back` by closing the
 * drawer or deselecting the global panel — always returning to the
 * Conversation, which is the only surface where Back leaves the app.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-android-webview-bridge',
  factory() {
    /** Marker the page and the app agree on for `postMessage` traffic. */
    const MESSAGE_SOURCE = 'dsh-android-webview-bridge'
    /** DOM CustomEvent name dispatched for every inbound Android event. */
    const DOM_EVENT_NAME = 'dsh-android-bridge'

    const DEFAULTS = {
      bridgeObjectName: 'DSHAndroidBridge',
      receiveFunctionName: 'DSHAndroidBridgeReceive',
      forwardedClientEvents: ['connection/reset', 'theme/change', 'locale/change'],
      pollTimeoutMs: 25000,
    }

    const ENDPOINT_CONFIG = 'android-bridge.config'
    const ENDPOINT_INBOUND = 'android-bridge.inbound'
    const ENDPOINT_POLL = 'android-bridge.poll'

    /**
     * Android -> page: the system Back button, which the page absorbs while a
     * surface above the Conversation is open.
     */
    const NAVIGATION_BACK_EVENT = 'android/navigation/back'
    /**
     * Page -> Android: which surface is showing, so Back either navigates (the
     * page handles it) or leaves the app.
     */
    const VIEW_STATE_EVENT = 'android/ui-state'

    /** Attributes whose change can move the user between surfaces. */
    const VIEW_ATTRIBUTES = [
      'data-global-panel',
      'data-sidebar-collapsed',
      'data-sidebar-drawer',
      'data-rightbar-collapsed',
      'data-rightbar-fullscreen',
      'class',
      'hidden',
      'inert',
      'open',
      'aria-hidden',
      'aria-expanded',
      'role',
      'data-state',
    ]
    /** Quiet window after a DOM change before the surface is re-read. */
    const VIEW_SETTLE_MS = 120

    const MIN_RETRY_MS = 400
    const MAX_RETRY_MS = 5000

    return {
      inject: [],
      apply(ctx) {
        if (typeof globalThis.fetch !== 'function') {
          console.warn('[android-bridge] fetch is unavailable; the bridge stays inactive')
          return
        }

        const settings = { ...DEFAULTS }
        /** Installed `window` function names, so cleanup removes exactly those. */
        const installedFunctions = new Set()
        let disposed = false
        /** Last sequence delivered to this page; starts at the Host's head. */
        let cursor = null
        let retryDelay = MIN_RETRY_MS
        /** Last reported surface signature, so unchanged state is never re-sent. */
        let lastViewSignature = null
        let viewRevision = 0
        let viewTimer = null
        /** The shell layout exists in the DOM; the app is no longer a blank page. */
        let shellMounted = false
        /** The shell layout has been presented at least once, so a reveal is safe. */
        let shellPainted = false
        let paintScheduled = false

        const sleep = (ms, signal) => new Promise((resolve) => {
          if (signal?.aborted) {
            resolve()
            return
          }
          const timer = setTimeout(done, ms)
          function done() {
            clearTimeout(timer)
            signal?.removeEventListener?.('abort', done)
            resolve()
          }
          signal?.addEventListener?.('abort', done, { once: true })
        })

        /**
         * One POST to a bridge route. The URL is document-relative, exactly like
         * the application's own `api/...` calls, so a mounted prefix still works.
         * Never throws for a transport problem.
         */
        async function call(endpoint, payload, signal) {
          try {
            const response = await globalThis.fetch(`api/${endpoint}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload ?? {}),
              credentials: 'same-origin',
              cache: 'no-store',
              signal,
            })
            if (!response.ok) {
              return {
                ok: false,
                error: { code: 'android-bridge/http', message: `HTTP ${String(response.status)}` },
              }
            }
            const body = await response.json()
            if (body === null || typeof body !== 'object' || typeof body.ok !== 'boolean') {
              return {
                ok: false,
                error: { code: 'android-bridge/protocol', message: 'malformed bridge response' },
              }
            }
            return body
          } catch (error) {
            return {
              ok: false,
              error: {
                code: signal?.aborted ? 'android-bridge/cancelled' : 'android-bridge/transport',
                message: error instanceof Error ? error.message : String(error),
              },
            }
          }
        }

        /** Deliver one event to the Android app. */
        function post(eventName, payload) {
          const bridge = globalThis[settings.bridgeObjectName]
          if (bridge !== undefined && typeof bridge?.onEvent === 'function') {
            try {
              bridge.onEvent(eventName, JSON.stringify(payload ?? null))
              return
            } catch (error) {
              console.warn(`[android-bridge] ${settings.bridgeObjectName}.onEvent threw`, error)
            }
          }
          try {
            globalThis.postMessage({ source: MESSAGE_SOURCE, name: eventName, payload }, '*')
          } catch (error) {
            console.warn('[android-bridge] postMessage fallback failed', error)
          }
        }

        /**
         * Which surface the shell is showing, read from the frame's own data
         * attributes — the shell has no URL routing, so the DOM is the only
         * public statement of whether the Conversation is the current surface.
         *
         * - `data-global-panel` appears on the centre column while any global
         *   main panel (Settings, Plugins, Schedules, …) is selected.
         * - the frame carries `data-sidebar-drawer` in drawer mode and
         *   `data-sidebar-collapsed` while that drawer is shut, so an open
         *   drawer is "drawer mode without the collapsed mark".
         * - `[data-rightbar-col]`'s parent is the frame itself, so its presence
         *   means the shell mounted and the page is no longer blank.
         *
         * Every read is defensive: a payload that cannot be determined reports
         * the Conversation, which is the safe default for Back.
         */
        function readViewState() {
          const state = { conversation: true, panel: false, drawer: false, frame: null }
          try {
            const doc = globalThis.document
            if (doc === null || doc === undefined || typeof doc.querySelector !== 'function') return state
            state.panel = doc.querySelector('[data-global-panel]') !== null
            const rightbarColumn = doc.querySelector('[data-rightbar-col]')
            const frame = rightbarColumn?.parentElement ?? null
            state.frame = frame
            state.drawer = frame !== null
              && frame.hasAttribute('data-sidebar-drawer')
              && !frame.hasAttribute('data-sidebar-collapsed')
            state.conversation = !state.panel && !state.drawer
          } catch (error) {
            console.warn('[android-bridge] view state unavailable', error)
          }
          return state
        }

        /**
         * Mark the shell as painted once two animation frames have passed.
         *
         * The first frame lands after React has committed the layout; the second
         * one after the browser has presented it. Only then can an app hiding a
         * loading cover reveal the page without showing an unstyled frame.
         */
        function schedulePaintReport() {
          if (disposed || shellPainted || paintScheduled) return
          const raf = globalThis.requestAnimationFrame
          if (typeof raf !== 'function') {
            // A page without rAF cannot report a paint boundary; the app's own
            // timeout keeps its cover from sticking.
            shellPainted = true
            return
          }
          paintScheduled = true
          raf(() => raf(() => {
            paintScheduled = false
            if (disposed) return
            shellPainted = true
            reportViewState()
          }))
        }

        /** Report the current surface once it differs from the last report. */
        function reportViewState() {
          if (disposed) return
          const state = readViewState()
          if (state.frame !== null && !shellMounted) {
            shellMounted = true
            schedulePaintReport()
          }
          const signature = [
            String(state.conversation),
            String(state.panel),
            String(state.drawer),
            String(shellMounted),
            String(shellPainted),
          ].join('|')
          if (signature === lastViewSignature) return
          lastViewSignature = signature
          viewRevision += 1
          post(VIEW_STATE_EVENT, {
            conversation: state.conversation,
            panel: state.panel,
            drawer: state.drawer,
            shellMounted,
            painted: shellPainted,
            revision: viewRevision,
          })
        }

        /** Coalesce a burst of DOM changes into one state read. */
        function scheduleViewReport() {
          if (disposed || viewTimer !== null) return
          viewTimer = globalThis.setTimeout(() => {
            viewTimer = null
            reportViewState()
          }, VIEW_SETTLE_MS)
        }

        /**
         * Absorb Android's Back inside the page: close the drawer it opened,
         * else deselect the global panel, which always returns to the
         * Conversation. A Conversation surface stays untouched so the app can
         * leave on that press.
         */
        function navigateBack() {
          const state = readViewState()
          try {
            const layout = ctx.get('layout')
            if (layout === null || layout === undefined) return
            if (state.drawer && typeof layout.toggleSidebar === 'function') {
              layout.toggleSidebar()
            } else if (state.panel && typeof layout.selectPanel === 'function') {
              layout.selectPanel(null)
            }
          } catch (error) {
            console.warn('[android-bridge] navigation back failed', error)
          } finally {
            scheduleViewReport()
          }
        }

        /** Android -> DeepSeek Harness. */
        async function handleInbound(eventName, payload) {
          if (typeof eventName !== 'string' || eventName.trim() === '') {
            return { ok: false, error: { code: 'android-bridge/invalid-request', message: 'event name is required' } }
          }
          const name = eventName.trim()
          if (name === NAVIGATION_BACK_EVENT) navigateBack()
          try {
            globalThis.dispatchEvent(new CustomEvent(DOM_EVENT_NAME, { detail: { name, payload } }))
          } catch {
            // A page without CustomEvent support still gets the Host round trip.
          }
          return call(ENDPOINT_INBOUND, { name, payload: payload ?? null })
        }

        /** Install one `window` entry point for Android -> DeepSeek Harness. */
        function installReceiveFunction(functionName) {
          if (installedFunctions.has(functionName)) return
          installedFunctions.add(functionName)
          globalThis[functionName] = (eventName, payload) => {
            void handleInbound(eventName, payload)
          }
        }

        /** Handle a `postMessage`-carried inbound event. */
        function onWindowMessage(event) {
          const data = event?.data
          if (data === null || typeof data !== 'object' || data.source !== MESSAGE_SOURCE) return
          void handleInbound(data.name, data.payload)
        }

        /** Adopt the Host's configuration. */
        function applyConfig(value) {
          if (value === null || typeof value !== 'object') return
          if (typeof value.bridgeObjectName === 'string') settings.bridgeObjectName = value.bridgeObjectName
          if (typeof value.receiveFunctionName === 'string') settings.receiveFunctionName = value.receiveFunctionName
          if (Array.isArray(value.forwardedClientEvents)) {
            settings.forwardedClientEvents = value.forwardedClientEvents.filter((item) => typeof item === 'string')
          }
          installReceiveFunction(settings.receiveFunctionName)
        }

        /**
         * Long poll forever: each round trips at most `pollTimeoutMs`, so a
         * disconnected Host costs one failed request and a short backoff.
         */
        async function pollLoop(signal) {
          while (!disposed && !signal.aborted) {
            const result = await call(ENDPOINT_POLL, { after: cursor ?? 0 }, signal)
            if (disposed || signal.aborted) return

            if (result?.ok !== true) {
              await sleep(retryDelay, signal)
              retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 2)
              continue
            }

            retryDelay = MIN_RETRY_MS
            const value = result.value ?? {}
            const events = Array.isArray(value.events) ? value.events : []
            for (const event of events) {
              if (event === null || typeof event !== 'object') continue
              post(event.name, event.payload)
            }
            if (typeof value.next === 'number' && Number.isFinite(value.next)) cursor = value.next
          }
        }

        ctx.effect(() => {
          const controller = new AbortController()
          let viewObserver = null

          // Install the documented default name before configuration arrives,
          // so an app calling it during page load is never clipped.
          installReceiveFunction(DEFAULTS.receiveFunctionName)
          const onMessage = (event) => onWindowMessage(event)
          globalThis.addEventListener?.('message', onMessage)

          // Follow the shell's surface so Android always knows whether Back
          // should navigate inside the page or leave the app.
          try {
            const doc = globalThis.document
            if (typeof globalThis.MutationObserver === 'function' && doc?.documentElement) {
              viewObserver = new globalThis.MutationObserver(scheduleViewReport)
              viewObserver.observe(doc.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: VIEW_ATTRIBUTES,
              })
            }
          } catch (error) {
            console.warn('[android-bridge] view observation unavailable', error)
          }

          void (async () => {
            const configured = await call(ENDPOINT_CONFIG, {}, controller.signal)
            if (disposed || controller.signal.aborted) return

            if (configured?.ok === true) {
              applyConfig(configured.value)
              if (typeof configured.value?.head === 'number') cursor = configured.value.head
            }

            // Subscribe once the configured name list is known.
            for (const clientEvent of settings.forwardedClientEvents) {
              if (disposed) break
              ctx.on(clientEvent, (...args) => {
                post(clientEvent, args.length === 1 ? args[0] : args)
              })
            }

            post('dsh:bridge-ready', {
              bridgeObjectName: settings.bridgeObjectName,
              receiveFunctionName: settings.receiveFunctionName,
            })
            reportViewState()
            await pollLoop(controller.signal)
          })()

          return () => {
            disposed = true
            controller.abort()
            if (viewTimer !== null) {
              globalThis.clearTimeout(viewTimer)
              viewTimer = null
            }
            try {
              viewObserver?.disconnect()
            } catch {
              // A torn-down document needs no disconnection.
            }
            globalThis.removeEventListener?.('message', onMessage)
            for (const functionName of installedFunctions) {
              try {
                delete globalThis[functionName]
              } catch {
                globalThis[functionName] = undefined
              }
            }
            installedFunctions.clear()
            try {
              globalThis.postMessage({ source: MESSAGE_SOURCE, name: 'dsh:bridge-down', payload: null }, '*')
            } catch {
              // Nothing to clean up if the carrier is already gone.
            }
          }
        })
      },
    }
  },
})
