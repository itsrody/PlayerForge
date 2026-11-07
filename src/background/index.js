/*
 * The background plane's entry: the extension's resident service page.
 *
 * Two installs, both event-listener-shaped, zero DOM, zero timers - the
 * background never touches a document:
 *   1. the text relay (relay.js) - the package's one network egress, the
 *      cross-origin subtitle ingest through the <all_urls> host permission;
 *   2. the media hint ledger (ledger.js) - uBO-grade webRequest observation
 *      answering video/audio content-types with one frame-targeted hint
 *      (contract's NET_HINT) to the frame the traffic rode. The hint only
 *      accelerates: the content kernel's DOM-truth detection stays the
 *      deciding pipeline.
 *
 * background.js in the package is BUILD OUTPUT of this module (the same
 * bundle relationship content-side src has); the background page is
 * persistent (manifest), so these listeners run for the whole session.
 */
import { installTextRelay } from "./relay.js";
import { NetHintLedger } from "./ledger.js";

installTextRelay();
new NetHintLedger().install();
