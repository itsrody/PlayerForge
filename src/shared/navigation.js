/**
 * Same-document URL change events.
 *
 * One event source so consumers never re-derive SPA navigation detection from
 * pushState patching or location polling. Backends, best first:
 *
 *   1. Navigation API (`navigation.currententrychange`) - the native,
 *      GRANT-FREE source, and the live one on this fork. Firefox ships it from
 *      147 (fork baseline: 156) and it fires for pushState, replaceState,
 *      hash changes and history traversal alike, so the whole SPA surface is
 *      covered without asking the userscript manager for anything. Resolved
 *      per subscription rather than at module load, so the first subscriber
 *      decides after document-start has had its say about what this realm
 *      exposes.
 *   2. `popstate` + `hashchange` - the API-less last resort (jsdom harness,
 *      or a host older than 147). pushState-only route changes are invisible
 *      here, which is precisely why backend 1 is not optional on this fork.
 *
 * A granted manager event (`window.onurlchange`, Tampermonkey) is still
 * feature-detected for hosts that happen to expose it, but the fork no longer
 * GRANTS it: backend 1 already covers every change the grant bought, so
 * keeping the grant would only widen the userscript's permission surface and
 * its exposure to manager-specific semantics for zero added coverage.
 *
 * Returns an unsubscribe function; passing `signal` tears the subscription
 * down the same way.
 */
export function onNavigate(listener, { signal } = {}) {
  const nav = globalThis.navigation;
  if (nav && typeof nav.addEventListener === "function") {
    nav.addEventListener("currententrychange", listener, { signal });
    return () => nav.removeEventListener("currententrychange", listener);
  }
  const win = globalThis.window;
  if (win && typeof win.addEventListener === "function") {
    if ("onurlchange" in win) {
      win.addEventListener("urlchange", listener, { signal });
      return () => win.removeEventListener("urlchange", listener);
    }
    win.addEventListener("popstate", listener, { signal });
    win.addEventListener("hashchange", listener, { signal });
    return () => {
      win.removeEventListener("popstate", listener);
      win.removeEventListener("hashchange", listener);
    };
  }
  return () => {};
}
