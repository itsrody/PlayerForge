import { getConfigValue, setConfigValue, deleteConfigField } from "../../shared/store.js";
import { TUNING, clamp } from "../../shared/core.js";
import { debounce, Fan } from "../../shared/runtime.js";

/**
 * Zoom/pan persistence: one configs leaf per domain.
 *
 * The zoom crop is a viewing preference tied to the SITE the video lives on
 * (badly letterboxed embeds, overscanned encodes), so it persists per domain
 * rather than per video or globally: a per-video grain would re-seek the same
 * crop across every episode of a site, a global one would transplant a crop
 * between unrelated sites. The leaf lives under `zoom.<domainKey>`
 * (`{ s, ox, oy }`) in the shared configs document - the same root every
 * other preference uses, so the cross-tab live-reload cache and the whole
 * storage contract stay true. Until the shell's resume entry adopts (the
 * top-context domain arrives asynchronously), no domain is bound and state
 * stays session-only; a device-less page (no entry, cross-tab-less) simply
 * never persists.
 *
 * Phase application is deliberately a pure state machine: this class owns
 * numbers and persistence, never the video element. The action layer
 * (inputs/actions.js) owns the transform writes and their compositor
 * promptness; the panel section reads/writes the same instance, so a gesture
 * nudge and a panel edit are one state with one persistence path.
 */

export class ZoomState {
  #scale = 1;
  /** Pan as percentages of the element's own box (element-relative translate). */
  #ox = 0;
  #oy = 0;
  /** Domain the current session state belongs to; "" until an entry adopts. */
  #domainKey = "";
  /** State listeners (the action layer's transform applier, the section). */
  /** State audience on the shared Fan. */
  #audience = new Fan("zoom");
  /** Trailing persist: wheel steps and pan strokes apply instantly, storage
   *  lands once the gesture settles. Not tied to a Scope - the singleton-like
   *  domain map outlives one shell's teardown, so a flush on destroy is what
   *  keeps the last landed value honest. */
  #schedulePersist = debounce(() => this.#persist(), TUNING.zoom.persistDebounceMs);

  /** Bind (and persist) the state to a freshly adopted top-context domain.
   *  A pending persist is flushed into the OLD domain first, then the new
   *  domain's stored state becomes session truth; the same-domain bind is a
   *  no-op so adoption announcements cannot churn a live session. */
  bindDomain(domainKey) {
    if (!domainKey || domainKey === this.#domainKey) {
      return;
    }
    const previous = this.#domainKey;
    if (previous) {
      this.#persist();
      this.#schedulePersist.cancel();
    }
    this.#domainKey = domainKey;
    const stored = getConfigValue(`zoom.${domainKey}`, null);
    const scale = Number(stored?.s) || 1;
    this.#scale = clamp(scale, 1, TUNING.zoom.max);
    this.#ox = Number(stored?.ox) || 0;
    this.#oy = Number(stored?.oy) || 0;
    this.#emit();
  }

  get domainKey() {
    return this.#domainKey;
  }

  get scale() {
    return this.#scale;
  }

  get ox() {
    return this.#ox;
  }

  get oy() {
    return this.#oy;
  }

  /** True when the composed shape moves off the resting transform at all. */
  get zoomed() {
    return this.#scale !== 1 || this.#ox !== 0 || this.#oy !== 0;
  }

  /** Readable state triple for the panel section's live steppers. */
  get view() {
    return { scale: this.#scale, ox: this.#ox, oy: this.#oy };
  }

  /** Multiplicative wheel-style step; clamped to [1, max]. */
  zoomBy(factor) {
    return this.#set({ scale: this.#scale * factor });
  }

  /** Direct set (panel stepper); re-clamps so stubby bounds stay honest. */
  setScale(scale) {
    return this.#set({ scale });
  }

  setPan(ox, oy) {
    return this.#set({ ox, oy });
  }

  /**
   * User-intent reset: zeroes the session shape AND deletes the domain's
   * stored crop. Contrast to clearSession()-style paths: leaving fullscreen
   * or ending a pan stroke keeps the stored state - only an explicit "remove
   * the crop" gesture removes it.
   */
  resetForDomain() {
    this.#scale = 1;
    this.#ox = 0;
    this.#oy = 0;
    this.#schedulePersist.cancel();
    if (this.#domainKey) {
      deleteConfigField(`zoom.${this.#domainKey}`);
    }
    this.#emit();
  }

  /** Flush a trailing persist now (teardown, domain swap). */
  flush() {
    this.#schedulePersist.flush();
  }

  onState(listener, { signal } = {}) {
    return this.#audience.subscribe(listener, { signal });
  }

  #set({ scale, ox, oy }) {
    const nextScale = clamp(Number(scale) || 1, 1, TUNING.zoom.max);
    const nextOx = clamp(Number(ox ?? this.#ox), -100, 100);
    const nextOy = clamp(Number(oy ?? this.#oy), -100, 100);
    if (nextScale === this.#scale && nextOx === this.#ox && nextOy === this.#oy) {
      // Equality short-circuit: notification re-entry (section setValue echo)
      // must never schedule a persist for an untouched state.
      return false;
    }
    this.#scale = nextScale;
    this.#ox = nextOx;
    this.#oy = nextOy;
    this.#schedulePersist();
    this.#emit();
    return true;
  }

  #persist() {
    if (!this.#domainKey) {
      return;
    }
    setConfigValue(`zoom.${this.#domainKey}`, {
      s: this.#scale,
      ox: this.#ox,
      oy: this.#oy
    });
    this.#schedulePersist.cancel();
  }

  #emit() {
    this.#audience.emit(this.view);
  }
}

/** The zoom steppers' formatter: "1.4x" for scale, signed % for pan. */
function fmtZoomScale(v) {
  return `${Math.round(v * 100) / 100}x`;
}

function fmtZoomPan(v) {
  const rounded = Math.round(v);
  return rounded === 0 ? "0%" : `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/**
 * The zoom tools as one section inside the Settings tab (not its own tab):
 * the group rides the same addSection root the schema groups render into,
 * so the steppers + per-domain reset appear as one more labeled block at
 * the bottom of the settings list. The same adaptors as Color (state-owning
 * class, steppers up-date it), driven by the per-shell ZoomState. The
 * returned group owns nothing beyond the bus subscription (the panel tree
 * dies with the shell; the ZoomState singleton outlives one shell by design).
 */
export function buildZoomGroup(panel, sectionRoot, zoom, signal) {
  if (!sectionRoot) {
    return null;
  }
  const group = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
  const head = panel.el("div", { class: "pf-panel-section-head" }, group);
  panel.addLabel(head, "Zoom & Pan");
  panel.addControl(head, {
    type: "button",
    icon: "reload",
    title: "Reset zoom for this site",
    ariaLabel: "Reset zoom for this site",
    ghost: true,
    onClick: () => zoom.resetForDomain()
  });
  panel.addHint(group, "Fullscreen crop, saved per site");

  const grid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, group);
  const initial = zoom.view;
  const scaleStepper = panel.addControl(grid, {
    type: "stepper",
    label: "Scale",
    min: 1,
    max: 3,
    step: 0.05,
    value: initial.scale,
    format: fmtZoomScale,
    onChange: (v) => zoom.setScale(v)
  });
  const panXStepper = panel.addControl(grid, {
    type: "stepper",
    label: "Pan X",
    min: -100,
    max: 100,
    step: 5,
    value: initial.ox,
    format: fmtZoomPan,
    onChange: (v) => zoom.setPan(v, zoom.oy)
  });
  const panYStepper = panel.addControl(grid, {
    type: "stepper",
    label: "Pan Y",
    min: -100,
    max: 100,
    step: 5,
    value: initial.oy,
    format: fmtZoomPan,
    onChange: (v) => zoom.setPan(zoom.ox, v)
  });

  // Gesture-driven state updates flow back into the steppers while the panel
  // is open (wheel zoom, pinch reset). setValue short-circuits on an equal
  // commit, so the gesture -> state -> stepper -> gesture loop is self-breaking.
  zoom.onState(({ scale, ox, oy }) => {
    scaleStepper?.setValue(scale);
    panXStepper?.setValue(ox);
    panYStepper?.setValue(oy);
  }, { signal });
  return group;
}
