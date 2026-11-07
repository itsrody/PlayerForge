/**
 * Reforge - the claim policy surface over the ledger's roster (batch 4;
 * user direction 2026-11: beyond witnessing the page's media network, the
 * background CONTROLS and improves the request flow it classified). The
 * module/export vocabulary stays the recovered branch's machine spelling
 * (enhance.js, EnhanceSession, enhancer.<id> configs keys, ENHANCE_*) -
 * "Reforge" is the panel-only surface name.
 *
 * The port's claim contract with the ledger: the ledger asks its claim
 * source (method, url, record) at the manifest family's request edge; the
 * source answers a ledger claim shape ({ reload: url } - the browser's
 * own redirect re-request carries the page's headers to the roster's
 * freshest capture - or { rewrite: { text } } - a filterResponseData
 * serve). The branch's three page-verb levers (segProxy/elemSrc/
 * fullProxy) retire with their wrap legs - see contract.js's table
 * docstring for the two-row direction and the translation story.
 *
 * Claim composition (the levers' mapping, one knob per row):
 *   - tokenSplice: the roster's family URL is the FRESHEST fired request
 *     string (the record refreshes to every sighting); a request for a
 *     DIFFERENT string of the same family is a stale-token fetch, so the
 *     claim redirects to the freshest capture. The branch's
 *     relay-replacement leg translated exactly here: the branch served
 *     the fresh capture through its own request; the redirect makes the
 *     browser's REFERRED re-request land the fresh bytes - the page's
 *     own headers ride (redirect semantics), status/headers are the
 *     target's own truth, and the fresh sighting merges into the family.
 *   - abrPin: armed selects the parsed body's TOP variant (bandwidth
 *     descending, the parser's own sort) - the claim serves the record's
 *     RETAINED master body with every other variant's block dropped
 *     (requestBody's rewriteMasterBody grammar). Master playlists are
 *     static material, so the captured body is current; when
 *     tokenSplice ALSO fires on the same ask, freshness outranks the pin
 *     (serving a stale retention would rewind tokens - the branch's own
 *     composition precedent), and the freshest master rides whole.
 * Precedence overall: tokenSplice (a fresher-truth serve) before abrPin
 * (a static-material serve), then null.
 *
 * State rides the configs plane (store.js's echo): exactly one spell
 * site for the keys (contract's ENHANCE_CONTROLS, `enhancer.<id>`), the
 * background's own warm read at install, and foreign flips (the panel,
 * another tab, another frame) arriving through watchStorageKey - the
 * armed state follows wherever the write came from. The background never
 * writes configs; nothing changes silently (every row UNARMED).
 *
 * Belted on purpose (the branch's decideRequest contract): a claim
 * throw degrades to the native ride - the video never strands on a
 * transform failure.
 */

import { logger } from "../shared/runtime.js";
import { KEYS, warmStorage, getConfigValue, watchStorageKey } from "../shared/store.js";
import { parseAttrs } from "./tables.js";
import { ENHANCE_CONTROLS, ENHANCE_PRESETS } from "../kernel/contract.js";

/**
 * One master-body block walk (the branch's shape, verbatim): drop every
 * variant block whose BANDWIDTH sits outside the keep window. A
 * `#EXT-X-STREAM-INF` tag is followed by exactly one non-comment line -
 * the variant URI - so a dropped block carries both (a rewritten body
 * must never pair a URI with the next block's tag). Returns null when
 * nothing changed (the ledger's no-serve shape: unchanged text never
 * costs a serve) plus a `dropped` count for the status surface.
 */
export function rewriteMasterBody(text, { pinBandwidth = null } = {}) {
  const lines = text.split("\n");
  const out = [];
  let dropped = 0;
  let swallowing = false;
  for (const line of lines) {
    if (swallowing) {
      // A dropped tag's URI line: any non-comment line belongs to the
      // dropped block and stays dropped; a comment or blank line means
      // malformed input (the tag shipped no URI) - stop swallowing
      // rather than mis-drop unrelated lines.
      if (line !== "" && !line.startsWith("#")) {
        swallowing = false;
        continue;
      }
      swallowing = false;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      // The ONE attribute vocabulary - tables.js's parseAttrs, the same
      // reader the parser itself uses.
      const bandwidth = Number(parseAttrs(line.slice(18)).BANDWIDTH) || 0;
      const drop = pinBandwidth != null && bandwidth !== pinBandwidth;
      if (drop) {
        dropped++;
        swallowing = true;
        continue;
      }
    }
    out.push(line);
  }
  return dropped === 0 ? null : { text: out.join("\n"), dropped };
}

/**
 * The one claim session per background page. Its input is the ledger's
 * claim hook; its state is the armed preset map (configs-derived).
 */
class EnhanceSession {
  /** preset id -> armed boolean; every row starts UNARMED. */
  #presets = new Map();

  /**
   * Install: the background's page-lifetime plane. The warm read is the
   * one wholesale storage read (restores a stored armed preset - the
   * ownership is persisted, not re-decided per navigation), then sync
   * folds the doc, and the echo delivers every later foreign flip
   * (the panel's setSetting write lands its doc through the same
   * watchStorageKey contract the configs consumers share). Returns the
   * claim verb so index.js hands it to the ledger in one expression.
   */
  async install() {
    await warmStorage();
    this.#syncPresets();
    // The returned handle is deliberately never consumed: the background
    // page persists for the session (the manifest's persistent page is
    // the lease), so the watch lives as long as the session does.
    watchStorageKey(KEYS.configs, () => this.#syncPresets());
    return (method, url, record) => this.claim(method, url, record);
  }

  /**
   * The claim question. Belts its own throw (the branch's contract): the
   * answer is a ledger claim shape or null (native ride).
   */
  claim(method, url, record) {
    try {
      return this.#claim(method, url, record);
    } catch (error) {
      logger.warn("reforge", "enhance claim failed (native ride)", error);
      return null;
    }
  }

  #claim(method, url, record) {
    if (method !== "GET" || !record || record.verdict !== "clear") {
      // Clear-verdict claims only (the plane's whole premise: non-DRM
      // media improves; unknown and protected rides apply nothing).
      return null;
    }
    const fresh = record.url !== String(url);
    if (fresh && this.#presets.get(ENHANCE_PRESETS.tokenSplice)) {
      return { reload: record.url };
    }
    if ("variants" in record && this.#presets.get(ENHANCE_PRESETS.abrPin)) {
      const pinBandwidth = record.variants?.[0]?.bandwidth ?? null;
      if (pinBandwidth != null) {
        const rewrite = rewriteMasterBody(record.body, { pinBandwidth });
        if (rewrite) {
          return { rewrite: { text: rewrite.text } };
        }
        // The retention speaks no bandwidth on its lead variant (or the
        // walk dropped nothing): the pinned serve would be the identity
        // serve - the native ride costs nothing and the ledger's filter
        // stays asleep.
      }
    }
    return null;
  }

  /** Re-read the configs family and fold it into #presets through the
   *  ONE preset-apply loop (foreign adopt + install-time restore). The
   *  fallback is UNARMED: the table's lines carry no default arm. */
  #syncPresets() {
    for (const control of ENHANCE_CONTROLS) {
      this.#presets.set(control.id, Boolean(getConfigValue(control.key, false)));
    }
  }
}

export const enhancer = new EnhanceSession();
