/** Pools up to 8 absolutely-positioned cue slots and diffs their content/styles. */
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
      return 0;
    }
    const count = Math.min(cues.length, 8);
    for (let i = 0; i < count; i++) {
      const slot = this.#ensureSlot(i);
      const cue = cues[i];
      const prev = this.#lastRender[i] || {};
      if (prev.text !== cue.text) {
        slot.textContent = cue.text;
      }
      if (prev.top !== cue.top) {
        slot.style.setProperty("--pf-cue-top", cue.top);
      }
      if (prev.left !== cue.left) {
        slot.style.setProperty("--pf-cue-left", cue.left);
      }
      if (prev.x !== cue.x) {
        slot.style.setProperty("--pf-cue-x", cue.x);
      }
      slot.hidden &&= false;
      this.#lastRender[i] = { text: cue.text, top: cue.top, left: cue.left, x: cue.x };
    }
    for (let i = count; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        this.#lastRender[i] = null;
      }
    }
    return count;
  }

  clear() {
    if (!this.#destroyed) {
      for (let i = 0; i < this.#slots.length; i++) {
        const slot = this.#slots[i];
        if (!slot.hidden) {
          slot.hidden = true;
          this.#lastRender[i] = null;
        }
      }
    }
  }

  get slotCount() {
    return this.#slots.length;
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
