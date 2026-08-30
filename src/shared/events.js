/**
 * The cross-frame window message namespace in one place. Every postMessage
 * type PlayerForge sends or receives across iframe edges lives here as a named
 * constant, so a typo in any of these strings surfaces as a build error
 * instead of a silently-dead listener.
 *
 * Intra-app coordination deliberately has NO message namespace: kernel signals
 * are direct method calls (discovery, shell created/destroyed) and in-shell
 * gestures are real events dispatched on the shell host element.
 */

/** Frame-bridge window message types (window.postMessage across frame edges). */
export const CTX_REQUEST_TYPE = "pf:ctx-request";
export const CTX_RESPONSE_TYPE = "pf:ctx";
export const FS_REQUEST_TYPE = "pf:req-fullscreen";
