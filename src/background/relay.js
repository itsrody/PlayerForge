import { TEXT_RELAY } from "../shared/store.js";
import { TAB_COMMAND, COMMAND_RELAY, DRM_LATCH } from "../kernel/contract.js";

/**
 * The background page's shared receiver: the one network egress (the
 * cross-origin text relay) plus one command arm plus one latch arm.
 *
 * Content scripts inherit the PAGE's CORS, so a cross-origin subtitle
 * ingest dies on exactly the user-supplied hosts the feature serves; the
 * background page's fetch rides the manifest's <all_urls> host permission
 * and cannot be blocked by CORS. This relay is the granted-xhr surface
 * reduced to its actual use (the store.js census): single-flight (one
 * user-triggered subtitle URL load at a time), text responses, a timeout
 * honored via AbortSignal.timeout - every failure answers as a result
 * object, because a rejection cannot cross the message channel.
 *
 * The consuming page (persistent: true) lives for the whole session; an
 * awaited fetch keeps it alive through the request, so there is no re-wake
 * machinery to write, and no receiver-shutdown race to outlive - a crashed
 * background makes the content relay answer "Relay unavailable" (store.js)
 * instead of hanging.
 *
 * The command arm rides the SAME one receiver (the census's three onMessage
 * sites stay three): the debug handle's pfCommand arm (entry.js) forwards a
 * command, and this arm replays the browserAction popup's exact hop -
 * browser.tabs.sendMessage onto the active tab's top document, where
 * kernel.js TabCommands receives. The hop is what a cross-extension caller
 * can never make directly (tabs.sendMessage delivers only to the calling
 * extension's own content scripts), and the receiver answers undefined for
 * one-way commands (diag) - a null reply is the popup's own no-reply shape,
 * not an error.
 *
 * The latch arm (reforge's sole claim veto, batch 2) rides the receiver
 * too: the passive `encrypted` listener (entry.js) sends DRM_LATCH per
 * realm whose document fed a CDM-protected stream, and the arm hands
 * (sender's tabId, frameId) to the ledger's latchDrm - the roster's veto
 * by construction. It answers undefined and the content side consumes no
 * reply (one-way). */
export function installTextRelay(ledger = null) {
  browser.runtime.onMessage.addListener(async (message, sender) => {
    if (message?.type === DRM_LATCH) {
      ledger?.latchDrm(sender?.tab?.id ?? -1, sender?.frameId ?? undefined);
      return undefined;
    }
    if (message?.type === COMMAND_RELAY) {
      const command = typeof message.command === "string"
        ? message.command.slice(0, 40) : "";
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        return { ok: false, error: "no active tab" };
      }
      return browser.tabs.sendMessage(tab.id, { type: TAB_COMMAND, command })
        .then((reply) => (reply === undefined ? null : reply),
          (err) => ({ ok: false, error: String(err?.message ?? err) }));
    }
    if (message?.type !== TEXT_RELAY) {
      return undefined;
    }
    const { url, timeoutMs = 30000 } = message;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      // The body is drained inside the relay: after this handler returns the
      // page's response object is gone, and the consumer asked for text.
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        // The post-redirect final URL - the old GM response's finalUrl
        // contract, consumed by subtitles' file naming.
        finalUrl: response.url,
        responseText: text
      };
    } catch (error) {
      // AbortSignal.timeout surfaces its deadline as TimeoutError; readable
      // flat messages both for the sync-offset failure toast and because
      // values crossing the message channel must be structured-cloneable.
      return {
        ok: false,
        error: error?.name === "TimeoutError"
          ? `Timed out after ${timeoutMs}ms`
          : `Network error: ${error?.message ?? String(error)}`
      };
    }
  });
}
