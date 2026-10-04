import { DOMManager } from "../../shared/dom-manager.js";
import { Scope } from "../../shared/scope.js";

const STACK_OVERLAP_EM = 1.6;
const MAX_SLOTS = 8;
/** The native TextTrack label this renderer owns; reuse, never append. */
const TRACK_LABEL = "PlayerForge Subtitles";
/** Marker attribute identifying the <track> element this renderer owns. */
const TRACK_ATTR = "data-pf-subtitles";
/** Native blob parse watchdog; a real load/error lands far below this. */
const LOAD_TIMEOUT_MS = 8000;

/**
 * Shift a base cue time by a sync offset, clamped at t=0. Negative or
 * past-the-origin times collapse to 0, so a cue wholly before t=0 becomes a
 * zero-length cue at 0 (never active) instead of being dropped - which is
 * what keeps the native cue list 1:1 with the zero-offset base.
 */
function shiftTime(time, offset) {
  const shifted = time + offset;
  return shifted < 0 ? 0 : shifted;
}

/**
 * `--pf-cue-top` for a cue's line. Gecko parses full WebVTT settings, so the
 * renderer has to honour both line models: snap-to-lines (integer, negative
 * counts up from the bottom, one `1lh` line box per step) and the legacy
 * percent model (positive, or negative meaning 100+line). `auto` keeps the
 * historical 85% bottom anchor. The stack term lifts simultaneous cues off
 * each other, matching the old renderer.
 */
function lineTop(line, snapToLines, i) {
  // The stack term is a number, unit added at each use. Baking the unit in
  // produced "1.6emem", which fails the <length-percentage> syntax that
  // @property declares for --pf-cue-top - and a registered custom property
  // silently discards a non-matching value, so every cue after the first in a
  // stack quietly fell back to the 85% initial and piled up on the first one.
  // The registered initial plus var()'s own fallback are what kept that
  // invisible: no error, just overlapping captions.
  const overlap = i * STACK_OVERLAP_EM;
  if (snapToLines && typeof line === "number") {
    return line < 0
      ? `calc(100% + ${line} * 1lh - ${overlap}em)`
      : `calc(${line} * 1lh - ${overlap}em)`;
  }
  const pct = typeof line === "number" ? (line < 0 ? 100 + line : line) : 85;
  return `calc(${pct}% - ${overlap}em)`;
}

/**
 * Subtitle track backed by Firefox's native WebVTT parser and TextTrack
 * scheduling behind a blob <track> element, with a custom DOM surface for
 * rendering. The browser parses the document (full cue settings, markup,
 * NOTE/STYLE/REGION handling) and fires cuechange at exact enter/exit
 * boundaries; this class owns the visual output: pooled caption slots,
 * CSS custom-property-based styling, and per-cue stacking for simultaneous
 * lines.
 *
 * Sync offsets rebuild the cue list (remove → shift from base → re-add):
 * Gecko does not reliably re-index in-place startTime/endTime mutations
 * (stale exits while paused even survive into later playback), while
 * remove+add always rebuilds scheduling correctly in both states.
 */
export class ForgeTrack {
  #cueLayer;
  #cueLayerStyle;
  #trackEl = null;
  #track = null;
  #slots = [];
  /** DOM lifecycle manager: cue slot elements auto-removed on destroy. */
  #dom = new DOMManager();
  /** Fixed, shape-stable scratch per slot (pooled, never reallocated on
   *  render); #lastActive mirrors which slots currently hold a live cue so a
   *  `null` entry never needs to be stored. Same discipline as the forge's
   *  pooled scrub payload: mutate in place, read immediately. */
  #lastRender = [];
  #lastActive = [];
  /** Map<native cue, {start,end}>: the zero-offset times the native cues
   *  were parsed at; every setOffset re-derives from this. */
  #base = null;
  /** Offset currently applied to the native cues (setOffset no-ops on a repeat). */
  #offset = 0;
  /** Blob URL of the current native parse; revoked on replace and destroy. */
  #blobUrl = null;
  /** Records the bound cuechange so destroy can unregister it. */
  #onCueChange = null;
  /** Disposal flag; cuechange itself has no signal form (spec-forced). */
  #scope = new Scope();

  constructor(video, cueLayer) {
    if (typeof video?.appendChild !== "function") {
      throw new Error("This element cannot host a subtitle track");
    }
    const doc = video.ownerDocument ?? globalThis.document;
    if (!doc) {
      throw new Error("This element cannot host a subtitle track");
    }
    // Own exactly one <track> child per video: Gecko's native parser reads
    // its blob src, and element tracks are removable (unlike the append-only
    // addTextTrack list), so destroy leaves no residue. Reuse an existing
    // marked element - a second one would shadow ours in video.textTracks.
    let trackEl;
    try {
      trackEl = video.querySelector?.(`track[${TRACK_ATTR}]`);
    } catch {
      trackEl = null;
    }
    if (!trackEl) {
      trackEl = doc.createElement("track");
      trackEl.kind = "subtitles";
      trackEl.label = TRACK_LABEL;
      trackEl.srclang = "en";
      trackEl.setAttribute?.(TRACK_ATTR, "");
      video.appendChild(trackEl);
    }
    // HTMLTrackElement has no mode IDL in Gecko: `el.mode = "hidden"` only
    // creates a shadowing own property. Mode lives on the TextTrack itself.
    const track = trackEl.track ?? null;
    if (!track) {
      throw new Error("This element cannot host a subtitle track");
    }
    track.mode = "hidden";
    this.#trackEl = trackEl;
    this.#track = track;
    this.#cueLayer = cueLayer;
    this.#cueLayerStyle = cueLayer?.style;
    // Preallocate the pooled per-slot scratch now so cuechange renders (the
    // hot subtitle path) stay completely allocation-free.
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.#lastRender[i] = {
        cueRef: null, top: null, left: null, x: null,
        prevLine: NaN, prevSnap: null, prevPosition: NaN, prevAlign: null,
        prevVert: null, prevI: -1
      };
      this.#lastActive[i] = false;
    }
    // Pre-allocate all cue slot elements upfront for zero first-show latency.
    // Slots are hidden by default and toggled visible by #render().
    // DOMManager tracks them for automatic removal on destroy.
    if (cueLayer) {
      for (let i = 0; i < MAX_SLOTS; i++) {
        this.#slots[i] = this.#dom.createElement("div", { class: "pf-cue", role: "caption" }, cueLayer);
      }
    }
    this.#onCueChange = () => {
      this.#render();
    };
    track.addEventListener("cuechange", this.#onCueChange);
  }

  /**
   * Parse `text` with Firefox's native WebVTT parser (a blob <track> src)
   * and install the result. `offset` is applied through setOffset's rebuild
   * pass on top of the unshifted native times, which are snapshotted as the
   * zero-offset base.
   *
   * Returns the cue count, or 0 when the native load fails, times out, or
   * is aborted by dispose - pure-native policy: CSP blocks and parse
   * failures surface upstream as the "No cues found" toast.
   */
  async loadText(text, offset = 0) {
    if (this.#scope.disposed) {
      return 0;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
    if (this.#blobUrl) {
      URL.revokeObjectURL(this.#blobUrl);
    }
    this.#blobUrl = url;
    const loaded = await this.#awaitNativeLoad(url);
    if (!loaded || this.#scope.disposed) {
      return 0;
    }
    const cues = this.#track.cues;
    if (!cues || cues.length === 0) {
      return 0;
    }
    this.#snapshot(cues);
    this.setOffset(offset);
    return cues.length;
  }

  /**
   * Wait for the <track> element to fire load (parsed) or error (CSP,
   * fetch, parse failure), with a watchdog and a dispose abort. Both
   * outcomes resolve - never reject - so an aborted ingest cannot leak an
   * unhandled rejection.
   */
  #awaitNativeLoad(url) {
    const el = this.#trackEl;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        el.removeEventListener("load", onLoad);
        el.removeEventListener("error", onError);
        resolve(ok);
      };
      const onLoad = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
      el.addEventListener("load", onLoad);
      el.addEventListener("error", onError);
      this.#scope.signal.addEventListener("abort", () => finish(false), { once: true });
      // Gecko only fetches/parses while the TextTrack mode is not disabled.
      this.#track.mode = "hidden";
      el.src = url;
    });
  }

  /** Snapshot cue times as the zero-offset base (assumes base = raw times). */
  #snapshot(cues) {
    const base = new Map();
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      base.set(cue, { start: cue.startTime, end: cue.endTime });
    }
    this.#base = base;
    this.#offset = 0;
  }

  /**
   * Install an already-parsed cue list as the track's content at offset 0.
   * loadText() snapshots the native parse in place instead; this is the
   * programmatic entry point (used by unit tests) that also (re)populates
   * the track from the given cues.
   */
  adopt(cues) {
    if (this.#scope.disposed) {
      return;
    }
    const track = this.#track;
    for (let i = track.cues.length - 1; i >= 0; i--) {
      track.removeCue(track.cues[i]);
    }
    this.#snapshot(cues);
    for (const cue of cues) {
      track.addCue(cue);
    }
  }

  /**
   * Apply a sync offset by rebuilding the native cue list from the base:
   * remove every cue, shift its times from the zero-offset snapshot, and
   * re-add it (addCue re-inserts in sorted order and rebuilds the engine's
   * scheduling structure). Every write re-derives from the base, so clamping
   * stays exact across a back-and-forth drag (no accumulated drift).
   * Repeats of the current offset no-op; a list that diverged from the base
   * heals on the next call, since the rebuild source is the base itself.
   */
  setOffset(offset) {
    if (this.#scope.disposed || !this.#base || offset === this.#offset) {
      return;
    }
    const track = this.#track;
    for (let i = track.cues.length - 1; i >= 0; i--) {
      track.removeCue(track.cues[i]);
    }
    for (const [cue, times] of this.#base) {
      // TextTrackCue's writable timing attributes are startTime/endTime.
      cue.startTime = shiftTime(times.start, offset);
      cue.endTime = shiftTime(times.end, offset);
      track.addCue(cue);
    }
    this.#offset = offset;
  }

  #render() {
    if (this.#scope.disposed || !this.#cueLayer || !this.#track) {
      return;
    }
    const active = this.#track.activeCues;
    if (!active) {
      return;
    }
    const slots = this.#slots;
    const lastRender = this.#lastRender;
    const lastActive = this.#lastActive;
    const count = Math.min(active.length, MAX_SLOTS);
    for (let i = 0; i < count; i++) {
      const slot = slots[i];
      if (!slot) {
        continue;
      }
      const cue = active[i];
      const line = cue.line;
      const snap = cue.snapToLines === true && typeof line === "number";
      const position = typeof cue.position === "number" ? cue.position : 50;
      const align = cue.align || "center";
      const vert = cue.vertical || "";
      const prev = lastRender[i];
      // Numeric/string dirty checks: skip string construction when values
      // match the previous render - avoids template-literal allocation per
      // slot per cuechange on the hot subtitle path.
      if (line !== prev.prevLine || snap !== prev.prevSnap || i !== prev.prevI) {
        const top = lineTop(line, snap, i);
        if (prev.top !== top) {
          slot.style.setProperty("--pf-cue-top", top);
        }
        prev.top = top;
        prev.prevLine = line;
        prev.prevSnap = snap;
        prev.prevI = i;
      }
      if (position !== prev.prevPosition) {
        const left = `${position}%`;
        if (prev.left !== left) {
          slot.style.setProperty("--pf-cue-left", left);
        }
        prev.left = left;
        prev.prevPosition = position;
      }
      if (align !== prev.prevAlign) {
        const x = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
        if (prev.x !== x) {
          slot.style.setProperty("--pf-cue-x", x);
        }
        // Horizontal growth direction: the translateX anchor above keeps the
        // cue box on its position, text-align keeps the lines inside it
        // growing the same way native rendering does.
        slot.style.textAlign = align === "start" ? "left" : align === "end" ? "right" : "center";
        prev.x = x;
        prev.prevAlign = align;
      }
      if (vert !== prev.prevVert) {
        slot.style.writingMode = vert ? (vert === "rl" ? "vertical-rl" : "vertical-lr") : "";
        prev.prevVert = vert;
      }
      if (prev.cueRef !== cue) {
        // Native fragment: Gecko's getCueAsHTML() builds the spec-whitelisted
        // WebVTT markup (<b>, <i>, <c>, <v>, ruby) as real nodes - safe by
        // construction. Fall back to plain text where it is unavailable
        // (test doubles).
        if (typeof cue.getCueAsHTML === "function") {
          slot.replaceChildren(cue.getCueAsHTML());
        } else {
          slot.textContent = cue.text;
        }
        prev.cueRef = cue;
      }
      if (slot.hidden) {
        slot.hidden = false;
      }
      lastActive[i] = true;
    }
    for (let i = count; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        lastActive[i] = false;
      }
    }
  }

  clear() {
    if (this.#scope.disposed || !this.#lastActive.some(Boolean)) {
      return;
    }
    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        this.#lastActive[i] = false;
      }
    }
  }

  setVar(prop, value) {
    this.#cueLayerStyle?.setProperty(prop, value);
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    // Unregister our native cuechange listener before the element goes away.
    if (this.#track) {
      this.#track.removeEventListener?.("cuechange", this.#onCueChange);
      this.#track.mode = "disabled";
    }
    // The <track> element is ours: removing it drops the TextTrack from the
    // video's list (element tracks are removable, unlike addTextTrack) and
    // takes every parsed cue with it.
    this.#trackEl?.remove?.();
    if (this.#blobUrl) {
      URL.revokeObjectURL(this.#blobUrl);
      this.#blobUrl = null;
    }
    this.#trackEl = null;
    this.#track = null;
    // DOMManager removes all cue slot elements.
    this.#dom.destroy();
    this.#slots = [];
    this.#lastActive = [];
    this.#base = null;
    this.#offset = 0;
  }
}
