/**
 * Tampermonkey GM_* API stubs for browser integration tests.
 *
 * These are injected into the page context via addScriptToEvaluateOnNewDocument
 * or executeScript before the userscript runs. They simulate the Tampermonkey
 * runtime environment using localStorage as the backing store.
 *
 * This file is a no-op by itself — the actual stubs are wired in
 * firefox.mjs's injectGMStubs(). This module exists as a reference and
 * can be imported standalone for documentation purposes.
 */

// The actual GM_* stubs are defined inline in firefox.mjs's injectGMStubs()
// method to keep them self-contained within the evaluateScript call. This
// file documents the API contract:

/**
 * GM_getValue(key, fallback) -> any
 *   Read a value from persistent storage. Returns fallback if key is absent.
 *
 * GM_setValue(key, value) -> void
 *   Write a value to persistent storage.
 *
 * GM_deleteValue(key) -> void
 *   Remove a key from persistent storage.
 *
 * GM_registerMenuCommand(title, fn) -> id
 *   Register a command in the Tampermonkey menu. Returns a handle.
 *
 * GM_unregisterMenuCommand(id) -> void
 *   Remove a previously registered menu command.
 *
 * GM_addValueChangeListener(key, cb) -> id
 *   Subscribe to storage changes. Callback receives (key, oldValue, newValue).
 *   Returns a handle for unsubscribing.
 *
 * GM_removeValueChangeListener(id) -> void
 *   Remove a previously registered change listener.
 *
 * GM_getResourceText(name) -> Promise<string>
 *   Fetch an @resource text block. Returns empty string in test env.
 *
 * GM_info() -> { script: { version: string } }
 *   Return script metadata.
 *
 * GM_xmlhttpRequest(details) -> void
 *   HTTP request (stubbed as no-op in tests).
 */
