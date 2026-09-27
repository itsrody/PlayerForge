/**
 * Same-document URL change events.
 *
 * One event source so consumers never re-derive SPA navigation detection from
 * pushState patching or location polling. Two backends, best first:
 *
 *   1. Navigation API (`navigation.currententrychange`) - native Chromium 102+,
 *      covers pushState, replaceState, hash changes and history traversal, and
 *      needs no Tampermonkey grant. Resolved per subscription (not at module
 *      load) so the first subscriber decides, after document-start has had its
 *      say about what this realm exposes.
 *   2. `popstate` + `hashchange` - what the Navigation API-less harness (and
 *      any runtime without it) can still deliver. pushState-only route changes
 *      are invisible on this path, which is why the Navigation API is the
 *      preferred backend.
 *
 * `window.onurlchange` (Tampermonkey `@grant window.onurlchange`) would be a
 * third backend, but it costs a grant line for coverage the native Navigation
 * API already provides on the Chromium 153 floor - the grant policy in
 * shared/storage.js reserves manager APIs for capabilities the page cannot
 * supply, and URL change notification is not one of them.
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
    win.addEventListener("popstate", listener, { signal });
    win.addEventListener("hashchange", listener, { signal });
    return () => {
      win.removeEventListener("popstate", listener);
      win.removeEventListener("hashchange", listener);
    };
  }
  return () => {};
}
