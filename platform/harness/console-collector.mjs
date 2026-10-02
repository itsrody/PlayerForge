/**
 * Cross-context console capture.
 *
 * A userscript's diagnostics do not land in one place. The content script runs
 * in the page's userscript world, the service worker is its own target, and
 * extension pages are separate again. Driver-level log capture only exposes the
 * page, so a failure printed by the manager's worker is invisible exactly when
 * you most want it - and the visible surface still looks clean.
 *
 * This attaches at the *browser* CDP endpoint and auto-attaches to every target
 * recursively, so all contexts funnel into one stream tagged with its origin.
 * `waitForDebuggerOnStart` means a new target is hooked before it runs its first
 * line, which is what keeps `document-start` output from being missed.
 *
 * Ported from ScriptCat's `e2e/session.mjs` `attachConsoleCollector`.
 */

/** Render a CDP remote object so assertions survive into the log. */
function renderRemoteObject(arg) {
  if ("value" in arg) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  // Object arguments carry only a preview. Rendering them as `Object` records
  // nothing, and a self-test's summary counts are exactly the payload that
  // matters.
  const { preview } = arg;
  if (preview?.properties) {
    const isArray = preview.subtype === "array";
    const parts = preview.properties.map((p) => (isArray ? (p.value ?? p.type) : `${p.name}: ${p.value ?? p.type}`));
    if (preview.overflow) parts.push("…");
    return isArray ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
  }
  return arg.description ?? arg.type;
}

/**
 * @param {number} cdpPort - Chrome DevTools port of the running browser.
 * @param {(line: string) => void} append - Sink for each captured line.
 * @param {object} [options]
 * @param {(err: Error) => void} [options.onDisconnect]
 * @returns {Promise<WebSocket>} Open socket; close it to stop collecting.
 */
export async function attachConsoleCollector(cdpPort, append, { onDisconnect = () => {} } = {}) {
  const version = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const sessionToTarget = new Map(); // sessionId -> targetId
  const targetInfo = new Map(); // targetId -> info (URL changes on navigation)
  const listening = new Set(); // sessionIds already Runtime.enable'd
  let nextId = 1;

  const send = (method, params, sessionId) =>
    socket.send(JSON.stringify({ id: nextId++, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("close", onDisconnect, { once: true });

  send("Target.setAutoAttach", autoAttach);
  // Without discovery there is no targetInfoChanged, so a navigating page's URL
  // stays frozen at attach time and every later line is misattributed.
  send("Target.setDiscoverTargets", { discover: true });

  const originOf = (sessionId) => {
    const info = targetInfo.get(sessionToTarget.get(sessionId));
    if (!info) return "?";
    return info.url.replace(/^chrome-extension:\/\/[a-p]+\//, "") || info.type;
  };

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return; // binary/partial frame
    }

    if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo: info } = message.params;
      sessionToTarget.set(sessionId, info.targetId);
      // A nested target (an offscreen document's sandbox iframe) is only
      // reachable by attaching again on its parent's session.
      send("Target.setAutoAttach", autoAttach, sessionId);
      // Several parents can attach to the same target, and Runtime.enable
      // replays that context's existing console history - so enable once per
      // target or the log duplicates exponentially.
      if (!targetInfo.has(info.targetId)) {
        targetInfo.set(info.targetId, info);
        listening.add(sessionId);
        send("Runtime.enable", {}, sessionId);
        send("Log.enable", {}, sessionId);
      }
      // Required regardless of whether we listen: without it a target under
      // waitForDebuggerOnStart stays suspended forever.
      send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      return;
    }
    if (message.method === "Target.targetInfoChanged") {
      const { targetInfo: info } = message.params;
      if (targetInfo.has(info.targetId)) targetInfo.set(info.targetId, info);
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      sessionToTarget.delete(message.params.sessionId);
      listening.delete(message.params.sessionId);
      return;
    }

    if (!listening.has(message.sessionId)) return;
    const origin = originOf(message.sessionId);
    if (message.method === "Runtime.consoleAPICalled") {
      append(`[${message.params.type}] (${origin}) ${message.params.args.map(renderRemoteObject).join(" ")}`);
    } else if (message.method === "Runtime.exceptionThrown") {
      const d = message.params.exceptionDetails;
      append(`[exception] (${origin}) ${d.exception?.description ?? d.text}`);
    } else if (message.method === "Log.entryAdded") {
      const e = message.params.entry;
      append(`[${e.level}] (${origin}) ${e.text}`);
    }
  });

  return socket;
}
