/*
 * Companion background page. No receiver: the command round trip moved
 * inside the product's own extension machinery - a cross-extension
 * browser.tabs.sendMessage structurally delivers only to the calling
 * extension's own content scripts (browser isolates runtime.onMessage per
 * extension, MDN-pinned), so the popup-channel hop a second addon sends can
 * never reach PlayerForge's commander. The trigger now rides the debug
 * console handle's pfCommand arm (document #pf-debug), which relays through
 * the package's own background -> the real tabs.sendMessage hop -> kernel.js
 * TabCommands. The page stays installed to carry the content script; the
 * tabs permission keeps the manifest's install shape.
 */
