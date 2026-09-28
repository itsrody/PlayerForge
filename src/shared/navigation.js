/**
 * Same-document URL change events.
 *
 * One event source so consumers never re-derive SPA navigation detection from
 * pushState patching or location polling. Three backends, best first:
 *
 *   1. Navigation API (`navigation.currententrychange`) - covers pushState,
 *      replaceState, hash changes and history traversal with no grant at all.
 *      Resolved per subscription (not at module load) so the first subscriber
 *      decides, after document-start has had its say about what this realm
 *      exposes. Firefox does not ship this API, so on this fork the branch
 *      exists purely as a feature-detect for foreign hosts.
 *   2. `urlchange` (Tampermonkey `@grant window.onurlchange`) - the manager
 *      patches history for us and fires one event per same-document URL
 *      change, pushState included. This is the complete SPA backend on
 *      Firefox, and it is a granted manager API precisely because the page
 *      cannot supply it - exactly what the grant policy in
 *      shared/storage.js reserves grants for.
 *   3. `popstate` + `hashchange` - the API-less last resort (jsdom harness,
 *      grant denied). pushState-only route changes are invisible here.
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
