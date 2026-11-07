/*
 * The background plane's entry: the extension's resident service page —
 * the Reforge background robust core.
 *
 * The plane's rebrand (user direction 2026-11): this directory IS Reforge,
 * the stream enhancer's extension port — the background engine that
 * witnesses the page's media network (ledger.js: webRequest observation +
 * the roster's per-(tab, frame) family records driven by tables.js's
 * classification vocabulary) and executes its claims through this same
 * listener farm (the webRequestBlocking lever, Probe B-proven live on the
 * 159 floor; the execute batch landed it). The content side keeps passive
 * duty only: hints and latches arrive by message, never verb wraps.
 *
 * Three installs, all event-listener-shaped, zero DOM, zero timers - the
 * background never touches a document:
 *   1. the text relay (relay.js) - the package's one network egress, the
 *      cross-origin ingest through the <all_urls> host permission;
 *   2. the witness ledger (ledger.js) - uBO-grade webRequest observation
 *      classifying media/xhr traffic through tables.js's vocabulary and
 *      answering the frame the traffic rode (contract's NET_HINT) with the
 *      classified shape. The hint only accelerates: the content kernel's
 *      DOM-truth detection stays the deciding pipeline;
 *   3. the claim policy (enhance.js) - the Reforge controls' EnhanceSession:
 *      the enhancer.<id> presets ride the configs echo plane and the session
 *      composes { reload } / { rewrite } claims over the roster's family
 *      records - handed here to the ledger's claim hook.
 */
import { installTextRelay } from "./relay.js";
import { NetHintLedger } from "./ledger.js";
import { enhancer } from "./enhance.js";

const ledger = new NetHintLedger();
installTextRelay(ledger);
ensuringClaims().catch((error) => {
  // The claim policy fails to the NULL source (batch 3's shipped default:
  // nothing about any page changes silently) - the witness floor keeps
  // running, every request rides native.
  console.error("[reforge] EnhanceSession install failed (native rides)", error);
});

async function ensuringClaims() {
  const claimSource = await enhancer.install();
  ledger.setClaimSource(claimSource);
}

ledger.install();
