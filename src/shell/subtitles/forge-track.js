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
  #video;
  #cueLayer;
  #cueLayerStyle;
  #track;
  #slots = [];
  #lastRender = [];
  #destroyed = false;

  constructor(video, cueLayer) {
    this.#video = video;
    this.#cueLayer = cueLayer;
    this.#cueLayerStyle = cueLayer?.style;
    this.#track = video.addTextTrack("subtitles", "Subtitles", "en");
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
      vtt.line = cue.line ?? 85;
      vtt.position = cue.position ?? 50;
      if (cue.align) {
        vtt.align = cue.align;
      }
      track.addCue(vtt);
    }
  }

  #render() {
    if (this.#destroyed) {
      return;
    }
    const active = this.#track.activeCues;
    const count = Math.min(active.length, MAX_SLOTS);
    for (let i = 0; i < count; i++) {
      const slot = this.#ensureSlot(i);
      const cue = active[i];
      const line = cue.line ?? 85;
      const position = cue.position ?? 50;
      const align = cue.align || "center";
      const top = `calc(${line}% - ${i * STACK_OVERLAP_EM}em)`;
      const left = `${position}%`;
      const x = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
      const prev = this.#lastRender[i] || {};
      if (prev.text !== cue.text) {
        slot.textContent = cue.text;
      }
      if (prev.top !== top) {
        slot.style.setProperty("--pf-cue-top", top);
      }
      if (prev.left !== left) {
        slot.style.setProperty("--pf-cue-left", left);
      }
      if (prev.x !== x) {
        slot.style.setProperty("--pf-cue-x", x);
      }
      slot.hidden &&= false;
      this.#lastRender[i] = { text: cue.text, top, left, x };
    }
    for (let i = count; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        this.#lastRender[i] = null;
      }
    }
  }

  clear() {
    if (this.#destroyed || !this.#lastRender.some(Boolean)) {
      return;
    }
    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        this.#lastRender[i] = null;
      }
    }
  }

  #ensureSlot(index) {
    let slot = this.#slots[index];
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "pf-cue";
      slot.setAttribute("role", "caption");
      this.#cueLayer.appendChild(slot);
      this.#slots[index] = slot;
    }
    return slot;
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
    this.#lastRender = [];
  }
}
