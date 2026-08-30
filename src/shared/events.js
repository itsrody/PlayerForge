/**
 * The whole cross-module event/message namespace in one place. Every bus
 * event type (EventBus over EventTarget) and frame-bridge window message type
 * that PlayerForge emits or listens for lives here as a named constant, so a
 * typo in any of these strings surfaces as a build error instead of a
 * silently-dead listener. Mirror of GESTURE_EVENTS, which already centralizes
 * the gesture event family.
 */

/** Kernel/shell bus event types - emitted and subscribed with these names.
 *  Video discovery is a direct kernel→LifecycleManager call (single listener),
 *  not a bus broadcast. Fullscreen state has NO bus event: consumers read the
 *  single shared `fs` marker (shadow.js) or subscribe to its transitions
 *  directly. */
export const BUS_EVENTS = {
  shellCreated: "pf:shell-created",
  shellDestroyed: "pf:shell-destroyed"
};

/** Frame-bridge window message types (window.postMessage across frame edges). */
export const CTX_REQUEST_TYPE = "pf:ctx-request";
export const CTX_RESPONSE_TYPE = "pf:ctx";
export const FS_REQUEST_TYPE = "pf:req-fullscreen";
