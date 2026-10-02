import { DOMManager } from "../../shared/dom-manager.js";
import { Scope } from "../../shared/scope.js";

const STACK_OVERLAP_EM = 1.6;
const MAX_SLOTS = 8;
/** The native TextTrack label this renderer owns; reuse, never append. */
const TRACK_LABEL = "PlayerForge Subtitles";

/**
 * Shift a base cue time by a sync offset, clamped at t=0 - the exact time the
 * offsetCues() pass used to bake into a fresh copy of the cue list. Negative
 * or past-the-origin times collapse to 0, so a cue wholly before t=0 becomes a
 * zero-length cue at 0 (never active) instead of being dropped.
 */
function shiftTime(time, offset) {
  const shifted = time + offset;
  return shifted < 0 ? 0 : shifted;
}

/**
 * Subtitle track backed by the browser's native TextTrack for timing and a
 * custom DOM surface for rendering. The browser owns cue scheduling (fires
 * cuechange at exact enter/exit boundaries), while this class owns the visual
 * output: pooled caption slots, CSS custom-property-based styling, and
 * per-cue stacking for simultaneous lines.
 */
export class ForgeTrack {
  #cueLayer;
  #cueLayerStyle;
  #track;
  #slots = [];
  /** DOM lifecycle manager: cue slot elements auto-removed on destroy. */
  #dom = new DOMManager();
  /** Fixed, shape-stable scratch per slot (pooled, never reallocated on
   *  render); #lastActive mirrors which slots currently hold a live cue so a
   *  `null` entry never needs to be stored. Same discipline as the forge's
   *  pooled scrub payload: mutate in place, read immediately. */
  #lastRender = [];
  #lastActive = [];
  /** Zero-offset cue base the native cues were built from; drives setOffset. */
  #baseCues = null;
  /** Offset already applied to the native cues (setOffset no-ops on a repeat). */
  #offset = 0;
  /** Global placement overrides from the panel's V/H steppers (0-100), or
   *  null to keep each cue's own line/position (default until the user moves
   *  a stepper). Applied per render, so a change re-lays active slots. */
  #lineOverride = null;
  #positionOverride = null;
  /** Records the bound cuechange so destroy can unregister it. */
  #onCueChange = null;
  /** Whether the player is currently on screen. Defaults true so a host
   *  without IntersectionObserver (or before the first observation lands)
   *  renders unconditionally; the observer only ever suppresses off-screen
   *  churn and re-renders on re-entry. */
  #onScreen = true;
  /** Disposal flag; cuechange itself has no signal form (spec-forced). */
  #scope = new Scope();

  constructor(video, cueLayer) {
    this.#cueLayer = cueLayer;
    this.#cueLayerStyle = cueLayer?.style;
    // Preallocate the pooled per-slot scratch now so cuechange renders (the
    // hot subtitle path) stay completely allocation-free.
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.#lastRender[i] = { text: null, top: null, left: null, x: null, prevLine: NaN, prevPosition: NaN, prevI: -1 };
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
    // Reuse a PlayerForge-owned native track instead of calling addTextTrack
    // on every toggle cycle: textTracks is append-only (no spec API removes a
    // track), so a fresh track per load would accumulate leaks across cycles.
    // A page track with this exact label is collision-safe - the renderer owns
    // it exclusively once created.
    const owned = Array.from(video?.textTracks ?? []).find(
      (track) => track.kind === "subtitles" && track.label === TRACK_LABEL
    );
    this.#track = owned ?? video?.addTextTrack?.("subtitles", TRACK_LABEL, "en");
    if (!this.#track) {
      throw new Error("This element cannot host a subtitle track");
    }
    this.#track.mode = "hidden";
    this.#onCueChange = () => {
      this.#render();
    };
    this.#track.addEventListener("cuechange", this.#onCueChange);
    // Off-screen players still fire cuechange; suppress the slot churn until
    // the player is visibly on screen and re-render once when it scrolls back.
    // getBoundingClientRect is the element guard: a non-element videoLike
    // (test double, detached stub) never gets observed.
    if (video && typeof IntersectionObserver === "function" && typeof video.getBoundingClientRect === "function") {
      const observer = new IntersectionObserver(([entry]) => {
        if (this.#scope.disposed) {
          return;
        }
        const was = this.#onScreen;
        this.#onScreen = entry.isIntersecting;
        if (this.#onScreen && !was) {
          this.#render();
        }
      });
      observer.observe(video);
      this.#scope.onDispose(() => observer.disconnect());
    }
  }

  /**
   * Replace all cues on the track. Accepts plain cue objects from forgevtt.
   * `offset` is applied while building, and the plain cues are remembered as
   * the zero-offset base so later sync nudges can shift the native cues in
   * place (see setOffset) instead of draining and rebuilding the list.
   *
   * Cues the old offsetCues()+load() path dropped entirely (shifted end <= 0,
   * i.e. wholly before t=0) are kept as zero-length cues at t=0 instead: they
   * can never satisfy start <= t < end, so they never enter the active set -
   * but keeping every base cue keeps `track.cues` positionally aligned with
   * the base array, which is what lets setOffset walk the two by index.
   */
  load(cues, offset = 0) {
    if (this.#scope.disposed) {
      return;
    }
    const track = this.#track;
    // Drain from the back: the cue list is a live array, so popping the last
    // index avoids shifting the remaining entries on every removal (the
    // front-drain was O(n²) memmove for an n-cue track).
    for (let i = track.cues.length - 1; i >= 0; i--) {
      track.removeCue(track.cues[i]);
    }
    for (const cue of cues) {
      const vtt = new VTTCue(shiftTime(cue.start, offset), shiftTime(cue.end, offset), cue.text);
      vtt.line = cue.line;
      vtt.position = cue.position;
      if (cue.align) {
        vtt.align = cue.align;
      }
      track.addCue(vtt);
    }
    this.#baseCues = cues;
    this.#offset = offset;
  }

  /**
   * Shift every loaded cue by a new sync offset, in place. Two property
   * writes per cue replaces the old full re-offset (n plain objects) plus a
   * drain and rebuild of the native VTTCue list: no intermediate array, no
   * VTTCue construction, no cue-list churn. Every write re-derives from the
   * zero-offset base, so clamping stays exact across a back-and-forth drag
   * (no accumulated drift), and the engine repositions mutated cues itself
   * (Blink's cueWillChange/cueDidChange path re-sorts the cue list and
   * re-inserts into the interval tree), so active-cue scheduling stays
   * correct.
   */
  setOffset(offset) {
    if (this.#scope.disposed || offset === this.#offset) {
      return;
    }
    const base = this.#baseCues;
    const cues = this.#track.cues;
    if (!base) {
      return;
    }
    if (cues.length !== base.length) {
      // Defensive: the list can only diverge if a load raced this call.
      // Rebuild rather than walk a mismatched pairing.
      this.load(base, offset);
      return;
    }
    for (let i = 0; i < base.length; i++) {
      const src = base[i];
      const cue = cues[i];
      // TextTrackCue's writable timing attributes are startTime/endTime - the
      // plain `start`/`end` names only exist on forgevtt's own cue objects.
      // Writing `cue.start` would just create an own data property that
      // shadows nothing: the engine keeps scheduling on the untouched
      // startTime/endTime and activeCues would never move.
      const start = shiftTime(src.start, offset);
      if (cue.startTime !== start) {
        cue.startTime = start;
      }
      const end = shiftTime(src.end, offset);
      if (cue.endTime !== end) {
        cue.endTime = end;
      }
    }
    this.#offset = offset;
  }

  #render() {
    if (this.#scope.disposed || !this.#cueLayer || !this.#onScreen) {
      return;
    }
    const active = this.#track.activeCues;
    const count = Math.min(active.length, MAX_SLOTS);
    for (let i = 0; i < count; i++) {
      const slot = this.#slots[i];
      if (!slot) {
        continue;
      }
      const cue = active[i];
      const line = this.#lineOverride ?? cue.line;
      const position = this.#positionOverride ?? cue.position;
      const align = cue.align || "center";
      const prev = this.#lastRender[i];
      // Numeric dirty checks: skip string construction when values match
      // the previous render — avoids template-literal allocation per slot
      // per cuechange on the hot subtitle path.
      const lineChanged = line !== prev.prevLine || i !== prev.prevI;
      const positionChanged = position !== prev.prevPosition;
      if (lineChanged) {
        const top = `calc(${line}% - ${i * STACK_OVERLAP_EM}em)`;
        if (prev.top !== top) {
          slot.style.setProperty("--pf-cue-top", top);
        }
        prev.top = top;
        prev.prevLine = line;
        prev.prevI = i;
      }
      if (positionChanged) {
        const left = `${position}%`;
        if (prev.left !== left) {
          slot.style.setProperty("--pf-cue-left", left);
        }
        prev.left = left;
        prev.prevPosition = position;
      }
      const x = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
      if (prev.x !== x) {
        slot.style.setProperty("--pf-cue-x", x);
      }
      if (prev.text !== cue.text) {
        slot.textContent = cue.text;
      }
      if (slot.hidden) {
        slot.hidden = false;
      }
      prev.text = cue.text;
      prev.x = x;
      this.#lastActive[i] = true;
    }
    for (let i = count; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        this.#lastActive[i] = false;
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

  /**
   * Global caption placement (panel V/H steppers): 0-100 percentages, or null
   * to fall back to each cue's own line/position. Re-renders active slots so
   * the move lands immediately instead of at the next cue change.
   */
  setPlacement({ line = null, position = null } = {}) {
    if (this.#scope.disposed || (line === this.#lineOverride && position === this.#positionOverride)) {
      return;
    }
    this.#lineOverride = line;
    this.#positionOverride = position;
    this.#render();
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    // Unregister our native cuechange listener: the track survives (the spec
    // has no removal API) and would otherwise keep firing this renderer's
    // slot-node logic against a torn-down pool forever.
    this.#track.removeEventListener?.("cuechange", this.#onCueChange);
    this.#track.mode = "disabled";
    while (this.#track.cues.length > 0) {
      this.#track.removeCue(this.#track.cues[0]);
    }
    // DOMManager removes all cue slot elements.
    this.#dom.destroy();
    this.#slots = [];
    this.#lastActive = [];
    this.#baseCues = null;
    this.#offset = 0;
  }
}
