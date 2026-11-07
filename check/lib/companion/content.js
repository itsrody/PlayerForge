/*
 * Companion content script - the harness's ears and hands inside the page.
 *
 * Two jobs, both harness-only (the checked product stays untouched):
 *
 * 1. The error rail. geckodriver serves no console endpoint and the
 *    marionette realm cannot read content-realm JS objects (both probed on
 *    this floor), but DOM string attributes cross the Xray on both sides -
 *    so every uncaught error / un-handled rejection this document sees is
 *    appended to document.documentElement.dataset.plErr (last 3 lines). The
 *    browser stage fails a case whose rail is non-empty, which is the
 *    real-Chrome-era "cases fail on any page error" contract's twin.
 *
 * 2. The command trigger. The browserAction popup is chrome UI no driver
 *    can reach. The popup's machinery is the package's own extension
 *    channel - content -> background -> browser.tabs.sendMessage onto the
 *    active tab's top document - and a second addon's tabs.sendMessage
 *    structurally delivers only to its OWN content scripts (browser
 *    isolates runtime.onMessage per extension), so the companion's own
 *    background channel can never reach PlayerForge's commander. The door
 *    exists inside the page: the product's debug console handle (document
 *    #pf-debug, debug mode only) exposes pfCommand, which relays through
 *    that same package-internal machinery and writes the settled reply to
 *    a data-pf-cmd-<command> rail attribute. The companion waits for the
 *    handle (the product boots after its storage warm - a few milliseconds
 *    of IPC, not a race to fix), calls the arm, then assembles
 *    dataset.plReply in the row shape the driver reads. Handle missing
 *    after the deadline (skipped host, no debug hash) fails the row with a
 *    readable why instead of a channel-shaped timeout.
 */
(function () {
  "use strict";

  const root = document.documentElement;
  const pushErr = (msg) => {
    const el = document.documentElement;
    if (!el) return;
    const prev = el.dataset.plErr;
    el.dataset.plErr = ((prev ? prev + "\n" : "") + msg).split("\n").slice(-3).join("\n");
  };
  window.addEventListener("error", (e) => {
    pushErr(`${e.message ?? "error"} @${String(e.filename ?? "").slice(-48)}:${e.lineno ?? -1}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    pushErr(String(e.reason?.message ?? e.reason));
  });

  // Top frame only: the command target is the active tab's top document,
  // and an embed page would otherwise fire once per frame.
  if (window.top !== window) {
    return;
  }
  const parsed = new URL(location.href);
  const commands = [parsed.searchParams.get("pfCmd"), parsed.searchParams.get("pfCmd2")]
    .filter((c) => c && c.length > 0 && c.length < 40 && /^[a-z-]+$/.test(c));
  if (commands.length === 0) {
    return;
  }
  // The live-shell gate: rows whose command answers "did the gesture reach
  // a live shell host" mark ?pfShell=1 and the arm fires only once the
  // shell exists - the popup's own shape (a user taps it with the player
  // live), not the fresh-navigation race.
  const waitShell = parsed.searchParams.get("pfShell") === "1";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The product installs the debug handle after its storage warm; the
  // deadline stays generous - handle-missing after it is the real failure
  // shape (skipped host / no #pf-debug), never a boot we should wait harder
  // for.
  const arm = async (cmd) => {
    const deadline = Date.now() + 6000;
    const forge = () => window.wrappedJSObject?.PlayerForge?.pfCommand;
    while (Date.now() < deadline && typeof forge() !== "function") {
      await sleep(40);
    }
    if (typeof forge() !== "function") {
      return { command: cmd, reply: { ok: false, error: "PlayerForge debug handle missing" } };
    }
    if (waitShell) {
      // The shell may live in an embed frame the command targets (the
      // popup acts on the top document but the row's live shell is the
      // iframe's) - scan the top document first, then same-origin child
      // iframes (cross-origin embeds stay dark here; no row rides one).
      const shellIn = (doc) => {
        try {
          if (doc.querySelector(".pf-shell")) return true;
          for (const frame of doc.querySelectorAll("iframe")) {
            const inner = frame.contentDocument;
            if (inner?.querySelector(".pf-shell")) return true;
          }
        } catch { /* cross-origin frame: skip, keep polling */ }
        return false;
      };
      const shellDeadline = Date.now() + 9000;
      while (Date.now() < shellDeadline && !shellIn(document)) {
        await sleep(60);
      }
      if (!shellIn(document)) {
        return { command: cmd, reply: { ok: false, error: "no .pf-shell within the shell-wait deadline" } };
      }
    }
    const accepted = forge()(cmd);
    const attr = `data-pf-cmd-${cmd}`;
    const railDeadline = Date.now() + 9000;
    let raw;
    while (Date.now() < railDeadline &&
      (raw = document.documentElement?.getAttribute(attr)) === null) {
      await sleep(40);
    }
    return {
      command: cmd,
      reply: raw === null
        ? { ok: false, error: `no reply on ${attr} (arm status: ${accepted})` }
        : JSON.parse(raw)
    };
  };
  Promise.all(commands.map(arm)).then((replies) => {
    if (document.documentElement) {
      document.documentElement.dataset.plReply = JSON.stringify(replies);
    }
  });
})();
