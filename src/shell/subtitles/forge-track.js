import { el } from "../chrome/elements.js";

const STACK_OVERLAP_EM = 1.6;
const MAX_SLOTS = 8;

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
  /** Fixed, shape-stable scratch per slot (pooled, never reallocated on
   *  render); #lastActive mirrors which slots currently hold a live cue so a
   *  `null` entry never needs to be stored. Same discipline as the forge's
   *  pooled scrub payload: mutate in place, read immediately. */
  #lastRender = [];
  #lastActive = [];
  #destroyed = false;

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
    if (cueLayer) {
      const doc = cueLayer.ownerDocument;
      for (let i = 0; i < MAX_SLOTS; i++) {
        this.#slots[i] = el("div", { class: "pf-cue", role: "caption" }, cueLayer);
      }
    }
    // addTextTrack is undefined on non-media elements; fail the constructor
    // with a clear error so the section's own catch surfaces a "Failed to
    // load subtitles" toast instead of a bare TypeError on mode.
    this.#track = video?.addTextTrack?.("subtitles", "Subtitles", "en");
    if (!this.#track) {
      throw new Error("This element cannot host a subtitle track");
    }
    this.#track.mode = "hidden";
    this.#track.addEventListener("cuechange", () => {
      this.#render();
    });
  }

  /** Replace all cues on the track. Accepts plain cue objects from forgevtt. */
  load(cues) {
    if (this.#destroyed) {
      return;
    }
    const track = this.#track;
    while (track.cues.length > 0) {
      track.removeCue(track.cues[0]);
    }
    for (const cue of cues) {
      const vtt = new VTTCue(cue.start, cue.end, cue.text);
      vtt.line = cue.line;
      vtt.position = cue.position;
      if (cue.align) {
        vtt.align = cue.align;
      }
      track.addCue(vtt);
    }
  }

  #render() {
    if (this.#destroyed || !this.#cueLayer) {
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
      const line = cue.line;
      const position = cue.position;
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
      slot.hidden &&= false;
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
    if (this.#destroyed || !this.#lastActive.some(Boolean)) {
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
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#track.mode = "disabled";
    while (this.#track.cues.length > 0) {
      this.#track.removeCue(this.#track.cues[0]);
    }
    for (const slot of this.#slots) {
      slot.remove();
    }
    this.#slots = [];
    this.#lastActive = [];
  }
}
