import { logger, Scope } from "../../shared/runtime.js";
import { DomPool, deepestActiveElement, subscribeFullscreen } from "../../shared/dom.js";
import { formatTime, clamp } from "../../shared/core.js";
import { button, createIconElement, flashElement, el } from "./ui.js";
import { GESTURE_EVENTS } from "../inputs/actions.js";
import { buildZoomGroup } from "../inputs/zoom.js";
import { getSetting, onSettingsChanged, setSetting, SETTINGS_SCHEMA, SETTING_KEYS } from "./config.js";

/** Stepper drag-follow: pointer travel that crosses one step of sweep. */
const DRAG_STEP_PX = 14;
const TAB_NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
/** Auto-detect compact lives in CSS: the stage container query + pointer media
 *  query drive it through the hud layer's compact bus (styles.css compact
 *  writers). The only JS state is the ui.compact setting's explicit value,
 *  surfaced as the panel's data-compact attribute - "on"/"off"/-absent is
 *  the whole contract. */
const COMPACT_EXPLICIT = { true: "on", false: "off" };

function decimalsOf(step) {
  const str = String(step);
  const dot = str.indexOf(".");
  return dot === -1 ? 0 : str.length - dot - 1;
}

/**
 * Numeric spinbutton widget used by panel fields: text input with
 * hold-to-repeat chevron buttons and keyboard support. Programmatic
 * setValue() cascades through onChange like any user edit. The committed
 * value is a private field, so render + read + write ride one instance.
 */
class Stepper {
  /** Public widget handles the documented addStepper shape exposes. */
  root;
  input;

  #lo;
  #hi;
  #by;
  #roundTo;
  #committed;
  #format;
  #deferTextInput;
  #onChange;
  #upButton;
  #downButton;

  constructor({
    min = 0,
    max = 100,
    step = 1,
    value,
    label,
    onChange,
    deferTextInput = false,
    format,
    signal
  } = {}) {
    const lo = this.#lo = Number(min);
    const hi = this.#hi = Number(max);
    const by = this.#by = Math.abs(Number(step)) || 1;
    const decimals = Math.max(decimalsOf(by), 0);
    // decimals is fixed per stepper, so the 10**decimals factor is computed once
    // here instead of on every nudge/commit (hold-repeat fires it ~13x/s).
    const roundFactor = 10 ** decimals;
    this.#roundTo = (v) => Math.round(v * roundFactor) / roundFactor;
    this.#committed = this.#roundTo(clamp(Number(value ?? min), lo, hi));
    this.#format = format;
    this.#deferTextInput = deferTextInput;
    this.#onChange = onChange;

    const input = this.input = document.createElement("input");
    input.className = "pf-stepper-input";
    input.type = "text";
    input.setAttribute("inputmode", "decimal");
    input.setAttribute("role", "spinbutton");
    input.setAttribute("aria-valuemin", String(lo));
    input.setAttribute("aria-valuemax", String(hi));
    if (label) {
      input.setAttribute("aria-label", label);
    }

    this.#upButton = this.#makeButton("chevron-up", 1, "Increase", signal);
    this.#downButton = this.#makeButton("chevron-down", -1, "Decrease", signal);
    const arrows = document.createElement("span");
    arrows.className = "pf-stepper-arrows";
    arrows.appendChild(this.#upButton);
    arrows.appendChild(this.#downButton);

    this.root = document.createElement("span");
    this.root.className = "pf-stepper";
    this.root.appendChild(this.input);
    this.root.appendChild(arrows);

    // Round-trip text for #commit()/#nudge() - always numeric so parseFloat
    // parses it back. `format` (caller-provided) is display-only.
    this.#showCommitted();
    this.#syncAria();
  }

  /**
   * One press-and-sweep chevron wired to #nudge(dir). The old hold-repeat
   * loop (delay + interval timers) is gone: the pointer provides its own
   * event stream, so the same press gesture covers the whole range. A press
   * nudges once (the repeat's first tick); dragging from the press sweeps -
   * every DRAG_STEP_PX of pointer travel lands one step, with fractional
   * remainder carried so short strokes stay faithful. Drag is direction-less
   * (up sweeps +, down -), so both chevrons share one mapping. Capture keeps
   * the stream on the button past its bounds, touch-action: none keeps the
   * panel from scrolling the touch away, and every listener rides the panel
   * signal so destroy ends a mid-drag session natively.
   */
  #makeButton(name, dir, title, signal) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pf-stepper-btn";
    button.tabIndex = -1;
    button.appendChild(createIconElement(name));
    button.title = title;
    // One drag session at a time; all listeners attach once.
    let dragging = false;
    let lastY = 0;
    let remainder = 0;
    button.addEventListener("pointermove", (event) => {
      if (!dragging || this.input.disabled) {
        return;
      }
      remainder += (lastY - event.clientY) / DRAG_STEP_PX;
      lastY = event.clientY;
      while (remainder >= 1) {
        remainder -= 1;
        this.#nudge(1);
      }
      while (remainder <= -1) {
        remainder += 1;
        this.#nudge(-1);
      }
    }, { signal });
    button.addEventListener("pointerup", () => {
      dragging = false;
    }, { signal });
    button.addEventListener("pointercancel", () => {
      dragging = false;
    }, { signal });
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (this.input.disabled) {
        return;
      }
      this.#nudge(dir);
      dragging = true;
      lastY = event.clientY;
      remainder = 0;
      button.setPointerCapture(event.pointerId);
    });
    return button;
  }

  #numText(v) {
    return String(this.#roundTo(v));
  }

  #syncAria() {
    this.input.setAttribute("aria-valuenow", String(this.#committed));
    if (this.#format) {
      this.input.setAttribute("aria-valuetext", this.#format(this.#committed));
    }
  }

  #showCommitted() {
    this.input.value = this.#format ? this.#format(this.#committed) : this.#numText(this.#committed);
  }

  #commit(rawText) {
    const parsed = Number.parseFloat(rawText);
    if (!Number.isFinite(parsed)) {
      this.#showCommitted();
      return this.#committed;
    }
    const next = this.#roundTo(clamp(parsed, this.#lo, this.#hi));
    if (next !== this.#committed) {
      this.#committed = next;
      this.#syncAria();
      this.#onChange?.(this.#committed);
    }
    // Render after the mutation: the old order painted the pre-commit value,
    // so blur/Enter/nudge flashed the previous number while state advanced.
    this.#showCommitted();
    return this.#committed;
  }

  #nudge(dir) {
    this.#commit(this.#numText(this.#committed + dir * this.#by));
  }

  getValue() {
    return this.#committed;
  }

  setValue(next) {
    const nextValue = this.#roundTo(clamp(Number(next), this.#lo, this.#hi));
    if (nextValue === this.#committed) {
      this.#showCommitted();
      return this.#committed;
    }
    this.#committed = nextValue;
    this.#showCommitted();
    this.#syncAria();
    this.#onChange?.(this.#committed);
    return this.#committed;
  }

  setDisabled(disabled) {
    this.input.disabled = disabled;
    this.#upButton.disabled = disabled;
    this.#downButton.disabled = disabled;
    // Visual/pointer disabled state derives from :has(:disabled) in CSS -
    // no class to mirror here.
  }

  wire() {
    const input = this.input;
    input.addEventListener("input", () => {
      // deferTextInput (settings steppers): typing stays local until blur or
      // Enter commits, so every keystroke doesn't write GM storage and wake
      // every other tab's live-reload. Arrow nudges still commit per click.
      if (this.#deferTextInput) {
        return;
      }
      const text = input.value.trim();
      if (!text) {
        return;
      }
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return;
      }
      const next = this.#roundTo(clamp(parsed, this.#lo, this.#hi));
      if (next !== this.#committed) {
        this.#committed = next;
        this.#syncAria();
        this.#onChange?.(this.#committed);
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.#nudge(1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.#nudge(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.#commit(input.value);
        // Commit but keep focus: Tab continues through the panel instead of
        // dropping to <body> and restarting from the document.
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.#showCommitted();
        if (input.dataset.pfEscArmed) {
          // Second Esc: the edit is already reverted - let this one reach the
          // panel's document-level dismiss handler (and the CloseWatcher's
          // close event, whose watcher consumed its free pass above).
          delete input.dataset.pfEscArmed;
        } else {
          // First Esc: revert only. Swallow it here so it can't bubble to the
          // panel's document keydown listener and close the whole panel.
          input.dataset.pfEscArmed = "1";
          event.stopPropagation();
        }
      }
    });

    input.addEventListener("blur", () => {
      delete input.dataset.pfEscArmed;
      this.#commit(input.value);
    });
  }
}

/**
 * Factory form kept as the public face; the widget state lives in Stepper.
 */
function createStepper(options) {
  const stepper = new Stepper(options);
  stepper.wire();
  return stepper;
}

/**
 * The tabbed settings panel hosted in the shell HUD, and the shell's open UI
 * API. Three layers in one module:
 *
 *   - SettingsPanel: features declare sections (addSection) and controls
 *     through parameterized builders (addStepper/addButton/addCheckbox/...)
 *     instead of assembling DOM. Sections populate lazily via
 *     setSectionBuilder on first open, with a toast + builder-restore when a
 *     build fails. Open/close is a class flip wrapped in view transitions
 *     (pf-panel-open / pf-panel-close); compact mode is an explicit setting
 *     with a narrow-touch auto-detect re-applied live on breakpoint changes.
 *     Dismissal while open: UA-owned Escape (CloseWatcher, Chromium 131+)
 *     plus our guarded document listeners for outside click; close() hands
 *     focus back to the opener (native showModal() semantics, tracked at
 *     open()). Arrow-key tab navigation stays ours (roving tabindex over the
 *     section tablist).
 *   - createStepper: the parameterized spinbutton widget the panel renders.
 *   - Product sections (addSettingsSection, addHistorySection): the concrete
 *     panels the shell fills through that API, kept beside it because they
 *     program the builder surface directly instead of reaching back up into
 *     config.js state.
 */
export class SettingsPanel {
  #hudLayer;
  #slot;
  #shellHost;
  #root = null;
  #body = null;
  #tabList = null;
  #closeButton = null;
  /** The sliding segmented capsule + its strip-box observer. */
  #capsule = null;
  #tabResize = null;
  #sections = new Map();
  #activeSection = null;
  #sectionCounter = 0;
  /** All panel subscriptions die with this signal; disposal flag lives here. */
  #scope = new Scope();
  /** Live only while the panel is open: Esc + outside-click dismissal. */
  #dismissScope = null;
  /** UA-owned Escape watcher (CloseWatcher), live with #dismissScope. */
  #closeWatcher = null;
  #backdrop = null;
  #sectionBuilder = null;
  /** Live only across the lazy-section await: dedupes double open() races. */
  #opening = false;
  /** Shell toast hook, kept only for section-build failure reporting. */
  #shellToast = null;
  /** Element focused at open(); close() hands focus back to it (A1). */
  #returnFocus = null;

  constructor(shell) {
    this.#hudLayer = shell.shellDom?.hudLayer;
    this.#shellHost = shell.shellHost;
    this.#shellToast = shell.toastFlash?.bind(shell) ?? null;
    if (!this.#hudLayer || !this.#shellHost) {
      logger.error("panel", "Missing shell DOM - panel not available");
      return;
    }
    this.#buildDom();
    this.#wireEvents();
    logger.log("panel", "Panel ready");
  }

  /**
   * Compact mode: the setting override wins as the data-compact attribute
   * ("on"/"off"); an unset setting clears the attribute and the stage
   * container query auto-detects - live, in the style pipeline, with no
   * listener (styles.css compact writers).
   */
  #applyCompactSetting() {
    const explicit = getSetting(SETTING_KEYS.compact);
    const state = COMPACT_EXPLICIT[explicit];
    if (state === undefined) {
      delete this.#root.dataset.compact;
    } else {
      this.#root.dataset.compact = state;
    }
  }

  get element() {
    return this.#root;
  }

  get body() {
    return this.#body;
  }

  get isOpen() {
    return !!this.#root && this.#root.classList.contains("pf-open");
  }

  /** Register a lazy builder that populates sections on first open. */
  setSectionBuilder(fn) {
    this.#sectionBuilder = fn;
  }

  async open() {
    if (!this.#root || this.#scope.disposed || this.isOpen || this.#opening) {
      return;
    }
    if (this.#sectionBuilder) {
      const build = this.#sectionBuilder;
      this.#sectionBuilder = null;
      this.#opening = true;
      // Marker for atomic-failure rollback: only sections THIS attempt added
      // roll back, so a pre-attempt panel state never gets clobbered.
      const attemptStart = this.#sections.size;
      try {
        await build();
      } catch (err) {
        logger.error("panel", "Panel section build failed:", err);
        // Roll the attempt back before handing the builder over: a retry
        // must start from the pre-attempt state, or addSection would stack
        // duplicate tabs for every section the failed build already placed.
        // (The section instances themselves die through the builder's own
        // catch - the panel owns tab rows + section DOM, the shell owns the
        // instance lifecycle.)
        this.#rollbackTo(attemptStart);
        // Hand the builder back (unless a newer one was registered mid-build)
        // so the next open retries against a clean body instead of facing
        // an empty tab row forever.
        if (!this.#sectionBuilder) {
          this.#sectionBuilder = build;
        }
        this.#shellToast?.("reload", "Panel failed to load", "panel");
      } finally {
        this.#opening = false;
      }
    }
    if (!this.#body?.childElementCount || !this.#root || this.#scope.disposed) {
      return;
    }
    // Snapshot the opener before focus moves into the panel; close() hands
    // focus back to it (native showModal() behavior), not just the host.
    this.#returnFocus = deepestActiveElement(this.#shellHost);
    this.#armDismissal();
    this.#runWithViewTransition("pf-panel-open", () => {
      this.#applyCompactSetting();
      this.#root.classList.add("pf-open");
      // Tab boxes resolve only after the display flip; doing it inside the
      // transition update keeps the strip as the source of truth in the VT.
      this.#moveCapsule();
      const activeTab = this.#root.querySelector(".pf-panel-tab-active") || this.#closeButton;
      if (activeTab && deepestActiveElement(this.#shellHost) !== activeTab) {
        activeTab.focus();
      }
    });
  }

  close() {
    if (this.#root && !this.#scope.disposed && this.isOpen) {
      const opener = this.#returnFocus;
      this.#returnFocus = null;
      const hadFocusInside = this.#root.contains(deepestActiveElement(this.#shellHost));
      this.#runWithViewTransition("pf-panel-close", () => {
        this.#root.classList.remove("pf-open");
      });
      // Dismissal dies before focus moves: the focusin containment handler
      // would yank an outside-the-shell opener straight back to the tab.
      this.#teardownDismissal();
      if (hadFocusInside) {
        // Back to the opener (native showModal() restore) when it is still a
        // live element - body/null (nothing was focused) and a disconnected
        // opener (SPA navigation) fall back to the shell host instead.
        const live = opener && opener !== document.body
          && opener !== document.documentElement && opener.isConnected;
        if (live) {
          opener.focus();
        } else if (this.#shellHost) {
          this.#shellHost.focus();
        }
      }
    }
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Esc + outside-click dismissal exists only while the panel is open. Arming
   * it per open() keeps two document listeners out of the page's hot path for
   * shells whose panel is never (or rarely) opened; close()/destroy() abort
   * the per-open scope, so they die with the open state. Escape also gets a
   * CloseWatcher where available (Chromium 131+, TM/Greasemonkey grants it via
   * the same global): the UA then dismisses us even when a page-level
   * keydown handler would otherwise swallow or reorder the event, and we do
   * not depend on the event still bubbling to the shadow host.
   */
  #armDismissal() {
    if (this.#dismissScope || this.#scope.disposed) {
      return;
    }
    this.#dismissScope = new AbortController();
    const { signal } = this.#dismissScope;
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    }, { signal });
    document.addEventListener("pointerdown", (event) => {
      // The whole host counts as "inside", so a press on the panel or its
      // HUD siblings toggles without a close/reopen flicker. Shadow
      // retargeting makes target === host exactly when the press landed in
      // the host's (shadow-only) subtree - no composedPath() array to
      // allocate per outside press.
      if (event.target === this.#shellHost) {
        return;
      }
      this.close();
    }, { signal, capture: true, passive: true });
    // Focus containment: the backdrop already blocks clicks into the page,
    // but Tab/Shift+Tab would still walk focus out of the "modal" into the
    // controls behind it. Focus landing outside the host pulls back to the
    // active tab - the native showModal() confinement, without moving the
    // panel into the top layer (which would fight the z-index doctrine and
    // the view-transition open animation).
    document.addEventListener("focusin", (event) => {
      const target = event.target;
      if (target !== this.#shellHost && !this.#shellHost.contains(target)) {
        const activeTab = this.#root.querySelector(".pf-panel-tab-active") || this.#closeButton;
        activeTab?.focus();
      }
    }, { signal });
    if (typeof CloseWatcher === "function") {
      try {
        this.#closeWatcher = new CloseWatcher();
        this.#closeWatcher.addEventListener("close", () => {
          // The watcher fires on the Escape KEYUP, after a focused field's
          // keydown already consumed that press to revert its edit (armed
          // via pfEscArmed). That first Esc must not dismiss the panel -
          // the next one will, through either path.
          const active = deepestActiveElement(this.#shellHost);
          if (active?.dataset?.pfEscArmed) {
            return;
          }
          this.close();
        }, { signal });
      } catch {
        // Constructor can throw where the API is gated; our keydown path above
        // still dismisses, so the feature degrades instead of failing.
        this.#closeWatcher = null;
      }
    }
  }

  #teardownDismissal() {
    // Null the refs first: watcher.close() may dispatch its own `close`
    // event synchronously, which re-enters this.close() and finds nothing
    // left to tear down (close() itself is idempotent behind isOpen).
    const watcher = this.#closeWatcher;
    const scope = this.#dismissScope;
    this.#closeWatcher = null;
    this.#dismissScope = null;
    watcher?.close();
    scope?.abort();
  }

  /**
   * Undo a failed builder attempt: remove the tab rows + section DOM added
   * after the attempt marker. #sections keeps insertion order, so a slice
   * from the marker is exactly this attempt's registrations; the active
   * section can only be lost when the whole panel was rolled back, and the
   * next addSection activates its own - the pre-attempt state never held an
   * active section without also holding it in #sections.
   */
  #rollbackTo(startSize) {
    if (this.#sections.size <= startSize) {
      return;
    }
    for (const section of [...this.#sections.keys()].slice(startSize)) {
      this.#sections.get(section)?.remove();
      section.remove();
      this.#sections.delete(section);
    }
    if (this.#activeSection && !this.#sections.has(this.#activeSection)) {
      this.#activeSection = null;
    }
  }

  /** Add a section; returns the section root (or null when unusable). */
  addSection(title, icon) {
    if (!this.#root || this.#scope.disposed) {
      return null;
    }
    const sectionId = `pf-panel-section-${++this.#sectionCounter}`;
    const section = document.createElement("div");
    section.className = "pf-panel-section";
    section.id = sectionId;
    section.hidden = true;
    section.setAttribute("role", "tabpanel");
    section.setAttribute("aria-labelledby", `pf-panel-tab-${this.#sectionCounter}`);
    this.#body.appendChild(section);

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "pf-panel-tab";
    tab.id = `pf-panel-tab-${this.#sectionCounter}`;
    tab.dataset.title = title;
    // Roving tabindex: the tablist is one Tab stop (#activateSection moves
    // tabindex 0 to the selected tab); arrows already do the rest.
    tab.tabIndex = -1;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("aria-controls", sectionId);
    if (icon) {
      const iconEl = createIconElement(icon);
      if (iconEl) {
        tab.appendChild(iconEl);
      }
    }
    const label = document.createElement("span");
    label.className = "pf-tab-label";
    label.textContent = title;
    tab.appendChild(label);

    tab.addEventListener("click", () => this.#activateSection(section), { signal: this.#scope.signal });
    this.#tabList.appendChild(tab);
    this.#sections.set(section, tab);
    if (!this.#activeSection) {
      this.#activateSection(section);
    }
    return section;
  }

  /** Generic escape hatch: create + attribute + append in one call. */
  el(tag, attrs = {}, parent = this.#body) {
    return el(tag, attrs, parent);
  }

  addLabel(parent, text) {
    const node = this.el("span", { class: "pf-panel-label" }, parent);
    node.textContent = text;
    return node;
  }

  addHint(parent, text = "") {
    const node = this.el("div", { class: "pf-panel-hint" }, parent);
    node.textContent = text;
    return node;
  }

  /**
   * Unified declarative control builder - the routing core behind the
   * single-purpose add* wrappers. `type` selects the widget; every other
   * option is one key in one superset object, so callers pass exactly the
   * fields their control reads (unused keys are ignored).
   *
   *   Common        label, onChange, disabled
   *   button:       icon, title, ariaLabel, ghost
   *   checkbox:     checked
   *   color:        value (hex)
   *   select:       options ([value] or [value,label]), value
   *   stepper:      min, max, step, value, format, deferTextInput, head, class
   *
   * Returns the same per-widget handle the matching add* wrapper returns:
   * button -> <button>, checkbox -> <input>, select -> <select>,
   * color   -> { input, getValue, setValue },
   * stepper -> { root, input, getValue, setValue, setDisabled }.
   */
  addControl(parent, { type, ...opts } = {}) {
    switch (type) {
      case "button":
        return this.addButton(parent, opts);
      case "checkbox":
        return this.addCheckbox(parent, opts);
      case "color":
        return this.addColor(parent, opts);
      case "select":
        return this.addSelect(parent, opts);
      case "stepper":
        return this.addStepper(parent, opts);
      default:
        logger.warn("panel", `addControl: unknown type "${type}"`);
        return null;
    }
  }

  addButton(parent, { icon, title, ariaLabel, ghost, onClick, disabled } = {}) {
    const button = this.el("button", {
      class: ghost ? "pf-btn pf-btn-ghost pf-btn-icon" : "pf-btn pf-btn-icon",
      type: "button"
    }, parent);
    if (icon) {
      const iconEl = createIconElement(icon);
      if (iconEl) {
        button.appendChild(iconEl);
      }
    }
    if (title) {
      button.title = title;
    }
    if (ariaLabel) {
      button.setAttribute("aria-label", ariaLabel);
    }
    if (disabled) {
      button.disabled = true;
    }
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * Labeled numeric stepper with a live formatted value display.
   * Renders a grid cell by default; pass `class` for custom containers
   * or `head: true` for the stacked label-over-stepper layout.
   */
  addStepper(parent, {
    label,
    min = 0,
    max = 100,
    step = 1,
    value,
    format,
    onChange,
    deferTextInput = false,
    class: className,
    head,
    disabled = false
  } = {}) {
    const cell = this.el("div", { class: className || "pf-panel-cell" }, parent);
    const stepper = createStepper({
      min,
      max,
      step,
      value,
      label,
      deferTextInput,
      format,
      onChange,
      signal: this.#scope.signal
    });
    if (head) {
      const cellHead = this.el("div", { class: "pf-panel-cell-head" }, cell);
      this.addLabel(cellHead, label);
      cell.appendChild(stepper.root);
    } else {
      this.addLabel(cell, label);
      cell.appendChild(stepper.root);
    }
    if (disabled) {
      stepper.setDisabled(true);
    }
    return stepper;
  }

  addCheckbox(parent, { checked = false, onChange, disabled = false } = {}) {
    const attrs = { type: "checkbox" };
    if (disabled) attrs.disabled = "";
    const input = this.el("input", attrs, parent);
    input.checked = checked;
    input.addEventListener("change", () => onChange?.(input.checked));
    return input;
  }

  addColor(parent, { label, value = "#ffffff", onChange, disabled = false } = {}) {
    const cell = this.el("div", { class: "pf-panel-cell" }, parent);
    this.addLabel(cell, label);
    const attrs = { type: "color", value };
    if (disabled) attrs.disabled = "";
    const input = this.el("input", attrs, cell);
    const apply = (v) => {
      onChange?.(v);
    };
    input.addEventListener("input", () => apply(input.value));
    return {
      input,
      getValue: () => input.value,
      setValue(next) {
        if (input.value !== next) {
          input.value = next;
          apply(next);
        }
      }
    };
  }

  addSelect(parent, { options = [], value, onChange, disabled = false } = {}) {
    const attrs = { class: "pf-select" };
    if (disabled) attrs.disabled = "";
    const select = this.el("select", attrs, parent);
    for (const entry of options) {
      const [optValue, optLabel] = Array.isArray(entry) ? entry : [entry, entry];
      const option = document.createElement("option");
      option.value = optValue;
      option.textContent = optLabel;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener("change", () => onChange?.(select.value));
    return select;
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    this.#teardownDismissal();
    this.#root?.remove();
    this.#root = null;
    this.#slot?.remove();
    this.#slot = null;
    this.#backdrop?.remove();
    this.#backdrop = null;
    this.#body = null;
    this.#tabList = null;
    this.#capsule = null;
    this.#tabResize?.disconnect();
    this.#tabResize = null;
    this.#sections.clear();
    this.#activeSection = null;
  }

  #buildDom() {
    // Transparent modal shield: while the panel is open it covers the whole
    // shell (pointer-events: auto gated by .pf-open via :has in CSS), so a
    // click outside the panel closes it and is swallowed - it never passes
    // through to the SDK/video. Sits below the panel (z-hud) so panel controls
    // stay interactive. Because it lives in the host's shadow, the forge's
    // composedPath guard already ignores it; the stopPropagation below also
    // keeps it from bubbling to page/SDK handlers. Only animation/state lives
    // here - visibility is pure CSS, keyed on the single .pf-open source.
    const backdrop = document.createElement("div");
    backdrop.className = "pf-panel-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      this.close();
    }, { signal: this.#scope.signal });
    this.#hudLayer.appendChild(backdrop);
    this.#backdrop = backdrop;

    const root = document.createElement("div");
    root.className = "pf-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "PlayerForge controls");

    const header = document.createElement("div");
    header.className = "pf-panel-header";

    const tabList = document.createElement("div");
    tabList.className = "pf-panel-tabs";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", "PlayerForge sections");
    // The segmented capsule rides under the labels (paints below later
    // siblings); it never seeks events, never receives focus.
    const capsule = document.createElement("div");
    capsule.className = "pf-tab-capsule";
    capsule.setAttribute("aria-hidden", "true");
    tabList.appendChild(capsule);
    this.#capsule = capsule;
    // Density flips (compact setting mid-session) reshape the strip; the
    // observer re-anchors the capsule whenever the tab boxes move while the
    // panel is open. One observer, no timers.
    this.#tabResize = new ResizeObserver(() => {
      if (this.isOpen) {
        this.#moveCapsule();
      }
    });
    this.#tabResize.observe(tabList);

    const closeButton = document.createElement("button");
    closeButton.className = "pf-panel-close";
    closeButton.type = "button";
    closeButton.title = "Close";
    closeButton.setAttribute("aria-label", "Close panel");
    closeButton.textContent = "✕";

    header.appendChild(tabList);
    header.appendChild(closeButton);
    this.#tabList = tabList;

    const body = document.createElement("div");
    body.className = "pf-panel-body";
    root.appendChild(header);
    root.appendChild(body);
    // The panel rides a stage-sized slot (inset:0, pointer-transparent) so
    // the compact engine resolves wholly in-shadow: the slot is the stage
    // container Pf-stage AND the compact bus holder; a container lookup from
    // shadow content to the light-DOM host never resolves (the browser gate
    // established that), so the slot must exist as the shadow-side stage.
    // Inside it a safe-box wrapper carries the env() safe-area inset - the
    // slot itself cannot (its inline size IS the player region for the bus),
    // and env() cannot enter calc()/min() here (compact row measured the
    // width going invalid through both var-mediated and inline calc forms),
    // so the wrapper uses exactly the proven bare-env inset primitive.
    this.#slot = document.createElement("div");
    this.#slot.className = "pf-panel-slot";
    const safeBox = document.createElement("div");
    safeBox.className = "pf-safe";
    this.#hudLayer.appendChild(this.#slot);
    this.#slot.appendChild(safeBox);
    safeBox.appendChild(root);
    this.#root = root;
    this.#body = body;
    this.#closeButton = closeButton;

    // Compact mode: the setting override writes data-compact; the unset
    // setting leaves the attribute absent so the stage container query
    // auto-detects in the style pipeline. Runs after the root claims, since
    // the write is to the panel's own dataset.
    this.#applyCompactSetting();

    closeButton.addEventListener("click", () => this.close(), { signal: this.#scope.signal });
  }

  #wireEvents() {
    const { signal } = this.#scope;
    this.#shellHost.addEventListener(GESTURE_EVENTS.panel, (event) => {
      event.stopPropagation();
      this.toggle();
    }, { signal });
    this.#shellHost.addEventListener(GESTURE_EVENTS.swipe, (event) => {
      if (event.detail?.direction === "up") {
        this.toggle();
      }
    }, { signal });

    // Block every native pointer/touch/click event from crossing the panel
    // boundary into the SDK. The backdrop covers the rest of the shell, but
    // clicks that land ON the panel itself would otherwise bubble up through
    // the composed path to page-level handlers. Bubble phase so panel controls
    // (tabs, buttons) receive events first. Passive: the handlers only
    // stopPropagation - they never cancel a default, so the renderer may skip
    // the touch-action/scrollability check entirely.
    for (const type of ["pointerdown", "pointerup", "click", "touchstart", "touchend"]) {
      this.#root.addEventListener(type, (event) => {
        event.stopPropagation();
      }, { signal, passive: true });
    }

    // Any fullscreen transition dismisses the panel; the shared transition
    // source (shared/dom.js) drives it - no bus event needed.
    subscribeFullscreen(() => this.close(), this.#scope.signal);

    // Dismissal is ours since the popover left: Esc closes, and a press
    // outside the shell closes. The whole host counts as "inside" so our
    // own controls toggle themselves without a close/reopen flicker. Armed
    // per open() and torn down on close()/destroy() so a never-opened panel
    // pays zero document listeners for its whole shell lifetime.
    this.#tabList.addEventListener("keydown", (event) => {
      if (!TAB_NAV_KEYS.has(event.key)) {
        return;
      }
      // Index the NodeList directly; no [...querySelectorAll] copy per press.
      const tabNodes = this.#tabList.querySelectorAll(".pf-panel-tab");
      if (!tabNodes.length) {
        return;
      }
      let currentIndex = -1;
      const active = deepestActiveElement(this.#shellHost);
      for (let i = 0; i < tabNodes.length; i++) {
        if (tabNodes[i] === active) {
          currentIndex = i;
          break;
        }
      }
      if (currentIndex === -1) {
        return;
      }
      event.preventDefault();
      let nextIndex = currentIndex;
      if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + tabNodes.length) % tabNodes.length;
      } else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabNodes.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabNodes.length - 1;
      }
      const nextTab = tabNodes[nextIndex];
      let targetSection = null;
      for (const [section, tab] of this.#sections) {
        if (tab === nextTab) {
          targetSection = section;
          break;
        }
      }
      nextTab.focus();
      if (targetSection) {
        this.#activateSection(targetSection);
      }
    }, { signal });
  }

  #activateSection(targetSection) {
    const prev = this.#activeSection;
    if (prev === targetSection) {
      return;
    }
    if (prev) {
      const prevTab = this.#sections.get(prev);
      if (prevTab) {
        prev.hidden = true;
        prevTab.classList.remove("pf-panel-tab-active");
        prevTab.setAttribute("aria-selected", "false");
        prevTab.tabIndex = -1;
      }
    }
    targetSection.hidden = false;
    const targetTab = this.#sections.get(targetSection);
    if (targetTab) {
      targetTab.classList.add("pf-panel-tab-active");
      targetTab.setAttribute("aria-selected", "true");
      targetTab.tabIndex = 0;
    }
    this.#activeSection = targetSection;
    this.#moveCapsule();
  }

  /** Re-seat the capsule under the active tab; no-op while boxes are unknown. */
  #moveCapsule() {
    if (!this.#capsule) {
      return;
    }
    const tab = this.#sections.get(this.#activeSection);
    if (!tab || !tab.isConnected) {
      return;
    }
    const width = tab.offsetWidth;
    if (width > 0) {
      this.#capsule.style.width = `${width}px`;
      this.#capsule.style.translate = `${tab.offsetLeft}px 0`;
    }
  }

  #runWithViewTransition(type, update) {
    if (typeof document.startViewTransition === "function") {
      const transition = document.startViewTransition({ types: [type], update });
      // An overlapping open/close skips the older transition by design; the
      // browser then rejects `ready` (and settles `finished`), and those
      // rejections must not surface as unhandled promise errors in user
      // consoles.
      transition.ready.catch(() => {});
      transition.finished.catch(() => {});
    } else {
      update();
    }
  }
}

/* - Panel sections - */

/**
 * Render the settings schema into the panel: one labeled section per group,
 * toggles for bools, staged sliders for enum options, steppers for numbers.
 * One instance per render; the widget map and the reactivity subscription
 * are private fields, so a change event re-syncs without any module-let
 * state (`signal` ties that subscription to the caller, e.g. the shell).
 */
class SettingsSection {
  #panel;
  /** key -> widget handle(s), so a change event can re-sync without queries. */
  #controls = new Map();
  /** The reactivity subscription; torn down when the panel body is nulled. */
  #off = () => {};

  constructor(panel, zoom, signal) {
    this.#panel = panel;
    if (!panel?.body) {
      return;
    }
    const sectionRoot = panel.addSection("Settings", "settings");
    if (!sectionRoot) {
      return;
    }

    let currentGroup = null;
    let groupGrid = null;
    for (const definition of SETTINGS_SCHEMA) {
      if (definition.group !== currentGroup) {
        currentGroup = definition.group;
        const groupSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
        panel.addLabel(groupSection, definition.group);
        groupGrid = panel.el("div", { class: "pf-panel-grid" }, groupSection);
      }
      if (definition.type === "bool") {
        this.#addBool(groupGrid, definition);
      } else if (definition.type === "options") {
        this.#addOptions(groupGrid, definition);
      } else {
        const stepper = panel.addControl(groupGrid, {
          type: "stepper",
          label: definition.label,
          min: definition.min,
          max: definition.max,
          step: definition.step,
          value: getSetting(definition.key),
          head: true,
          format: definition.fmt,
          // Typing stays local until blur/Enter - no GM_setValue per keystroke
          // (subtitle steppers keep live output, so they stay immediate).
          deferTextInput: true,
          onChange: (parsed) => setSetting(definition.key, parsed)
        });
        if (stepper) {
          this.#controls.set(definition.key, { type: "stepper", el: stepper });
        }
      }
    }

    // The zoom/pan tools inline as one more labeled group under the render
    // loop (they read a state class, not the configs schema, so they cannot
    // ride SETTINGS_SCHEMA).
    if (zoom) {
      buildZoomGroup(panel, sectionRoot, zoom, signal);
    }

    // Re-sync widgets when a setting changes elsewhere (another tab's write, or
    // an in-page setSetting that did not originate from these controls). Values
    // are assigned - never .click()/.dispatchEvent - so the sync cannot echo
    // back into setSetting. A destroyed panel (body nulled) unsubscribes.
    this.#off = onSettingsChanged(() => this.#syncFromCache(), { signal });
    logger.log("settings", "Settings section ready");
  }

  #addBool(groupGrid, definition) {
    const panel = this.#panel;
    const cell = panel.el("div", { class: "pf-panel-cell" }, groupGrid);
    const toggleLabel = panel.el("label", { class: "pf-settings-toggle" }, cell);
    const checkbox = panel.addControl(toggleLabel, {
      type: "checkbox",
      checked: getSetting(definition.key),
      onChange: (checked) => {
        setSetting(definition.key, checked);
      }
    });
    checkbox.setAttribute("aria-label", definition.label);
    panel.el("span", {}, toggleLabel).textContent = definition.label;
    this.#controls.set(definition.key, { type: "bool", el: checkbox });
  }

  /**
   * Options-type settings render as staged sliders: label on the left and
   * the active option as a value hint on the right share the slider's line
   * (the settings-row grammar, no tick tips on the slider itself). The
   * range's own value/step/arrow semantics replace the roving radio group
   * entirely - one focusable stop, arrows step options, and the sync path
   * stays the same set-only assignment (never echo).
   */
  #addOptions(groupGrid, definition) {
    const panel = this.#panel;
    const cell = panel.el("div", { class: "pf-panel-cell pf-options-cell" }, groupGrid);
    panel.addLabel(cell, definition.label);
    const stage = panel.el("div", { class: "pf-stage" }, cell);
    const slider = panel.el("input", {
      class: "pf-slider",
      type: "range",
      min: 0,
      max: definition.options.length - 1,
      step: 1
    }, stage);
    slider.setAttribute("aria-label", definition.label);
    const hint = panel.el("span", { class: "pf-options-hint" }, cell);
    const syncOptions = (active) => {
      const index = definition.options.indexOf(active);
      const value = index === -1 ? 0 : index;
      slider.value = value;
      hint.textContent = definition.fmt(definition.options[value]);
      slider.setAttribute("aria-valuetext", definition.fmt(definition.options[value]));
    };
    slider.addEventListener("input", () => {
      const index = Number(slider.value) | 0;
      if (index >= 0 && index < definition.options.length) {
        setSetting(definition.key, definition.options[index]);
      }
    });
    syncOptions(getSetting(definition.key));
    this.#controls.set(definition.key, { type: "options", sync: syncOptions });
  }

  #syncFromCache() {
    if (!this.#panel?.body) {
      this.#off();
      return;
    }
    for (const [key, rec] of this.#controls) {
      const fresh = getSetting(key);
      if (rec.type === "bool") {
        rec.el.checked = fresh;
      } else if (rec.type === "options") {
        rec.sync(fresh);
      } else {
        rec.el.setValue(fresh);
      }
    }
  }
}

export function addSettingsSection(panel, zoom, signal) {
  new SettingsSection(panel, zoom, signal);
}

/**
 * The resume-history section: pooled past-video cards for the shell's
 * opening panel, one event-delegated listener for the whole list.
 */
function formatDomain(domain) {
  if (!domain) return "";
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

class HistorySection {
  #panel;
  #shell;
  /** Tracks which cards are currently in the DOM (acquired from pool). */
  #activeCards = [];
  /**
   * Element refs captured when the pool builds a card. The card tree is
   * fixed at factory time, so #renderCard/reset re-read these instead of
   * re-running two querySelector calls per card per render (a structural
   * render walks every pooled card - 200 entries is 400 lookups saved).
   */
  #cardRefs = new WeakMap();
  #list;
  #hint;
  #cardPool;

  constructor(panel, shell) {
    this.#panel = panel;
    this.#shell = shell;
    const sectionRoot = panel.addSection("History", "resume");
    if (!sectionRoot) {
      return;
    }

    const list = this.#list = panel.el("div", { class: "pf-history-list" }, sectionRoot);
    const hint = this.#hint = panel.el("div", { class: "pf-panel-hint" }, sectionRoot);
    hint.textContent = "No watch history yet";

    this.#cardPool = new DomPool({
      factory: () => this.#buildCard(),
      // reset clears text + buttons so #renderCard() can repopulate.
      reset: (card) => this.#resetCard(card)
    });

    // Event delegation for the whole list: one static listener instead of one
    // per pooled card. Card count is runtime-dynamic (watched entries, removals,
    // cross-tab adds) and the pool shrinks, so listener lifetime must not ride
    // the card/pool cycle - render() and shrink() never attach or detach a
    // listener. Button clicks bubble up through the card to the list.
    list.addEventListener("click", (event) => this.#onListClick(event));

    this.#render();
    // The store gains entries throughout the session (new videos watched) and
    // on cross-tab imports; re-render when the entry SET changes so the open
    // History tab never shows a boot-time snapshot. Position-only persists are
    // not structural and stay invisible - the cards don't display position.
    shell.resume?.onChange?.((structural) => {
      if (structural) {
        this.#render();
      }
    });
  }

  #refsFor(card) {
    let refs = this.#cardRefs.get(card);
    if (!refs) {
      const info = card.querySelector(".pf-history-info");
      refs = {
        title: info.querySelector(".pf-history-title"),
        meta: info.querySelector(".pf-history-meta"),
        resetBtn: card.querySelector('[data-action="reset"]'),
        removeBtn: card.querySelector('[data-action="remove"]')
      };
      this.#cardRefs.set(card, refs);
    }
    return refs;
  }

  /** Pool factory: builds the full card tree. */
  #buildCard() {
    const panel = this.#panel;
    const card = panel.el("div", { class: "pf-history-card" });
    const info = panel.el("div", { class: "pf-history-info" }, card);
    const title = panel.el("div", { class: "pf-history-title" }, info);
    const meta = panel.el("div", { class: "pf-history-meta" }, info);
    const actions = panel.el("div", { class: "pf-history-actions" }, card);
    const resetBtn = button({
      class: "pf-btn pf-btn-icon pf-btn-ghost",
      title: "Reset",
      "aria-label": "Reset resume position",
      "data-action": "reset",
      icon: createIconElement("reload")
    }, actions);
    const removeBtn = button({
      class: "pf-btn pf-btn-icon pf-btn-ghost",
      title: "Remove",
      "aria-label": "Remove from history",
      "data-action": "remove",
      icon: createIconElement("trash")
    }, actions);
    this.#cardRefs.set(card, { title, meta, resetBtn, removeBtn });
    return card;
  }

  /** Pool reset: clears text + buttons so #renderCard() can repopulate. */
  #resetCard(card) {
    card.dataset.entryId = "";
    const refs = this.#refsFor(card);
    refs.title.textContent = "";
    refs.meta.textContent = "";
    // Generic labels while pooled: a card must never announce its previous
    // entry's name between renders.
    refs.resetBtn.setAttribute("aria-label", "Reset resume position");
    refs.removeBtn.setAttribute("aria-label", "Remove from history");
    return card;
  }

  #onListClick(event) {
    const btn = event.target.closest("[data-action]");
    const card = event.target.closest(".pf-history-card");
    if (!btn || !card) {
      return;
    }
    const shell = this.#shell;
    if (btn.dataset.action === "reset") {
      shell.resume?.resetEntry(card.dataset.entryId);
      flashElement(btn);
      shell.toastInfo("reload", "Resume Entry Reset", "history");
    } else if (btn.dataset.action === "remove") {
      // The store's #persist(true) fires onChange synchronously, so the
      // structural #render() below reconciles the list (pop the stale card,
      // re-label the rest). Manual mutation here would double-release the
      // clicked card into the pool — #render() is the single mutator.
      shell.resume?.removeEntry(card.dataset.entryId);
      shell.toastInfo("trash", "Resume Entry Removed", "history");
    }
  }

  #render() {
    const entries = this.#shell.resume?.getEntries() || [];
    const pool = this.#cardPool;
    const cards = this.#activeCards;
    // Release cards that are no longer needed.
    while (cards.length > entries.length) {
      const card = cards.pop();
      card.remove();
      pool.release(card);
    }
    // Acquire or reuse cards for each entry.
    for (let i = 0; i < entries.length; i++) {
      let card = cards[i];
      if (!card) {
        card = pool.acquire();
        cards.push(card);
        this.#list.appendChild(card);
      }
      this.#renderCard(entries[i], card);
    }
    this.#hint.hidden = entries.length > 0;
    // Drop excess pooled cards when the list shrinks significantly.
    if (pool.idle > entries.length * 2) {
      pool.shrink(entries.length);
    }
  }

  #renderCard(entry, card) {
    card.dataset.entryId = entry.id;
    const refs = this.#refsFor(card);
    const name = entry.title || formatDomain(entry.domain);
    refs.title.textContent = name;
    // Announce which entry each icon acts on (two identical buttons per card).
    if (name) {
      refs.resetBtn.setAttribute("aria-label", `Reset resume position for ${name}`);
      refs.removeBtn.setAttribute("aria-label", `Remove ${name} from history`);
    } else {
      refs.resetBtn.setAttribute("aria-label", "Reset resume position");
      refs.removeBtn.setAttribute("aria-label", "Remove from history");
    }
    const parts = [formatDomain(entry.domain)];
    if (entry.duration > 0) {
      parts.push(formatTime(entry.duration));
    }
    refs.meta.textContent = parts.join(" \u00b7 ");
  }
}

export function addHistorySection(panel, shell) {
  new HistorySection(panel, shell);
}
