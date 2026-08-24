/** Extra vertical offset per stacked cue so simultaneous lines don't overlap. */
const STACK_OVERLAP_EM = 1.6;
const MAX_SLOTS = 8;

/**
 * Pooled caption surface for the shell's cue layer. Consumes engine-shaped
 * cues ({ text, line?, position?, align? } - WebVTT semantics, defaults
 * 85 / 50 / center), computes each slot's geometry including stacking, and
 * diffs content/styles between renders.
 */
export class CueRenderer {
  #cueLayer;
  #slots = [];
  #lastRender = [];
  #destroyed = false;

  constructor(cueLayer) {
    this.#cueLayer = cueLayer;
  }

  render(cues = []) {
    if (this.#destroyed) {
      return;
    }
    const count = Math.min(cues.length, MAX_SLOTS);
    for (let i = 0; i < count; i++) {
      const slot = this.#ensureSlot(i);
      const cue = cues[i];
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

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      for (const slot of this.#slots) {
        slot.remove();
      }
      this.#slots = [];
      this.#lastRender = [];
    }
  }
}
