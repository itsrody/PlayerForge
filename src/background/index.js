/*
 * The background plane's entry: the extension's resident service page —
 * the Reforge background robust core.
 *
 * The plane's rebrand (user direction 2026-11): this directory IS Reforge,
 * the stream enhancer's extension port — the background engine that
 * witnesses the page's media network (ledger.js: webRequest observation +
 * the roster's per-(tab, frame) family records driven by tables.js's
 * classification vocabulary) and will execute its claims through this same
 * listener farm (the webRequestBlocking lever, Probe B-proven live on the
 * 159 floor; the execute batch lands it). The content side keeps passive
 * duty only: hints and latches arrive by message, never verb wraps.
 *
 * Two installs, both event-listener-shaped, zero DOM, zero timers - the
 * background never touches a document:
 *   1. the text relay (relay.js) - the package's one network egress, the
 *      cross-origin ingest through the <all_urls> host permission;
 *   2. the witness ledger (ledger.js) - uBO-grade webRequest observation
 *      classifying media/xhr traffic through tables.js's vocabulary and
 *      answering the frame the traffic rode (contract's NET_HINT) with the
 *      classified shape. The hint only accelerates: the content kernel's
 *      DOM-truth detection stays the deciding pipeline.
 *
 * background.js in the package is BUILD OUTPUT of this module (the same
 * bundle relationship content-side src has); the background page is
 * persistent (manifest), so these listeners run for the whole session.
 */
import { installTextRelay } from "./relay.js";
import { NetHintLedger } from "./ledger.js";

installTextRelay();
new NetHintLedger().install();
