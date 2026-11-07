/*
 * The background page: the package's one network egress family.
 *
 * Content scripts inherit the PAGE's CORS, so a cross-origin subtitle
 * ingest dies on exactly the user-supplied hosts the feature serves; the
 * background page's fetch rides the manifest's <all_urls> host permission
 * and cannot be blocked by CORS. This relay is the userscript plane's
 * granted-xhr surface reduced to its actual use (the store.js census):
 * single-flight (one user-triggered subtitle URL load at a time), text
 * responses, a timeout honored via AbortSignal.timeout - every failure
 * answers as a result object, because a rejection cannot cross the message
 * channel.
 *
 * persistent: true runs this page for the whole session; an awaited fetch
 * keeps the page alive through the request, so there is no re-wake
 * machinery to write, and no receiver-shutdown race to outlive - a
 * crashed background makes the content relay answer "Relay unavailable"
 * (store.js) instead of hanging.
 */

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.type !== "pf:request-text") {
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
      // The post-redirect final URL - the GM response's finalUrl contract,
      // consumed by subtitles' file naming.
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
