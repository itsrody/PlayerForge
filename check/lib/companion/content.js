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
 *    can reach, but its channel is exactly one call - browser.tabs.
 *    sendMessage(activeTab, {type: TAB_COMMAND, command}) - and the
 *    companion background page makes that same call on the case's behalf:
 *    the fixture page carries ?pfCmd= / ?pfCmd2=, this script forwards them
 *    to its own background, the background sends into the tab's PlayerForge
 *    commander, and the round-trip reply lands in dataset.plReply for the
 *    driver to read. The product's onMessage receiver is thereby exercised
 *    through the machinery the popup actually uses, not a forgery.
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
  Promise.all(commands.map((cmd) =>
    browser.runtime.sendMessage({ pfTrigger: cmd }).then(
      (reply) => ({ command: cmd, reply: reply === undefined ? null : reply }),
      (err) => ({ command: cmd, reply: { ok: false, error: String(err?.message ?? err) } })
    )
  )).then((replies) => {
    document.documentElement.dataset.plReply = JSON.stringify(replies);
  });
})();
